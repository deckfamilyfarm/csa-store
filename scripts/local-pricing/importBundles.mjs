import fs from 'node:fs';
import path from 'node:path';
import { installLocalEnvironment, assertLocalDatabase, installLoopbackNetworkGuard } from './env.mjs';
installLocalEnvironment(); assertLocalDatabase(); installLoopbackNetworkGuard();
const root = process.argv.find(arg => arg.startsWith('--snapshot='))?.slice(11);
if (!root) throw new Error('Provide --snapshot=<reconciliation folder containing remote box snapshots>.');
const read = file => JSON.parse(fs.readFileSync(path.join(root,file)));
const { getPool } = await import('../../apps/api/db.js');
const { importLocalBundles, listBundles } = await import('../../apps/api/lib/enterpriseBundles.js');
const pool = getPool();
try {
  const [[actor]] = await pool.query("SELECT id FROM users WHERE username='local.admin'");
  if (!actor) throw new Error('Local pricing administrator is missing.');
  const manifest = read('remote/manifest.json');
  const snapshot = { boxes: read('remote/localline-boxes.json'), vendors: read('remote/localline-vendors.json'),
    capturedAt: manifest.finishedAt, legacyProductIds: manifest.errors.map(row => row.productId) };
  // The reconciliation report records product_is_box failures. Do not classify
  // other HTTP failures as bundles or invent links from similar product names.
  const exportData = read('remote/localline-export.json');
  for (const id of snapshot.legacyProductIds) {
    const product = exportData.availability.find(p => Number(p['Local Line Product ID']) === Number(id));
    if (!product || !snapshot.boxes.some(b => b.name === product.Product)) throw new Error(`Unresolved export record ${id} is not a captured bundle.`);
  }
  const result = await importLocalBundles(snapshot, { userId: actor.id });
  const current = await listBundles();
  const receipt = { ...result, database: process.env.STORE_DB_DATABASE, at: new Date().toISOString(),
    bundles: current.rows.map(row => ({ id: row.id, remoteBoxId: row.remoteBoxId, name: row.input.name, buyPrice: row.input.buyPrice,
      visible: row.input.visible, componentCount: row.input.components.length, priceCents: row.output.priceCents, blockers: row.output.blockers })) };
  const out = path.join(root,`bundle-import-${Date.now()}.json`);
  fs.writeFileSync(out,JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({receipt:out,...receipt},null,2));
} finally { await pool.end(); }
