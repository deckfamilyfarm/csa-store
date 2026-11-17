import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { storedAccessToken, withTokenStoreLock, saveRefreshTokenLocked } from './qboTokenStore.js';

const exec = promisify(execFile);
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-tokens-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'refresh.json');
  fs.writeFileSync(filename, JSON.stringify({ '1': 'current-1', '2': 'current-2' }));
  return { directory, filename, config: { realmId: '1', clientId: 'app', refreshToken: 'outdated-env', tokenStorePath: filename } };
}

test('concurrent refreshes use the newest token, reuse access tokens, and preserve other companies', async t => {
  const { filename, config } = fixture(t);
  const calls = [];
  const refresh = async (token) => {
    calls.push(token);
    await new Promise(resolve => setTimeout(resolve, 40));
    return { access_token: `access-${token}`, refresh_token: `next-${token}`, expires_in: 3600 };
  };
  const values = await Promise.all([
    storedAccessToken(config, refresh), storedAccessToken(config, refresh),
    storedAccessToken({ ...config, realmId: '2' }, refresh),
  ]);
  assert.deepEqual(values, ['access-current-1', 'access-current-1', 'access-current-2']);
  assert.deepEqual(calls.sort(), ['current-1', 'current-2']);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { '1': 'next-current-1', '2': 'next-current-2' });
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${filename}.access.json`).mode & 0o777, 0o600);
});

test('separate processes share one refresh and do not lose rotated credentials', async t => {
  const { directory, filename, config } = fixture(t);
  const audit = path.join(directory, 'calls');
  const script = `
    const fs=await import('node:fs'),{storedAccessToken}=await import(${JSON.stringify(new URL('./qboTokenStore.js',import.meta.url).href)});
    const config=JSON.parse(process.argv[1]),audit=process.argv[2];
    storedAccessToken(config,async token=>{
      fs.appendFileSync(audit,token+'\\n');
      await new Promise(r=>setTimeout(r,100));
      return {access_token:'shared-access',refresh_token:'shared-next',expires_in:3600};
    }).then(value=>process.stdout.write(value)).catch(e=>{console.error(e.message);process.exitCode=1;});
  `;
  const results = await Promise.all(Array.from({ length: 3 }, () => exec(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(config), audit])));
  assert.ok(results.every(result => result.stdout === 'shared-access'));
  assert.equal(fs.readFileSync(audit, 'utf8'), 'current-1\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { '1': 'shared-next', '2': 'current-2' });
});

test('corrupt credentials stop before contacting Intuit and never fall back to stale env values', async t => {
  const { filename, config } = fixture(t);
  fs.writeFileSync(filename, '{"1":"sensitive-broken-value');
  let called = false;
  await assert.rejects(storedAccessToken(config, async () => { called = true; return {}; }), error => {
    assert.match(String(error), /invalid JSON/);
    assert.doesNotMatch(String(error), /sensitive-broken-value/);
    return true;
  });
  assert.equal(called, false);
  assert.equal(fs.existsSync(`${filename}.lock`), false);
});

test('persistence failures are reported instead of returning a token that was not saved', async t => {
  const { filename, config } = fixture(t);
  const original = fs.renameSync;
  const replacement = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === filename) throw Object.assign(new Error('test write failure'), { code: 'EACCES' });
    return original(from, to);
  });
  await assert.rejects(storedAccessToken(config, async () => ({ access_token: 'access', refresh_token: 'new-secret' })), /Cannot persist QuickBooks tokens/);
  replacement.mock.restore();
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8'))['1'], 'current-1');
  assert.equal(fs.existsSync(`${filename}.access.json`), false);
  assert.equal(fs.existsSync(`${filename}.lock`), false);
});

test('reauthorization invalidates the access cache, and a failed refresh releases its lock', async t => {
  const { filename, config } = fixture(t);
  await assert.rejects(storedAccessToken(config, async () => { throw new Error('Intuit rejected the token'); }), /Intuit rejected/);
  await storedAccessToken(config, async () => ({ access_token: 'old-access', refresh_token: 'old-next' }));
  await withTokenStoreLock(filename, async () => saveRefreshTokenLocked(filename, '1', 'reauthorized'));
  let observed = '';
  const access = await storedAccessToken(config, async token => {
    observed = token;
    return { access_token: 'reauthorized-access', refresh_token: 'reauthorized-next' };
  });
  assert.equal(observed, 'reauthorized');
  assert.equal(access, 'reauthorized-access');
});

test('a live lock is respected; a dead process lock is recovered', async t => {
  const { filename } = fixture(t);
  const lock = `${filename}.lock`;
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ host: os.hostname(), pid: process.pid }));
  await assert.rejects(withTokenStoreLock(filename, async () => 'unexpected', 50), /Timed out waiting/);
  const child = await exec(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ host: os.hostname(), pid: Number(child.stdout) }));
  assert.equal(await withTokenStoreLock(filename, async () => 'recovered', 1000), 'recovered');
  assert.equal(fs.existsSync(lock), false);
});
