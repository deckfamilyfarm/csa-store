// Reads live Square data and saves an image-only Product Sync review. Never publishes.
import fs from 'node:fs/promises';
import { getPool } from '../db.js';
import { createProductSyncAudit, getProductSyncAudit, listProductSyncActions } from '../lib/productSync.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const pool = getPool();
try {
  const requested = process.argv.find(arg => arg.startsWith('--audit-id='));
  const started = requested ? { id: Number(requested.split('=')[1]) } : await createProductSyncAudit({
    platforms: ['square'], vendorGroup: 'all', productScope: 'all', squareImagesOnly: true
  }, { adminRoles: ['square_pull'] });
  let audit, lastProgress = 0;
  do {
    audit = await getProductSyncAudit(started.id);
    if (!audit) throw new Error('Image audit not found.');
    if (Date.now() - lastProgress > 30000) {
      console.log(JSON.stringify({ auditId: audit.id, status: audit.status, products: audit.overview.reduce((n, row) => n + row.productCount, 0) }));
      lastProgress = Date.now();
    }
    if (audit.status === 'running') await new Promise(resolve => setTimeout(resolve, 1000));
  } while (audit.status === 'running');
  const rows = [];
  let page = 1, result;
  do {
    result = await listProductSyncActions(audit.id, { status: 'all', page, pageSize: 100 });
    rows.push(...result.rows); page++;
  } while ((page - 1) * 100 < result.productCount);
  const directory = new URL(`../../../reports/square-product-images-${new Date().toISOString().slice(0, 10)}/`, import.meta.url);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(new URL(`audit-${audit.id}.json`, directory), JSON.stringify({ audit, rows }, null, 2) + '\n');
  const counts = rows.reduce((all, row) => ({ ...all, [row.status]: (all[row.status] || 0) + 1 }), {});
  const photo = (url, label) => /^https?:\/\//.test(url || '') ? `<img loading="lazy" src="${escape(url)}" alt="${escape(label)}">` : '<span>No photo</span>';
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Square product image review</title>
  <style>body{font:16px system-ui;margin:24px;max-width:1100px}article{border:1px solid #ccc;padding:16px;margin:16px 0;break-inside:avoid}.photos{display:flex;gap:24px;flex-wrap:wrap}figure{margin:0}img{width:160px;height:160px;object-fit:contain}small{color:#555}</style>
  <h1>Square product image review</h1><p>Audit #${audit.id} · ${escape(audit.status)} · ${escape(JSON.stringify(counts))}</p>
  <p>Proposed only. Use the saved primary product photo as the POS icon at every location where the matched item is available. This also changes the primary Square Online image. Other photos, prices and location availability are kept.</p>
  ${rows.map(row => `<article><h2>${escape(row.productName)}</h2><small>${escape(row.vendorName)} · Local #${row.productId} · Square ${escape(row.squareItemId || 'unmatched')} · ${escape(row.status)}</small><p>${escape(row.message)}</p>${row.display ? `<div class="photos"><figure><figcaption>Current Square icon</figcaption>${photo(row.display.current.image, 'Current Square icon')}</figure><figure><figcaption>Saved product photo</figcaption>${photo(row.display.proposed.image, 'Proposed Square photo')}</figure></div>` : ''}</article>`).join('')}</html>`;
  const report = new URL(`audit-${audit.id}.html`, directory);
  await fs.writeFile(report, html);
  console.log(JSON.stringify({ auditId: audit.id, status: audit.status, counts, report: report.pathname, error: audit.error }, null, 2));
} finally { await pool.end(); }
