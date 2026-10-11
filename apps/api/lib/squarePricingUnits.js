// Square prices are rates. A $2.50/lb rate must carry a pound unit, even
// when the local CSA/Local Line package is a bag with an estimated weight.
export function expectedSquareUnit(usesSourcePricing, explicitUnit) {
  if (!usesSourcePricing) return 'package';
  if (explicitUnit === 'lbs') return 'lb';
  if (explicitUnit === 'each') return 'each';
  return null; // Never infer retail units from bag names, weights, or defaults.
}

export function squareUnitSnapshot(id, units = new Map()) {
  if (!id) return { id: null, unit: 'each/package', precision: 0, definition: null };
  const object = units.get(id);
  const data = object?.measurement_unit_data;
  if (object?.type !== 'MEASUREMENT_UNIT' || object.is_deleted || !data?.measurement_unit) {
    return { id, unit: 'unknown', precision: null, definition: null };
  }
  const definition = data.measurement_unit;
  return { id, unit: definition.weight_unit === 'IMPERIAL_POUND' ? 'lb' : 'other',
    precision: data.precision ?? 3, definition };
}

export function poundUnit(units, preferredId) {
  const candidates = [...units.keys()].map(id => squareUnitSnapshot(id, units))
    .filter(unit => unit.unit === 'lb' && Number.isInteger(unit.precision) && unit.precision >= 1 && unit.precision <= 5)
    .sort((a, b) => a.id.localeCompare(b.id));
  return candidates.find(unit => unit.id === preferredId) || candidates[0] || null;
}

export function unitChangeIssue(variation) {
  const data = variation?.item_variation_data || {};
  if (data.stockable_conversion || data.track_inventory || data.location_overrides?.some(row => row.track_inventory)) {
    return 'Square inventory tracking or a stock conversion uses this unit. Review it in Square before changing the selling unit.';
  }
  return '';
}

export function planSquareUnit(expectedUnit, variation, units = new Map()) {
  const current = squareUnitSnapshot(variation?.item_variation_data?.measurement_unit_id, units);
  const issues = [];
  let proposed = current;
  if (!expectedUnit) issues.push('Set the local Retail Price unit (lb or each) in Products before syncing Square.');
  else if (current.unit === 'unknown') issues.push('Square measurement unit is unavailable. Refresh and review its unit definition.');
  else if (expectedUnit === 'lb') {
    if (!['lb', 'each/package'].includes(current.unit)) issues.push('Square uses a different measurement unit. Review the conversion in Square before syncing.');
    else {
      proposed = poundUnit(units, current.id);
      if (!proposed) issues.push('No Square pound unit with decimal precision is available. Add a lb unit in Square, then run the audit again.');
    }
  } else if (current.unit === 'lb') {
    // Explicit local each/package pricing can remove a known pound unit after review.
    proposed = squareUnitSnapshot(null, units);
  } else if (current.id) {
    // A custom bag or another measured unit may have business meaning; do not erase it.
    issues.push('Square uses a measured unit but local pricing is per each/package. Review the selling basis before syncing.');
  }
  const changed = Boolean(proposed && current.id !== proposed.id);
  if (changed && unitChangeIssue(variation)) issues.push(unitChangeIssue(variation));
  return { expectedUnit, current, proposed, changed, issues };
}
