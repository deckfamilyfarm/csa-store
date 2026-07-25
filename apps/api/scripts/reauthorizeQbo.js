import crypto from "crypto";
import fs from "fs";
import path from "path";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import {
  buildQboClientConfig,
  getQboEntityId,
  getQboEntityName,
  getQboEnv,
  resolveQboTokenStorePaths
} from "../lib/qboConfig.js";
import { QuickBooksClient } from "../lib/quickBooksClient.js";
import { parseDashboardPnlReport } from "../lib/qboDashboard.js";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const QBO_SCOPE = "com.intuit.quickbooks.accounting";

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  argv.forEach((arg) => {
    if (!arg.startsWith("--")) return;
    const [rawKey, ...rest] = arg.slice(2).split("=");
    const key = rawKey.replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
    args[key] = rest.length ? rest.join("=") : true;
  });
  return args;
}

function usage() {
  return `
Usage:
  npm --prefix apps/api run qbo:reauthorize -- --redirect-uri=https://your-registered-callback.example/qbo
  npm --prefix apps/api run qbo:reauthorize -- --callback-url='https://your-registered-callback.example/qbo?code=...&realmId=...&state=...'

Options:
  --entity=BUSINESS_B              QBO entity id. Defaults to DASHBOARD_QBO_ENTITY_ID or BUSINESS_B.
  --redirect-uri=URL               Redirect URI registered on the Intuit Developer app.
  --callback-url=URL               Full callback URL copied after Intuit authorization.
  --code=CODE --realm-id=REALM     Use code/realm directly instead of --callback-url.
  --allow-realm-change             Allow exchanging a code for a different realmId than configured.
  --test                           Only run the QBO connection test using the current saved token.
  --skip-test                      Do not run the connection test after exchanging a code.
  --skip-report                    Test CompanyInfo only; skip Profit and Loss.
  --print-url-only                 Print the authorization URL and exit without prompting.
`.trim();
}

function getEntityId(args) {
  return String(args.entity || getQboEntityId());
}

function getRedirectUri(entityId, args, stateRecord = null) {
  return (
    args.redirectUri ||
    getQboEnv(`QBO_${entityId}_REDIRECT_URI`) ||
    getQboEnv("QBO_REDIRECT_URI") ||
    stateRecord?.redirectUri ||
    ""
  );
}

function getStatePath() {
  const tokenStores = resolveQboTokenStorePaths();
  return path.join(path.dirname(tokenStores.tokenStorePath), "qbo-oauth-state.json");
}

function readStateRecord() {
  try {
    return JSON.parse(fs.readFileSync(getStatePath(), "utf8"));
  } catch {
    return null;
  }
}

function writeStateRecord(record) {
  const statePath = getStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(record, null, 2), "utf8");
  try {
    fs.chmodSync(statePath, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
}

function buildAuthorizationUrl(config, redirectUri, state) {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QBO_SCOPE);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

function normalizePastedValue(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

function parseCallback(args) {
  if (args.callbackUrl) {
    const url = new URL(String(args.callbackUrl));
    return {
      code: url.searchParams.get("code") || "",
      realmId: url.searchParams.get("realmId") || "",
      state: url.searchParams.get("state") || ""
    };
  }
  return {
    code: String(args.code || ""),
    realmId: String(args.realmId || ""),
    state: String(args.state || "")
  };
}

function parseCallbackInput(value, config) {
  const pasted = normalizePastedValue(value);
  if (!pasted) return null;
  if (/^https?:\/\//i.test(pasted)) {
    return { callbackUrl: pasted };
  }
  if (/^(code|realmId|state)=/.test(pasted)) {
    const params = new URLSearchParams(pasted);
    return {
      code: params.get("code") || "",
      realmId: params.get("realmId") || config.realmId,
      state: params.get("state") || ""
    };
  }
  return {
    code: pasted,
    realmId: config.realmId
  };
}

function writeRefreshTokenToStore(tokenStorePath, realmId, refreshToken) {
  if (!tokenStorePath) return false;
  fs.mkdirSync(path.dirname(tokenStorePath), { recursive: true });
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(tokenStorePath, "utf8"));
  } catch {
    existing = {};
  }
  existing[realmId] = refreshToken;
  fs.writeFileSync(tokenStorePath, JSON.stringify(existing, null, 2), "utf8");
  try {
    fs.chmodSync(tokenStorePath, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
  return true;
}

async function exchangeCode({ config, code, redirectUri }) {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: body.toString()
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    throw new Error(`QBO token exchange returned invalid JSON (${response.status}): ${text}`);
  }
  if (!response.ok) {
    throw new Error(`QBO token exchange failed (${response.status}): ${text}`);
  }
  if (!parsed.refresh_token || !parsed.access_token) {
    throw new Error(`QBO token exchange did not return both access_token and refresh_token: ${text}`);
  }
  return parsed;
}

async function verifyCompanyInfo({ config, accessToken, realmId }) {
  const baseUrl = config.env === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
  const url = `${baseUrl}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`CompanyInfo verification failed (${response.status}): ${text}`);
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

function formatYmd(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function getDefaultStartDate() {
  const now = new Date();
  return `${now.getUTCFullYear()}-01-01`;
}

function getDefaultEndDate() {
  return formatYmd(new Date());
}

async function runConnectionTest(args = {}) {
  const entityId = getEntityId(args);
  const { config, missingEnv } = buildQboClientConfig(entityId);
  if (!config) {
    throw new Error(`Missing QBO env for ${entityId}: ${missingEnv.map((key) => `QBO_${entityId}_${key}`).join(", ")}`);
  }

  const client = new QuickBooksClient(config);
  const companyInfo = await client.fetchCompanyInfo();
  const company = companyInfo?.CompanyInfo || {};
  const result = {
    ok: true,
    entityId,
    realmId: config.realmId,
    env: config.env,
    companyName: company.CompanyName || company.LegalName || null,
    companyId: company.Id || null
  };

  if (!args.skipReport) {
    const startDate = args.start || getDefaultStartDate();
    const endDate = args.end || getDefaultEndDate();
    const report = await client.fetchProfitAndLoss(startDate, endDate);
    const metrics = parseDashboardPnlReport(report, {
      entityId,
      entityName: result.companyName || entityId
    });
    result.profitAndLoss = {
      startDate,
      endDate,
      income: metrics.income,
      cogs: metrics.cogs,
      grossProfit: metrics.grossProfit,
      expenses: metrics.expenses,
      netIncome: metrics.netIncome,
      memberPayments: metrics.memberPayments
    };
  }

  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function printAuthorizationUrl(args) {
  const entityId = getEntityId(args);
  const { config, missingEnv } = buildQboClientConfig(entityId);
  if (!config) {
    throw new Error(`Missing QBO env for ${entityId}: ${missingEnv.map((key) => `QBO_${entityId}_${key}`).join(", ")}`);
  }
  const redirectUri = getRedirectUri(entityId, args, readStateRecord());
  if (!redirectUri) {
    throw new Error(
      `Missing redirect URI.\n\n${usage()}\n\nFor production QBO apps, Intuit requires an HTTPS redirect URI registered on the Intuit Developer app.`
    );
  }
  const state = `csa-store-qbo-${entityId}-${crypto.randomBytes(16).toString("hex")}`;
  writeStateRecord({
    entityId,
    realmId: config.realmId,
    redirectUri,
    state,
    createdAt: new Date().toISOString()
  });

  console.log(`QBO entity: ${entityId} (${getQboEntityName(entityId)})`);
  console.log(`Configured realmId: ${config.realmId}`);
  console.log(`Environment: ${config.env}`);
  console.log(`Redirect URI: ${redirectUri}`);
  console.log("\nOpen this URL in a browser, approve access, then copy the full redirected callback URL back here:\n");
  const authorizationUrl = buildAuthorizationUrl(config, redirectUri, state);
  console.log(authorizationUrl);
  return { entityId, config, redirectUri, state, authorizationUrl };
}

async function exchangeCallback(args) {
  const stateRecord = readStateRecord();
  const entityId = getEntityId(args);
  const { config, missingEnv } = buildQboClientConfig(entityId);
  if (!config) {
    throw new Error(`Missing QBO env for ${entityId}: ${missingEnv.map((key) => `QBO_${entityId}_${key}`).join(", ")}`);
  }
  const callback = parseCallback(args);
  if (!callback.code || !callback.realmId) {
    throw new Error(`Missing callback code or realmId.\n\n${usage()}`);
  }
  if (stateRecord?.state && callback.state && callback.state !== stateRecord.state) {
    throw new Error("Callback state did not match the saved authorization state. Start over and generate a fresh URL.");
  }
  if (callback.realmId !== config.realmId && !args.allowRealmChange) {
    throw new Error(
      `Callback realmId ${callback.realmId} does not match configured realmId ${config.realmId}. ` +
        "Select the expected QuickBooks company or rerun with --allow-realm-change if this is intentional."
    );
  }

  const redirectUri = getRedirectUri(entityId, args, stateRecord);
  if (!redirectUri) {
    throw new Error(`Missing redirect URI for token exchange.\n\n${usage()}`);
  }

  const tokenResponse = await exchangeCode({
    config,
    code: callback.code,
    redirectUri
  });
  const tokenStores = resolveQboTokenStorePaths();
  const writtenPaths = [
    tokenStores.tokenStorePath,
    tokenStores.fallbackTokenStorePath
  ]
    .filter(Boolean)
    .filter((tokenStorePath, index, paths) => paths.indexOf(tokenStorePath) === index)
    .filter((tokenStorePath) => writeRefreshTokenToStore(tokenStorePath, callback.realmId, tokenResponse.refresh_token));

  let companyName = "";
  try {
    const companyInfo = await verifyCompanyInfo({
      config,
      accessToken: tokenResponse.access_token,
      realmId: callback.realmId
    });
    companyName =
      companyInfo?.QueryResponse?.CompanyInfo?.[0]?.CompanyName ||
      companyInfo?.CompanyInfo?.CompanyName ||
      "";
  } catch (error) {
    console.warn(`Token was saved, but CompanyInfo verification failed: ${error?.message || error}`);
  }

  console.log(JSON.stringify({
    ok: true,
    entityId,
    realmId: callback.realmId,
    companyName: companyName || null,
    refreshTokenSaved: true,
    tokenStores: writtenPaths,
    expiresIn: tokenResponse.expires_in || null,
    xRefreshTokenExpiresIn: tokenResponse.x_refresh_token_expires_in || null
  }, null, 2));
  return {
    entityId,
    realmId: callback.realmId,
    companyName: companyName || null,
    tokenStores: writtenPaths
  };
}

async function askForRedirectUri(rl, args, entityId) {
  const current = getRedirectUri(entityId, args, readStateRecord());
  if (current) return current;
  const answer = normalizePastedValue(
    await rl.question("Registered QBO redirect URI: ")
  );
  if (!answer) {
    throw new Error("A registered redirect URI is required to start QBO authorization.");
  }
  return answer;
}

async function runInteractive(args) {
  const rl = readline.createInterface({ input, output });
  try {
    const entityId = getEntityId(args);
    const redirectUri = await askForRedirectUri(rl, args, entityId);
    const baseArgs = { ...args, entity: entityId, redirectUri };

    while (true) {
      const auth = await printAuthorizationUrl(baseArgs);
      console.log("\nPaste the full callback URL, the query string, or just the authorization code.");
      console.log("Type 'test' to test the current saved token, or 'quit' to exit.");
      const pasted = normalizePastedValue(await rl.question("> "));
      const command = pasted.toLowerCase();

      if (["q", "quit", "exit"].includes(command)) break;
      if (["t", "test"].includes(command)) {
        await runConnectionTest(baseArgs);
      } else {
        const callbackArgs = parseCallbackInput(pasted, auth.config);
        if (!callbackArgs) {
          console.log("No code or callback URL pasted; skipping exchange.");
        } else {
          await exchangeCallback({ ...baseArgs, ...callbackArgs });
          if (!args.skipTest) {
            console.log("\nRunning QBO connection test with the saved token...");
            await runConnectionTest(baseArgs);
          }
        }
      }

      const next = normalizePastedValue(
        await rl.question("\nNext: [r]eauthorize again, [t]est current token, [q]uit? ")
      ).toLowerCase();
      if (["q", "quit", "exit"].includes(next)) break;
      if (["t", "test"].includes(next)) {
        await runConnectionTest(baseArgs);
        const afterTest = normalizePastedValue(
          await rl.question("\nNext: [r]eauthorize again or [q]uit? ")
        ).toLowerCase();
        if (["q", "quit", "exit"].includes(afterTest)) break;
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.test) {
    await runConnectionTest(args);
    return;
  }
  if (args.callbackUrl || args.code) {
    await exchangeCallback(args);
    if (!args.skipTest) {
      console.log("\nRunning QBO connection test with the saved token...");
      await runConnectionTest(args);
    }
    return;
  }
  if (args.printUrlOnly) {
    await printAuthorizationUrl(args);
    return;
  }
  await runInteractive(args);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
