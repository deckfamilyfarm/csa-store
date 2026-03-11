const LL_BASEURL = process.env.LL_BASEURL || "https://localline.ca/api/backoffice/v2/";
const SKEW_SECONDS = Number.parseInt(process.env.LOCALLINE_TOKEN_SKEW_SEC || "60", 10);
const FALLBACK_TTL_SECONDS = Number.parseInt(
  process.env.LOCALLINE_TOKEN_FALLBACK_TTL || "600",
  10
);

let cachedToken = null;
let tokenExpiryMs = 0;
let refreshingPromise = null;

function decodeJwtPayload(token) {
  try {
    const base64Url = token.split(".")[1];
    const json = Buffer.from(base64Url, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isExpiringSoon() {
  const nowMs = Date.now();
  return !tokenExpiryMs || nowMs >= tokenExpiryMs - SKEW_SECONDS * 1000;
}

export function isLocalLineAuthConfigured() {
  return Boolean(process.env.LL_USERNAME && process.env.LL_PASSWORD);
}

export function getLocalLineBaseUrl() {
  return LL_BASEURL;
}

async function fetchNewToken() {
  const username = process.env.LL_USERNAME;
  const password = process.env.LL_PASSWORD;
  if (!username || !password) {
    throw new Error("LL_USERNAME/LL_PASSWORD are not set");
  }

  const response = await fetch(`${LL_BASEURL}token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LocalLine token error: ${response.status} ${body}`);
  }

  const data = await response.json();
  const token = data?.access || data?.token || data;
  if (!token || typeof token !== "string") {
    throw new Error("LocalLine token response missing access token");
  }

  const payload = decodeJwtPayload(token);
  const expMs = payload?.exp
    ? payload.exp * 1000
    : Date.now() + FALLBACK_TTL_SECONDS * 1000;

  cachedToken = token;
  tokenExpiryMs = expMs;

  return token;
}

async function refreshAccessTokenSingleFlight() {
  if (!refreshingPromise) {
    refreshingPromise = fetchNewToken().finally(() => {
      refreshingPromise = null;
    });
  }
  return refreshingPromise;
}

export async function getLocalLineAccessToken() {
  if (!cachedToken || isExpiringSoon()) {
    await refreshAccessTokenSingleFlight();
  }
  return cachedToken;
}
