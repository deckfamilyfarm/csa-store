export async function adminResponseError(response, fallback) {
  const body = await response.text();
  let payload;
  try { payload = JSON.parse(body); } catch { payload = {}; }
  const gateway = [502, 503, 504].includes(response.status)
    ? "The server could not finish this request in time. Please try again."
    : `${fallback} (HTTP ${response.status})`;
  const error = new Error(payload?.detail || payload?.error || gateway);
  error.status = response.status;
  if (response.status === 409) {
    error.farmStockConflict = payload?.farmStockConflict;
    error.inventoryConflict = payload?.inventoryConflict;
  }
  return error;
}
