import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

export const DEFAULT_QBO_ENTITY_ID = "BUSINESS_B";
export const DEFAULT_QBO_ENTITY_NAME = "Full Farm CSA";
export const DEFAULT_QBO_TIMEOUT_MS = 15000;
export const DEFAULT_QBO_ACCOUNTING_METHOD = "Cash";

function loadEnvSource(envPath, label) {
  if (!envPath) return null;
  const resolvedPath = path.isAbsolute(envPath) ? envPath : path.resolve(repoRoot, envPath);
  try {
    if (!fs.existsSync(resolvedPath)) return null;
    return {
      label,
      path: resolvedPath,
      dir: path.dirname(resolvedPath),
      values: dotenv.parse(fs.readFileSync(resolvedPath))
    };
  } catch {
    return null;
  }
}

function buildEnvSources() {
  const localSources = [
    loadEnvSource(path.resolve(repoRoot, ".env"), "repo .env"),
    loadEnvSource(path.resolve(repoRoot, "apps/api/.env"), "apps/api .env")
  ].filter(Boolean);
  const getLocalEnvValue = (key) => {
    if (process.env[key]) return process.env[key];
    for (const source of localSources) {
      if (source.values[key]) return source.values[key];
    }
    return null;
  };

  return [
    ...localSources,
    loadEnvSource(getLocalEnvValue("DASHBOARD_QBO_ENV_PATH"), "DASHBOARD_QBO_ENV_PATH"),
    loadEnvSource(getLocalEnvValue("ACCOUNTING_REPORTS_ENV_PATH"), "ACCOUNTING_REPORTS_ENV_PATH"),
    loadEnvSource(path.resolve(repoRoot, "../accounting-reports/.env"), "sibling accounting-reports .env"),
    loadEnvSource(path.resolve(repoRoot, "../account-reports/.env"), "sibling account-reports .env")
  ].filter(Boolean);
}

const envSources = buildEnvSources();

export function getQboEnvEntry(key) {
  const direct = process.env[key];
  if (typeof direct !== "undefined" && direct !== "") {
    return { value: direct, dir: process.cwd(), label: "process.env" };
  }
  for (const source of envSources) {
    const value = source.values[key];
    if (typeof value !== "undefined" && value !== "") {
      return { value, dir: source.dir, label: source.label, path: source.path };
    }
  }
  return null;
}

export function getQboEnv(key, fallback = "") {
  return getQboEnvEntry(key)?.value ?? fallback;
}

export function getQboPathEnv(key, fallback = null) {
  const entry = getQboEnvEntry(key);
  const value = entry?.value || fallback;
  if (!value) return null;
  const baseDir = entry?.dir || repoRoot;
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function resolvePathFromEntry(entry) {
  if (!entry?.value) return null;
  return path.isAbsolute(entry.value) ? entry.value : path.resolve(entry.dir || repoRoot, entry.value);
}

export function getQboEnvSources() {
  return envSources.map((source) => ({
    label: source.label,
    path: source.path
  }));
}

export function getQboEntityId() {
  return getQboEnv("DASHBOARD_QBO_ENTITY_ID", DEFAULT_QBO_ENTITY_ID);
}

export function getQboEntityName(entityId = getQboEntityId()) {
  return getQboEnv("DASHBOARD_QBO_ENTITY_NAME", entityId === DEFAULT_QBO_ENTITY_ID ? DEFAULT_QBO_ENTITY_NAME : entityId);
}

export function getQboAccountingMethod() {
  return getQboEnv("DASHBOARD_QBO_ACCOUNTING_METHOD", DEFAULT_QBO_ACCOUNTING_METHOD);
}

export function getQboTimeoutMs() {
  return (
    Number.parseInt(getQboEnv("DASHBOARD_QBO_TIMEOUT_MS", String(DEFAULT_QBO_TIMEOUT_MS)), 10) ||
    DEFAULT_QBO_TIMEOUT_MS
  );
}

export function resolveQboTokenStorePath() {
  return resolveQboTokenStorePaths().tokenStorePath;
}

export function resolveQboTokenStorePaths() {
  const entry = getQboEnvEntry("QBO_TOKEN_STORE");
  const localLabels = new Set(["process.env", "repo .env", "apps/api .env"]);
  if (entry && localLabels.has(entry.label)) {
    return {
      tokenStorePath: resolvePathFromEntry(entry),
      fallbackTokenStorePath: null
    };
  }
  return {
    tokenStorePath: path.resolve(repoRoot, ".qbo/qbo-refresh.json"),
    fallbackTokenStorePath: resolvePathFromEntry(entry)
  };
}

export function buildQboClientConfig(entityId = getQboEntityId()) {
  const required = ["REALM_ID", "CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN"];
  const missingEnv = required.filter((key) => !getQboEnv(`QBO_${entityId}_${key}`));
  if (missingEnv.length) return { config: null, missingEnv };
  const tokenStores = resolveQboTokenStorePaths();
  return {
    config: {
      entityId,
      realmId: getQboEnv(`QBO_${entityId}_REALM_ID`),
      clientId: getQboEnv(`QBO_${entityId}_CLIENT_ID`),
      clientSecret: getQboEnv(`QBO_${entityId}_CLIENT_SECRET`),
      refreshToken: getQboEnv(`QBO_${entityId}_REFRESH_TOKEN`),
      env: getQboEnv(`QBO_${entityId}_ENV`) === "production" ? "production" : "sandbox",
      tokenStorePath: tokenStores.tokenStorePath,
      fallbackTokenStorePath: tokenStores.fallbackTokenStorePath,
      timeoutMs: getQboTimeoutMs()
    },
    missingEnv: []
  };
}

export function describeQboConfig(entityId = getQboEntityId()) {
  const { config, missingEnv } = buildQboClientConfig(entityId);
  return {
    entityId,
    configured: Boolean(config),
    missingEnv: missingEnv.map((key) => `QBO_${entityId}_${key}`),
    env: config?.env || null,
    realmId: config?.realmId || null,
    tokenStorePath: config?.tokenStorePath || resolveQboTokenStorePath(),
    fallbackTokenStorePath: config?.fallbackTokenStorePath || resolveQboTokenStorePaths().fallbackTokenStorePath,
    accountingMethod: getQboAccountingMethod(),
    envSources: getQboEnvSources()
  };
}
