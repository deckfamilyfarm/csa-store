import { test } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import sharp from 'sharp';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import * as schema from '../schema.js';

const socket = process.env.PRODUCT_SYNC_TEST_SOCKET;
test('Square image review, shared locations, drift and durable recovery', { skip: !socket }, async t => {
  assert.match(socket, /^\/(?:private\/)?tmp\/csa-product-sync-/);
  const database = `csa_images_test_${process.pid}_${Date.now()}`;
  const root = await mysql.createConnection({ socketPath: socket, user: 'root' });
  await root.query(`CREATE DATABASE \`${database}\``);
  await root.end();
  Object.assign(process.env, { STORE_DB_HOST: '127.0.0.1', STORE_DB_PORT: '1', STORE_DB_DATABASE: database,
    STORE_DB_USER: 'root', STORE_DB_PASSWORD: '', SQUARE_BASE_URL: 'https://square.test',
    SQUARE_ACCESS_TOKEN: 'test', SQUARE_LOCATION_ID: 'configured-location' });
  const { getPool } = await import('../db.js');
  const pool = getPool();
  pool.pool.config.connectionConfig.socketPath = socket;
  t.after(() => pool.end());
  for (const table of [schema.products, schema.packages, schema.vendors, schema.categories, schema.productPricingProfiles,
    schema.productSales, schema.productTags, schema.productImages, schema.productMedia, schema.localLineProductMeta,
    schema.localLinePackageMeta, schema.users]) {
    const config = getTableConfig(table);
    const columns = config.columns.map(col => `\`${col.name}\` ${col.getSQLType()}${col.notNull ? ' NOT NULL' : ''}${col.autoIncrement ? ' AUTO_INCREMENT' : ''}${col.primary ? ' PRIMARY KEY' : ''}${col.default !== undefined && (typeof col.default !== 'object' || col.default === null) ? ` DEFAULT ${pool.escape(col.default)}` : ''}`);
    for (const index of config.indexes.filter(i => i.config.unique)) columns.push(`UNIQUE KEY \`${index.config.name}\` (${index.config.columns.map(col => `\`${col.name}\``).join(',')})`);
    await pool.query(`CREATE TABLE \`${config.name}\` (${columns.join(',')}) ENGINE=InnoDB`);
  }
  await pool.query("INSERT INTO categories (id,name) VALUES (1,'Meat')");
  await pool.query("INSERT INTO vendors (id,name) VALUES (1,'Deck Family Farm'),(2,'Other Farm')");
  const { ensureProductSyncSchema } = await import('./productSyncSchema.js');
  await ensureProductSyncSchema();
  // Enterprise products must be allowed to publish photos without publishing prices.
  const { ensureEnterprisePricingSchema } = await import('./enterprisePricingSchema.js');
  await ensureEnterprisePricingSchema();
  const service = await import('./productSync.js');
  const objects = new Map(), photos = new Map(), uploads = [], writes = [], uploadResults = new Map();
  let loseUpload = false, loseAttach = false, rejectAttach = false;
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const parsed = new URL(url);
    assert.ok(['square.test', 'photos.test'].includes(parsed.hostname), `Unexpected provider: ${url}`);
    if (parsed.hostname === 'photos.test') return new Response(photos.get(parsed.pathname), { headers: { 'content-type': 'image/png' } });
    if (parsed.pathname === '/v2/catalog/images') {
      assert.ok(options.body instanceof FormData);
      assert.equal(options.headers['Content-Type'], undefined, 'fetch supplies the multipart boundary');
      const request = JSON.parse(options.body.get('request'));
      assert.equal(request.object_id, undefined, 'upload does not attach before item preflight');
      const bytes = Buffer.from(await options.body.get('file').arrayBuffer());
      assert.equal((await sharp(bytes).metadata()).format, 'jpeg');
      uploads.push({ request, bytes });
      if (!uploadResults.has(request.idempotency_key)) {
        const image = { type: 'IMAGE', id: `PHOTO${uploadResults.size + 1}`, image_data: { url: 'https://photos.test/square.jpg' } };
        uploadResults.set(request.idempotency_key, image); objects.set(image.id, image);
      }
      if (loseUpload) { loseUpload = false; throw new Error('Lost upload response'); }
      return json({ image: uploadResults.get(request.idempotency_key) });
    }
    const body = options.body ? JSON.parse(options.body) : null;
    if (parsed.pathname === '/v2/catalog/list') return json({ objects: [...objects.values()].filter(o => o.type === parsed.searchParams.get('types')) });
    if (parsed.pathname === '/v2/catalog/batch-retrieve') return json({ objects: body.object_ids.map(id => objects.get(id)).filter(Boolean) });
    if (parsed.pathname === '/v2/catalog/batch-upsert') {
      for (const object of body.batches[0].objects) {
        objects.set(object.id, { ...structuredClone(object), version: object.version + 1 });
        const parent = objects.get(object.item_variation_data?.item_id);
        if (parent) { parent.version++; parent.item_data.variations = parent.item_data.variations.map(v => v.id === object.id ? objects.get(object.id) : v); }
      }
      return json({ objects: body.batches[0].objects.map(o => objects.get(o.id)) });
    }
    if (parsed.pathname === '/v2/catalog/object') {
      writes.push(body);
      if (rejectAttach) { rejectAttach = false; return json({ errors: [{ code: 'VERSION_MISMATCH' }] }, 409); }
      assert.equal(body.object.version, objects.get(body.object.id).version);
      const item = structuredClone(body.object); item.version++;
      objects.set(item.id, item);
      if (loseAttach) { loseAttach = false; throw new Error('Lost attachment response'); }
      return json({ catalog_object: item });
    }
    throw new Error(`Unexpected path: ${parsed.pathname}`);
  });
  async function product(id, { photo = true, vendor = 1, linked = true, sharedPhoto = false } = {}) {
    await pool.query('INSERT INTO products (id,name,vendor_id,category_id,visible,is_deleted) VALUES (?,?,?,1,1,0)', [id, `Product ${id}`, vendor]);
    await pool.query("INSERT INTO packages (id,product_id,name,price,unit,num_of_items) VALUES (?,?,'each',11,'ea',1)", [id * 10, id]);
    await pool.query("INSERT INTO product_pricing_profiles (product_id,source_unit_price,unit_of_measure) VALUES (?,11,'each')", [id]);
    if (photo) {
      const path = sharedPhoto ? '/1.png' : `/${id}.png`;
      if (!photos.has(path)) photos.set(path, await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: id * 15, g: 10, b: 20 } } }).png().toBuffer());
      await pool.query('INSERT INTO product_images (product_id,url,url_hash) VALUES (?,?,SHA2(?,256))', [id, `https://photos.test${path}`, `https://photos.test${path}`]);
    }
    if (!linked) return;
    const variation = { type: 'ITEM_VARIATION', id: `V${id}`, version: 1, present_at_all_locations: false,
      present_at_location_ids: ['market-one', 'market-two'], item_variation_data: { item_id: `I${id}`, name: 'each',
        sku: `SKU${id}`, price_money: { amount: 1700, currency: 'USD' }, pricing_type: 'FIXED_PRICING', track_inventory: true } };
    const item = { type: 'ITEM', id: `I${id}`, version: 1, present_at_all_locations: false, present_at_location_ids: ['market-one', 'market-two'],
      item_data: { name: `Product ${id}`, image_ids: ['OLD', 'SECOND'], variations: [variation], tax_ids: ['TAX'], ecom_visibility: 'VISIBLE' } };
    objects.set(item.id, item); objects.set(variation.id, variation);
    objects.set('OLD', { type: 'IMAGE', id: 'OLD', image_data: { url: 'https://photos.test/old.jpg' } });
    await pool.query('INSERT INTO square_variation_links (product_id,package_id,square_item_id,square_variation_id,approved_at) VALUES (?,?,?,?,UTC_TIMESTAMP())', [id, id * 10, item.id, variation.id]);
  }
  const user = { userId: 1, adminRoles: ['admin'] };
  async function audit(ids, options = {}) {
    const started = await service.createProductSyncAudit({ platforms: ['square'], productIds: ids, vendorGroup: 'all', squareImagesOnly: true, ...options }, user);
    let result;
    for (let i = 0; i < 400; i++) {
      result = await service.getProductSyncAudit(started.id);
      if (result.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(result.status, 'completed', JSON.stringify(result));
    return { audit: result, rows: (await service.listProductSyncActions(result.id, { status: 'all' })).rows };
  }
  async function approve(check, selectedUser = user) {
    return service.createProductSyncRelease({ auditId: check.audit.id, actionIds: check.rows.filter(r => r.status === 'changed').map(r => r.id), localWorkerOnly: true }, selectedUser);
  }
  const run = release => service.runProductSyncRelease(release.id, { user, allowFuture: true });
  await product(1); await product(2, { photo: false }); await product(3, { vendor: 2, sharedPhoto: true }); await product(4, { linked: false });
  await pool.query('INSERT INTO enterprise_pricing_product_state (product_id,active_revision_id,updated_at) VALUES (1,1,UTC_TIMESTAMP())');
  await pool.query("INSERT INTO packages (id,product_id,name,price,unit,num_of_items) VALUES (101,1,'Half',8,'ea',1)");
  const secondVariation = structuredClone(objects.get('V1'));
  secondVariation.id = 'V1-HALF'; secondVariation.item_variation_data.name = 'Half';
  objects.get('I1').item_data.variations.push(secondVariation); objects.set(secondVariation.id, secondVariation);
  await pool.query("INSERT INTO square_variation_links (product_id,package_id,square_item_id,square_variation_id,approved_at) VALUES (1,101,'I1','V1-HALF',UTC_TIMESTAMP())");
  const first = await audit([1, 2, 3, 4]);
  assert.equal(first.rows.filter(row => row.status === 'changed').length, 2);
  assert.equal(first.rows.find(row => row.productId === 2).status, 'review');
  assert.equal(first.rows.find(row => row.productId === 4).status, 'blocked');
  assert.equal(uploads.length + writes.length, 0, 'audit never publishes');
  await assert.rejects(approve(first, { adminRoles: ['square_pull'] }), /Push permission/);
  await assert.rejects(service.createProductSyncAudit({ platforms: ['square'], squareImagesOnly: true, staged: [{ productId: 1, changes: { visible: 0 } }] }, user), /separately/);
  const before = structuredClone(objects.get('I1'));
  const approved = await approve(first);
  assert.match((await service.getProductSyncRelease(approved.id)).scheduledAt, /^9999-01-01/, 'an older deployed scheduler cannot claim a laptop-owned image release');
  let done = await run(approved);
  assert.equal(done.status, 'completed', JSON.stringify(done.actions));
  assert.equal(uploads.length, 1, 'same saved photo is uploaded once across products');
  assert.equal(writes.length, 2);
  const after = objects.get('I1');
  assert.deepEqual(after.item_data.image_ids, ['PHOTO1', 'OLD', 'SECOND']);
  const { image_ids: _, ...afterData } = after.item_data;
  const { image_ids: __, ...beforeData } = before.item_data;
  assert.deepEqual(afterData, beforeData, 'prices, inventory, taxes, online visibility and all variation fields are preserved');
  assert.deepEqual(after.present_at_location_ids, before.present_at_location_ids, 'configured location cannot restrict photos or change item availability');
  assert.equal((await audit([1])).rows[0].status, 'synced');

  await product(5);
  const retryCheck = await audit([5]); const retryRelease = await approve(retryCheck);
  loseUpload = true;
  done = await run(retryRelease); assert.equal(done.status, 'failed');
  const failedUpload = uploads.at(-1);
  done = await run(retryRelease); assert.equal(done.status, 'completed', JSON.stringify(done.actions));
  assert.deepEqual(uploads.at(-1), failedUpload, 'unknown upload reuses its exact key, JSON and encoded bytes');

  await product(6);
  const lost = await approve(await audit([6])); loseAttach = true;
  done = await run(lost); assert.equal(done.status, 'failed');
  const count = writes.length;
  done = await run(lost); assert.equal(done.status, 'completed');
  assert.equal(writes.length, count, 'lost attachment response is confirmed without another POST');

  await product(7);
  const drift = await approve(await audit([7]));
  photos.set('/7.png', photos.get('/1.png'));
  done = await run(drift); assert.equal(done.status, 'held');
  assert.match(done.actions[0].message, /content changed/);
  assert.equal(writes.length, count);

  await product(8);
  const remoteDrift = await approve(await audit([8])); objects.get('I8').item_data.image_ids = ['SOMEONE-ELSE'];
  done = await run(remoteDrift); assert.equal(done.status, 'held');
  assert.equal(writes.length, count);

  await product(9);
  const definitive = await approve(await audit([9])); rejectAttach = true;
  done = await run(definitive); assert.equal(done.status, 'failed');
  objects.get('I9').version++; objects.get('I9').item_data.description = 'New remote description';
  done = await run(definitive); assert.equal(done.status, 'completed');
  assert.equal(objects.get('I9').item_data.description, 'New remote description');

  await pool.query("UPDATE square_variation_links SET square_item_id='I1',square_variation_id='OTHER' WHERE product_id=3");
  assert.match((await audit([1])).rows[0].message, /conflicting/);
  await product(10, { sharedPhoto: true });
  const deletedImage = await approve(await audit([10]));
  objects.get('PHOTO1').is_deleted = true;
  done = await run(deletedImage); assert.equal(done.status, 'held');
  assert.match(done.actions[0].message, /photo is missing or deleted/);
  objects.get('PHOTO1').is_deleted = false;

  await product(11, { vendor: 2 });
  const pricesOnly = await audit([11], { squareImagesOnly: false });
  assert.deepEqual(pricesOnly.rows.map(row => row.kind), ['price'], 'older price-only callers keep their reviewed scope');
  const combined = await audit([11], { squareImagesOnly: false, includeSquareImages: true });
  assert.deepEqual(combined.rows.map(row => row.kind).sort(), ['image', 'price']);
  done = await run(await approve(combined)); assert.equal(done.status, 'completed', JSON.stringify(done.actions));
  assert.equal(objects.get('I11').item_data.variations[0].item_variation_data.price_money.amount, 1100);
  assert.notEqual(objects.get('I11').item_data.image_ids[0], 'OLD');

  for (const [id, photo] of [[12, true], [13, false]]) {
    await product(id, { photo });
    const input = { squareEnabled: true, pricingUnit: 'each', packages: [{ packageId: id * 10 }] };
    const output = { packages: [{ packageId: id * 10, squareVariationCents: 1200 }] };
    const [revision] = await pool.query("INSERT INTO enterprise_pricing_revisions (product_id,settings_version_id,status,input_json,output_json,editor_id,created_at) VALUES (?,1,'approved',?,?,1,UTC_TIMESTAMP())", [id, JSON.stringify(input), JSON.stringify(output)]);
    await pool.query('INSERT INTO enterprise_pricing_product_state (product_id,latest_revision_id,updated_at) VALUES (?,?,UTC_TIMESTAMP())', [id, revision.insertId]);
    const check = await audit([id], { squareImagesOnly: false, includeSquareImages: true, enterpriseRevisionId: revision.insertId, publicationScope: 'enterprise-selected-prices', productEditorSync: true });
    assert.equal(check.rows.filter(row => row.kind === 'image').length, photo ? 1 : 0, 'missing photos leave the current icon without blocking prices');
    assert.ok(check.rows.every(row => row.enterpriseRevisionId === revision.insertId));
    done = await run(await approve(check)); assert.equal(done.status, 'completed', JSON.stringify(done.actions));
    assert.equal(objects.get(`I${id}`).item_data.variations[0].item_variation_data.price_money.amount, 1200);
    assert.equal(objects.get(`I${id}`).item_data.image_ids[0] !== 'OLD', photo);
    assert.ok((await service.getProductSyncReleaseProgress(done.id)).actions.some(a => a.kind === 'price'));
  }
});
