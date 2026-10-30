import { comparisonGroups } from "./productSyncView.js";

export const syncMoney = cents => cents == null || !Number.isFinite(Number(cents)) ? "Not available" : `$${(Number(cents) / 100).toFixed(2)}`;
const priceCents = value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100);
export function productSyncSummary(action) {
  if (action.direction === "incoming") return null;
  const groups = comparisonGroups(action);
  const notes = [];
  const prices = [];
  if (action.platform === "square") {
    const current = action.display?.current, proposed = action.display?.proposed;
    if (current || proposed) prices.push({ package: action.packageName || "Selling price", baskets: [],
      currentCents: priceCents(current?.price), localCents: priceCents(proposed?.price),
      currentUnit: current?.sellingUnit, proposedUnit: proposed?.sellingUnit });
  } else {
    // These are frozen observed customer prices, not the API's base price or
    // adjustment_value (which may mean a percentage rather than dollars).
    const rows = action.display?.pricingComparison || [];
    for (const [index, row] of rows.entries()) {
      const packageName = row.packageName || row.label?.replace(/ · basket .+$/, "") || "Package";
      const packageKey = row.remotePackageId ?? packageName;
      let group = prices.find(item => item.packageKey === packageKey && item.currentCents === row.currentCents && item.localCents === row.localCents);
      if (!group) {
        group = { packageKey, package: packageName, currentCents: row.currentCents, localCents: row.localCents, baskets: [], totalBaskets: rows.filter(item => (item.remotePackageId ?? item.packageName ?? item.label?.replace(/ · basket .+$/, "")) === packageKey).length };
        prices.push(group);
      }
      group.baskets.push(row.listName || `Basket ${index + 1}`);
    }
    if (groups.some(group => group.rows.some(row => /adjustment_type/.test(row.key) && Number(row.proposed) === 3))) {
      notes.push("Local Line will use the saved selling prices directly instead of calculating a separate markup.");
    }
    if (!prices.length && groups.some(group => group.title === "Prices & packages")) notes.push("Package pricing will be updated. Customer-price comparisons are unavailable for this saved check; the recorded values are under Technical details.");
  }
  if (groups.some(group => group.title === "Images")) {
    const images = action.display?.proposed?.images;
    const count = images?.sources?.length ?? (Array.isArray(images) ? images.length : null);
    notes.push(count == null ? "Update the product photos on Local Line." : count === 0 ? "Remove the current Local Line photos."
      : `Send ${count === 1 ? "the saved product photo" : `${count} saved product photos`} to Local Line, replacing its current photo list.`);
  }
  // Keep non-price changes visible so a compact price review does not conceal
  // visibility, sale, inventory, description, or unit changes in the same update.
  const otherGroups = groups.filter(group => !["Images", "Prices & packages"].includes(group.title));
  const packageChanges = groups.find(group => group.title === "Prices & packages")?.rows.filter(row => !/price|adjustment|sellingUnit/i.test(row.key)) || [];
  if (packageChanges.length) otherGroups.push({ title: "Package details", rows: packageChanges });
  return { prices, notes, otherGroups, changed: groups.length > 0 };
}
