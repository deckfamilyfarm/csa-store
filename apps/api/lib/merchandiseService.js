import {
  fail, integer, text, hash, tokenHash, parse, checkoutReturnOrigin, json, uuid,
  fingerprint, addressInput, cartInput, proposedRetail, merchandiseSellingPrice, supplierProduct,
  verifySupplierOrder, US_SHIPPING_REGIONS, printifyProduction, printifyProductionFingerprint
} from './merchandiseCore.js';
import { assertMerchandiseSchema } from './merchandiseSchema.js';

const RETRY_WINDOW = 23 * 3600000;
const cents = value => value == null ? null : integer(value, 'Provider amount', 0, 100000000);
const id = value => text(value, 'record ID', 100);
const cartError = (message, status=409) => Object.assign(new Error(message), {status, cartReviewRequired:true});
export function createMerchandiseService({ pool, stripeClients = {}, provider, config = {}, now = Date.now, sendEmail } = {}) {
  const ready = () => assertMerchandiseSchema(pool);
  async function atomic(c, fn) { await c.beginTransaction(); try { const result=await fn(); await c.commit(); return result; } catch(e) { await c.rollback(); throw e; } }
  async function lock(key, fn) {
    await ready(); const c=await pool.getConnection(); const name='merch:'+hash(key).slice(0,56);
    try {
      const [[row]]=await c.query('SELECT GET_LOCK(?,10) acquired',[name]);
      if (Number(row.acquired)!==1) fail('This merchandise operation is busy. Retry shortly.',409);
      return await fn(c);
    } finally { await c.query('SELECT RELEASE_LOCK(?)',[name]).catch(()=>{}); c.release(); }
  }
  const client = mode => { if (!stripeClients[mode]) fail(`Matching Stripe ${mode} credentials are not configured.`,503); return stripeClients[mode]; };
  async function account(mode, expected) {
    const a=await client(mode).accounts.retrieve();
    if (!a.id || (expected && a.id!==expected) || (config.accountId && a.id!==config.accountId)) fail('Stripe account attribution requires review.',409);
    return a.id;
  }
  function enabled() {
    if (!config.checkoutEnabled) fail('Merchandise checkout is disabled.',409);
    if (!['test','live'].includes(config.mode || 'test')) fail('Configure a Stripe mode.',503);
    if (config.mode==='live' && !config.liveEnabled) fail('Live merchandise checkout is disabled.',409);
    if (!config.webhookReady) fail(`Configure the existing storefront Stripe webhook signing secret for ${config.mode} mode before merchandise checkout.`,503);
  }
  async function requireVendor(c,vendorId) {
    const value=integer(vendorId,'Existing local vendor',1,2147483647);
    const [[vendor]]=await c.query("SELECT id,name FROM vendors WHERE id=? AND NULLIF(TRIM(name),'') IS NOT NULL FOR UPDATE",[value]);
    if(!vendor)fail('Choose an existing named local vendor before saving merchandise.');
    return vendor;
  }
  async function rows(c=pool) {
    const [products]=await c.query('SELECT * FROM merch_products ORDER BY name,id');
    const [variants]=await c.query('SELECT * FROM merch_variants ORDER BY product_id,id');
    return products.map(p=>{
      const source=parse(p.source_json);
      const supplierVariants=source.catalog?.shipping && source.catalog?.provider
        ? new Set(source.catalog.variants?.variants?.map(v=>v.id))
        : new Set();
      return { id:p.id, name:p.name, description:p.description, category:p.category,vendorId:p.vendor_id,
      images:parse(p.images_json), supplier:'printify', shopId:Number(p.shop_id), externalId:p.external_id,
      provider:p.provider_name, active:Boolean(p.active), artworkReviewed:Boolean(p.artwork_reviewed),
      currency:p.currency, version:p.version, holds:parse(p.holds_json), updatedMs:Number(p.updated_ms),
      sourceVisible:source.product.visible===true,
      variants:variants.filter(v=>v.product_id===p.id).map(v=>({ id:v.id, externalId:Number(v.external_id), title:v.title, sku:v.sku,
        options:parse(v.options_json), sourceEnabled:Boolean(v.source_enabled), available:Boolean(v.available),
        canSell:Boolean(v.source_enabled && v.available && supplierVariants.has(Number(v.external_id))),
        enabled:Boolean(v.enabled), retailCents:v.retail_cents, proposedRetailCents:proposedRetail(v.cost_cents),
        sellingPriceCents:merchandiseSellingPrice(v.cost_cents,v.retail_cents),
        costCents:v.cost_cents, channelPriceCents:v.channel_price_cents })) };
    });
  }
  async function catalog(admin=false) {
    if (!admin && !config.catalogEnabled) return { enabled:false, products:[], checkoutEnabled:false };
    await ready(); const products=await rows();
    const [vendors]=admin?await pool.query("SELECT id,name FROM vendors WHERE NULLIF(TRIM(name),'') IS NOT NULL ORDER BY name"): [[]];
    const shipsNationwide=config.usDefaultTax==='not_collecting';
    const configuredRegions=Object.keys(config.taxRules || {}).filter(key=>/^US:[A-Z]{2}$/.test(key));
    return { category:'Branded Merchandise', enabled:Boolean(config.catalogEnabled),
      shipsNationwide,shippingRegions:[...new Set([...configuredRegions,...(shipsNationwide?US_SHIPPING_REGIONS:[])])].sort(),
      checkoutEnabled:Boolean(config.checkoutEnabled && (config.mode!=='live' || config.liveEnabled)), mode:config.mode || 'test',
      ...(admin ? { vendors,controls:{ liveCheckout:Boolean(config.liveEnabled), supplierOrders:Boolean(config.ordersEnabled), production:Boolean(config.productionEnabled) } } : {}),
      products:admin ? products : products.filter(p=>p.active && p.artworkReviewed && p.currency==='USD' && p.variants.some(v=>v.enabled && v.canSell && v.sellingPriceCents!==null)).map(p=>({ id:p.id,name:p.name,description:p.description,
        category:p.category,images:p.images.map(image=>({src:image.src,variantIds:p.variants.filter(v=>image.variant_ids?.includes(v.externalId)).map(v=>v.id)})),currency:p.currency,variants:p.variants.filter(v=>v.enabled && v.canSell && v.sellingPriceCents!==null)
          .map(v=>({id:v.id,title:v.title,options:v.options,retailCents:v.sellingPriceCents})) })) };
  }
  async function importRecords(records, actor, expected, {initialOnly=false}={}) {
    if (!Array.isArray(records) || !records.length || records.length>1000) fail('Provide a supplier snapshot.');
    const normalized=records.map(supplierProduct);
    if (new Set(normalized.map(p=>`${p.shopId}/${p.externalId}`)).size!==normalized.length) fail('Duplicate source product.');
    return lock('catalog',c=>atomic(c,async()=>{
      for (const p of normalized) {
        const vendor=await requireVendor(c,p.record.vendorId);
        const catalog=p.record.catalog || {};
        const holds=[];
        if (!catalog.variants || !catalog.shipping || !catalog.provider) holds.push('Supplier specifications or shipping are unavailable.');
        if (!p.variants.some(v=>v.enabled)) holds.push('Supplier has no enabled variants.');
        if (catalog.unresolvedArtwork?.length) holds.push('Generated or unresolved artwork layers require visual review.');
        const [[old]]=await c.query("SELECT * FROM merch_products WHERE supplier='printify' AND shop_id=? AND external_id=? FOR UPDATE",[p.shopId,p.externalId]);
        if (initialOnly && old) {
          const [[edited]]=await c.query('SELECT COUNT(*) n FROM merch_variants WHERE product_id=? AND (enabled<>0 OR retail_cents IS NOT NULL)',[old.id]);
          if (old.source_hash!==p.sourceHash || old.vendor_id!==vendor.id || old.active || old.artwork_reviewed || old.currency || Number(edited.n)) fail('Initial import found existing merchandise edits. They were preserved; review the catalog instead of overwriting it.',409);
        }
        if (expected && (!old || old.id!==expected.id || old.version!==expected.version)) fail('Product changed while supplier data was being fetched. Refresh and review.',409);
        if (old?.source_hash===p.sourceHash && old.vendor_id===vendor.id) continue;
        let productId=old?.id;
        if (!old) {
          const [result]=await c.query(`INSERT INTO merch_products
            (shop_id,external_id,vendor_id,name,description,images_json,source_json,source_hash,holds_json,provider_name,updated_ms,updated_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[p.shopId,p.externalId,vendor.id,p.name,p.description,json(p.images),json(p.record),p.sourceHash,json(holds),catalog.provider?.title || null,now(),actor || null]);
          productId=result.insertId;
        } else await c.query(`UPDATE merch_products SET vendor_id=?,name=?,description=?,images_json=?,source_json=?,source_hash=?,holds_json=?,provider_name=?,
          active=0,artwork_reviewed=0,version=version+1,updated_ms=?,updated_by=? WHERE id=?`,
          [vendor.id,p.name,p.description,json(p.images),json(p.record),p.sourceHash,json(holds),catalog.provider?.title || null,now(),actor || null,productId]);
        // Keep old variant identities/retail values for orders; missing variants become unavailable.
        await c.query('UPDATE merch_variants SET source_enabled=0,available=0 WHERE product_id=?',[productId]);
        // One batch per product avoids holding vendor/catalog locks across
        // thousands of network round trips during a connected draft import.
        const values=p.variants.map(v=>[productId,v.id,v.title,v.sku,json(v.options),v.enabled?1:0,v.available?1:0,v.cost,v.channelPrice,proposedRetail(v.cost)]);
        await c.query(`INSERT INTO merch_variants
          (product_id,external_id,title,sku,options_json,source_enabled,available,cost_cents,channel_price_cents,proposed_retail_cents)
          VALUES ${values.map(()=>'(?,?,?,?,?,?,?,?,?,?)').join(',')} ON DUPLICATE KEY UPDATE title=VALUES(title),sku=VALUES(sku),options_json=VALUES(options_json),
          source_enabled=VALUES(source_enabled),available=VALUES(available),cost_cents=VALUES(cost_cents),channel_price_cents=VALUES(channel_price_cents),proposed_retail_cents=VALUES(proposed_retail_cents)`,
          values.flat());
      }
      return { products:await rows(c) };
    }));
  }
  async function saveProduct(productId, body, actor) {
    productId=integer(productId,'Product ID',1,2147483647);
    return lock('catalog',c=>atomic(c,async()=>{
      const [[p]]=await c.query('SELECT * FROM merch_products WHERE id=? FOR UPDATE',[productId]);
      if (!p) fail('Merchandise product not found.',404);
      const vendor=await requireVendor(c,body.vendorId ?? p.vendor_id);
      if (body.version!==p.version) fail('Supplier data or another edit changed this product. Reload and review.',409);
      if (typeof body.active!=='boolean' || typeof body.artworkReviewed!=='boolean') fail('Choose product and artwork review settings.');
      if (body.currency!==null && body.currency!=='USD') fail('Only explicitly confirmed USD pricing is supported.');
      const [variants]=await c.query('SELECT * FROM merch_variants WHERE product_id=? FOR UPDATE',[productId]);
      if (!Array.isArray(body.variants) || body.variants.length>2000) fail('Provide variant edits.');
      const seen=new Set();
      for (const input of body.variants) {
        const v=variants.find(v=>v.id===input.id);
        if (!v || seen.has(v.id) || typeof input.enabled!=='boolean') fail('Unknown or duplicate variant edit.');
        seen.add(v.id); v.enabled=input.enabled;
        v.retail_cents=input.retailCents===null ? null : integer(input.retailCents,'Retail price in cents',50,10000000);
      }
      if (body.active) {
        const record=parse(p.source_json), selected=variants.filter(v=>v.enabled);
        if (record.product.currency && String(record.product.currency).toUpperCase()!=='USD') fail('Supplier currency does not match the supported USD checkout.');
        if (!record.catalog?.variants || !record.catalog?.shipping || !record.catalog?.provider) fail('Supplier data is unavailable; keep this product disabled.');
        if (!body.artworkReviewed || body.currency!=='USD') fail('Review artwork and explicitly confirm USD before enabling.');
        if (!selected.length) fail('Enable at least one available variant.');
        for (const v of selected) {
          if (!v.source_enabled || !v.available || !record.catalog.variants.variants.some(row=>row.id===Number(v.external_id))) fail('A selected variant is not currently available from the supplier.');
          if (merchandiseSellingPrice(v.cost_cents,v.retail_cents)===null) fail('Each selected variant needs a valid price above its Printify production cost. Review its default or modified price.');
        }
      }
      for (const v of variants) if (seen.has(v.id)) await c.query('UPDATE merch_variants SET retail_cents=?,enabled=? WHERE id=?',[v.retail_cents,v.enabled?1:0,v.id]);
      await c.query('UPDATE merch_products SET vendor_id=?,active=?,artwork_reviewed=?,currency=?,version=version+1,updated_ms=?,updated_by=? WHERE id=?',
        [vendor.id,body.active?1:0,body.artworkReviewed?1:0,body.currency,now(),actor,productId]);
      return (await rows(c)).find(p=>p.id===productId);
    }));
  }
  async function refreshProduct(productId, actor) {
    await ready(); const [[p]]=await pool.query('SELECT * FROM merch_products WHERE id=?',[integer(productId,'Product ID',1)]);
    if (!p) fail('Merchandise product not found.',404);
    const product=await provider.product(p.shop_id,p.external_id);
    const catalog=await provider.metadata(product);
    return importRecords([{shopId:Number(p.shop_id),vendorId:p.vendor_id,product,catalog}],actor,{id:p.id,version:p.version});
  }
  async function resolveCart(items, c=pool) {
    const result=[];
    const issues=[];
    for (const input of items) {
      const [[v]]=await c.query(`SELECT v.*,p.shop_id,p.external_id product_external_id,p.name,p.vendor_id,local_vendor.name vendor_name,p.source_json,p.source_hash,p.currency,p.version,p.active,p.artwork_reviewed
        FROM merch_variants v JOIN merch_products p ON p.id=v.product_id JOIN vendors local_vendor ON local_vendor.id=p.vendor_id WHERE v.id=? AND NULLIF(TRIM(local_vendor.name),'') IS NOT NULL`,[input.variantId]);
      const retailCents=v && merchandiseSellingPrice(v.cost_cents,v.retail_cents);
      if (!v || !v.active || !v.artwork_reviewed || !v.enabled || !v.source_enabled || !v.available || v.currency!=='USD' || retailCents===null) {
        issues.push({variantId:input.variantId,code:'unavailable'});
        continue;
      }
      if (retailCents!==input.expectedPriceCents) {
        issues.push({variantId:input.variantId,code:'price_changed',retailCents});
        continue;
      }
      const source=parse(v.source_json).product;
      result.push({ variantId:v.id,productId:v.product_id,shopId:Number(v.shop_id),externalProductId:v.product_external_id,
        externalVariantId:Number(v.external_id),name:v.name,title:v.title,quantity:input.quantity,retailCents,costCents:v.cost_cents,
        productVersion:v.version,sourceHash:v.source_hash,vendorId:v.vendor_id,vendorName:v.vendor_name,
        productionHash:fingerprint(printifyProduction(source)),productionStableHash:printifyProductionFingerprint(source) });
    }
    if (new Set(result.map(v=>v.shopId)).size>1) fail('These products use different supplier shops. Separate checkout is required.');
    return {items:result,issues};
  }
  async function selected(input,c=pool) {
    const {items,issues}=await resolveCart(input,c);
    if (issues.some(issue=>issue.code==='unavailable')) throw cartError('An item is no longer available. Review your cart.');
    if (issues.length) throw cartError('A retail price changed. Review the updated price in your cart.');
    return items;
  }
  const cartSupplierCache=new Map();
  function supplierForCart(row) {
    const key=`${row.shopId}/${row.externalProductId}`;
    const saved=cartSupplierCache.get(key);
    if (saved && saved.expiresAt>now()) return saved.read;
    for (const [id,entry] of cartSupplierCache) if (entry.expiresAt<=now()) cartSupplierCache.delete(id);
    if (cartSupplierCache.size>=80) cartSupplierCache.delete(cartSupplierCache.keys().next().value);
    const entry={expiresAt:now()+15000,read:provider.product(row.shopId,row.externalProductId)};
    cartSupplierCache.set(key,entry);
    entry.read.catch(()=>{ if (cartSupplierCache.get(key)===entry) cartSupplierCache.delete(key); });
    return entry.read;
  }
  async function matchesProduction(row,product) {
    const liveStableHash=printifyProductionFingerprint(product);
    if (row.productionStableHash) return liveStableHash===row.productionStableHash;
    if (fingerprint(printifyProduction(product))===row.productionHash) return true;
    // An old paid order contains only the raw digest. Use its original source
    // record if still present, and confirm it matches the frozen digest first.
    const [[original]]=await pool.query('SELECT source_json FROM merch_products WHERE id=? AND source_hash=?',[row.productId,row.sourceHash]);
    const source=original && parse(original.source_json).product;
    return Boolean(source && fingerprint(printifyProduction(source))===row.productionHash && printifyProductionFingerprint(source)===liveStableHash);
  }
  async function supplierIssues(items,preview=false) {
    const products=new Map();
    const results=await Promise.all(items.map(async row=>{
      const key=`${row.shopId}/${row.externalProductId}`;
      if (!products.has(key)) products.set(key,preview?supplierForCart(row):provider.product(row.shopId,row.externalProductId));
      let product;
      try { product=await products.get(key); }
      catch (error) { return {variantId:row.variantId,code:error.providerStatus===404?'unavailable':'verification_unavailable'}; }
      const variant=product.variants?.find(v=>v.id===row.externalVariantId);
      if (Number(product.shop_id)!==row.shopId || !variant?.is_enabled || !variant.is_available) return {variantId:row.variantId,code:'unavailable'};
      if (variant.cost!==row.costCents || !await matchesProduction(row,product)) return {variantId:row.variantId,code:'supplier_review'};
      return null;
    }));
    return results.filter(Boolean);
  }
  async function verifyCurrent(items,fulfillment=false) {
    const issues=await supplierIssues(items);
    const affected=new Set(issues.map(issue=>issue.variantId));
    for (const row of items) if (affected.has(row.variantId)) cartSupplierCache.delete(`${row.shopId}/${row.externalProductId}`);
    if (issues.some(issue=>issue.code==='verification_unavailable')) {
      throw cartError(fulfillment?'Unable to verify the supplier listing. Retry fulfillment.':'We couldn’t confirm availability. Check your cart and try again.',503);
    }
    if (issues.length) throw cartError(fulfillment?'Supplier cost, availability or artwork changed. Review before fulfillment.':'An item changed and needs review. Return to your cart for details.');
  }
  async function reviewCart(body) {
    enabled(); await ready();
    const {items,issues}=await resolveCart(cartInput(body.items));
    return {issues:[...issues,...await supplierIssues(items,true)]};
  }
  async function tax(items, shipping, address, mode) {
    const region=`${address.country}:${address.region}`;
    const rules=config.taxRules || {};
    if (!Object.hasOwn(rules,region)) {
      if (config.usDefaultTax==='not_collecting' && US_SHIPPING_REGIONS.includes(region)) {
        return { cents:0, rateId:null, shippingTaxable:false, basis:'configured_no_collection', rule:fingerprint({region,policy:config.usDefaultTax}) };
      }
      fail('Tax configuration for this shipping destination has not been reviewed.',409);
    }
    const rule=rules[region];
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('Complete the reviewed tax configuration.',503);
    if (rule.exempt===true) return { cents:0, rateId:null, shippingTaxable:false, basis:'configured_exemption', rule:fingerprint(rule) };
    if (!rule.rateId || typeof rule.shippingTaxable!=='boolean') fail('Complete the reviewed tax configuration.',503);
    const rate=await client(mode).taxRates.retrieve(rule.rateId);
    if (!rate.active || rate.inclusive || rate.country!==address.country || (rate.state && rate.state!==address.region) || rate.tax_type==='not_collecting') fail('Stripe tax rate requires review.',409);
    const percentage=Number(rate.percentage);
    if (!Number.isFinite(percentage) || percentage<0 || percentage>100) fail('Invalid Stripe tax rate.',503);
    const total=items.reduce((sum,row)=>sum+Math.round(row.quantity*row.retailCents*percentage/100),0)+(rule.shippingTaxable?Math.round(shipping*percentage/100):0);
    return { cents:total, rateId:rate.id, percentage, shippingTaxable:rule.shippingTaxable, basis:'reviewed_stripe_tax_rate', rule:fingerprint(rule) };
  }
  const supplierLines = items => items.map(row=>({ product_id:row.externalProductId,variant_id:row.externalVariantId,quantity:row.quantity }));
  async function quote(body) {
    enabled(); await ready();
    const access=tokenHash(body.token), input=cartInput(body.items), address=addressInput(body.customer), mode=config.mode || 'test';
    const items=await selected(input); await verifyCurrent(items);
    const shippingQuote=await provider.quoteShipping(items[0].shopId,{line_items:supplierLines(items),address_to:address});
    const shipping=integer(shippingQuote.standard,'Standard shipping quote',0,10000000);
    const taxes=await tax(items,shipping,address,mode), stripeAccount=await account(mode);
    const subtotal=items.reduce((sum,row)=>sum+row.quantity*row.retailCents,0);
    const snapshot={items,address,mode,stripeAccount,shippingMethod:1,shippingCents:shipping,tax:taxes,subtotalCents:subtotal,
      totalCents:integer(subtotal+shipping+taxes.cents,'Order total',50,10000000),currency:'usd'};
    // Remote reads happen before local row locks. Reject a concurrent local save.
    const quoteId=uuid(), expiresMs=now()+10*60000;
    await lock('catalog',c=>atomic(c,async()=>{
      const current=await selected(input,c);
      if (fingerprint(current)!==fingerprint(items)) fail('Catalog changed while calculating shipping. Review a new quote.',409);
      await c.query('INSERT INTO commerce_quotes (id,token_hash,snapshot_json,expires_ms,created_ms) VALUES (?,?,?,?,?)',[quoteId,access,json(snapshot),expiresMs,now()]);
    }));
    return {quoteId,expiresMs,...snapshot};
  }
  async function checkout(body, origin) {
    const access=tokenHash(body.token), requestHash=fingerprint({quoteId:id(body.quoteId),origin:checkoutReturnOrigin(config.baseUrl || 'https://store.deckfamilyfarm.com',origin)});
    const orderId=await lock('checkout:'+access,async c=>{
      try {
      const [[existing]]=await c.query('SELECT * FROM commerce_orders WHERE token_hash=?',[access]);
      if (existing) {
        if (existing.request_hash!==requestHash) fail('This checkout token already belongs to a different frozen order. Recover that order first.',409);
        return existing.id;
      }
      enabled();
      const [[q]]=await c.query('SELECT * FROM commerce_quotes WHERE id=? AND token_hash=?',[body.quoteId,access]);
      if (!q || q.expires_ms<now() || q.order_id) fail('Shipping quote expired or was already used. Request a fresh quote.',409);
      const snapshot=parse(q.snapshot_json);
      if (snapshot.mode!==(config.mode || 'test')) fail('Checkout mode changed. Request a fresh quote.',409);
      await account(snapshot.mode,snapshot.stripeAccount);
      const current=await selected(snapshot.items.map(row=>({variantId:row.variantId,quantity:row.quantity,expectedPriceCents:row.retailCents})),c);
      // Quotes created before stable artwork IDs were introduced retain their
      // original digest in the Stripe snapshot. Compare those without the new field.
      const comparable=current.map(({productionStableHash,...row},index)=>snapshot.items[index]?.productionStableHash
        ? {...row,productionStableHash} : row);
      if (fingerprint(comparable)!==fingerprint(snapshot.items)) throw cartError('The catalog changed after quoting. Review your cart for an updated quote.');
      await verifyCurrent(current);
      const shipping=await provider.quoteShipping(snapshot.items[0].shopId,{line_items:supplierLines(snapshot.items),address_to:snapshot.address});
      if (shipping.standard!==snapshot.shippingCents || fingerprint(await tax(snapshot.items,snapshot.shippingCents,snapshot.address,snapshot.mode))!==fingerprint(snapshot.tax)) fail('Shipping or tax changed. Review a new quote.',409);
      const orderId=uuid(), fulfillmentId=uuid(), returnOrigin=checkoutReturnOrigin(config.baseUrl || 'https://store.deckfamilyfarm.com',origin), expires=Math.floor(now()/1000)+1800;
      const taxRates=snapshot.tax.rateId ? [snapshot.tax.rateId] : undefined;
      const request={mode:'payment',payment_method_types:['card'],client_reference_id:orderId,customer_email:snapshot.address.email,
        metadata:{commerce_order_id:orderId,order_kind:'merchandise',quote_fingerprint:fingerprint(snapshot)},payment_intent_data:{metadata:{commerce_order_id:orderId,order_kind:'merchandise',quote_fingerprint:fingerprint(snapshot)}},
        line_items:snapshot.items.map(row=>({quantity:row.quantity,...(taxRates?{tax_rates:taxRates}:{}),price_data:{currency:'usd',unit_amount:row.retailCents,
          product_data:{name:`${row.name} — ${row.title}`,metadata:{merch_variant_id:String(row.variantId),fulfillment_kind:'printify'}}}})),
        success_url:`${returnOrigin}/#/merchandise/order?order=${orderId}`,cancel_url:`${returnOrigin}/#/merchandise/order?order=${orderId}&cancelled=1`,expires_at:expires};
      if (snapshot.shippingCents) request.line_items.push({quantity:1,...(taxRates && snapshot.tax.shippingTaxable?{tax_rates:taxRates}:{}),
        price_data:{currency:'usd',unit_amount:snapshot.shippingCents,product_data:{name:'Merchandise shipping',metadata:{fulfillment_kind:'printify_shipping'}}}});
      const supplierRequest={external_id:`csa-merch-${fulfillmentId}`,label:`MERCH-${orderId.slice(0,8).toUpperCase()}`,
        line_items:supplierLines(snapshot.items),shipping_method:1,send_shipping_notification:false,address_to:snapshot.address};
      await atomic(c,async()=>{
        for (const row of snapshot.items) {
          const [[current]]=await c.query('SELECT p.version,p.active,p.vendor_id,v.name vendor_name FROM merch_products p JOIN vendors v ON v.id=p.vendor_id WHERE p.id=? FOR UPDATE',[row.productId]);
          if (!current?.active || current.version!==row.productVersion || current.vendor_id!==row.vendorId || current.vendor_name!==row.vendorName || !current.vendor_name.trim()) fail('Catalog or vendor changed before checkout was saved. Review a fresh quote.',409);
        }
        const [claimed]=await c.query('UPDATE commerce_quotes SET order_id=? WHERE id=? AND order_id IS NULL AND expires_ms>=?',[orderId,q.id,now()]);
        if (claimed.affectedRows!==1) fail('Quote was already consumed or expired.',409);
        await c.query(`INSERT INTO commerce_orders
          (id,number,token_hash,quote_id,request_hash,stripe_mode,stripe_account,subtotal_cents,shipping_cents,tax_cents,total_cents,currency,
          snapshot_json,stripe_request_json,stripe_key,expires_ms,created_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [orderId,supplierRequest.label,access,q.id,requestHash,snapshot.mode,snapshot.stripeAccount,snapshot.subtotalCents,snapshot.shippingCents,snapshot.tax.cents,snapshot.totalCents,'usd',json(snapshot),json(request),`merch-checkout-${orderId}`,expires*1000,now()]);
        await c.query('INSERT INTO commerce_fulfillments (id,order_id,shop_id,external_id,request_json,updated_ms) VALUES (?,?,?,?,?,?)',
          [fulfillmentId,orderId,snapshot.items[0].shopId,supplierRequest.external_id,json(supplierRequest),now()]);
      });
      return orderId;
      } catch(error) {
        // Set this flag only while holding this token's lock and after any local
        // transaction rolled back. Unknown/committed outcomes retain the token.
        const [[saved]]=await c.query('SELECT id FROM commerce_orders WHERE token_hash=?',[access]);
        if (!saved && ([400,409].includes(error.status) || error.cartReviewRequired)) error.checkoutRejected=true;
        throw error;
      }
    });
    return resumeCheckout(orderId,body.token);
  }
  async function resumeCheckout(orderId, token) {
    return lock('order:'+id(orderId),async c=>{
      const [[order]]=await c.query('SELECT * FROM commerce_orders WHERE id=?',[orderId]);
      if (!order || order.token_hash!==tokenHash(token)) fail('Order access not found.',404);
      if (order.paid_ms) return {orderId,status:order.status};
      if (order.status==='expired') return {orderId,status:'expired'};
      const stripe=client(order.stripe_mode); await account(order.stripe_mode,order.stripe_account);
      let session;
      if (order.stripe_session_id) session=await stripe.checkout.sessions.retrieve(order.stripe_session_id);
      else {
        if (order.stripe_attempt_ms && now()-Number(order.stripe_attempt_ms)>=RETRY_WINDOW) fail('Checkout outcome is held for reconciliation; no replacement payment was created.',409);
        if (!order.stripe_attempt_ms) await c.query('UPDATE commerce_orders SET stripe_attempt_ms=? WHERE id=?',[now(),orderId]);
        try { session=await stripe.checkout.sessions.create(parse(order.stripe_request_json),{idempotencyKey:order.stripe_key}); }
        catch { await c.query("UPDATE commerce_orders SET last_error='Stripe checkout outcome unknown; retry the same order.' WHERE id=?",[orderId]); fail('Checkout outcome is unknown. Keep this order token and retry the same order.',503); }
      }
      verifySession(order,session,false);
      if (session.status==='expired') { await c.query("UPDATE commerce_orders SET status='expired',stripe_session_id=? WHERE id=?",[session.id,orderId]); return {orderId,status:'expired'}; }
      await c.query('UPDATE commerce_orders SET stripe_session_id=?,checkout_url=?,status=?,last_error=NULL WHERE id=?',[session.id,session.url || null,session.payment_status==='paid'?'awaiting_webhook':'pending',orderId]);
      return {orderId,status:session.payment_status==='paid'?'awaiting_webhook':'pending',checkoutUrl:session.status==='open'?session.url:null};
    });
  }
  function verifySession(order,session,paid) {
    if (!session?.id || session.metadata?.commerce_order_id!==order.id || session.client_reference_id!==order.id ||
      session.metadata?.order_kind!=='merchandise' || session.metadata?.quote_fingerprint!==fingerprint(parse(order.snapshot_json)) || session.currency!==order.currency || session.amount_total!==order.total_cents ||
      session.livemode!==(order.stripe_mode==='live') || (order.stripe_session_id && order.stripe_session_id!==session.id)) fail('Stripe checkout attribution requires review.',409);
    if (paid && (session.status!=='complete' || session.payment_status!=='paid')) fail('Stripe has not confirmed successful payment.',409);
  }
  async function recoverCheckout(orderId,sessionId) {
    return lock('order:'+id(orderId),async c=>{
      const [[o]]=await c.query('SELECT * FROM commerce_orders WHERE id=?',[orderId]);
      if (!o) fail('Order not found.',404);
      await account(o.stripe_mode,o.stripe_account);
      const session=await client(o.stripe_mode).checkout.sessions.retrieve(text(sessionId,'Stripe Checkout Session ID',255));
      verifySession(o,session,false);
      await c.query('UPDATE commerce_orders SET stripe_session_id=?,checkout_url=?,last_error=NULL WHERE id=?',[session.id,session.url || null,o.id]);
      return {orderId:o.id,sessionId:session.id,paidWebhookStillRequired:!o.paid_ms};
    });
  }
  async function queueEmail(c,order,kind,message) {
    const snapshot=parse(order.snapshot_json);
    await c.query('INSERT IGNORE INTO commerce_emails (order_id,kind,payload_json,next_attempt_ms) VALUES (?,?,?,?)',
      [order.id,kind,json({to:snapshot.address.email,subject:`Deck Family Farm ${order.number}: ${kind.replaceAll('_',' ')}`,
        text:`${message}\nOrder: ${order.number}\nOpen the confirmation page in the browser used at checkout to view current status.`,messageId:`<merch-${order.id}-${kind}@deckfamilyfarm.com>`}),now()]);
  }
  async function stripeWebhook(event) {
    const object=event.data?.object;
    let orderId=object?.metadata?.commerce_order_id;
    const paymentId=typeof object?.payment_intent==='string'?object.payment_intent:object?.payment_intent?.id;
    if (!orderId && ['refund.updated','refund.created','refund.failed','charge.refunded'].includes(event.type) && paymentId) {
      await ready();
      const [[owned]]=await pool.query('SELECT id FROM commerce_orders WHERE stripe_payment_id=?',[paymentId]);
      orderId=owned?.id;
    }
    if (!orderId) return {ignored:true}; // This endpoint cannot claim turkey/member payments.
    return lock('order:'+id(orderId),async c=>{
      const [[order]]=await c.query('SELECT * FROM commerce_orders WHERE id=?',[orderId]);
      if (!order) return {ignored:true};
      if (event.livemode!==(order.stripe_mode==='live') || (event.account && event.account!==order.stripe_account)) fail('Stripe event account or mode does not match.',409);
      const [[seen]]=await c.query("SELECT * FROM commerce_webhooks WHERE provider='stripe' AND event_id=?",[id(event.id)]);
      if (seen) { if (seen.payload_hash!==fingerprint(event)) fail('Webhook ID was reused with different content.',409); return {duplicate:true}; }
      await account(order.stripe_mode,order.stripe_account);
      if (['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) {
        const stripe=client(order.stripe_mode), session=await stripe.checkout.sessions.retrieve(object.id);
        verifySession(order,session,true);
        const paymentId=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
        const payment=await stripe.paymentIntents.retrieve(paymentId);
        if (payment.id!==paymentId || payment.status!=='succeeded' || payment.currency!==order.currency || payment.amount_received!==order.total_cents ||
          payment.metadata?.commerce_order_id!==order.id || payment.metadata?.order_kind!=='merchandise' || payment.metadata?.quote_fingerprint!==fingerprint(parse(order.snapshot_json)) || payment.livemode!==(order.stripe_mode==='live') ||
          (order.stripe_payment_id && order.stripe_payment_id!==paymentId)) fail('Stripe payment attribution requires review.',409);
        await atomic(c,async()=>{
          if (!order.paid_ms) {
            await c.query("UPDATE commerce_orders SET status='paid',paid_ms=?,stripe_session_id=?,stripe_payment_id=?,last_error=NULL WHERE id=?",[now(),session.id,paymentId,order.id]);
            await c.query("UPDATE commerce_fulfillments SET status='queued',updated_ms=? WHERE order_id=? AND status='awaiting_payment'",[now(),order.id]);
            await queueEmail(c,order,'payment_received',`Payment received. Merchandise ships separately from farm pickups or deliveries.${order.stripe_mode==='test'?' This is a test order; no production will be submitted.':''}`);
          }
          await c.query('INSERT INTO commerce_webhooks VALUES (?,?,?,?)',['stripe',event.id,fingerprint(event),now()]);
        });
      } else if (event.type==='checkout.session.expired') {
        const session=await client(order.stripe_mode).checkout.sessions.retrieve(object.id);
        verifySession(order,session,false);
        if (!order.paid_ms && session.status==='expired') await atomic(c,async()=>{
          await c.query("UPDATE commerce_orders SET status='expired',stripe_session_id=?,last_error=NULL WHERE id=?",[session.id,order.id]);
          await c.query("UPDATE commerce_fulfillments SET status='expired',updated_ms=? WHERE order_id=? AND attempted_ms IS NULL AND remote_id IS NULL",[now(),order.id]);
        });
        await c.query('INSERT INTO commerce_webhooks VALUES (?,?,?,?)',['stripe',event.id,fingerprint(event),now()]);
      } else {
        if (['refund.updated','refund.created','refund.failed','charge.refunded'].includes(event.type) && order.paid_ms) await syncRefunds(c,order,false);
        await c.query('INSERT INTO commerce_webhooks VALUES (?,?,?,?)',['stripe',event.id,fingerprint(event),now()]);
      }
      return {received:true};
    });
  }
  async function viewOrder(orderId, token, admin=false) {
    await ready(); const [[o]]=await pool.query('SELECT * FROM commerce_orders WHERE id=?',[id(orderId)]);
    if (!o || (!admin && o.token_hash!==tokenHash(token))) fail('Order access not found. Use the browser used at checkout or contact the farm.',404);
    const snapshot=parse(o.snapshot_json);
    const [fulfillments]=await pool.query('SELECT * FROM commerce_fulfillments WHERE order_id=?',[o.id]);
    const [operations]=await pool.query('SELECT * FROM commerce_operations WHERE order_id=? ORDER BY created_ms',[o.id]);
    return {id:o.id,number:o.number,status:o.status,mode:o.stripe_mode,createdMs:Number(o.created_ms),paid:Boolean(o.paid_ms),
      subtotalCents:o.subtotal_cents,shippingCents:o.shipping_cents,taxCents:o.tax_cents,totalCents:o.total_cents,refundedCents:o.refunded_cents,
      financialHold:Boolean(o.financial_hold),items:snapshot.items.map(row=>({name:row.name,title:row.title,quantity:row.quantity,retailCents:row.retailCents})),
      address:snapshot.address,fulfillments:fulfillments.map(f=>({id:f.id,kind:f.kind,status:f.status,tracking:parse(f.tracking_json || '[]'),
        ...(admin?{remoteId:f.remote_id,shopId:Number(f.shop_id),lastError:f.last_error,actualCostCents:f.actual_cost_cents,actualShippingCents:f.actual_shipping_cents,actualTaxCents:f.actual_tax_cents}: {})})),
      ...(admin?{stripeSessionId:o.stripe_session_id,stripePaymentId:o.stripe_payment_id,stripeFeeCents:o.stripe_fee_cents,lastError:o.last_error,
        operations:operations.map(op=>({id:op.id,kind:op.kind,status:op.status,amountCents:op.amount_cents,lastError:op.last_error,createdMs:Number(op.created_ms)}))}: {})};
  }
  async function supplierReceipt(c, fulfillment, receipt) {
    verifySupplierOrder(receipt,parse(fulfillment.request_json));
    const costs=cents(receipt.total_price), shipping=cents(receipt.total_shipping), supplierTax=cents(receipt.total_tax);
    const tracking=(receipt.shipments || []).map(s=>({carrier:String(s.carrier || ''),number:String(s.number || ''),
      url:(()=>{try {const u=new URL(s.url);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}})(),deliveredAt:s.delivered_at || null}));
    await c.query('UPDATE commerce_fulfillments SET remote_id=?,status=?,receipt_json=?,tracking_json=?,actual_cost_cents=?,actual_shipping_cents=?,actual_tax_cents=?,last_error=NULL,updated_ms=? WHERE id=?',
      [String(receipt.id),text(receipt.status,'Supplier status',40),json(receipt),json(tracking),costs,shipping,supplierTax,now(),fulfillment.id]);
    return receipt;
  }
  async function processFulfillment(fulfillmentId) {
    await ready(); const [[initial]]=await pool.query('SELECT order_id FROM commerce_fulfillments WHERE id=?',[id(fulfillmentId)]);
    if (!initial) fail('Fulfillment not found.',404);
    return lock('order:'+initial.order_id,async c=>{
      try {
      const [[f]]=await c.query('SELECT * FROM commerce_fulfillments WHERE id=?',[fulfillmentId]);
      const [[o]]=await c.query('SELECT * FROM commerce_orders WHERE id=?',[f.order_id]);
      if (!o.paid_ms) fail('Verified Stripe payment webhook is required before fulfillment.',409);
      if (f.remote_id) return supplierReceipt(c,f,await provider.order(f.shop_id,f.remote_id));
      if (f.attempted_ms) {
        const found=await provider.findOrder(f.shop_id,f.external_id);
        if (found) return supplierReceipt(c,f,found);
        fail('Supplier creation outcome remains unknown. No replacement order will be sent.',409);
      }
      if (o.financial_hold || o.refunded_cents || f.status==='canceled') fail('Financial or cancellation review holds this fulfillment.',409);
      if (o.stripe_mode==='test' && !provider.supportsTestOrders) {
        await c.query("UPDATE commerce_fulfillments SET status='held_test_mode',last_error='Stripe test payments never create real Printify orders.',updated_ms=? WHERE id=?",[now(),f.id]);
        return {held:true};
      }
      if (!config.ordersEnabled || !config.manualApprovalVerified || String(config.approvedShopId)!==String(f.shop_id)) {
        await c.query("UPDATE commerce_fulfillments SET status='held_disabled',last_error='Supplier orders disabled or manual approval not verified.',updated_ms=? WHERE id=?",[now(),f.id]);
        return {held:true};
      }
      const finances=await syncRefunds(c,o,false);
      if (finances.refundedCents || finances.financialHold) fail('Stripe refunds hold new supplier submission. Review financial receipts.',409);
      const body=parse(f.request_json);
      await verifyCurrent(parse(o.snapshot_json).items,true);
      await c.query("UPDATE commerce_fulfillments SET attempted_ms=?,status='creating',updated_ms=? WHERE id=?",[now(),now(),f.id]);
      try {
        let receipt;
        try { receipt=await provider.createOrder(f.shop_id,body); }
        catch(error) { if (!error.existingOrderId) throw error; receipt=await provider.order(f.shop_id,error.existingOrderId); }
        // Creation responses may be minimal. Confirm through the shop-scoped read.
        if (!receipt?.id) fail('Supplier returned no order ID.',409);
        await c.query("UPDATE commerce_fulfillments SET remote_id=?,status='confirming',updated_ms=? WHERE id=?",[String(receipt.id),now(),f.id]);
        return supplierReceipt(c,f,await provider.order(f.shop_id,receipt.id));
      } catch(error) {
        await c.query('UPDATE commerce_fulfillments SET status=?,attempted_ms=IF(? IS TRUE,NULL,attempted_ms),last_error=?,updated_ms=? WHERE id=?',
          [error.definitive?'failed':'unknown',Boolean(error.definitive),error.definitive?`Supplier rejected request (HTTP ${error.providerStatus}); retry retains the same frozen request.`:'Supplier outcome unknown. Reconcile existing order; never create a replacement.',now(),f.id]);
        throw Object.assign(new Error('Supplier fulfillment requires reconciliation. See the order dashboard.'),{status:409});
      }
      } catch(error) {
        await c.query(`UPDATE commerce_fulfillments SET status=IF(status='awaiting_payment',status,IF(attempted_ms IS NULL AND remote_id IS NULL,'held_review',status)),
          last_error=?,updated_ms=? WHERE id=?`,[error.status?String(error.message).slice(0,500):'Supplier read failed; reconciliation will retry without replacing the operation.',now(),fulfillmentId]);
        throw error;
      }
    });
  }
  async function printifyWebhook(event) {
    await ready();
    const shop=integer(event.resource?.data?.shop_id,'Shop ID',1,2147483647), remote=id(event.resource?.id);
    if (!String(event.type).startsWith('order:')) return {ignored:true};
    let [[f]]=await pool.query('SELECT * FROM commerce_fulfillments WHERE kind=\'printify\' AND shop_id=? AND remote_id=?',[shop,remote]);
    if (!f) {
      const [[candidate]]=await pool.query('SELECT id FROM commerce_fulfillments WHERE shop_id=? AND attempted_ms IS NOT NULL AND remote_id IS NULL LIMIT 1',[shop]);
      if (!candidate) return {ignored:true};
      const receipt=await provider.order(shop,remote);
      [[f]]=await pool.query('SELECT * FROM commerce_fulfillments WHERE shop_id=? AND external_id=?',[shop,receipt.metadata?.shop_order_id || '']);
      if (!f) return {ignored:true};
    }
    return lock('order:'+f.order_id,async c=>{
      const [[seen]]=await c.query("SELECT * FROM commerce_webhooks WHERE provider='printify' AND event_id=?",[id(event.id)]);
      if (seen) { if (seen.payload_hash!==fingerprint(event)) fail('Supplier webhook ID changed content.',409); return {duplicate:true}; }
      const receipt=await provider.order(shop,remote);
      await atomic(c,async()=>{
        await supplierReceipt(c,f,receipt);
        await c.query('INSERT INTO commerce_webhooks VALUES (?,?,?,?)',['printify',event.id,fingerprint(event),now()]);
        if ((receipt.shipments || []).length) {
          const [[o]]=await c.query('SELECT * FROM commerce_orders WHERE id=?',[f.order_id]);
          await queueEmail(c,o,'shipping_update','Your merchandise shipping information is available on your order page.');
        }
      });
      return {received:true};
    });
  }
  // Cancellation, production release and payment refunds are separate reviewed operations.
  async function operationBaseline(c,o,kind) {
    const [[f]]=await c.query('SELECT * FROM commerce_fulfillments WHERE order_id=?',[o.id]);
    if (kind==='refund') return {payment:o.stripe_payment_id,mode:o.stripe_mode,remaining:o.total_cents-o.refunded_cents,financialHold:o.financial_hold};
    if (!f?.remote_id) fail('No confirmed supplier order exists. A Stripe refund does not cancel production.',409);
    const receipt=await provider.order(f.shop_id,f.remote_id); await supplierReceipt(c,f,receipt);
    return {fulfillmentId:f.id,shopId:Number(f.shop_id),remoteId:f.remote_id,status:receipt.status,cost:receipt.total_price,shipping:receipt.total_shipping,tax:receipt.total_tax,refunded:o.refunded_cents,mode:o.stripe_mode};
  }
  async function reviewOperation(orderId,kind,actor) {
    if (!['refund','cancel','production'].includes(kind)) fail('Unsupported operation.');
    return lock('order:'+id(orderId),async c=>{
      let [[o]]=await c.query('SELECT * FROM commerce_orders WHERE id=?',[orderId]);
      if (!o?.paid_ms) fail('A paid merchandise order is required.',409);
      if (['production','refund'].includes(kind)) {
        await syncRefunds(c,o,false);
        [[o]]=await c.query('SELECT * FROM commerce_orders WHERE id=?',[orderId]);
      }
      const [[existing]]=await c.query("SELECT * FROM commerce_operations WHERE order_id=? AND kind=? AND status NOT IN ('applied','rejected') ORDER BY created_ms LIMIT 1",[o.id,kind]);
      if (existing && (existing.attempted_ms || existing.baseline_hash===fingerprint(await operationBaseline(c,o,kind)))) return {id:existing.id,kind,status:existing.status,amountCents:existing.amount_cents,request:parse(existing.request_json)};
      if (existing) await c.query("UPDATE commerce_operations SET status='rejected',last_error='Unused review superseded after explicit re-review.' WHERE id=?",[existing.id]);
      const baseline=await operationBaseline(c,o,kind), operationId=uuid();
      if (kind==='refund' && (baseline.remaining<=0 || baseline.financialHold)) fail('No remaining reviewed payment amount is available for refund.',409);
      if (kind==='cancel' && !['on-hold','payment-not-received'].includes(baseline.status)) fail('Supplier production cannot currently be canceled.',409);
      if (kind==='production' && (!['on-hold'].includes(baseline.status) || o.refunded_cents || o.financial_hold)) fail('Supplier or financial state holds production release.',409);
      if (kind==='production' && [baseline.cost,baseline.shipping,baseline.tax].some(value=>!Number.isSafeInteger(value) || value<0)) fail('Confirm supplier production, shipping and tax costs before release.',409);
      const request=kind==='refund'?{payment_intent:o.stripe_payment_id,amount:baseline.remaining,metadata:{commerce_order_id:o.id,commerce_operation_id:operationId}}:baseline;
      await c.query('INSERT INTO commerce_operations (id,order_id,fulfillment_id,kind,baseline_hash,request_json,request_key,amount_cents,created_ms,reviewed_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [operationId,o.id,baseline.fulfillmentId || null,kind,fingerprint(baseline),json(request),`merch-${kind}-${operationId}`,kind==='refund'?baseline.remaining:null,now(),actor]);
      return {id:operationId,kind,status:'reviewed',amountCents:kind==='refund'?baseline.remaining:null,request};
    });
  }
  async function confirmOperation(orderId,operationId,actor) {
    return lock('order:'+id(orderId),async c=>{
      let [[o]]=await c.query('SELECT * FROM commerce_orders WHERE id=?',[orderId]);
      const [[op]]=await c.query('SELECT * FROM commerce_operations WHERE id=? AND order_id=?',[id(operationId),orderId]);
      if (!o || !op) fail('Reviewed operation not found.',404);
      if (op.status==='applied') return {id:op.id,status:'applied'};
      if (op.status==='rejected') fail('This operation is no longer valid. Review a new operation.',409);
      if (!op.attempted_ms && ['refund','production'].includes(op.kind)) {
        await syncRefunds(c,o,false);
        [[o]]=await c.query('SELECT * FROM commerce_orders WHERE id=?',[orderId]);
      }
      const request=parse(op.request_json);
      if (!op.attempted_ms && fingerprint(await operationBaseline(c,o,op.kind))!==op.baseline_hash) fail('Order changed since review. This operation must be reviewed again.',409);
      if (op.kind==='refund') {
        const stripe=client(o.stripe_mode); await account(o.stripe_mode,o.stripe_account);
        let receipt;
        if (op.attempted_ms) {
          const all=[];
          for await (const refund of stripe.refunds.list({payment_intent:o.stripe_payment_id,limit:100})) all.push(refund);
          receipt=all.find(r=>r.id===op.remote_id || r.metadata?.commerce_operation_id===op.id);
          if (!receipt) fail('Refund outcome unknown. Reconcile the original refund; no replacement request was sent.',409);
        } else {
          await c.query("UPDATE commerce_operations SET status='attempting',attempted_ms=?,approved_by=? WHERE id=?",[now(),actor,op.id]);
          try { receipt=await stripe.refunds.create(request,{idempotencyKey:op.request_key}); }
          catch { await c.query("UPDATE commerce_operations SET status='unknown',last_error='Refund outcome unknown; reconcile original receipt.' WHERE id=?",[op.id]); fail('Refund outcome unknown; reconcile before retry.',409); }
        }
        if (receipt.payment_intent!==o.stripe_payment_id || receipt.amount!==op.amount_cents || receipt.currency!==o.currency ||
          receipt.metadata?.commerce_order_id!==o.id || receipt.metadata?.commerce_operation_id!==op.id) fail('Refund attribution requires review.',409);
        await atomic(c,async()=>{
          await c.query('UPDATE commerce_operations SET status=?,receipt_json=?,remote_id=?,applied_ms=? WHERE id=?',
            [receipt.status==='succeeded'?'applied':receipt.status==='failed'?'rejected':'pending',json(receipt),receipt.id,receipt.status==='succeeded'?now():null,op.id]);
          if (receipt.status==='succeeded') {
            await c.query('UPDATE commerce_orders SET refunded_cents=refunded_cents+?,financial_hold=0 WHERE id=?',[op.amount_cents,o.id]);
            await queueEmail(c,o,'refund_received','Your merchandise payment refund was confirmed. Supplier production cancellation is handled separately.');
          }
        });
      } else {
        const [[f]]=await c.query('SELECT * FROM commerce_fulfillments WHERE id=?',[op.fulfillment_id]);
        if (op.attempted_ms) {
          const receipt=await provider.order(f.shop_id,f.remote_id); await supplierReceipt(c,f,receipt);
          const confirmed=op.kind==='cancel'?receipt.status==='canceled':Boolean(receipt.sent_to_production_at) || ['sending-to-production','in-production','fulfilled'].includes(receipt.status);
          if (!confirmed) fail('Supplier operation remains uncertain. No replacement POST will be sent.',409);
          await c.query("UPDATE commerce_operations SET status='applied',receipt_json=?,applied_ms=? WHERE id=?",[json(receipt),now(),op.id]);
        } else {
          if (o.stripe_mode==='test' && !provider.supportsTestOrders) fail('Stripe test orders cannot change real Printify production.',409);
          if (!config.ordersEnabled || !config.manualApprovalVerified || String(config.approvedShopId)!==String(f.shop_id) || (op.kind==='production' && !config.productionEnabled)) fail('Supplier cancellation/production controls are disabled.',409);
          await c.query("UPDATE commerce_operations SET status='attempting',attempted_ms=?,approved_by=? WHERE id=?",[now(),actor,op.id]);
          try {
            if (op.kind==='cancel') await provider.cancelOrder(f.shop_id,f.remote_id);
            else await provider.sendToProduction(f.shop_id,f.remote_id);
            const receipt=await provider.order(f.shop_id,f.remote_id); await supplierReceipt(c,f,receipt);
            const confirmed=op.kind==='cancel'?receipt.status==='canceled':Boolean(receipt.sent_to_production_at) || ['sending-to-production','in-production','fulfilled'].includes(receipt.status);
            if (!confirmed) throw new Error('Supplier result is not confirmed.');
            await c.query("UPDATE commerce_operations SET status='applied',receipt_json=?,applied_ms=? WHERE id=?",[json(receipt),now(),op.id]);
          } catch { await c.query("UPDATE commerce_operations SET status='unknown',last_error='Supplier operation outcome unknown; reconcile receipt.' WHERE id=?",[op.id]); fail('Supplier operation outcome unknown; reconcile before retry.',409); }
        }
      }
      const [[result]]=await c.query('SELECT id,kind,status,amount_cents amountCents FROM commerce_operations WHERE id=?',[op.id]);
      return result;
    });
  }
  async function refreshFees(orderId) {
    return lock('order:'+id(orderId),async c=>{
      const [[o]]=await c.query('SELECT * FROM commerce_orders WHERE id=?',[orderId]);
      if (!o?.stripe_payment_id) return;
      await account(o.stripe_mode,o.stripe_account);
      const stripe=client(o.stripe_mode), payment=await stripe.paymentIntents.retrieve(o.stripe_payment_id,{expand:['latest_charge.balance_transaction']});
      const charge=payment.latest_charge, balance=charge?.balance_transaction;
      if (payment.metadata?.commerce_order_id!==o.id || payment.id!==o.stripe_payment_id || !balance?.id || balance.currency!==o.currency || charge.payment_intent!==o.stripe_payment_id || charge.amount!==o.total_cents || balance.source!==charge.id) return;
      await c.query('UPDATE commerce_orders SET stripe_fee_cents=? WHERE id=?',[cents(balance.fee),o.id]);
    });
  }
  async function syncRefunds(c,o,acknowledgeExternal,actor=null) {
    await account(o.stripe_mode,o.stripe_account);
    let total=0, external=false, pending=false;
    const [operations]=await c.query("SELECT * FROM commerce_operations WHERE order_id=? AND kind='refund'",[o.id]);
    const receipts=[];
    const operationReceipts=new Set();
    for await (const receipt of client(o.stripe_mode).refunds.list({payment_intent:o.stripe_payment_id,limit:100})) {
      if (receipt.payment_intent!==o.stripe_payment_id || receipt.currency!==o.currency) fail('Refund receipt attribution requires review.',409);
      const op=operations.find(op=>op.id===receipt.metadata?.commerce_operation_id);
      if (op && !op.attempted_ms) fail('Refund receipt references an unattempted local operation; financial review is required.',409);
      if (op && (receipt.amount!==op.amount_cents || receipt.metadata?.commerce_order_id!==o.id)) fail('Refund receipt does not match its frozen operation.',409);
      if (op && operationReceipts.has(op.id)) fail('Multiple refund receipts claim the same operation; financial review is required.',409);
      if (op) operationReceipts.add(op.id);
      if (receipt.status==='succeeded') total+=cents(receipt.amount);
      if (receipt.status==='pending') pending=true;
      if (!op && receipt.status!=='failed' && receipt.status!=='canceled') external=true;
      receipts.push({id:receipt.id,amountCents:receipt.amount,status:receipt.status,external:!op,operationId:op?.id || null,fullReceipt:receipt});
    }
    if (total>o.total_cents || total<o.refunded_cents) fail('Refund totals require financial review.',409);
    const externalReceipts=receipts.filter(r=>r.external).map(({id,amountCents,status})=>({id,amountCents,status})).sort((a,b)=>a.id.localeCompare(b.id));
    const acknowledgmentHash=fingerprint(externalReceipts);
    const [[ack]]=await c.query("SELECT id FROM commerce_operations WHERE order_id=? AND kind='external_refund_ack' AND status='applied' AND baseline_hash=? LIMIT 1",[o.id,acknowledgmentHash]);
    const acknowledged=Boolean(ack || acknowledgeExternal);
    const financialHold=pending || (external && !acknowledged);
    await atomic(c,async()=>{
      if (acknowledgeExternal && external && !ack) await c.query(`INSERT INTO commerce_operations
        (id,order_id,kind,status,baseline_hash,request_json,request_key,created_ms,reviewed_by,approved_by,applied_ms)
        VALUES (?,?,'external_refund_ack','applied',?,?,?,?,?,?,?)`,[uuid(),o.id,acknowledgmentHash,json(externalReceipts),`merch-refund-ack-${fingerprint({order:o.id,receipts:externalReceipts})}`,now(),actor,actor,now()]);
      for (const receipt of receipts) {
        const op=operations.find(op=>op.id===receipt.operationId);
        if (op && receipt.status==='succeeded') await c.query("UPDATE commerce_operations SET status='applied',applied_ms=COALESCE(applied_ms,?),remote_id=?,receipt_json=? WHERE id=?",[now(),receipt.id,json(receipt.fullReceipt),op.id]);
      }
      await c.query('UPDATE commerce_orders SET refunded_cents=?,financial_hold=? WHERE id=?',[total,financialHold?1:0,o.id]);
    });
    return {receipts:receipts.map(({fullReceipt,...safe})=>safe),refundedCents:total,externalRefunds:external,financialHold,supplierCancellationPerformed:false};
  }
  async function reconcileFinances(orderId,acknowledgeExternal=false,actor=null) {
    return lock('order:'+id(orderId),async c=>{
      const [[o]]=await c.query('SELECT * FROM commerce_orders WHERE id=?',[orderId]);
      if (!o?.stripe_payment_id) fail('Paid order not found.',404);
      return syncRefunds(c,o,acknowledgeExternal,actor);
    });
  }
  async function orders() {
    await ready(); const [list]=await pool.query('SELECT id FROM commerce_orders ORDER BY created_ms DESC LIMIT 200');
    return Promise.all(list.map(o=>viewOrder(o.id,null,true)));
  }
  async function report() {
    await ready(); const [rows]=await pool.query('SELECT o.*,f.actual_cost_cents,f.actual_shipping_cents,f.actual_tax_cents FROM commerce_orders o JOIN commerce_fulfillments f ON f.order_id=o.id WHERE o.paid_ms IS NOT NULL');
    return ['test','live'].map(mode=>{
      const selected=rows.filter(o=>o.stripe_mode===mode), sum=fn=>selected.reduce((total,o)=>total+fn(o),0);
      return {mode,paidOrders:selected.length,grossSalesCents:sum(o=>o.subtotal_cents),shippingChargedCents:sum(o=>o.shipping_cents),taxCollectedCents:sum(o=>o.tax_cents),
        refundsCents:sum(o=>o.refunded_cents),productionCostCents:sum(o=>o.actual_cost_cents ?? parse(o.snapshot_json).items.reduce((n,row)=>n+row.costCents*row.quantity,0)),
        shippingCostCents:sum(o=>o.actual_shipping_cents ?? o.shipping_cents),supplierTaxCents:sum(o=>o.actual_tax_cents ?? 0),
        knownStripeFeesCents:sum(o=>o.stripe_fee_cents || 0),missingStripeFees:selected.filter(o=>o.stripe_fee_cents==null).length,
        estimatedCostOrders:selected.filter(o=>o.actual_cost_cents==null || o.actual_shipping_cents==null || o.actual_tax_cents==null).length,
        estimatedGrossProfitCents:sum(o=>o.subtotal_cents+o.shipping_cents-o.refunded_cents-(o.actual_cost_cents ?? parse(o.snapshot_json).items.reduce((n,row)=>n+row.costCents*row.quantity,0))-(o.actual_shipping_cents ?? o.shipping_cents)-(o.actual_tax_cents ?? 0)-(o.stripe_fee_cents || 0)),
        note:'Estimates use frozen production/shipping quotes and zero for unknown supplier tax/fees. Missing fees and unconfirmed supplier costs are listed; refunds do not cancel supplier orders.'};
    });
  }
  async function deliverEmails() {
    if (!sendEmail) return;
    return lock('email',async c=>{
      const [due]=await c.query("SELECT * FROM commerce_emails WHERE status='pending' AND next_attempt_ms<=? ORDER BY id LIMIT 20",[now()]);
      for (const mail of due) {
        try { await sendEmail(parse(mail.payload_json)); await c.query("UPDATE commerce_emails SET status='sent',sent_ms=?,attempts=attempts+1,last_error=NULL WHERE id=?",[now(),mail.id]); }
        catch { await c.query("UPDATE commerce_emails SET attempts=attempts+1,next_attempt_ms=?,last_error='Email delivery failed; retry scheduled.' WHERE id=?",[now()+Math.min(3600000,60000*2**Math.min(mail.attempts,6)),mail.id]); }
      }
    });
  }
  async function maintenance() {
    await ready();
    const [pending]=await pool.query("SELECT id FROM commerce_orders WHERE paid_ms IS NULL AND stripe_session_id IS NOT NULL AND status='pending' ORDER BY created_ms LIMIT 20");
    for (const row of pending) await lock('order:'+row.id,async c=>{
      const [[o]]=await c.query('SELECT * FROM commerce_orders WHERE id=?',[row.id]);
      if(o.paid_ms || o.status!=='pending')return;
      try {
        await account(o.stripe_mode,o.stripe_account);
        const session=await client(o.stripe_mode).checkout.sessions.retrieve(o.stripe_session_id);verifySession(o,session,false);
        if(session.status==='expired')await c.query("UPDATE commerce_orders SET status='expired',last_error=NULL WHERE id=?",[o.id]);
        else if(session.payment_status==='paid')await c.query("UPDATE commerce_orders SET status='awaiting_webhook',last_error='Payment observed; replay the verified Stripe event to release fulfillment.' WHERE id=?",[o.id]);
      }catch{await c.query("UPDATE commerce_orders SET last_error='Stripe status read failed; no replacement checkout or fulfillment was created.' WHERE id=?",[o.id]);}
    });
    const [due]=await pool.query("SELECT f.id,f.order_id FROM commerce_fulfillments f JOIN commerce_orders o ON o.id=f.order_id WHERE o.paid_ms IS NOT NULL AND f.status NOT IN ('awaiting_payment','expired','canceled','delivered') ORDER BY f.updated_ms LIMIT 20");
    const results=[];
    for (const f of due) {
      try { await processFulfillment(f.id); await refreshFees(f.order_id); results.push({id:f.id,ok:true}); }
      catch { results.push({id:f.id,ok:false}); }
    }
    await deliverEmails(); return results;
  }
  return {catalog,importRecords,saveProduct,refreshProduct,reviewCart,quote,checkout,resumeCheckout,stripeWebhook,viewOrder,
    processFulfillment,printifyWebhook,reviewOperation,confirmOperation,reconcileFinances,recoverCheckout,refreshFees,orders,report,deliverEmails,maintenance};
}
