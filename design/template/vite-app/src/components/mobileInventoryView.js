// Presentation-only helpers. Persisted values and saves stay in productWorkspace.
export function mobileFarmStatus(row, drafts = {}) {
  const value = drafts[row.productId]?.values.stockOnFarm ?? row.stockOnFarm;
  // An explicit null draft can undo an unsaved check of an unchecked product.
  if (drafts[row.productId]?.values.stockOnFarm === null || value == null) return null;
  return Boolean(Number(value));
}

export function mobileInventoryView(rows, drafts, search, filter, farmFilter = "all") {
  const query = search.trim().toLocaleLowerCase();
  const checked = rows.filter(row => mobileFarmStatus(row, drafts) !== null).length;
  return {
    checked,
    total: rows.length,
    rows: rows.filter(row => {
      const name = drafts[row.productId]?.values.name ?? row.name;
      const status = mobileFarmStatus(row, drafts);
      const reviewed = status !== null;
      return String(name).toLocaleLowerCase().includes(query) &&
        (filter === "checked" ? reviewed : filter === "not-checked" ? !reviewed : true) &&
        (farmFilter === "true" ? status === true : farmFilter === "false" ? status === false : farmFilter === "not-checked" ? !reviewed : true);
    }),
  };
}

export async function readMobileInventoryPages(readPage, cancelled = () => false) {
  const first = await readPage(1);
  const rows = [...(first.rows || [])];
  for (let page = 2; page <= (first.pagination?.totalPages || 1); page++) {
    if (cancelled()) return null;
    const next = await readPage(page);
    rows.push(...(next.rows || []));
  }
  if (cancelled()) return null;
  return { ...first, rows: [...new Map(rows.map(row => [row.productId, row])).values()] };
}
