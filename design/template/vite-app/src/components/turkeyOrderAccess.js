const ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keyFor = orderId => `turkeyOrder:${orderId}`;

// Retain only the access token, not customer details, so a Stripe return in a
// new tab can still show the receipt. Access stays scoped to this origin.
export function rememberOrderAccess(orderId, token, browser = window, now = Date.now()) {
  if (!orderId || !validToken(token)) return false;
  let saved = false;
  try { browser.sessionStorage.setItem(keyFor(orderId), JSON.stringify(token)); saved = true; } catch { /* Try the other storage. */ }
  try {
    browser.localStorage.setItem(keyFor(orderId), JSON.stringify({ token, expiresAt: now + ACCESS_TTL_MS }));
    saved = true;
  } catch { /* Session storage is sufficient for a return in the same tab. */ }
  return saved;
}

export function readOrderAccess(orderId, browser = window, now = Date.now()) {
  if (!orderId) return null;
  try {
    const token = JSON.parse(browser.sessionStorage.getItem(keyFor(orderId)));
    if (validToken(token)) return token;
  } catch { /* The tab may have been closed or storage may be unavailable. */ }
  try {
    const saved = JSON.parse(browser.localStorage.getItem(keyFor(orderId)));
    if (validToken(saved?.token) && Number.isFinite(saved.expiresAt) && saved.expiresAt > now) return saved.token;
    browser.localStorage.removeItem(keyFor(orderId));
  } catch { /* Show the receipt recovery message. */ }
  return null;
}
