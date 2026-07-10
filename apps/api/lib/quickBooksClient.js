import fs from "fs";
import path from "path";
import { getQboAccountingMethod } from "./qboConfig.js";

function parseJsonResponse(text, label) {
  try {
    return JSON.parse(text || "{}");
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error?.message || error}`);
  }
}

export class QuickBooksClient {
  constructor(config = {}) {
    this.config = config;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    const storedRefreshToken = this.loadRefreshTokenFromStores();
    this.refreshToken = storedRefreshToken?.token || config.refreshToken || "";
    if (storedRefreshToken?.token && storedRefreshToken.path !== config.tokenStorePath) {
      this.saveRefreshTokenToStore(storedRefreshToken.token);
    } else if (config.refreshToken && !storedRefreshToken?.token) {
      this.saveRefreshTokenToStore(config.refreshToken);
    }
  }

  baseUrl() {
    return this.config.env === "production"
      ? "https://quickbooks.api.intuit.com"
      : "https://sandbox-quickbooks.api.intuit.com";
  }

  async fetchWithTimeout(url, options = {}) {
    const timeoutMs = Number(this.config.timeoutMs || 15000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureAccessToken() {
    const now = Date.now();
    if (this.accessToken && now < this.accessTokenExpiresAt - 60000) {
      return this.accessToken;
    }

    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken
    });
    const response = await this.fetchWithTimeout("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: body.toString()
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`QBO token refresh failed (${response.status}): ${text}`);
    }
    const parsed = parseJsonResponse(text, "QBO token refresh");
    this.accessToken = parsed.access_token || null;
    if (!this.accessToken) {
      throw new Error("QBO token refresh did not return an access token.");
    }
    if (parsed.refresh_token) {
      this.refreshToken = parsed.refresh_token;
      this.saveRefreshTokenToStore(parsed.refresh_token);
    }
    const expiresIn = Number(parsed.expires_in) || 3600;
    this.accessTokenExpiresAt = Date.now() + expiresIn * 1000;
    return this.accessToken;
  }

  async qboGet(pathname, params = {}) {
    const token = await this.ensureAccessToken();
    const url = new URL(`${this.baseUrl()}${pathname}`);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== null && typeof value !== "undefined" && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
    const response = await this.fetchWithTimeout(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`QBO GET ${pathname} failed (${response.status}): ${text}`);
    }
    return parseJsonResponse(text, `QBO GET ${pathname}`);
  }

  async qboQuery(sql) {
    const token = await this.ensureAccessToken();
    const pathname = `/v3/company/${this.config.realmId}/query`;
    const url = new URL(`${this.baseUrl()}${pathname}`);
    url.searchParams.set("minorversion", "75");
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "text/plain"
    };

    const postResponse = await this.fetchWithTimeout(url.toString(), {
      method: "POST",
      headers,
      body: sql
    });
    const postText = await postResponse.text();
    if (postResponse.ok) {
      return parseJsonResponse(postText, `QBO query ${sql}`);
    }

    const getUrl = new URL(`${this.baseUrl()}${pathname}`);
    getUrl.searchParams.set("query", sql);
    getUrl.searchParams.set("minorversion", "75");
    const getResponse = await this.fetchWithTimeout(getUrl.toString(), { headers });
    const getText = await getResponse.text();
    if (!getResponse.ok) {
      throw new Error(`QBO query failed (POST ${postResponse.status}: ${postText}; GET ${getResponse.status}: ${getText})`);
    }
    return parseJsonResponse(getText, `QBO query ${sql}`);
  }

  async fetchCompanyInfo() {
    return this.qboGet(`/v3/company/${this.config.realmId}/companyinfo/${this.config.realmId}`, {
      minorversion: 75
    });
  }

  async fetchReportJson(reportName, startDate, endDate, extraParams = {}) {
    const data = await this.qboGet(`/v3/company/${this.config.realmId}/reports/${reportName}`, {
      start_date: startDate,
      end_date: endDate,
      minorversion: 75,
      ...extraParams
    });
    return data?.Report || data;
  }

  async fetchProfitAndLoss(startDate, endDate, extraParams = {}) {
    return this.fetchReportJson("ProfitAndLoss", startDate, endDate, {
      accounting_method: getQboAccountingMethod(),
      ...extraParams
    });
  }

  async fetchClasses() {
    const data = await this.qboQuery("select * from Class where Active = true");
    return data?.QueryResponse?.Class || [];
  }

  loadRefreshTokenFromStore() {
    return this.loadRefreshTokenFromStores()?.token || null;
  }

  loadRefreshTokenFromStores() {
    const paths = [
      this.config.tokenStorePath,
      this.config.fallbackTokenStorePath
    ].filter(Boolean);
    for (const tokenStorePath of paths) {
      const token = this.loadRefreshTokenFromStorePath(tokenStorePath);
      if (token) return { token, path: tokenStorePath };
    }
    return null;
  }

  loadRefreshTokenFromStorePath(tokenStorePath) {
    if (!tokenStorePath) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(tokenStorePath, "utf8"));
      const value = parsed?.[this.config.realmId];
      return typeof value === "string" && value ? value : null;
    } catch {
      return null;
    }
  }

  saveRefreshTokenToStore(token) {
    const tokenStorePath = this.config.tokenStorePath;
    if (!tokenStorePath || !token) return;
    try {
      fs.mkdirSync(path.dirname(tokenStorePath), { recursive: true });
      let existing = {};
      if (fs.existsSync(tokenStorePath)) {
        existing = JSON.parse(fs.readFileSync(tokenStorePath, "utf8"));
      }
      existing[this.config.realmId] = token;
      fs.writeFileSync(tokenStorePath, JSON.stringify(existing, null, 2), "utf8");
    } catch {
      // Best effort only; the in-memory token can still be used for this process.
    }
  }
}
