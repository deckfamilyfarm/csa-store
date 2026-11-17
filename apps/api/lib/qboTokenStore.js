// Shared on-disk lock/cache protocol used by the accounting service.
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function reapDeadOwner(lock, ownerPath) {
  // Serialize recovery too: two waiters must not both remove a newly acquired lock.
  const recovery = `${lock}.recovery`;
  try { fs.mkdirSync(recovery, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') {
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 120000) fs.rmSync(lock, { recursive: true, force: true });
        } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
      }
      return;
    }
    if (owner.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') fs.rmSync(lock, { recursive: true, force: true }); }
    }
  } finally {
    fs.rmdirSync(recovery);
  }
}

function readObject(filename) {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    // JSON parse errors can contain credentials; report only the filename and OS error code.
    throw new Error(`Cannot read QuickBooks token store ${filename} (${error.code || 'invalid JSON'}). No fallback token was used.`);
  }
}

export function readRefreshTokens(filename) {
  const saved = readObject(filename);
  if (Object.values(saved).some(value => typeof value !== 'string' || !value)) {
    throw new Error(`Invalid QuickBooks refresh-token entries in ${filename}.`);
  }
  return saved;
}

export function writePrivateJson(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filename);
  } catch (error) {
    throw new Error(`Cannot persist QuickBooks tokens to ${filename} (${error.code || 'write failed'}).`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** One lock covers refresh, reauthorization, and updates for every company in this store. */
export async function withTokenStoreLock(filename, action, timeoutMs = 45000) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const lock = `${filename}.lock`;
  const ownerPath = path.join(lock, 'owner.json');
  const started = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Error(`Cannot lock QuickBooks token store ${filename} (${error.code}).`);
      reapDeadOwner(lock, ownerPath);
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for QuickBooks token store ${filename}; another refresh may still be running.`);
      await wait(30);
    }
  }
  try {
    fs.writeFileSync(ownerPath, JSON.stringify({ host: os.hostname(), pid: process.pid }), { mode: 0o600 });
    return await action();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Caller must hold the store lock, including during the authorization-code exchange. */
export function saveRefreshTokenLocked(filename, realmId, token) {
  if (!token) throw new Error('QuickBooks did not return a refresh token.');
  writePrivateJson(filename, { ...readRefreshTokens(filename), [realmId]: token });
}

export async function storedAccessToken(config, refresh) {
  const filename = path.resolve(config.tokenStorePath);
  return withTokenStoreLock(filename, async () => {
    const saved = readRefreshTokens(filename);
    const refreshToken = saved[config.realmId] || config.refreshToken;
    if (!refreshToken) throw new Error(`No saved QuickBooks refresh token for company ${config.realmId}. Reauthorize on the server.`);
    const cachePath = `${filename}.access.json`;
    const cache = readObject(cachePath);
    const key = `${config.clientId}:${config.realmId}`;
    const cached = cache[key];
    if (cached?.accessToken && cached.refreshHash === hash(refreshToken) && cached.expiresAt > Date.now() + 60000) {
      return cached.accessToken;
    }
    const response = await refresh(refreshToken);
    if (!response.access_token || !response.refresh_token) throw new Error('QuickBooks refresh did not return both access and refresh tokens.');
    // Persist the replacement refresh token before exposing the access token to any caller.
    saveRefreshTokenLocked(filename, config.realmId, response.refresh_token);
    cache[key] = { accessToken: response.access_token, expiresAt: Date.now() + (Number(response.expires_in) || 3600) * 1000,
      refreshHash: hash(response.refresh_token), refreshedAt: new Date().toISOString() };
    writePrivateJson(cachePath, cache);
    return response.access_token;
  });
}
