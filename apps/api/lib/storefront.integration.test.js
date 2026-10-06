import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { createStorefrontService } from './storefrontService.js';
import { DEFAULT_HERITAGE_DESCRIPTION, DEFAULT_BROAD_BREASTED_DESCRIPTION } from './storefrontDescriptions.js';

// Never load .env. This suite only accepts a disposable socket under /tmp.
const socket = process.env.STOREFRONT_TEST_SOCKET;
test('turkey checkout, inventory, fulfillment and refunds on isolated MySQL', { skip: !socket }, async t => {
  assert.match(socket, /^\/(?:private\/)?tmp\/csa-storefront-test[^/]*\//);
  const database = `storefront_test_${process.pid}_${Date.now()}`;
  const root = await mysql.createConnection({ socketPath: socket, user: 'root' });
  await root.query(`CREATE DATABASE \`${database}\``);
  const pool = mysql.createPool({ socketPath: socket, user: 'root', database, connectionLimit: 12 });
  t.after(async () => { await pool.end(); await root.query(`DROP DATABASE \`${database}\``); await root.end(); });
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const sessions = new Map(), checkoutKeys = new Map(), refunds = new Map(), refundKeys = new Map(), sent = [];
  let loseCheckoutResponse = false, expireDuringPayment = false, refundPending = false, loseRefundResponse = false, mailFails = false;
  const stripe = {
    checkout: { sessions: {
      create: async (payload, { idempotencyKey }) => {
        let session = checkoutKeys.get(idempotencyKey);
        if (!session) {
          session = { id: `cs_${sessions.size+1}`, url: `https://checkout.stripe.test/${sessions.size+1}`, status: 'open', payment_status: 'unpaid',
            expires_at: payload.expires_at, metadata: payload.metadata, amount_total: payload.line_items.reduce((sum, i) => sum + i.quantity * i.price_data.unit_amount, 0), currency: 'usd' };
          checkoutKeys.set(idempotencyKey, session); sessions.set(session.id, session);
        }
        if (loseCheckoutResponse) { loseCheckoutResponse = false; throw new Error('Simulated lost Stripe response'); }
        return structuredClone(session);
      },
      retrieve: async id => structuredClone(sessions.get(id)),
      expire: async id => {
        const session = sessions.get(id);
        if (expireDuringPayment) { expireDuringPayment = false; Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: `pi_${id}` }); throw new Error('Payment completed before expiry'); }
        session.status = 'expired'; return structuredClone(session);
      }
    } },
    refunds: {
      list: async ({ payment_intent }) => ({ data: [...refunds.values()].filter(r => r.payment_intent === payment_intent).map(r => structuredClone(r)), has_more: false }),
      create: async (payload, { idempotencyKey }) => {
        let refund = refundKeys.get(idempotencyKey);
        if (!refund) {
          refund = { ...payload, id: `re_${refunds.size+1}`, status: refundPending ? 'pending' : 'succeeded' };
          refunds.set(refund.id, refund); refundKeys.set(idempotencyKey, refund);
        }
        if (loseRefundResponse) { loseRefundResponse = false; throw new Error('Lost refund response'); }
        return structuredClone(refund);
      }
    }
  };
  const service = createStorefrontService({ pool, stripe, now: () => clock,
    config: { enabled: true, webhookSecret: 'test-secret', emailReady: true, baseUrl: 'http://localhost:5176' },
    sendEmail: async data => { if (mailFails) throw new Error('SMTP unavailable'); sent.push(data); }
  });
  const body = (optionId, quantity = 1, pickupId = 1) => ({ token: crypto.randomBytes(32).toString('hex'), pickupId,
    customer: { name: 'Turkey Buyer', email: `buyer-${crypto.randomBytes(3).toString('hex')}@example.com`, phone: '5415550100', addressLine1: '123 Main St', city: 'Eugene', state: 'OR', postalCode: '97401' },
    items: [{ optionId, quantity }], totalCents: 1
  });
  const stock = async id => (await service.catalog(true)).options.find(o => o.id === id);
  const setupPayload = catalog => ({ ...catalog.sale, options: catalog.options, pickups: catalog.pickups, pickupGroups: catalog.pickupGroups });
  const pay = async result => {
    const [[row]] = await pool.query('SELECT stripe_session_id FROM storefront_orders WHERE id=?', [result.orderId]);
    const session = sessions.get(row.stripe_session_id);
    Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: `pi_${session.id}` });
    await service.webhook({ id: `evt_${session.id}`, type: 'checkout.session.completed', data: { object: session } });
    return session;
  };
  let firstId, secondId, firstResult, firstBody;
  await pool.query('CREATE TABLE vendors (id INT PRIMARY KEY, name VARCHAR(255))');
  await pool.query('CREATE TABLE categories (id INT PRIMARY KEY, name VARCHAR(255))');
  await pool.query('CREATE TABLE products (id INT PRIMARY KEY, name VARCHAR(255), description TEXT, thumbnail_url TEXT, vendor_id INT, category_id INT, is_deleted TINYINT DEFAULT 0, inventory INT)');
  await pool.query('CREATE TABLE packages (id INT PRIMARY KEY, product_id INT, name VARCHAR(255), inventory INT, price DECIMAL(10,2), visible TINYINT, num_of_items INT, charge_type VARCHAR(50), unit VARCHAR(50))');
  await pool.query('CREATE TABLE product_pricing_profiles (product_id INT PRIMARY KEY, source_unit_price DECIMAL(10,2), unit_of_measure VARCHAR(16))');
  await pool.query('CREATE TABLE product_images (id INT PRIMARY KEY, product_id INT, url TEXT)');
  await pool.query("INSERT INTO vendors VALUES (1,'Deck Family Farm')");
  await pool.query("INSERT INTO categories VALUES (1,'Thanksgiving Turkeys'),(2,'Membership')");
  await pool.query("INSERT INTO products VALUES (1,'Heritage Turkey, Small','<p>Pasture-raised <strong>small turkey</strong>.</p>','https://example.com/small-thumb.jpg',1,1,0,88),(2,'Broad Breasted White Turkey, Large','<p>Our large turkey.</p>',NULL,1,1,0,88),(3,'Turkey club membership',NULL,NULL,1,2,0,88)");
  await pool.query("INSERT INTO packages VALUES (1,1,'9–12 lbs',77,54.12,1,1,'package','ea'),(2,2,'14–16 lbs',77,81.18,1,1,'package','ea')");
  await pool.query("INSERT INTO product_pricing_profiles VALUES (1,100.00,'each'),(2,150.00,'each')");
  await pool.query("INSERT INTO product_images VALUES (1,1,'https://example.com/small.jpg'),(2,2,'https://example.com/large.jpg')");
  // Exercise the upgrade from the original fixed-location schema as well as fresh tables.
  await pool.query(`CREATE TABLE storefront_sales (
    id INT PRIMARY KEY,title VARCHAR(200) NOT NULL,description TEXT NOT NULL,image_url VARCHAR(2048) NOT NULL DEFAULT '',
    status VARCHAR(16) NOT NULL DEFAULT 'draft',pickup_date VARCHAR(10) NOT NULL,closes_ms BIGINT,
    contact_email VARCHAR(254) NOT NULL DEFAULT '',notify_email VARCHAR(254) NOT NULL DEFAULT '',
    updated_ms BIGINT NOT NULL,version INT NOT NULL DEFAULT 1,updated_by INT)`);
  await pool.query(`CREATE TABLE storefront_pickups (id INT PRIMARY KEY,sale_id INT NOT NULL,name VARCHAR(120) NOT NULL,
    address VARCHAR(500) NOT NULL DEFAULT '',hours VARCHAR(120) NOT NULL DEFAULT '',instructions TEXT NOT NULL)`);
  await pool.query("INSERT INTO storefront_pickups VALUES (1,1,'PSU Farmers Market','Existing address','9 AM','Existing instructions')");
  await pool.query(`CREATE TABLE storefront_options (id INT AUTO_INCREMENT PRIMARY KEY,sale_id INT NOT NULL,label VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,price_cents INT NOT NULL DEFAULT 0,on_hand INT NOT NULL DEFAULT 0,reserved INT NOT NULL DEFAULT 0,active TINYINT DEFAULT 1)`);
  // Exercise saving, stock adjustments, and checkout with offering IDs above quantity limits.
  await pool.query('ALTER TABLE storefront_options AUTO_INCREMENT=1000001');
  await t.test('store visibility defaults hidden, persists separately and rejects stale saves', async () => {
    assert.deepEqual(await service.storeSettings(), { showProducts: false, version: 1 });
    const before = await service.catalog(true);
    await assert.rejects(service.saveStoreSettings({ showProducts: 'false', version: 1 }, 1), /Choose whether/);
    assert.deepEqual(await service.saveStoreSettings({ showProducts: true, version: 1 }, 1), { showProducts: true, version: 2 });
    const otherProcess = createStorefrontService({ pool });
    assert.deepEqual(await otherProcess.storeSettings(), { showProducts: true, version: 2 });
    await assert.rejects(service.saveStoreSettings({ showProducts: false, version: 1 }, 1), error => error.status === 409);
    await otherProcess.saveStoreSettings({ showProducts: false, version: 2 }, 1);
    assert.deepEqual(await service.storeSettings(), { showProducts: false, version: 3 });
    const after = await service.catalog(true);
    assert.deepEqual(after.sale, before.sale);
    assert.deepEqual(after.options, before.options);
  });
  await t.test('draft setup has four seeded pickups and publishing validates configuration', async () => {
    const catalog = await service.catalog(true);
    assert.equal(catalog.sale.status, 'draft'); assert.equal(catalog.sale.pickupDate, '2026-11-21');
    assert.equal(catalog.sale.heritageDescription, DEFAULT_HERITAGE_DESCRIPTION);
    assert.equal(catalog.sale.broadBreastedDescription, DEFAULT_BROAD_BREASTED_DESCRIPTION);
    assert.equal(catalog.pickups.length, 4); assert.equal(catalog.options.length, 0);
    assert.equal(catalog.pickups[0].address, 'Existing address');
    assert.equal(catalog.pickupGroups.length, 1); assert.equal(catalog.pickups[0].groupId, 1);
    assert.deepEqual(catalog.catalogProducts.map(product => product.id).sort(), [1,2]);
    await assert.rejects(service.checkout(body(1)), /closed/);
    const setup = { ...catalog.sale, closesPacific: '2026-11-20T17:00', contactEmail: 'farm@example.com', notifyEmail: 'staff@example.com',
      options: [{ productId: 1, description: 'Small', priceCents: 1, active: true, inventory: { onHand: 1 } }, { productId: 2, description: 'Large', priceCents: 1, active: true, inventory: { onHand: 10 } }],
      pickupGroups: catalog.pickupGroups,
      pickups: catalog.pickups.map(p => ({ ...p, address: `${p.name} address`, hours: '9 AM–1 PM', instructions: 'Find our farm booth.' })) };
    const disabled = createStorefrontService({ pool, stripe, now: () => clock, config: { enabled: false, webhookSecret: '', emailReady: true } });
    await assert.rejects(disabled.saveSetup({ ...setup, status: 'open' }, 1), /Enable checkout/);
    assert.equal((await disabled.catalog(true)).options.length, 0);
    assert.equal((await disabled.catalog()).sale.status, 'draft');
    // Saving as Draft is supported before payment setup, with preview stock intact.
    const draft = await disabled.saveSetup({ ...setup, status: 'draft' }, 1);
    assert.deepEqual(draft.options.map(option => option.onHand), [1,10]);
    assert.equal((await disabled.catalog()).options.length, 0);
    setup.version = draft.sale.version;
    setup.options = draft.options;
    const saved = await service.saveSetup({ ...setup, status: 'open' }, 1);
    assert.deepEqual(saved.options.map(option => option.priceCents), [10000,15000]);
    firstId = saved.options[0].id; secondId = saved.options[1].id;
    assert.deepEqual(saved.options.map(option => option.onHand), [1,10]);
    assert.equal(saved.options[0].description, DEFAULT_HERITAGE_DESCRIPTION);
    const [initialHistory] = await pool.query('SELECT delta_on_hand,actor_id FROM storefront_stock_history ORDER BY id');
    assert.deepEqual(initialHistory.map(row => [row.delta_on_hand, row.actor_id]), [[1,1],[10,1]]);
    await assert.rejects(service.saveSetup({ ...setup, status: 'open' }, 1), /changed/);
  });
  await t.test('two buyers racing for the last bird cannot both reserve it', async () => {
    const bodies = [body(firstId), body(firstId)];
    const results = await Promise.allSettled(bodies.map(value => service.checkout(value)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const index = results.findIndex(r => r.status === 'fulfilled');
    firstBody = bodies[index]; firstResult = results[index].value;
    assert.ok(firstResult.url);
    assert.equal((await stock(firstId)).available, 0); assert.equal((await stock(firstId)).reserved, 1);
    const repeated = await service.checkout(firstBody);
    assert.equal(repeated.orderId, firstResult.orderId); assert.equal(sessions.size, 1);
    const info = await service.guestOrder(firstResult.orderId, firstBody.token);
    assert.equal(info.totalCents, 10000);
    assert.equal(info.items[0].optionId, firstId);
    assert.equal(info.items[0].productId, 1);
    assert.equal(info.items[0].typeLabel, 'Heritage');
    assert.equal(info.items[0].sizeLabel, '9–12 lb');
    const [[snapshot]] = await pool.query('SELECT stripe_request_json FROM storefront_orders WHERE id=?', [firstResult.orderId]);
    const stripeItem = JSON.parse(snapshot.stripe_request_json).line_items[0].price_data.product_data;
    assert.equal(stripeItem.name, 'Thanksgiving Turkey — Heritage, 9–12 lb');
    assert.deepEqual(stripeItem.metadata, {variant_id:String(firstId),catalog_product_id:'1',turkey_type:'Heritage',size_label:'9–12 lb'});
    await assert.rejects(service.guestOrder(firstResult.orderId, crypto.randomBytes(32).toString('hex')), { status: 404 });
    await assert.rejects(service.adjustStock(firstId, { delta: -1, reason: 'Cannot consume reserved stock' }, 1), /Insufficient/);
    await assert.rejects(service.checkout({ ...firstBody, pickupId: 2 }), /different order/);
    await assert.rejects(service.checkout({ ...firstBody, customer: {...firstBody.customer, phone:'bad'} }), error => /phone/.test(error.message) && !error.checkoutRejected);
    const invalidCustomer = body(secondId); invalidCustomer.customer.phone = 'bad';
    await assert.rejects(service.checkout(invalidCustomer), error => /phone/.test(error.message) && error.checkoutRejected === true);
  });
  await t.test('verified payment and duplicate webhooks deduct stock only once', async () => {
    const session = await pay(firstResult);
    await service.webhook({ id: `evt_${session.id}`, type: 'checkout.session.completed', data: { object: session } });
    await service.webhook({ id: 'evt_duplicate_content', type: 'checkout.session.completed', data: { object: session } });
    assert.equal((await service.guestOrder(firstResult.orderId, firstBody.token)).status, 'paid');
    assert.equal((await stock(firstId)).onHand, 0); assert.equal((await stock(firstId)).reserved, 0);
    assert.equal((await stock(firstId)).purchased, 1);
    mailFails = true; await service.deliverEmails(); assert.equal(sent.length, 0);
    assert.equal((await service.emailStatus())[0].attempts, 1);
    mailFails = false; clock += 61000; await service.deliverEmails(); await service.deliverEmails();
    assert.equal(sent.length, 1); assert.equal(sent[0].pickup.name, 'PSU Farmers Market');
  });
  await t.test('pending and repeated refunds return stock only after confirmed success', async () => {
    refundPending = true;
    await service.issueRefund(firstResult.orderId, 1);
    assert.equal((await stock(firstId)).available, 0);
    assert.equal((await service.guestOrder(firstResult.orderId, firstBody.token)).status, 'refund_pending');
    await service.issueRefund(firstResult.orderId, 1); assert.equal(refunds.size, 1);
    const [[request]] = await pool.query('SELECT refund_requested_by,refund_requested_ms FROM storefront_orders WHERE id=?', [firstResult.orderId]);
    assert.equal(request.refund_requested_by, 1); assert.equal(Number(request.refund_requested_ms), clock);
    const refund = [...refunds.values()][0]; refund.status = 'succeeded'; refundPending = false;
    await service.webhook({ id: 'evt_refund_1', type: 'refund.updated', data: { object: refund } });
    await service.issueRefund(firstResult.orderId, 1);
    assert.equal((await stock(firstId)).available, 1); assert.equal((await stock(firstId)).purchased, 0);
  });
  await t.test('abandoned and cancelled checkouts release reservations', async () => {
    const input = body(firstId); const result = await service.checkout(input);
    clock += 32 * 60000; await service.maintain();
    assert.equal((await service.guestOrder(result.orderId, input.token)).status, 'expired');
    assert.equal((await stock(firstId)).available, 1);
    const next = body(firstId); const nextResult = await service.checkout(next);
    await service.cancelReservation(nextResult.orderId, next.token);
    assert.equal((await stock(firstId)).available, 1);
  });
  await t.test('lost checkout responses recover the same Stripe session without double reservation', async () => {
    const input = body(firstId); loseCheckoutResponse = true;
    const result = await service.checkout(input);
    assert.equal(result.status, 'processing'); assert.equal((await stock(firstId)).reserved, 1);
    const count = sessions.size;
    const retry = await service.checkout(input);
    assert.equal(retry.orderId, result.orderId); assert.equal(sessions.size, count);
    assert.equal((await stock(firstId)).reserved, 1);
    expireDuringPayment = true;
    await service.cancelReservation(result.orderId, input.token);
    assert.equal((await service.guestOrder(result.orderId, input.token)).status, 'paid');
    assert.equal((await stock(firstId)).onHand, 0);
    loseRefundResponse = true;
    await assert.rejects(service.issueRefund(result.orderId, 1), /Lost refund/);
    const refundCount = refunds.size; await service.maintain();
    assert.equal(refunds.size, refundCount); assert.equal((await stock(firstId)).available, 1);
  });
  await t.test('mixed sizes, frozen order details, collection and partial external refunds', async () => {
    const input = body(firstId, 1, 4); input.items.push({ optionId: secondId, quantity: 2 });
    const result = await service.checkout(input); const session = await pay(result);
    assert.equal((await service.guestOrder(result.orderId, input.token)).totalCents, 40000);
    await pool.query("UPDATE storefront_pickups SET address='New address' WHERE id=4");
    await pool.query("UPDATE product_pricing_profiles SET source_unit_price=160 WHERE product_id=2");
    const info = await service.guestOrder(result.orderId, input.token);
    assert.equal(info.pickup.address, 'Farm Pickup address'); assert.equal(info.items[1].priceCents, 15000);
    await service.collect(result.orderId, 1); await service.collect(result.orderId, 1);
    await assert.rejects(service.issueRefund(result.orderId, 1), /Collected/);
    refunds.set('re_external_collected', { id: 're_external_collected', status: 'succeeded', amount: 40000, payment_intent: session.payment_intent });
    await service.reconcile(result.orderId);
    assert.equal((await stock(firstId)).available, 0); assert.equal((await stock(secondId)).available, 8);
    const partialInput = body(secondId); const partialResult = await service.checkout(partialInput); const partialSession = await pay(partialResult);
    refunds.set('re_external_partial', { id: 're_external_partial', status: 'succeeded', amount: 1000, payment_intent: partialSession.payment_intent });
    await service.reconcile(partialResult.orderId);
    assert.equal((await stock(secondId)).available, 7);
    await assert.rejects(service.issueRefund(partialResult.orderId, 1), /partial refund/);
    await assert.rejects(service.collect(partialResult.orderId, 1), /without a refund/);
  });
  await t.test('pending external refunds block collection and additional refunds', async () => {
    const input = body(secondId); const result = await service.checkout(input); const session = await pay(result);
    const refund = { id: 're_external_pending', status: 'pending', amount: 16000, payment_intent: session.payment_intent };
    refunds.set(refund.id, refund);
    const before = (await stock(secondId)).available;
    await service.reconcile(result.orderId);
    assert.equal((await service.guestOrder(result.orderId, input.token)).refundStatus, 'pending_external');
    await assert.rejects(service.issueRefund(result.orderId, 1), /already pending/);
    await assert.rejects(service.collect(result.orderId, 1), /without a refund/);
    refund.status = 'succeeded'; await service.reconcile(result.orderId);
    assert.equal((await stock(secondId)).available, before + 1);
  });
  await t.test('mismatched payment totals are held and require reconciliation', async () => {
    const input = body(secondId); const result = await service.checkout(input);
    const [[row]] = await pool.query('SELECT stripe_session_id FROM storefront_orders WHERE id=?', [result.orderId]);
    const session = sessions.get(row.stripe_session_id);
    Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: `pi_${session.id}`, amount_total: 1 });
    await assert.rejects(service.reconcile(result.orderId), /does not match/);
    assert.equal((await service.guestOrder(result.orderId, input.token)).status, 'reserved');
    session.amount_total = 16000; await service.reconcile(result.orderId);
  });
  await t.test('order locks work with a one-connection pool without starving transactions', { timeout: 5000 }, async () => {
    const smallPool = mysql.createPool({ socketPath: socket, user: 'root', database, connectionLimit: 1 });
    try {
      const limited = createStorefrontService({ pool: smallPool, stripe, now: () => clock,
        config: { enabled: true, webhookSecret: 'test-secret', emailReady: true } });
      const input = body(secondId); const result = await limited.checkout(input);
      await limited.cancelReservation(result.orderId, input.token);
      assert.equal((await limited.guestOrder(result.orderId, input.token)).status, 'expired');
    } finally { await smallPool.end(); }
  });
  await t.test('uncertain old checkouts never recreate a session and accept only a verified receipt', async () => {
    const input = body(secondId); loseCheckoutResponse = true;
    const result = await service.checkout(input);
    const count = sessions.size;
    await pool.query('UPDATE storefront_orders SET created_ms=? WHERE id=?', [clock - 24 * 3600000, result.orderId]);
    await service.reconcile(result.orderId);
    assert.equal(sessions.size, count);
    assert.equal((await service.guestOrder(result.orderId, input.token)).status, 'review');
    const ownSession = checkoutKeys.get(`storefront-checkout-${result.orderId}`);
    await assert.rejects(service.attachSession(result.orderId, 'cs_1'), /does not belong/);
    ownSession.status = 'expired';
    await service.attachSession(result.orderId, ownSession.id);
    assert.equal((await service.guestOrder(result.orderId, input.token)).status, 'expired');
  });
  await t.test('catalog identity and photos stay live while paid order labels remain frozen', async () => {
    const catalog = await service.catalog(true);
    assert.equal(catalog.options[0].productId, 1);
    assert.equal(catalog.options[0].imageUrl, 'https://example.com/small.jpg');
    assert.equal(catalog.catalogProducts.find(product => product.id === 1).sizeDescription, '9–12 lbs');
    assert.equal(catalog.catalogProducts.find(product => product.id === 1).wholeTurkey, true);
    const invalid = setupPayload(catalog);
    invalid.options = [{ ...invalid.options[0], productId: 3 }, invalid.options[1]];
    await assert.rejects(service.saveSetup(invalid, 1), /existing turkey/);
    await assert.rejects(service.saveSetup({ ...setupPayload(catalog), options: [...catalog.options, { ...catalog.options[0], id: undefined }] }, 1), /once per sale/);
    await pool.query("UPDATE products SET name='Small heritage turkey' WHERE id=1");
    await pool.query("UPDATE product_images SET url='https://example.com/new-photo.jpg' WHERE id=1");
    const updated = await service.catalog();
    assert.equal(updated.options.find(option => option.productId === 1).label, 'Small heritage turkey');
    assert.equal(updated.options.find(option => option.productId === 1).imageUrl, 'https://example.com/new-photo.jpg');
    assert.equal((await service.guestOrder(firstResult.orderId, firstBody.token)).items[0].label, 'Heritage Turkey, Small');
    await pool.query("UPDATE packages SET name='10–11 lbs' WHERE product_id=1");
    assert.equal((await service.catalog()).options.find(option => option.productId === 1).sizeLabel, '10–11 lb');
    assert.equal((await service.guestOrder(firstResult.orderId, firstBody.token)).items[0].sizeLabel, '9–12 lb');
    await pool.query("UPDATE packages SET name='9–12 lbs' WHERE product_id=1");
    await pool.query('UPDATE products SET is_deleted=1 WHERE id=2');
    assert.equal((await service.catalog()).options.some(option => option.productId === 2), false);
    await assert.rejects(service.checkout(body(secondId)), /unavailable/);
    await pool.query('UPDATE products SET is_deleted=0 WHERE id=2');
  });
  await t.test('pickup groups support additional locations, archive safely and preserve order snapshots', async () => {
    const catalog = await service.catalog(true);
    const payload = setupPayload(catalog);
    payload.pickupGroups.push({ key: 'new-eugene', name: 'Eugene area', active: true });
    payload.pickups.push(...['South market','North market'].map(name => ({ groupId: 'new-eugene', name, active: true,
      address: `${name} address`, hours: '10 AM–2 PM', instructions: 'Meet the farm truck.' })));
    const saved = await service.saveSetup(payload, 1);
    const location = saved.pickups.find(pickup => pickup.name === 'South market');
    assert.ok(location.id > 4); assert.equal(saved.pickupGroups.length, 2); assert.equal(saved.pickups.length, 6);
    const invalid = setupPayload(saved);
    invalid.pickups = invalid.pickups.filter(pickup => pickup.id !== location.id);
    await assert.rejects(service.saveSetup(invalid, 1), /Deactivate saved pickup/);
    const input = body(secondId, 1, location.id); const result = await service.checkout(input);
    const changed = setupPayload(await service.catalog(true));
    changed.pickupGroups = changed.pickupGroups.map(group => group.id === location.groupId ? { ...group, name: 'Renamed area', active: false } : group);
    changed.pickups = changed.pickups.map(pickup => pickup.id === location.id ? { ...pickup, name: 'Renamed market', address: 'New address' } : pickup);
    await service.saveSetup(changed, 1);
    assert.equal((await service.catalog()).pickups.some(pickup => pickup.id === location.id), false);
    await assert.rejects(service.checkout(body(secondId, 1, location.id)), /available pickup/);
    const frozen = await service.guestOrder(result.orderId, input.token);
    assert.equal(frozen.pickup.groupName, 'Eugene area'); assert.equal(frozen.pickup.name, 'South market');
    assert.equal(frozen.pickup.address, 'South market address');
    assert.equal((await service.orders({ pickupId: location.id })).length, 1);
    assert.match(await service.exportOrders({ pickupId: location.id }), /Eugene area/);
    await service.cancelReservation(result.orderId, input.token);
  });
  await t.test('setting on-hand inventory rejects stale counts and never consumes reservations', async () => {
    const before = await stock(secondId);
    const update = { onHand: before.onHand + 5, expectedOnHand: before.onHand, expectedReserved: before.reserved, reason: 'Counted preorder birds' };
    const results = await Promise.allSettled([service.adjustStock(secondId, update, 1), service.adjustStock(secondId, update, 1)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /Inventory changed/);
    const input = body(secondId); const result = await service.checkout(input);
    const reserved = await stock(secondId);
    await assert.rejects(service.adjustStock(secondId, { onHand: 0, expectedOnHand: reserved.onHand, expectedReserved: reserved.reserved, reason: 'Too low' }, 1), /Insufficient/);
    assert.equal((await stock(secondId)).onHand, before.onHand + 5);
    await service.cancelReservation(result.orderId, input.token);
  });
  await t.test('per-product setup inventory saves atomically and protects concurrent orders', async () => {
    const before = await service.catalog(true);
    const countEdit = (option, count) => ({ ...option, inventory: { onHand: count, expectedOnHand: option.onHand, expectedReserved: option.reserved } });
    const payload = setupPayload(before);
    payload.options = before.options.map(option => countEdit(option, option.onHand + 2));
    const saved = await service.saveSetup(payload, 7);
    assert.deepEqual(saved.options.map(option => option.onHand), before.options.map(option => option.onHand + 2));
    const [history] = await pool.query("SELECT delta_on_hand,actor_id FROM storefront_stock_history WHERE reason='Pre-order inventory set in turkey setup' ORDER BY id");
    assert.deepEqual(history.map(row => [row.delta_on_hand,row.actor_id]), [[2,7],[2,7]]);

    const input = body(secondId); const result = await service.checkout(input);
    const stale = setupPayload(saved);
    stale.title = 'Must not be persisted';
    stale.options = saved.options.map(option => countEdit(option, option.onHand + 3));
    await assert.rejects(service.saveSetup(stale, 7), /Inventory changed/);
    const current = await service.catalog(true);
    assert.equal(current.sale.title, saved.sale.title);
    assert.deepEqual(current.options.map(option => option.onHand), saved.options.map(option => option.onHand));
    assert.equal((await stock(secondId)).reserved, saved.options.find(option => option.id === secondId).reserved + 1);

    const invalid = setupPayload(current);
    invalid.options = current.options.map(option => countEdit(option, option.id === secondId ? 0 : option.onHand + 4));
    await assert.rejects(service.saveSetup(invalid, 7), /Insufficient/);
    const negative = setupPayload(current);
    negative.options = current.options.map(option => countEdit(option, -1));
    await assert.rejects(service.saveSetup(negative, 7), /whole number/);

    // Old read-only onHand/reserved values in an ordinary setup save are not stock edits.
    const metadata = setupPayload(saved);
    metadata.title = 'Updated turkey sale';
    await pay(result);
    const afterPayment = await stock(secondId);
    const afterSave = await service.saveSetup(metadata, 7);
    assert.equal(afterSave.options.find(option => option.id === secondId).onHand, afterPayment.onHand);
    assert.equal(afterSave.options.find(option => option.id === secondId).reserved, afterPayment.reserved);
  });
  await t.test('preorder descriptions are shared by breed and independent of catalog and legacy copy', async () => {
    const catalogDescription = '<p>Local Line delivery instructions.</p>';
    await pool.query('UPDATE products SET description=? WHERE id IN (1,2)', [catalogDescription]);
    await pool.query("UPDATE products SET name='Broad Breasted White Turkey, Large' WHERE id=2");
    await pool.query("UPDATE storefront_options SET description='Old separate preorder copy' WHERE id=?", [firstId]);
    const before = await service.catalog();
    assert.equal(before.options.find(option => option.id === firstId).description, DEFAULT_HERITAGE_DESCRIPTION);
    assert.equal(before.options.find(option => option.id === secondId).description, DEFAULT_BROAD_BREASTED_DESCRIPTION);
    const setup = setupPayload(await service.catalog(true));
    setup.heritageDescription = 'Our local heritage preorder description. Saturday pickup.';
    setup.broadBreastedDescription = 'Our local white turkey preorder description. Saturday pickup.';
    setup.options[0].description = 'The breed description remains authoritative';
    const saved = await service.saveSetup(setup, 1);
    assert.equal(saved.options[0].description, setup.heritageDescription);
    assert.equal(saved.options[1].description, setup.broadBreastedDescription);
    assert.deepEqual(saved.options.map(option => [option.onHand,option.reserved]), setup.options.map(option => [option.onHand,option.reserved]));
    const stale = { ...setup, heritageDescription: 'Do not overwrite' };
    await assert.rejects(service.saveSetup(stale, 1), /changed/);
    const invalid = setupPayload(saved);
    invalid.broadBreastedDescription = 'x'.repeat(10001);
    await assert.rejects(service.saveSetup(invalid, 1), /Broad Breasted White/);
    // Older clients that omit these fields preserve the saved preorder descriptions.
    const older = setupPayload(saved);
    delete older.heritageDescription; delete older.broadBreastedDescription;
    const retained = await service.saveSetup(older, 1);
    assert.equal(retained.sale.heritageDescription, setup.heritageDescription);
    assert.equal(retained.sale.broadBreastedDescription, setup.broadBreastedDescription);
    const [[product]] = await pool.query('SELECT description,inventory FROM products WHERE id=1');
    assert.equal(product.description, catalogDescription); assert.equal(product.inventory, 88);
    await pool.query("UPDATE products SET description='Updated Local Line copy' WHERE id=1");
    assert.equal((await service.catalog()).options[0].description, setup.heritageDescription);
  });
  await t.test('live retail prices drive new checkout while existing orders keep their original prices', async () => {
    const input = body(secondId); input.items[0].expectedPriceCents = 16000;
    const result = await service.checkout(input);
    await pool.query('UPDATE product_pricing_profiles SET source_unit_price=170 WHERE product_id=2');
    await pool.query('UPDATE storefront_options SET price_cents=1 WHERE id=?', [secondId]);
    assert.equal((await stock(secondId)).priceCents, 17000);
    assert.equal((await service.checkout(input)).orderId, result.orderId);
    await pay(result);
    assert.equal((await service.guestOrder(result.orderId, input.token)).totalCents, 16000);
    const stale = body(secondId); stale.items[0].expectedPriceCents = 16000;
    const before = await stock(secondId);
    await assert.rejects(service.checkout(stale), error => error.checkoutRejected === true && /retail price changed/.test(error.message));
    assert.equal((await stock(secondId)).reserved, before.reserved);
    const current = body(secondId); current.items[0].expectedPriceCents = 17000; current.items[0].priceCents = 1;
    const next = await service.checkout(current);
    assert.equal((await service.guestOrder(next.orderId, current.token)).totalCents, 17000);
    await service.cancelReservation(next.orderId, current.token);
  });
  await t.test('large catalog product IDs can save preorder stock and complete checkout', async () => {
    const productId = 2000000001;
    await pool.query("INSERT INTO products VALUES (?,'Heritage turkey with large ID','<p>Catalog turkey.</p>',NULL,1,1,0,88)", [productId]);
    await pool.query("INSERT INTO product_pricing_profiles VALUES (?,125.00,'each')", [productId]);
    await pool.query("INSERT INTO packages VALUES (3,?,'12.01–14 lbs',77,125.00,1,1,'package','ea')", [productId]);
    const payload = setupPayload(await service.catalog(true));
    payload.options.push({ productId: String(productId), active: true, inventory: { onHand: 8 } });
    const saved = await service.saveSetup(payload, 1);
    const offering = saved.options.find(option => option.productId === productId);
    assert.equal(offering.onHand, 8);
    assert.equal(offering.priceCents, 12500);
    assert.equal(offering.description, saved.sale.heritageDescription);
    assert.equal(saved.options.find(option => option.id === firstId).description, offering.description);
    const edited = setupPayload(saved);
    edited.options = edited.options.map(option => option.id === offering.id ? { ...option, inventory: { onHand: 10, expectedOnHand: 8, expectedReserved: 0 } } : option);
    await service.saveSetup(edited, 1);
    assert.equal((await stock(offering.id)).onHand, 10);
    const input = body(offering.id);
    const result = await service.checkout(input);
    assert.equal((await service.guestOrder(result.orderId, input.token)).totalCents, 12500);
    assert.equal((await stock(offering.id)).available, 9);
    await service.cancelReservation(result.orderId, input.token);
    assert.equal((await stock(offering.id)).available, 10);
    assert.ok((await service.stockHistory(offering.id)).length >= 4);
    const invalid = setupPayload(await service.catalog(true));
    invalid.options.push({ productId: 2000000002, active: true });
    await assert.rejects(service.saveSetup(invalid, 1), /existing turkey product/);
  });
  await t.test('checkout returns to its trusted starting host and keeps retry URLs frozen', async () => {
    const before = await stock(secondId);
    for (const origin of ['https://turkeys.deckfamilyfarm.com', 'https://store.deckfamilyfarm.com']) {
      const input = body(secondId);
      const result = await service.checkout(input, origin);
      const [[row]] = await pool.query('SELECT stripe_request_json FROM storefront_orders WHERE id=?', [result.orderId]);
      const frozen = JSON.parse(row.stripe_request_json);
      assert.equal(frozen.success_url, `${origin}/#/turkeys?order=${result.orderId}`);
      assert.equal(frozen.cancel_url, `${origin}/#/turkeys?order=${result.orderId}&cancelled=1`);
      assert.equal(frozen.success_url.includes(input.token), false);
      assert.equal((await service.checkout(input, 'http://localhost:5176')).orderId, result.orderId);
      const [[retry]] = await pool.query('SELECT stripe_request_json FROM storefront_orders WHERE id=?', [result.orderId]);
      assert.equal(retry.stripe_request_json, row.stripe_request_json);
      await assert.rejects(service.guestOrder(result.orderId, 'b'.repeat(64)), error => error.status === 404);
      await service.cancelReservation(result.orderId, input.token);
    }
    await assert.rejects(service.checkout(body(secondId), 'https://evil.example'), /store website/);
    assert.deepEqual(await stock(secondId), before);
  });
  await t.test('grouped product content persists independently and older setup clients preserve it', async () => {
    const before = await service.catalog(true);
    assert.equal(before.product.title, 'Thanksgiving Turkey');
    const content = 'Raised on our farm.\n\n- Pasture-raised\n- Saturday pickup';
    const saved = await service.saveSetup({ ...setupPayload(before), aboutDescription: content, productImageUrl: 'https://example.com/turkey.jpg' }, 1);
    assert.equal(saved.product.aboutDescription, content);
    assert.equal(saved.product.imageUrl, 'https://example.com/turkey.jpg');
    const older = setupPayload(saved); delete older.aboutDescription; delete older.productImageUrl;
    const retained = await service.saveSetup(older, 1);
    assert.equal(retained.product.aboutDescription, content);
    const [[product]] = await pool.query('SELECT description FROM products WHERE id=1');
    assert.equal(product.description, 'Updated Local Line copy');
    await assert.rejects(service.saveSetup({...setupPayload(retained),productImageUrl:'javascript:alert(1)'},1), /HTTPS/);
  });
  await t.test('unmapped and duplicate variants are blocked without reserving stock', async () => {
    const before = await stock(secondId);
    await pool.query("UPDATE packages SET name='Large' WHERE product_id=2");
    assert.equal((await service.catalog()).options.some(option=>option.id===secondId),false);
    assert.match((await stock(secondId)).variantError,/weight range/);
    await assert.rejects(service.checkout(body(secondId)), error=>error.checkoutRejected===true && /unavailable/.test(error.message));
    await assert.rejects(service.saveSetup(setupPayload(await service.catalog(true)),1), /weight range/);
    await pool.query("UPDATE packages SET name='14–16 lbs' WHERE product_id=2");
    assert.equal((await stock(secondId)).reserved,before.reserved);
    const [[duplicate]] = await pool.query('SELECT * FROM products WHERE id=1');
    await pool.query("UPDATE products SET name='Broad Breasted White Turkey' WHERE id=1");
    await pool.query("UPDATE packages SET name='14.00 - 16.00 lbs' WHERE product_id=1");
    assert.equal((await service.catalog()).options.some(option=>[firstId,secondId].includes(option.id)),false);
    await assert.rejects(service.checkout(body(secondId)), /unavailable/);
    await assert.rejects(service.saveSetup(setupPayload(await service.catalog(true)),1), /only one active offering/);
    await pool.query('UPDATE products SET name=? WHERE id=1',[duplicate.name]);
    await pool.query("UPDATE packages SET name='9–12 lbs' WHERE product_id=1");
  });
  await t.test('old order items without variant snapshots still return their saved labels', async () => {
    await pool.query('UPDATE storefront_order_items SET product_id=NULL,turkey_type=NULL,size_label=NULL WHERE order_id=?',[firstResult.orderId]);
    const old = await service.guestOrder(firstResult.orderId,firstBody.token);
    assert.equal(old.items[0].label,'Heritage Turkey, Small');
    assert.equal(old.items[0].sizeLabel,null);
    assert.equal(old.items[0].optionId,firstId);
  });
  await t.test('Stripe mode changes preserve refund, checkout retry and webhook safety', async t => {
    const before = await stock(secondId);
    await service.adjustStock(secondId, { onHand: before.onHand + 10, expectedOnHand: before.onHand, expectedReserved: before.reserved, reason: 'Mode regression fixtures' }, 1);
    function modeClient(mode) {
      const state = { sessions: new Map(), refunds: new Map(), checkoutKeys: new Map(), refundKeys: new Map(), calls: 0, loseCheckout: false, loseRefund: false };
      const read = id => { const session = state.sessions.get(id); assert.ok(session, `${mode} client must access only its own sessions`); return session; };
      const checkPayment = id => assert.ok([...state.sessions.values()].some(session => session.payment_intent === id), `${mode} client must access only its own payments`);
      const client = {
        checkout: { sessions: {
          create: async (payload, { idempotencyKey }) => {
            state.calls++;
            let session = state.checkoutKeys.get(idempotencyKey);
            if (!session) {
              session = { id: `cs_${mode}_mode_${state.sessions.size + 1}`, livemode: mode === 'live', metadata: payload.metadata,
                status: 'open', payment_status: 'unpaid', expires_at: payload.expires_at, currency: 'usd',
                amount_total: payload.line_items.reduce((sum, item) => sum + item.quantity * item.price_data.unit_amount, 0) };
              state.sessions.set(session.id, session); state.checkoutKeys.set(idempotencyKey, session);
            }
            if (state.loseCheckout) { state.loseCheckout = false; throw new Error('Lost mode checkout response'); }
            return structuredClone(session);
          },
          retrieve: async id => { state.calls++; return structuredClone(read(id)); },
          expire: async id => { state.calls++; const session = read(id); session.status = 'expired'; return structuredClone(session); }
        } },
        refunds: {
          list: async ({ payment_intent }) => { state.calls++; checkPayment(payment_intent); return { data: [...state.refunds.values()].filter(refund => refund.payment_intent === payment_intent).map(refund => structuredClone(refund)), has_more: false }; },
          create: async (payload, { idempotencyKey }) => {
            state.calls++; checkPayment(payload.payment_intent);
            let refund = state.refundKeys.get(idempotencyKey);
            if (!refund) {
              refund = { ...payload, id: `re_${mode}_${state.refunds.size + 1}`, status: 'pending', livemode: mode === 'live' };
              state.refunds.set(refund.id, refund); state.refundKeys.set(idempotencyKey, refund);
            }
            if (state.loseRefund) { state.loseRefund = false; throw new Error('Lost mode refund response'); }
            return structuredClone(refund);
          }
        }
      };
      const paidSession = orderId => {
        const session = state.checkoutKeys.get(`storefront-checkout-${orderId}`);
        Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: `pi_${session.id}` });
        return session;
      };
      return { client, state, paidSession };
    }
    const testStripe = modeClient('test'), liveStripe = modeClient('live');
    const modeConfig = { enabled: true, webhookSecret: 'test-secret', emailReady: true, baseUrl: 'http://localhost:5176' };
    const testService = createStorefrontService({ pool, stripe: testStripe.client, now: () => clock, config: { ...modeConfig, stripeMode: 'test' } });
    const liveOnly = createStorefrontService({ pool, stripe: liveStripe.client, now: () => clock, config: { ...modeConfig, stripeMode: 'live' } });
    const liveWithTest = createStorefrontService({ pool, stripe: liveStripe.client, stripeClients: { test: testStripe.client }, now: () => clock, config: { ...modeConfig, stripeMode: 'live' } });
    await t.test('legacy test refunds use the test key and restock once after verified success', async () => {
      const result = await testService.checkout(body(secondId));
      testStripe.paidSession(result.orderId); await testService.reconcile(result.orderId);
      // Existing orders predate the mode column, but retain a mode-specific session ID.
      await pool.query('UPDATE storefront_orders SET stripe_mode=NULL WHERE id=?', [result.orderId]);
      const sold = await stock(secondId), liveCalls = liveStripe.state.calls;
      await assert.rejects(liveOnly.issueRefund(result.orderId, 1), error => error.status === 409 && /test-mode order/.test(error.message));
      assert.equal(liveStripe.state.calls, liveCalls);
      assert.deepEqual(await stock(secondId), sold);
      const [[blocked]] = await pool.query('SELECT status,refund_key,last_error FROM storefront_orders WHERE id=?', [result.orderId]);
      assert.equal(blocked.status, 'paid'); assert.equal(blocked.refund_key, null); assert.match(blocked.last_error, /test-mode order/);
      assert.equal((await liveWithTest.orders({})).find(order => order.id === result.orderId).stripeMode, 'test');
      testStripe.state.loseRefund = true;
      await assert.rejects(liveWithTest.issueRefund(result.orderId, 1), /Lost mode refund response/);
      await liveWithTest.issueRefund(result.orderId, 1);
      assert.equal(testStripe.state.refunds.size, 1);
      assert.equal((await stock(secondId)).onHand, sold.onHand);
      const refund = [...testStripe.state.refunds.values()][0]; refund.status = 'succeeded';
      const event = { id: 'evt_mode_refund', type: 'refund.updated', livemode: false, data: { object: refund } };
      await liveWithTest.webhook(event); await liveWithTest.webhook(event); await liveWithTest.issueRefund(result.orderId, 1);
      assert.equal((await stock(secondId)).onHand, sold.onHand + 1);
      assert.equal(liveStripe.state.calls, liveCalls);
      const liveOrder = await liveWithTest.checkout(body(secondId));
      const [[liveRow]] = await pool.query('SELECT stripe_mode,stripe_session_id FROM storefront_orders WHERE id=?', [liveOrder.orderId]);
      assert.equal(liveRow.stripe_mode, 'live'); assert.match(liveRow.stripe_session_id, /^cs_live_/);
      liveStripe.paidSession(liveOrder.orderId); await liveWithTest.reconcile(liveOrder.orderId);
      await liveWithTest.issueRefund(liveOrder.orderId, 1);
      const liveRefund = [...liveStripe.state.refunds.values()][0]; liveRefund.status = 'succeeded';
      await liveWithTest.reconcile(liveOrder.orderId);
      assert.equal(liveStripe.state.refunds.size, 1); assert.equal(testStripe.state.refunds.size, 1);
    });
    await t.test('uncertain checkout retries remain in their original mode after switching to live', async () => {
      const input = body(secondId); testStripe.state.loseCheckout = true;
      const result = await testService.checkout(input);
      assert.equal(result.status, 'processing');
      const count = testStripe.state.sessions.size, liveCalls = liveStripe.state.calls;
      await assert.rejects(liveOnly.checkout(input), error => error.status === 409 && !error.checkoutRejected);
      assert.equal(liveStripe.state.calls, liveCalls);
      const retry = await liveWithTest.checkout(input);
      assert.equal(retry.orderId, result.orderId); assert.equal(testStripe.state.sessions.size, count);
      await liveWithTest.cancelReservation(result.orderId, input.token);
      const legacyInput = body(secondId); testStripe.state.loseCheckout = true;
      const legacy = await testService.checkout(legacyInput);
      await pool.query('UPDATE storefront_orders SET stripe_mode=NULL WHERE id=?', [legacy.orderId]);
      await assert.rejects(liveWithTest.checkout(legacyInput), /no recorded Stripe mode/);
      assert.equal(liveStripe.state.calls, liveCalls);
      assert.equal((await liveWithTest.orders({})).find(order => order.id === legacy.orderId).status, 'review');
      const original = testStripe.state.checkoutKeys.get(`storefront-checkout-${legacy.orderId}`);
      await liveWithTest.attachSession(legacy.orderId, original.id);
      await liveWithTest.cancelReservation(legacy.orderId, legacyInput.token);
    });
    await t.test('wrong-mode webhooks cannot update an order and lock conflicts stay retryable', async () => {
      const input = body(secondId), result = await testService.checkout(input);
      const session = testStripe.paidSession(result.orderId);
      const event = { id: 'evt_mode_locked', type: 'checkout.session.completed', livemode: false, data: { object: session } };
      const reserved = await stock(secondId);
      await assert.rejects(liveWithTest.webhook({ ...event, livemode: true }), /webhook mode does not match/);
      const connection = await pool.getConnection();
      try {
        await connection.query('SELECT GET_LOCK(?,0)', [`storefront:${result.orderId}`]);
        await assert.rejects(liveWithTest.webhook(event), error => error.status === 409 && /being updated/.test(error.message));
        const [seen] = await pool.query('SELECT event_id FROM storefront_webhooks WHERE event_id=?', [event.id]);
        assert.equal(seen.length, 0); assert.deepEqual(await stock(secondId), reserved);
      } finally { await connection.query('SELECT RELEASE_LOCK(?)', [`storefront:${result.orderId}`]); connection.release(); }
      await liveWithTest.webhook(event); await liveWithTest.webhook(event);
      const paid = await stock(secondId);
      assert.equal(paid.reserved, reserved.reserved - 1); assert.equal(paid.onHand, reserved.onHand - 1);
      await liveWithTest.issueRefund(result.orderId, 1);
      const refund = [...testStripe.state.refunds.values()].find(refund => refund.payment_intent === session.payment_intent);
      refund.status = 'succeeded'; await liveWithTest.reconcile(result.orderId);
    });
  });
  await t.test('cutoff enforcement, CSV and stock isolation from Local Line', async () => {
    const [[product]] = await pool.query('SELECT inventory FROM products WHERE id=1');
    const [[pkg]] = await pool.query('SELECT inventory FROM packages WHERE id=1');
    assert.equal(product.inventory, 88); assert.equal(pkg.inventory, 77);
    const before = await stock(secondId);
    await pool.query('UPDATE products SET inventory=10'); await pool.query('UPDATE packages SET inventory=11');
    assert.deepEqual(await stock(secondId), before);
    const csv = await service.exportOrders({ pickupId: 4 });
    assert.ok(csv.includes('Farm Pickup')); assert.ok(csv.includes('"400.00"'));
    clock = Date.parse('2026-11-21T01:00:01Z');
    await assert.rejects(service.checkout(body(secondId)), /closed/);
    assert.equal((await service.catalog()).sale.open, false);
  });
});
