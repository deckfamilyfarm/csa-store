import crypto from 'node:crypto';
import sharp from 'sharp';
import { getDb, getPool } from '../db.js';
import { getLocalProductImageSources } from '../localLine.js';
import { batchRetrieveSquareObjects, fetchSquare, getSquareConfig, upsertReturnedSquareObjects } from './squareStoreSync.js';
import { fingerprint, same } from './productSyncCore.js';
import { parseJson, withSyncLock } from './productSyncSchema.js';
import { enterpriseRevisionMarker } from './enterprisePricingService.js';

const hold = message => Object.assign(new Error(message), { hold: true });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const target = () => fingerprint(getSquareConfig());
const imageIds = item => item?.item_data?.image_ids || [];
export const squareImageProjection = item => item ? { id: item.id, deleted: Boolean(item.is_deleted), imageIds: imageIds(item) } : null;
export function squarePrimaryImageIds(primaryId, existing) {
  return [primaryId, ...existing.filter(id => id !== primaryId)];
}
export function squareImageUpdateObject(item, primaryId) {
  if (item?.type !== 'ITEM' || item.is_deleted || !item.version || !item.item_data) throw hold('The Square item is missing, deleted, or has no version. Review its match.');
  const next = structuredClone(item);
  next.item_data.image_ids = squarePrimaryImageIds(primaryId, imageIds(item));
  return next;
}

// The bytes, upload key, and receipt survive cancelled reviews and lost responses.
// Shared photos upload once and can be attached to any number of Square items.
export async function freezeSquareImage(sourceUrl) {
  const url = new URL(sourceUrl);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('The saved product photo needs an HTTP or HTTPS URL.');
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Unable to download the saved product photo.');
  const limit = 15 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('The saved photo exceeds 15 MB.'); }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('The saved photo exceeds 15 MB.');
    chunks.push(chunk);
  }
  const original = Buffer.concat(chunks);
  // Convert WebP and other saved formats to a supported format, preserving the
  // complete photo. Freeze the encoded bytes rather than encoding again on retry.
  const bytes = await sharp(original, { limitInputPixels: 40000000, failOn: 'error' }).rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  const sourceHash = digest(original);
  const contentHash = digest(bytes);
  const targetHash = target();
  const assetId = fingerprint({ targetHash, contentHash });
  await getPool().query(`INSERT IGNORE INTO square_sync_images (id,content_sha256,image_bytes,request_key,created_at)
    VALUES (?,?,?,?,UTC_TIMESTAMP())`, [assetId, contentHash, bytes, crypto.randomUUID()]);
  return { sourceUrl, sourceHash, assetId, targetHash };
}
async function assetReceipt(assetId) {
  const [[row]] = await getPool().query('SELECT result_json FROM square_sync_images WHERE id=?', [assetId]);
  return parseJson(row?.result_json);
}
async function productInputs(productId) {
  const [[product]] = await getPool().query(`SELECT p.id,p.name,p.vendor_id AS vendorId,v.name AS vendorName,
    p.is_deleted AS isDeleted,c.name AS categoryName FROM products p
    LEFT JOIN vendors v ON v.id=p.vendor_id LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=?`, [productId]);
  if (!product || product.isDeleted || product.categoryName?.trim().toLowerCase() === 'membership') throw hold('This product is no longer eligible for Square image publication.');
  if (!product.vendorId || !product.vendorName?.trim()) throw hold('Choose a valid named vendor before publishing.');
  const [sourceUrl] = await getLocalProductImageSources(getDb(), productId);
  return { productId: Number(product.id), productName: product.name, vendorId: Number(product.vendorId), vendorName: product.vendorName, sourceUrl: sourceUrl || null };
}
async function itemMapping(itemId) {
  // Include owners outside the audit scope: an image on a shared Square parent
  // changes every variation, so conflicting product ownership must be reviewed.
  const [rows] = await getPool().query(`SELECT l.id,l.product_id AS productId,l.package_id AS packageId,
    l.square_item_id AS squareItemId,l.square_variation_id AS squareVariationId,
    DATE_FORMAT(l.approved_at,'%Y-%m-%d %H:%i:%s') AS approvedAt,pkg.product_id AS packageProductId
    FROM square_variation_links l LEFT JOIN packages pkg ON pkg.id=l.package_id
    WHERE l.square_item_id=? ORDER BY l.id`, [itemId]);
  return rows.map(row => ({ ...row, id: Number(row.id), productId: Number(row.productId), packageId: Number(row.packageId), packageProductId: Number(row.packageProductId) }));
}
function verifyMapping(productId, mapping, item) {
  if (!mapping.length || mapping.some(row => !row.approvedAt || row.productId !== productId || row.packageProductId !== productId)) throw hold('This Square item has missing, unapproved or conflicting local product links. Review its matches first.');
  if (item?.type !== 'ITEM' || item.is_deleted || !item.version) throw hold('The matched Square item is missing or deleted.');
  for (const row of mapping) {
    const variation = item.item_data?.variations?.find(v => v.id === row.squareVariationId);
    if (!variation || variation.is_deleted || variation.item_variation_data?.item_id !== item.id) throw hold('A matched Square variation is missing or belongs to another item. Review its match.');
  }
}
function desiredProjection(action, receipt) {
  return { ...action.remoteBefore, imageIds: receipt
    ? squarePrimaryImageIds(receipt.id, action.remoteBefore.imageIds)
    : { savedPhoto: action.payload.assetId } };
}

export async function prepareSquareImageActions(products, onAction, { enterpriseRevision = null, staged = {}, includeMissing = true } = {}) {
  const frozenSources = new Map();
  async function prepareProduct(product) {
    const base = { direction: 'outgoing', platform: 'square', kind: 'image', productId: Number(product.id), productName: product.name, vendorName: product.vendorName, staged: staged[product.id] || {},
      ...(enterpriseRevision ? { enterpriseRevisionId: enterpriseRevision.id } : {}) };
    try {
      const local = await productInputs(base.productId);
      if (enterpriseRevision) local.enterpriseRevisionId = enterpriseRevision.id;
      if (!local.sourceUrl) { if (includeMissing) await onAction({ ...base, status: 'review', message: 'No saved product photo. The existing Square icon will be kept.' }); return; }
      const [links] = await getPool().query('SELECT DISTINCT square_item_id AS id FROM square_variation_links WHERE product_id=? ORDER BY square_item_id', [base.productId]);
      if (!links.length) { await onAction({ ...base, status: 'blocked', message: 'Approve a Square item match before publishing its photo.' }); return; }
      if (!frozenSources.has(local.sourceUrl)) frozenSources.set(local.sourceUrl, freezeSquareImage(local.sourceUrl));
      const payload = await frozenSources.get(local.sourceUrl);
      const objects = await batchRetrieveSquareObjects(links.map(row => row.id));
      for (const link of links) {
        try {
          const item = objects.find(row => row.id === link.id);
          const mapping = await itemMapping(link.id);
          verifyMapping(base.productId, mapping, item);
          const receipt = await assetReceipt(payload.assetId);
          const currentImage = imageIds(item)[0];
          const images = currentImage ? await batchRetrieveSquareObjects([currentImage]) : [];
          const action = { ...base, localBefore: local, localAfter: local, mapping, payload,
            squareItemId: item.id, remoteBefore: squareImageProjection(item) };
          action.desired = desiredProjection(action, receipt);
          const synced = same(action.remoteBefore, action.desired);
          await onAction({ ...action, status: synced ? 'synced' : 'changed',
            message: 'Use the saved primary photo at every location where this Square item is available. Other Square photos are kept. This also updates its primary Square Online image.',
            display: { current: { image: images[0]?.image_data?.url || null }, proposed: { image: local.sourceUrl } } });
        } catch (error) { await onAction({ ...base, squareItemId: link.id, status: 'blocked', message: error.message }); }
      }
    } catch (error) { await onAction({ ...base, status: 'blocked', message: error.message }); }
  }
  // Bound downloads and provider reads while keeping large catalog checks usable.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, products.length) }, async () => {
    while (next < products.length) await prepareProduct(products[next++]);
  }));
}

export async function inspectSquareImage(action) {
  if (target() !== action.payload.targetHash) throw hold('Square account configuration changed. Check and review images again.');
  const local = await productInputs(action.productId);
  if (action.enterpriseRevisionId) local.enterpriseRevisionId = await enterpriseRevisionMarker(action.productId, action.enterpriseRevisionId);
  const mapping = await itemMapping(action.squareItemId);
  const objects = await batchRetrieveSquareObjects([action.squareItemId]);
  const item = objects.find(row => row.id === action.squareItemId);
  verifyMapping(action.productId, mapping, item);
  const receipt = await assetReceipt(action.payload.assetId);
  if (receipt) {
    const [image] = (await batchRetrieveSquareObjects([receipt.id])).filter(row => row.id === receipt.id);
    if (image?.type !== 'IMAGE' || image.is_deleted) throw hold('The previously uploaded Square photo is missing or deleted. Review its image receipt before retrying.');
  }
  // After a versioned attachment request is sent, its frozen bytes and receipt
  // are enough to recover even if the source host is temporarily unavailable.
  if (!action.checkpoint?.imageRequest && same(local, action.localBefore)) {
    const fresh = await freezeSquareImage(local.sourceUrl);
    if (fresh.sourceHash !== action.payload.sourceHash) throw hold('The saved photo content changed. Check images and approve again.');
  }
  return { local, mapping, remote: squareImageProjection(item), desired: desiredProjection(action, receipt), object: item };
}
async function uploadFrozenImage(assetId) {
  return withSyncLock(`square-image:${assetId.slice(0, 48)}`, async connection => {
    const [[row]] = await connection.query('SELECT * FROM square_sync_images WHERE id=?', [assetId]);
    if (!row) throw hold('The approved photo bytes are missing. Check images again.');
    const saved = parseJson(row.result_json);
    if (saved) return saved;
    const form = new FormData();
    form.append('request', JSON.stringify({ idempotency_key: row.request_key,
      image: { type: 'IMAGE', id: '#photo', image_data: { name: `CSA photo ${row.content_sha256}` } } }));
    form.append('file', new Blob([row.image_bytes], { type: 'image/jpeg' }), 'product.jpg');
    const result = await fetchSquare('/v2/catalog/images', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    if (!result.image?.id || result.image.type !== 'IMAGE' || result.image.is_deleted) throw new Error('Square did not confirm the image upload. Retry will use the same upload key.');
    await connection.query('UPDATE square_sync_images SET result_json=? WHERE id=?', [JSON.stringify(result.image), assetId]);
    return result.image;
  });
}
export async function executeSquareImage(action, current, saveCheckpoint) {
  const receipt = await uploadFrozenImage(action.payload.assetId);
  const checkpoint = action.checkpoint || {};
  if (!checkpoint.imageRequest) {
    checkpoint.imageRequest = squareImageUpdateObject(current.object, receipt.id);
    checkpoint.imageKey = crypto.randomUUID();
    await saveCheckpoint(checkpoint);
  }
  try {
    const result = await fetchSquare('/v2/catalog/object', { method: 'POST',
      body: JSON.stringify({ idempotency_key: checkpoint.imageKey, object: checkpoint.imageRequest }), signal: AbortSignal.timeout(60000) });
    if (result.catalog_object) await upsertReturnedSquareObjects(getPool(), [result.catalog_object], new Date());
  } catch (error) {
    if (error.remoteRejected) {
      delete checkpoint.imageRequest;
      delete checkpoint.imageKey;
      await saveCheckpoint(checkpoint);
    }
    throw error;
  }
}
