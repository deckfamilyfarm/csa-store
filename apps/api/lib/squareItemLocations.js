// Catalog location settings belong to both the parent item and its variations.
// Preserve every other catalog field, including pricing, channels and inventory.
export function squareObjectAtLocation(object, locationId) {
  return object.present_at_all_locations !== false
    ? !(object.absent_at_location_ids || []).includes(locationId)
    : (object.present_at_location_ids || []).includes(locationId);
}
export function hideSquareItemAtLocations(item, locationIds) {
  if (item?.type !== 'ITEM' || item.is_deleted || !item.version) throw new Error('A live, versioned Square item is required.');
  const next = structuredClone(item), hidden = new Set(locationIds);
  if (!hidden.size) throw new Error('Choose at least one location.');
  for (const object of [next, ...(next.item_data?.variations || [])]) {
    if (object.present_at_all_locations !== false) {
      object.absent_at_location_ids = [...new Set([...(object.absent_at_location_ids || []), ...locationIds])].sort();
    } else {
      object.present_at_location_ids = (object.present_at_location_ids || []).filter(id => !hidden.has(id));
    }
  }
  return next;
}
export function showSquareItemAtLocations(item, locationIds) {
  if (item?.type !== 'ITEM' || item.is_deleted || !item.version) throw new Error('A live, versioned Square item is required.');
  if (!locationIds.length) throw new Error('Choose at least one location.');
  const next = structuredClone(item), shown = new Set(locationIds);
  for (const object of [next, ...(next.item_data?.variations || [])]) {
    if (object.present_at_all_locations !== false) {
      object.absent_at_location_ids = (object.absent_at_location_ids || []).filter(id => !shown.has(id));
    } else {
      object.present_at_location_ids = [...new Set([...(object.present_at_location_ids || []), ...locationIds])].sort();
    }
  }
  return next;
}
export function squareItemLocationSnapshot(item, locationIds) {
  if (!item || item.is_deleted) return null;
  return [item, ...(item.item_data?.variations || [])].map(object => ({
    id: object.id, locations: Object.fromEntries(locationIds.map(id => [id, squareObjectAtLocation(object, id)]))
  }));
}
