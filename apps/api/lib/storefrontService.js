import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ensureStorefrontSchema } from './storefrontSchema.js';
import { readStorefrontProducts, duplicateTurkeyVariants } from './storefrontProducts.js';
import { preorderDescriptions, turkeyDescription, turkeyAboutDescription } from './storefrontDescriptions.js';
import { stripeOrderMode, stripeModeError, storefrontStripeError } from './storefrontStripe.js';
import { HOLD_MS, hash, parse, fail, integer, recordId, text, email, tokenHash, checkoutReturnOrigin, normalizeCheckout, parsePacificInput, pacificInput, validatePublish, csvCell } from './storefrontCore.js';

// All writes are confined to storefront_* tables. Never use catalog inventory here.
export function createStorefrontService({ pool, stripe, stripeClients = {}, sendEmail, now = Date.now, config = {} }) {
  const connections = new AsyncLocalStorage();
  const db = () => connections.getStore() || pool;
  const ready = () => ensureStorefrontSchema(pool);
  const enabled = () => config.enabled === true;
  function stripeForOrder(row) {
    const mode = stripeOrderMode(row);
    if (mode) {
      const client = stripeClients[mode] || (config.stripeMode === mode ? stripe : null);
      if (!client) throw stripeModeError(mode);
      return client;
    }
    if (!stripe) fail('Stripe is not configured.', 503);
    // Never resend an older uncertain create using a potentially different mode.
    if (config.stripeMode && !row.stripe_session_id && !row.stripe_payment_id) {
      throw Object.assign(new Error('This older checkout has no recorded Stripe mode. Link its existing Stripe receipt before retrying; its stock remains held.'),
        { status: 409, code: 'storefront_stripe_unknown_mode' });
    }
    return stripe;
  }
  async function confirmStripeMode(row, object) {
    if (typeof object.livemode !== 'boolean') return;
    const mode = object.livemode ? 'live' : 'test';
    const expected = stripeOrderMode(row);
    if (expected && expected !== mode) fail('Stripe payment mode does not match this order. Review the original payment before retrying.', 409);
    if (!row.stripe_mode) await db().query('UPDATE storefront_orders SET stripe_mode=? WHERE id=? AND stripe_mode IS NULL', [mode, row.id]);
  }
  async function transaction(fn) {
    const inherited = connections.getStore();
    const connection = inherited || await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { if (!inherited) connection.release(); }
  }
  async function locked(id, fn) {
    const connection = await pool.getConnection();
    const name = `storefront:${id}`;
    let acquired = false;
    try {
      const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [name]);
      acquired = Number(rows[0].acquired) === 1;
      if (!acquired) fail('This order is being updated. Please try again shortly.', 409);
      // Reuse this connection for all work under the lock, avoiding pool starvation.
      return await connections.run(connection, fn);
    } catch (original) {
      const error = storefrontStripeError(original);
      if (acquired && error.code === 'storefront_stripe_mode') {
        await connection.query('UPDATE storefront_orders SET last_error=? WHERE id=?', [error.message, id]);
      } else if (acquired && error.code === 'storefront_stripe_unknown_mode') {
        await connection.query("UPDATE storefront_orders SET status='review',last_error=? WHERE id=? AND status IN ('creating','review') AND stripe_mode IS NULL AND stripe_session_id IS NULL", [error.message, id]);
      }
      throw error;
    } finally {
      if (acquired) await connection.query('SELECT RELEASE_LOCK(?)', [name]).catch(() => {});
      connection.release();
    }
  }
  async function order(id, connection = db(), forUpdate = false) {
    const [rows] = await connection.query(`SELECT * FROM storefront_orders WHERE id=?${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    if (!rows[0]) fail('Order not found.', 404);
    const [items] = await connection.query('SELECT * FROM storefront_order_items WHERE order_id=? ORDER BY option_id', [id]);
    return { ...rows[0], items };
  }
  function orderView(row, admin = false) {
    const view = {
      id: row.id, number: row.number, status: row.status, customer: parse(row.customer_json), pickup: parse(row.pickup_json),
      totalCents: row.total_cents, currency: row.currency, createdMs: Number(row.created_ms), paidMs: row.paid_ms && Number(row.paid_ms),
      collectedMs: row.collected_ms && Number(row.collected_ms), expiresMs: Number(row.expires_ms),
      refundStatus: row.refund_status, refundedCents: row.refunded_cents,
      contactEmail: row.contact_email,
      items: row.items.map(item => ({ optionId: item.option_id, productId: item.product_id, typeLabel: item.turkey_type,
        sizeLabel: item.size_label, label: item.label, quantity: item.quantity, priceCents: item.price_cents }))
    };
    if (admin) Object.assign(view, { lastError: row.last_error, stripeMode: stripeOrderMode(row), stripeSessionId: row.stripe_session_id, stripePaymentId: row.stripe_payment_id,
      refundRequestedBy: row.refund_requested_by, refundRequestedMs: row.refund_requested_ms && Number(row.refund_requested_ms) });
    return view;
  }
  async function authorize(id, token) {
    const hashed = tokenHash(token);
    const [rows] = await db().query('SELECT id FROM storefront_orders WHERE id=? AND token_hash=?', [id, hashed]);
    if (!rows.length) fail('Order not found.', 404);
  }
  async function stock(connection, optionId, delta, reserved, reason, orderId = null, actorId = null) {
    const [result] = await connection.query(`UPDATE storefront_options SET on_hand=on_hand+?, reserved=reserved+?
      WHERE id=? AND on_hand+? >= 0 AND reserved+? >= 0 AND on_hand+? >= reserved+?`,
    [delta, reserved, optionId, delta, reserved, delta, reserved]);
    if (!result.affectedRows) fail('Insufficient available stock or conflicting stock adjustment.', 409);
    await connection.query(`INSERT INTO storefront_stock_history
      (option_id,order_id,delta_on_hand,delta_reserved,reason,actor_id,created_ms) VALUES (?,?,?,?,?,?,?)`,
    [optionId, orderId, delta, reserved, reason, actorId, now()]);
  }
  async function queueEmail(connection, id, kind) {
    await connection.query('INSERT IGNORE INTO storefront_emails (order_id,kind,next_attempt_ms) VALUES (?,?,?)', [id, kind, now()]);
  }
  async function catalog(admin = false) {
    await ready();
    const [[saleRows], [options], [pickups], [groups], products] = await Promise.all([
      db().query('SELECT * FROM storefront_sales WHERE id=1'),
      db().query(`SELECT o.*, COALESCE((SELECT SUM(i.quantity) FROM storefront_order_items i
        JOIN storefront_orders r ON r.id=i.order_id WHERE i.option_id=o.id AND r.paid_ms IS NOT NULL AND r.status <> 'refunded'),0) AS purchased
        FROM storefront_options o WHERE sale_id=1 ORDER BY id`),
      db().query('SELECT * FROM storefront_pickups WHERE sale_id=1 ORDER BY id'),
      db().query('SELECT * FROM storefront_pickup_groups WHERE sale_id=1 ORDER BY id'),
      readStorefrontProducts(db())
    ]);
    const byProduct = new Map(products.map(product => [product.id, product]));
    const duplicates = duplicateTurkeyVariants(options, byProduct);
    const variantError = option => {
      const product = byProduct.get(option.product_id);
      return product?.variantError || (duplicates.has(product?.variantKey) ? 'Another active offering has the same turkey type and weight range. Deactivate the duplicate.' : '');
    };
    const activeGroupIds = new Set(groups.filter(group => group.active).map(group => group.id));
    const sale = saleRows[0];
    const descriptions = preorderDescriptions(sale);
    const open = enabled() && Boolean(stripe) && Boolean(config.webhookSecret) && sale.status === 'open' && Number(sale.closes_ms) > now();
    const result = {
      sale: { id: sale.id, title: sale.title, description: sale.description, imageUrl: sale.image_url,
        pickupDate: sale.pickup_date, closesMs: sale.closes_ms && Number(sale.closes_ms), contactEmail: sale.contact_email,
        status: sale.status, open },
      options: options.filter(option => admin || (option.active && byProduct.get(option.product_id)?.retailPriceCents != null && !variantError(option))).map(option => ({ id: option.id, label: byProduct.get(option.product_id)?.name || option.label,
        productId: option.product_id, imageUrl: byProduct.get(option.product_id)?.imageUrl || '',
        images: byProduct.get(option.product_id)?.images || [], productAvailable: byProduct.has(option.product_id),
        preorderBreed: byProduct.get(option.product_id)?.preorderBreed || null,
        typeLabel: byProduct.get(option.product_id)?.typeLabel || '', sizeLabel: byProduct.get(option.product_id)?.sizeLabel || '', variantError: variantError(option),
        description: turkeyDescription(byProduct.get(option.product_id)?.preorderBreed, descriptions), priceCents: byProduct.get(option.product_id)?.retailPriceCents ?? null,
        priceError: byProduct.get(option.product_id)?.priceError || '', available: option.on_hand - option.reserved,
        ...(admin ? { active: Boolean(option.active), onHand: option.on_hand, reserved: option.reserved, purchased: Number(option.purchased) } : {}) })),
      pickupGroups: groups.filter(group => admin || group.active).map(group => ({ id: group.id, name: group.name, active: Boolean(group.active) })),
      pickups: pickups.filter(p => admin || (p.active && activeGroupIds.has(p.group_id))).map(p => ({ id: p.id, groupId: p.group_id,
        active: Boolean(p.active), name: p.name, address: p.address, hours: p.hours, instructions: p.instructions }))
    };
    const firstPhoto = [...result.options].sort((a, b) => (a.preorderBreed === 'heritage') - (b.preorderBreed === 'heritage') || a.priceCents - b.priceCents).find(option => option.imageUrl)?.imageUrl;
    result.product = { title: 'Thanksgiving Turkey', shortDescription: sale.description,
      aboutDescription: turkeyAboutDescription(sale), imageUrl: sale.product_image_url || firstPhoto || sale.image_url || '/images/turkey-home/holiday-turkey.jpg' };
    if (admin) Object.assign(result, { catalogProducts: products, readiness: { checkoutEnabled: enabled(), stripeConfigured: Boolean(stripe), webhookConfigured: Boolean(config.webhookSecret), emailConfigured: Boolean(config.emailReady) },
      sale: { ...result.sale, ...descriptions, aboutDescription: turkeyAboutDescription(sale), productImageUrl: sale.product_image_url || '', notifyEmail: sale.notify_email, version: sale.version, closesPacific: pacificInput(sale.closes_ms) } });
    else if (sale.status === 'draft') Object.assign(result, { options: [], pickups: result.pickups.map(p => ({ id: p.id, groupId: p.groupId, name: p.name })) });
    return result;
  }
  async function saveSetup(body, actorId) {
    await ready();
    const title = text(body.title, 'sale title', 200);
    const description = text(body.description, 'description', 10000);
    const imageUrl = text(body.imageUrl, 'image URL', 2048, false);
    if (imageUrl && !/^https:\/\//.test(imageUrl) && !/^\/(?!\/)/.test(imageUrl)) fail('Use an HTTPS image URL or a local image path.');
    const pickupDate = text(body.pickupDate, 'pickup date', 10);
    const parsedDate = Date.parse(`${pickupDate}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate) || !Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0,10) !== pickupDate) fail('Enter a valid pickup date.');
    const closes = body.closesPacific ? parsePacificInput(body.closesPacific) : null;
    const contact = body.contactEmail ? email(body.contactEmail, 'contact email') : '';
    const notify = body.notifyEmail ? email(body.notifyEmail, 'notification email') : '';
    const status = body.status;
    if (!['draft', 'open', 'closed'].includes(status)) fail('Invalid sale status.');
    if (!Array.isArray(body.options) || body.options.length > 30 || !Array.isArray(body.pickups) || body.pickups.length > 500 ||
      !Array.isArray(body.pickupGroups) || body.pickupGroups.length > 100) fail('Provide turkey products and pickup groups with locations.');
    await transaction(async c => {
      const [[sale]] = await c.query('SELECT * FROM storefront_sales WHERE id=1 FOR UPDATE');
      if (Number(body.version) !== sale.version) fail('Sale setup changed. Reload before saving.', 409);
      const currentDescriptions = preorderDescriptions(sale);
      const aboutDescription = text(body.aboutDescription ?? turkeyAboutDescription(sale), 'About our turkeys', 10000);
      const productImageUrl = text(body.productImageUrl ?? sale.product_image_url ?? '', 'product photo URL', 2048, false);
      if (productImageUrl && !/^https:\/\//.test(productImageUrl) && !/^\/(?!\/)/.test(productImageUrl)) fail('Use an HTTPS product photo URL or a local image path.');
      const heritageDescription = text(body.heritageDescription ?? currentDescriptions.heritageDescription, 'Heritage Black preorder description', 10000);
      const broadBreastedDescription = text(body.broadBreastedDescription ?? currentDescriptions.broadBreastedDescription, 'Broad Breasted White preorder description', 10000);
      const [existing] = await c.query('SELECT * FROM storefront_options WHERE sale_id=1 FOR UPDATE');
      const existingIds = new Set(existing.map(o => o.id));
      const seen = new Set();
      const products = new Map((await readStorefrontProducts(c)).map(product => [product.id, product]));
      const usedProducts = new Set();
      for (const input of body.options) {
        const productId = input.productId ? recordId(input.productId, 'Catalog product') : null;
        const product = products.get(productId);
        // Preserve legacy drafts, but every offered turkey must now have a catalog identity.
        if ((!product && (input.active === true || !input.id)) || (productId && usedProducts.has(productId))) fail('Choose an existing turkey product once per sale.');
        if (productId) usedProducts.add(productId);
        const label = product?.name || text(input.label, 'turkey name', 255);
        // Descriptions use the sale's preorder copy for each breed, separate from Products.
        // Stored price is a compatibility cache. Catalog retail is authoritative at checkout.
        const price = product?.retailPriceCents ?? 0;
        const active = input.active === true ? 1 : 0;
        if (status === 'open' && active && product?.priceError) fail(`${product.name}: ${product.priceError}`);
        if (input.id) {
          const id = recordId(input.id, 'Size ID');
          if (!existingIds.has(id) || seen.has(id)) fail('Unknown or duplicate turkey size.');
          const previous = existing.find(option => option.id === id);
          if (previous.product_id && previous.product_id !== productId) fail('A saved offering keeps its catalog product. Deactivate it and add a different turkey.');
          seen.add(id);
          await c.query('UPDATE storefront_options SET product_id=?,label=?,price_cents=?,active=? WHERE id=?', [productId, label, price, active, id]);
          if (input.inventory !== undefined) {
            const delta = inventoryDelta(input.inventory, previous);
            if (delta) await stock(c, id, delta, 0, 'Pre-order inventory set in turkey setup', null, actorId);
          }
        } else {
          const initialCount = input.inventory === undefined ? 0 : integer(input.inventory?.onHand, 'Pre-order inventory');
          const [result] = await c.query("INSERT INTO storefront_options (sale_id,product_id,label,description,price_cents,active) VALUES (1,?,?,'',?,?)", [productId, label, price, active]);
          if (initialCount) await stock(c, result.insertId, initialCount, 0, 'Initial pre-order inventory', null, actorId);
        }
      }
      if (existing.some(o => !seen.has(o.id))) fail('Deactivate existing sizes instead of deleting them.');
      const [existingGroups] = await c.query('SELECT * FROM storefront_pickup_groups WHERE sale_id=1 FOR UPDATE');
      const groupIds = new Map();
      const seenGroups = new Set();
      for (const input of body.pickupGroups) {
        const name = text(input.name, 'location group name', 120);
        const active = input.active === true ? 1 : 0;
        if (input.id) {
          const id = recordId(input.id, 'Pickup group ID');
          if (!existingGroups.some(group => group.id === id) || seenGroups.has(id)) fail('Unknown or duplicate pickup group.');
          seenGroups.add(id); groupIds.set(String(id), id);
          await c.query('UPDATE storefront_pickup_groups SET name=?,active=? WHERE id=?', [name, active, id]);
        } else {
          const key = text(input.key, 'new pickup group key', 100);
          if (!key.startsWith('new-') || groupIds.has(key)) fail('Use a unique key for each new pickup group.');
          const [result] = await c.query('INSERT INTO storefront_pickup_groups (sale_id,name,active) VALUES (1,?,?)', [name, active]);
          groupIds.set(key, result.insertId);
        }
      }
      if (existingGroups.some(group => !seenGroups.has(group.id))) fail('Deactivate saved pickup groups instead of deleting them.');
      const [existingPickups] = await c.query('SELECT * FROM storefront_pickups WHERE sale_id=1 FOR UPDATE');
      const seenPickups = new Set();
      for (const input of body.pickups) {
        const groupId = groupIds.get(String(input.groupId));
        if (!groupId) fail('Choose a pickup group for each location.');
        const values = [groupId, input.active === true ? 1 : 0, text(input.name, 'location title', 120),
          text(input.address, 'pickup address', 500, false), text(input.hours, 'pickup hours', 120, false),
          text(input.instructions, 'pickup instructions', 3000, false)];
        if (input.id) {
          const id = recordId(input.id, 'Pickup ID');
          if (!existingPickups.some(pickup => pickup.id === id) || seenPickups.has(id)) fail('Unknown or duplicate pickup location.');
          seenPickups.add(id);
          await c.query('UPDATE storefront_pickups SET group_id=?,active=?,name=?,address=?,hours=?,instructions=? WHERE id=?', [...values, id]);
        } else {
          await c.query('INSERT INTO storefront_pickups (sale_id,group_id,active,name,address,hours,instructions) VALUES (1,?,?,?,?,?,?)', values);
        }
      }
      if (existingPickups.some(pickup => !seenPickups.has(pickup.id))) fail('Deactivate saved pickup locations instead of deleting them.');
      if (status === 'open') {
        if (!enabled() || !stripe || !config.webhookSecret || !config.emailReady) fail('Enable checkout and configure Stripe, its storefront webhook, and email before publishing.');
        const [[options], [pickups], [groups]] = await Promise.all([c.query('SELECT * FROM storefront_options WHERE sale_id=1'), c.query('SELECT * FROM storefront_pickups WHERE sale_id=1'), c.query('SELECT * FROM storefront_pickup_groups WHERE sale_id=1')]);
        const duplicates = duplicateTurkeyVariants(options, products);
        for (const option of options.filter(option => option.active)) {
          const product = products.get(option.product_id);
          if (product?.variantError) fail(`${product.name}: ${product.variantError}`);
          if (duplicates.has(product?.variantKey)) fail('Each turkey type and weight range must have only one active offering.');
        }
        validatePublish({ title, description, contact_email: contact, notify_email: notify, pickup_date: pickupDate, closes_ms: closes }, options, pickups, now(), groups);
      }
      await c.query(`UPDATE storefront_sales SET title=?,description=?,image_url=?,status=?,pickup_date=?,closes_ms=?,contact_email=?,notify_email=?,heritage_description=?,broad_breasted_description=?,about_description=?,product_image_url=?,updated_ms=?,updated_by=?,version=version+1 WHERE id=1`,
        [title, description, imageUrl, status, pickupDate, closes, contact, notify, heritageDescription, broadBreastedDescription, aboutDescription, productImageUrl, now(), actorId]);
    });
    return catalog(true);
  }
  function inventoryDelta(input, current) {
    if (integer(input?.expectedOnHand, 'Previous inventory') !== current.on_hand || integer(input?.expectedReserved, 'Previous reservations') !== current.reserved) fail('Inventory changed. Refresh the totals before setting a new count.', 409);
    return integer(input?.onHand, 'Pre-order inventory') - current.on_hand;
  }
  async function adjustStock(id, body, actorId) {
    await ready();
    const optionId = recordId(id, 'Size ID');
    const reason = text(body.reason, 'adjustment reason');
    await transaction(async c => {
      const [[current]] = await c.query('SELECT * FROM storefront_options WHERE id=? AND sale_id=1 FOR UPDATE', [optionId]);
      if (!current) fail('Turkey offering not found.', 404);
      let delta;
      if (body.onHand !== undefined) {
        delta = inventoryDelta(body, current);
      } else delta = integer(body.delta, 'Stock adjustment', -1000000);
      if (!delta) fail('Enter a changed inventory count.');
      await stock(c, optionId, delta, 0, reason, null, actorId);
    });
    return catalog(true);
  }
  async function release(id, error = null) {
    await transaction(async c => {
      const row = await order(id, c, true);
      if (!['creating', 'reserved', 'review'].includes(row.status)) return;
      for (const item of row.items) await stock(c, item.option_id, 0, -item.quantity, 'Checkout expired', id);
      await c.query("UPDATE storefront_orders SET status='expired',last_error=? WHERE id=?", [error, id]);
    });
  }
  async function applySession(id, session) {
    if (session.status === 'expired' && session.payment_status !== 'paid') return release(id);
    if (session.payment_status !== 'paid') return;
    await transaction(async c => {
      const row = await order(id, c, true);
      if (row.paid_ms) return;
      if (session.metadata?.storefront_order_id !== id || session.amount_total !== row.total_cents || session.currency !== 'usd' || !session.payment_intent) fail('Stripe payment does not match the order.', 409);
      if (!['creating', 'reserved', 'review'].includes(row.status)) fail('Paid order needs manual reconciliation; stock was already released.', 409);
      for (const item of row.items) await stock(c, item.option_id, -item.quantity, -item.quantity, 'Payment confirmed', id);
      await c.query("UPDATE storefront_orders SET status='paid',paid_ms=?,stripe_payment_id=?,last_error=NULL WHERE id=?", [now(), typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id, id]);
      await queueEmail(c, id, 'confirmation');
    });
  }
  async function syncSession(id) {
    let row = await order(id);
    const orderStripe = stripeForOrder(row);
    if (!row.stripe_session_id && ['creating', 'review'].includes(row.status)) {
      // Stripe may prune idempotency keys after 24h. Never recreate an uncertain older checkout.
      if (now() - Number(row.created_ms) > 23 * 3600000) {
        await db().query("UPDATE storefront_orders SET status='review',last_error=? WHERE id=?", ['Uncertain checkout older than 23 hours. Reconcile with Stripe before releasing stock.', id]);
        return;
      }
      const session = await orderStripe.checkout.sessions.create(parse(row.stripe_request_json), { idempotencyKey: `storefront-checkout-${id}` });
      await confirmStripeMode(row, session);
      await db().query("UPDATE storefront_orders SET stripe_session_id=?,checkout_url=?,expires_ms=?,status='reserved',last_error=NULL WHERE id=?", [session.id, session.url || '', session.expires_at * 1000, id]);
      row = await order(id);
    }
    if (!row.stripe_session_id) return;
    let session = await orderStripe.checkout.sessions.retrieve(row.stripe_session_id);
    await confirmStripeMode(row, session);
    if (session.status === 'open' && (row.cancel_requested || now() >= Number(row.expires_ms))) {
      try { session = await orderStripe.checkout.sessions.expire(session.id); }
      catch (error) {
        // Payment can win the race against expiry. Read back rather than returning stock blindly.
        session = await orderStripe.checkout.sessions.retrieve(row.stripe_session_id);
        if (session.status === 'open') throw error;
      }
    }
    await applySession(id, session);
  }
  async function checkout(body, requestOrigin) {
    await ready();
    const token = tokenHash(body.token);
    let input, returnOrigin;
    try {
      if (!enabled() || !stripe || !config.webhookSecret) fail('Preorders are not open yet.', 503);
      input = normalizeCheckout(body);
      returnOrigin = checkoutReturnOrigin(config.baseUrl, requestOrigin);
    } catch (error) {
      const [existing] = await db().query('SELECT id FROM storefront_orders WHERE token_hash=?', [token]);
      if (!existing.length && error.status) error.checkoutRejected = true;
      throw error;
    }
    const requestHash = hash(JSON.stringify(input));
    let existingOrder = false;
    const id = await transaction(async c => {
      // Serializes reservation creation and publication changes; stock rows are locked in ID order.
      const [[sale]] = await c.query('SELECT * FROM storefront_sales WHERE id=1 FOR UPDATE');
      const [previous] = await c.query('SELECT id,request_hash FROM storefront_orders WHERE token_hash=?', [token]);
      if (previous.length) {
        existingOrder = true;
        if (previous[0].request_hash !== requestHash) fail('This checkout already contains a different order. Start a new order.', 409);
        return previous[0].id;
      }
      if (sale.status !== 'open' || Number(sale.closes_ms) <= now()) fail('Turkey preorders are closed.', 409);
      const [[pickup]] = await c.query(`SELECT p.*,g.name AS group_name FROM storefront_pickups p
        JOIN storefront_pickup_groups g ON g.id=p.group_id AND g.sale_id=1 AND g.active=1
        WHERE p.id=? AND p.sale_id=1 AND p.active=1`, [input.pickupId]);
      if (!pickup) fail('Choose an available pickup location.');
      const [pending] = await c.query(`SELECT COUNT(*) AS total FROM storefront_orders WHERE status IN ('creating','reserved','review')
        AND JSON_UNQUOTE(JSON_EXTRACT(customer_json,'$.email'))=?`, [input.customer.email]);
      if (Number(pending[0].total) >= 3) fail('You already have several checkouts in progress. Complete or cancel one before starting another.', 429);
      const id = crypto.randomUUID();
      const number = `TK-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
      const items = [];
      const products = new Map((await readStorefrontProducts(c)).map(product => [product.id, product]));
      const [activeOptions] = await c.query('SELECT product_id,active FROM storefront_options WHERE sale_id=1 AND active=1');
      const duplicates = duplicateTurkeyVariants(activeOptions, products);
      for (const inputItem of input.items) {
        const [[option]] = await c.query('SELECT * FROM storefront_options WHERE id=? AND sale_id=1 FOR UPDATE', [inputItem.optionId]);
        const product = products.get(option?.product_id);
        if (!option?.active || product?.retailPriceCents == null || product.variantError || duplicates.has(product.variantKey)) fail('That turkey size is unavailable.', 409);
        if (inputItem.expectedPriceCents !== undefined && inputItem.expectedPriceCents !== product.retailPriceCents) fail('The retail price changed. Refresh the turkey page and start checkout again.', 409);
        if (option.on_hand - option.reserved < inputItem.quantity) fail(`${option.label} does not have enough turkeys available.`, 409);
        await stock(c, option.id, 0, inputItem.quantity, 'Checkout reservation', id);
        items.push({ ...inputItem, label: product.name, productId: product.id, typeLabel: product.typeLabel, sizeLabel: product.sizeLabel, priceCents: product.retailPriceCents });
      }
      const total = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
      integer(total, 'Order total', 50, 99999999);
      // One extra minute leaves room to submit Stripe's minimum 30-minute expiration.
      const expires = Math.floor((now() + HOLD_MS + 60000) / 1000);
      const checkoutRequest = {
        mode: 'payment', payment_method_types: ['card'], customer_email: input.customer.email,
        client_reference_id: id, metadata: { storefront_order_id: id },
        payment_intent_data: { metadata: { storefront_order_id: id }, receipt_email: input.customer.email },
        line_items: items.map(item => ({ quantity: item.quantity, price_data: { currency: 'usd', unit_amount: item.priceCents,
          product_data: { name: `Thanksgiving Turkey — ${item.typeLabel}, ${item.sizeLabel}`,
            metadata: { variant_id: String(item.optionId), catalog_product_id: String(item.productId), turkey_type: item.typeLabel, size_label: item.sizeLabel } } } })),
        expires_at: expires, success_url: `${returnOrigin}/#/turkeys?order=${id}`,
        cancel_url: `${returnOrigin}/#/turkeys?order=${id}&cancelled=1`
      };
      const pickupSnapshot = { id: pickup.id, groupId: pickup.group_id, groupName: pickup.group_name, name: pickup.name, address: pickup.address, hours: pickup.hours,
        instructions: pickup.instructions, date: sale.pickup_date, timezone: 'America/Los_Angeles' };
      await c.query(`INSERT INTO storefront_orders
        (id,number,sale_id,token_hash,request_hash,status,customer_json,pickup_json,total_cents,stripe_request_json,expires_ms,created_ms,contact_email,notify_email,stripe_mode)
        VALUES (?,?,1,?,?,'creating',?,?,?,?,?,?,?,?,?)`, [id, number, token, requestHash, JSON.stringify(input.customer), JSON.stringify(pickupSnapshot), total, JSON.stringify(checkoutRequest), expires * 1000, now(), sale.contact_email, sale.notify_email, config.stripeMode || null]);
      for (const item of items) await c.query('INSERT INTO storefront_order_items (order_id,option_id,label,quantity,price_cents,product_id,turkey_type,size_label) VALUES (?,?,?,?,?,?,?,?)', [id, item.optionId, item.label, item.quantity, item.priceCents, item.productId, item.typeLabel, item.sizeLabel]);
      return id;
    }).catch(error => {
      // Only a known rejection of a new, rolled-back checkout allows cart edits.
      // Lost responses and existing sessions must keep their original retry token.
      if (error.status && !existingOrder) error.checkoutRejected = true;
      throw error;
    });
    try { await locked(id, () => syncSession(id)); }
    catch (error) {
      await db().query('UPDATE storefront_orders SET last_error=? WHERE id=?', [error.message, id]);
      if (error.status === 409) throw error;
      return { orderId: id, status: 'processing', url: null, message: 'Payment checkout is being prepared. Your stock is held; retry this checkout shortly.' };
    }
    const row = await order(id);
    return { orderId: id, status: row.status, url: row.status === 'reserved' ? row.checkout_url : null };
  }
  async function guestOrder(id, token) {
    await ready(); await authorize(id, token);
    return orderView(await order(id));
  }
  async function reconcile(id, token = null) {
    await ready();
    if (token !== null) await authorize(id, token);
    await locked(id, async () => {
      const row = await order(id);
      if (['creating', 'reserved', 'review'].includes(row.status)) await syncSession(id);
      const updated = await order(id);
      if (updated.stripe_payment_id) await syncRefunds(id);
    });
    return orderView(await order(id), token === null);
  }
  async function cancelReservation(id, token) {
    await ready(); await authorize(id, token);
    await locked(id, async () => {
      const row = await order(id);
      if (!['creating', 'reserved', 'review'].includes(row.status)) fail('Only unpaid reservations can be cancelled.', 409);
      stripeForOrder(row);
      await db().query('UPDATE storefront_orders SET cancel_requested=1 WHERE id=?', [id]);
      await syncSession(id);
    });
    return guestOrder(id, token);
  }
  async function attachSession(id, sessionId) {
    await ready();
    await locked(id, async () => {
      const row = await order(id);
      if (!['creating', 'reserved', 'review'].includes(row.status)) fail('Only unresolved checkouts can be reconciled with a receipt.', 409);
      if (row.stripe_session_id && row.stripe_session_id !== sessionId) fail('This order already has a different Stripe checkout.', 409);
      sessionId = text(sessionId, 'Stripe Checkout Session ID', 255);
      const sessionMode = stripeOrderMode({ stripe_session_id: sessionId });
      if (stripeOrderMode(row) && sessionMode && stripeOrderMode(row) !== sessionMode) fail('The Stripe checkout mode does not match this order.', 409);
      const orderStripe = stripeForOrder({ ...row, stripe_session_id: sessionId });
      const session = await orderStripe.checkout.sessions.retrieve(sessionId);
      if (session.metadata?.storefront_order_id !== id || session.amount_total !== row.total_cents || session.currency !== 'usd') fail('The Stripe checkout does not belong to this order.', 409);
      await confirmStripeMode(row, session);
      await db().query("UPDATE storefront_orders SET stripe_session_id=?,checkout_url=?,expires_ms=?,status='reserved',last_error=NULL WHERE id=?", [session.id, session.url || '', session.expires_at * 1000, id]);
      await syncSession(id);
    });
    return orderView(await order(id), true);
  }
  async function syncRefunds(id) {
    const row = await order(id);
    if (!row.stripe_payment_id) return;
    const orderStripe = stripeForOrder(row);
    const refunds = await orderStripe.refunds.list({ payment_intent: row.stripe_payment_id, limit: 100 });
    if (refunds.has_more) fail('Refund history requires manual review.', 409);
    const refunded = refunds.data.filter(r => r.status === 'succeeded').reduce((sum, r) => sum + r.amount, 0);
    const requested = refunds.data.find(r => r.id === row.refund_id || (row.refund_key && r.metadata?.storefront_refund_key === row.refund_key));
    const externalPending = refunds.data.some(r => r !== requested && ['pending', 'requires_action'].includes(r.status));
    await transaction(async c => {
      const current = await order(id, c, true);
      await c.query('UPDATE storefront_orders SET refunded_cents=?,refund_status=?,refund_id=COALESCE(?,refund_id) WHERE id=?', [refunded,
        requested?.status || (externalPending ? 'pending_external' : refunded ? (refunded >= current.total_cents ? 'succeeded' : 'partial') : current.refund_status), requested?.id || null, id]);
      if (refunded >= current.total_cents && current.status !== 'refunded') {
        if (!current.collected_ms) {
          for (const item of current.items) await stock(c, item.option_id, item.quantity, 0, 'Full refund: return uncollected turkey', id, current.refund_requested_by);
        }
        await c.query("UPDATE storefront_orders SET status='refunded',cancelled_ms=?,last_error=NULL WHERE id=?", [now(), id]);
        await queueEmail(c, id, 'refund');
      } else if (requested && ['failed', 'canceled'].includes(requested.status)) {
        await c.query("UPDATE storefront_orders SET status='refund_failed',last_error=? WHERE id=? AND status <> 'refunded'", ['Stripe refund failed or was cancelled. Review the payment before retrying.', id]);
      }
    });
  }
  async function issueRefund(id, actorId) {
    await ready();
    await locked(id, async () => {
      let row = await order(id);
      if (row.collected_ms) fail('Collected orders cannot be cancelled and restocked.', 409);
      if (!row.paid_ms) fail('Only paid orders can be refunded.', 409);
      const orderStripe = stripeForOrder(row);
      await syncRefunds(id);
      row = await order(id);
      if (row.status === 'refunded') return;
      if (row.refund_status === 'pending_external') fail('A refund is already pending in Stripe. Reconcile it before requesting another.', 409);
      if (row.refunded_cents) fail('This order has an external partial refund. Finish reconciliation in Stripe.', 409);
      if (!['paid', 'refund_pending', 'refund_failed'].includes(row.status)) fail('Order is not eligible for a refund.', 409);
      if (row.status === 'refund_failed') fail('Review the failed refund in Stripe before taking further action.', 409);
      if (!row.refund_key) {
        await db().query("UPDATE storefront_orders SET refund_key=?,status='refund_pending',refund_status='requested',refund_requested_by=?,refund_requested_ms=? WHERE id=?", [crypto.randomUUID(), actorId, now(), id]);
        row = await order(id);
      }
      if (!row.refund_id) {
        const refund = await orderStripe.refunds.create({ payment_intent: row.stripe_payment_id, amount: row.total_cents,
          metadata: { storefront_order_id: id, storefront_refund_key: row.refund_key } }, { idempotencyKey: `storefront-refund-${row.refund_key}` });
        await db().query('UPDATE storefront_orders SET refund_id=?,refund_status=? WHERE id=?', [refund.id, refund.status, id]);
      }
      await syncRefunds(id);
    });
    return orderView(await order(id), true);
  }
  async function collect(id, actorId) {
    await ready();
    await locked(id, async () => {
      await syncRefunds(id);
      await transaction(async c => {
        const row = await order(id, c, true);
        if (row.collected_ms) return;
        if (row.status !== 'paid' || row.refunded_cents || row.refund_status) fail('Only a paid order without a refund can be marked collected.', 409);
        await c.query("UPDATE storefront_orders SET status='collected',collected_ms=?,collected_by=? WHERE id=?", [now(), actorId, id]);
      });
    });
    return orderView(await order(id), true);
  }
  async function orders(filters = {}) {
    await ready();
    const where = ['sale_id=1']; const args = [];
    if (filters.status) { where.push('status=?'); args.push(filters.status); }
    if (filters.pickupId) { where.push("JSON_EXTRACT(pickup_json,'$.id')=?"); args.push(recordId(filters.pickupId, 'Pickup ID')); }
    if (filters.search) { where.push('(number LIKE ? OR customer_json LIKE ?)'); const term = `%${text(filters.search, 'search', 150)}%`; args.push(term, term); }
    const [rows] = await db().query(`SELECT * FROM storefront_orders WHERE ${where.join(' AND ')} ORDER BY created_ms DESC LIMIT 5000`, args);
    if (!rows.length) return [];
    const [items] = await db().query('SELECT * FROM storefront_order_items WHERE order_id IN (?) ORDER BY option_id', [rows.map(row => row.id)]);
    const byOrder = new Map();
    for (const item of items) { if (!byOrder.has(item.order_id)) byOrder.set(item.order_id, []); byOrder.get(item.order_id).push(item); }
    return rows.map(row => orderView({ ...row, items: byOrder.get(row.id) || [] }, true));
  }
  async function exportOrders(filters) {
    const rows = await orders(filters);
    const header = ['Order','Status','Name','Email','Phone','Address','Pickup group','Pickup location','Pickup date','Pickup address','Pickup hours','Turkey size','Quantity','Unit price USD','Order total USD','Variant ID','Catalog product ID','Turkey type','Weight range'];
    return [header, ...rows.flatMap(row => row.items.map(item => [row.number, row.status, row.customer.name, row.customer.email,
      row.customer.phone, [row.customer.addressLine1,row.customer.addressLine2,row.customer.city,row.customer.state,row.customer.postalCode,row.customer.country].filter(Boolean).join(', '),
      row.pickup.groupName,row.pickup.name,row.pickup.date,row.pickup.address,row.pickup.hours,item.label,item.quantity,(item.priceCents / 100).toFixed(2),(row.totalCents / 100).toFixed(2),item.optionId,item.productId,item.typeLabel,item.sizeLabel]))].map(row => row.map(csvCell).join(',')).join('\r\n');
  }
  async function webhook(event) {
    await ready();
    const [seen] = await db().query('SELECT event_id FROM storefront_webhooks WHERE event_id=?', [event.id]);
    if (seen.length) return;
    const object = event.data.object;
    let id;
    if (event.type.startsWith('checkout.session.')) {
      // Resolve only by a persisted session or this application's metadata.
      id = object.metadata?.storefront_order_id;
    } else if (['refund.created','refund.updated','refund.failed','charge.refunded'].includes(event.type)) {
      const [rows] = await db().query('SELECT id FROM storefront_orders WHERE stripe_payment_id=?', [typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id || '']);
      id = rows[0]?.id;
    }
    if (id) {
      const [exists] = await db().query('SELECT id,stripe_mode,stripe_session_id FROM storefront_orders WHERE id=?', [id]);
      if (exists.length) {
        const mode = stripeOrderMode(exists[0]);
        if (mode && typeof event.livemode === 'boolean' && event.livemode !== (mode === 'live')) fail('Stripe webhook mode does not match this order.', 409);
        await reconcile(id);
      }
    }
    await db().query('INSERT IGNORE INTO storefront_webhooks (event_id,event_type,processed_ms) VALUES (?,?,?)', [event.id, event.type, now()]);
  }
  async function deliverEmails() {
    if (!sendEmail) return;
    await locked('emails', async () => {
      const [rows] = await db().query("SELECT * FROM storefront_emails WHERE status='pending' AND next_attempt_ms<=? ORDER BY id LIMIT 50", [now()]);
      for (const row of rows) {
        try {
          const data = await order(row.order_id);
          if (row.kind === 'confirmation' && data.status === 'refunded') {
            await db().query("UPDATE storefront_emails SET status='skipped' WHERE id=?", [row.id]);
            continue;
          }
          // SMTP offers at-least-once delivery; a stable Message-ID lets recipients deduplicate retries.
          await sendEmail({ ...orderView(data), notifyEmail: data.notify_email, kind: row.kind, messageId: `<storefront-${row.order_id}-${row.kind}@deckfamilyfarm.com>` });
          await db().query("UPDATE storefront_emails SET status='sent',sent_ms=?,attempts=attempts+1,last_error=NULL WHERE id=?", [now(), row.id]);
        } catch (error) {
          await db().query('UPDATE storefront_emails SET attempts=attempts+1,last_error=?,next_attempt_ms=? WHERE id=?', [error.message, now() + Math.min(3600000, 60000 * 2 ** Math.min(row.attempts, 6)), row.id]);
        }
      }
    });
  }
  async function maintain() {
    await ready();
    const [rows] = await db().query(`SELECT id,status FROM storefront_orders
      WHERE status IN ('creating','reserved','refund_pending','refund_failed') OR (status='review' AND created_ms>?)
      ORDER BY CASE WHEN status IN ('creating','reserved','refund_pending') THEN 0 ELSE 1 END, created_ms LIMIT 200`, [now() - 23 * 3600000]);
    const results = [];
    for (const row of rows) {
      try {
        if (row.status === 'refund_pending') await issueRefund(row.id, null);
        else await reconcile(row.id);
        results.push({ id: row.id, ok: true });
      } catch (error) {
        await db().query('UPDATE storefront_orders SET last_error=? WHERE id=?', [error.message, row.id]);
        results.push({ id: row.id, error: error.message });
      }
    }
    await deliverEmails();
    return results;
  }
  async function stockHistory(id) {
    await ready();
    const [rows] = await db().query('SELECT * FROM storefront_stock_history WHERE option_id=? ORDER BY id DESC LIMIT 100', [recordId(id, 'Size ID')]);
    return rows;
  }
  async function emailStatus() {
    await ready();
    const [rows] = await db().query("SELECT order_id AS orderId,kind,attempts,last_error AS lastError FROM storefront_emails WHERE status='pending' ORDER BY id LIMIT 100");
    return rows;
  }
  async function storeSettings() {
    await ready();
    const [[row]] = await db().query('SELECT show_products, version FROM storefront_settings WHERE id=1');
    return { showProducts: Number(row.show_products) === 1, version: row.version };
  }
  async function saveStoreSettings(input, actorId) {
    await ready();
    if (typeof input?.showProducts !== 'boolean') fail('Choose whether to show products.');
    const version = recordId(input.version, 'Settings version');
    const [result] = await db().query(`UPDATE storefront_settings
      SET show_products=?, version=version+1, updated_ms=?, updated_by=? WHERE id=1 AND version=?`,
    [input.showProducts ? 1 : 0, now(), actorId, version]);
    if (!result.affectedRows) fail('Store visibility changed elsewhere. Reload the settings before saving.', 409);
    return { showProducts: input.showProducts, version: version + 1 };
  }
  return { storeSettings, saveStoreSettings, catalog, saveSetup, adjustStock, checkout, guestOrder, reconcile, cancelReservation, attachSession, issueRefund, collect, orders, exportOrders, webhook, maintain, deliverEmails, stockHistory, emailStatus };
}
