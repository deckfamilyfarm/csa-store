import { getPool } from '../db.js';
import { ensureEnterprisePricingSchema } from './enterprisePricingSchema.js';
import { roundRatio } from './enterprisePricingEngine.js';
import { promotionIsActive } from './enterprisePromotionsCore.js';
const parse = v => typeof v === 'string' ? JSON.parse(v) : v;
const fail = (message, status=409) => { throw Object.assign(new Error(message), {status}); };
export function salePrice(cents, bp) {
  return cents == null ? null : roundRatio(BigInt(cents)*BigInt(10000-bp),10000n);
}
export function effectiveProductSale(productId, packages, desired, promotions, now=Date.now(), squareEnabled=false) {
  const ids = new Set(packages.map(p=>Number(p.packageId ?? p.id)));
  const related = promotions.filter(p=>p.input?.packageIds?.some(id=>ids.has(Number(id))));
  if (desired) return { revision:Number(desired.revision), discountBp:Number(desired.discount_bp), active:Number(desired.discount_bp)>0,
    promotionId:desired.promotion_id, channels: related.find(p=>Number(p.id)===Number(desired.promotion_id))?.input.channels || (squareEnabled?['localline','square']:['localline']) };
  const active = related.filter(p=>!['pending','cancelled','expired'].includes(p.status) && promotionIsActive(p.input,now));
  const simple = active.length===1 && active[0].input.packageIds.length===ids.size && active[0].input.packageIds.every(id=>ids.has(Number(id)));
  return {revision:0, active:active.length>0, discountBp:simple?active[0].input.discountBp:0,
    channels:simple?active[0].input.channels:[], complex:related.length>0&&!simple, promotionId:simple?active[0].id:null};
}
export async function readProductSales(connection, productIds) {
  if (!productIds.length) return new Map();
  const [rows]=await connection.query('SELECT * FROM enterprise_product_sales WHERE product_id IN (?)',[productIds]);
  const result=new Map(rows.map(r=>[Number(r.product_id),r]));
  // The explicit product sale flag takes precedence over stale formula-profile
  // defaults. A disabled or percentage-less sale must never be reactivated.
  const [legacy]=await connection.query(`SELECT p.id AS product_id,
    COALESCE(ps.on_sale,pp.on_sale,0) AS enabled,
    CASE WHEN ps.product_id IS NOT NULL THEN ps.sale_discount ELSE pp.sale_discount END AS discount
    FROM products p LEFT JOIN product_sales ps ON ps.product_id=p.id
    LEFT JOIN product_pricing_profiles pp ON pp.product_id=p.id WHERE p.id IN (?)`,[productIds]);
  for(const row of legacy) if(!result.has(Number(row.product_id)) && Number(row.enabled)===1 && Number(row.discount)>0 && Number(row.discount)<1)
    result.set(Number(row.product_id),{product_id:row.product_id,revision:0,discount_bp:Math.round(Number(row.discount)*10000),promotion_id:null,inherited:true});
  return result;
}
export function applySaleOutput(output, sale) {
  if (!output || !sale) return output;
  const result=structuredClone(output), bp=sale.active?sale.discountBp:0;
  result.squareSaleUnitCents=sale.channels.includes('square')?salePrice(result.squareUnitCents,bp):result.squareUnitCents;
  for(const pkg of result.packages) {
    pkg.localLineSaleCents=sale.channels.includes('localline')?salePrice(pkg.localLineRegularCents,bp):pkg.localLineRegularCents;
    pkg.squareSaleCents=sale.channels.includes('square')?salePrice(pkg.squareVariationCents,bp):pkg.squareVariationCents;
  }
  return result;
}
export async function saveProductSale(productId, body, user) {
  await ensureEnterprisePricingSchema();
  const bp=Number(body.discountBp), pid=Number(productId);
  if(!Number.isSafeInteger(pid)||pid<=0||!Number.isSafeInteger(bp)||bp<0||bp>=10000) fail('Enter a sale percentage from 0 to 99.99.',400);
  const db=await getPool().getConnection();
  const locks=[];
  try {
    const lock=`csa-product-sale-${pid}`;
    const [held]=await db.query('SELECT GET_LOCK(?,0) AS acquired',[lock]);
    if(Number(held[0].acquired)!==1) fail('A sale publication is running. Try again when it finishes.');
    locks.push(lock);
    await db.beginTransaction();
    const [rows]=await db.query(`SELECT p.name,v.name AS vendorName,s.active_revision_id AS revisionId,r.input_json,r.output_json
      FROM products p LEFT JOIN vendors v ON v.id=p.vendor_id JOIN enterprise_pricing_product_state s ON s.product_id=p.id
      JOIN enterprise_pricing_revisions r ON r.id=s.active_revision_id WHERE p.id=? FOR UPDATE`,[pid]);
    const row=rows[0]; if(!row) fail('Save regular pricing before adding a sale.');
    if(!row.vendorName?.trim()) fail('Choose a named vendor before saving.');
    if(/deposit/i.test(row.name)) fail('Deposits use their fixed price.');
    const input=parse(row.input_json), output=parse(row.output_json), ids=output.packages.map(p=>p.packageId);
    const [states]=await db.query('SELECT * FROM enterprise_product_sales WHERE product_id=? FOR UPDATE',[pid]);
    const state=states[0];
    if(Number(body.expectedPricingRevision)!==Number(row.revisionId)) fail('Regular prices changed. Refresh before saving the sale.');
    if(Number(body.expectedRevision)!==Number(state?.revision||0)) {
      if(state&&Number(state.discount_bp)===bp) { await db.rollback(); return {saved:true}; }
      fail('This sale changed in another window. Refresh before saving.');
    }
    const [sales]=await db.query("SELECT * FROM enterprise_promotions WHERE status IN ('pending','approved','scheduled','active','partial','cancelling') FOR UPDATE");
    const related=sales.filter(s=>parse(s.input_json).packageIds.some(id=>ids.includes(id)));
    for(const sale of related) {
      const saleLock=`csa-enterprise-promotion-${sale.id}`;
      const [held]=await db.query('SELECT GET_LOCK(?,0) AS acquired',[saleLock]);
      if(Number(held[0].acquired)!==1) fail('A sale publication is running. Try again when it finishes.');
      locks.push(saleLock);
      const i=parse(sale.input_json);
      if(i.packageIds.length!==ids.length||!i.packageIds.every(id=>ids.includes(id))||Date.parse(i.startAt)>Date.now()||i.endAt||
        i.channels.length!==(input.squareEnabled?2:1)) fail('This product has a scheduled or package/channel-specific sale. Review it in Sales first.');
      if(['partial','cancelling'].includes(sale.status)||['sending','confirming','uncertain'].includes(sale.square_status)) fail('Finish the existing sale publication before editing it.');
    }
    const supersedes=related.filter(s=>s.status!=='pending').map(s=>Number(s.id));
    const locations=related.map(s=>parse(s.input_json).squareLocationIds).find(l=>l?.length)||String(process.env.SQUARE_LOCATION_ID||'').split(',').filter(Boolean);
    const promotionInput={name:`${row.name} — ${bp?`${bp/100}% off`:'end sale'}`,description:'Inline product sale',discountBp:bp,regularRevisionId:Number(row.revisionId),
      startAt:new Date().toISOString(),endAt:null,timezone:'America/Los_Angeles',packageIds:ids,
      channels:input.squareEnabled?['localline','square']:['localline'],squareLocationIds:locations,
      localProductId:pid,localSaleRevision:Number(state?.revision||0)+1,supersedes,endSale:bp===0};
    // Mappings and remote baselines are collected at approval, never during a local save.
    const frozen={packages:[],localLinePrices:output.packages.map(p=>({packageId:p.packageId,regularCents:p.localLineRegularCents,saleCents:salePrice(p.localLineRegularCents,bp)}))};
    const actor=Number(user.userId||user.adminId);
    const [legacyBefore]=await db.query(`SELECT ps.on_sale AS productOn,ps.sale_discount AS productDiscount,
      pp.on_sale AS profileOn,pp.sale_discount AS profileDiscount FROM products p
      LEFT JOIN product_sales ps ON ps.product_id=p.id LEFT JOIN product_pricing_profiles pp ON pp.product_id=p.id WHERE p.id=?`,[pid]);
    // Once explicitly edited, versioned sale settings own this product. Retain
    // the former legacy settings in the event rather than allowing two writers.
    await db.query('UPDATE product_sales SET on_sale=0,sale_discount=0 WHERE product_id=?',[pid]);
    await db.query('UPDATE product_pricing_profiles SET on_sale=0,sale_discount=0 WHERE product_id=?',[pid]);
    for(const old of related.filter(s=>s.status==='pending')) await db.query("UPDATE enterprise_promotions SET status='cancelled',updated_at=UTC_TIMESTAMP() WHERE id=?",[old.id]);
    const [insert]=await db.query("INSERT INTO enterprise_promotions(status,input_json,output_json,editor_id,created_at,updated_at) VALUES('pending',?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())",[JSON.stringify(promotionInput),JSON.stringify(frozen),actor]);
    await db.query(`INSERT INTO enterprise_product_sales(product_id,revision,discount_bp,promotion_id,editor_id,updated_at) VALUES(?,?,?,?,?,UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE revision=VALUES(revision),discount_bp=VALUES(discount_bp),promotion_id=VALUES(promotion_id),editor_id=VALUES(editor_id),updated_at=UTC_TIMESTAMP()`,[pid,promotionInput.localSaleRevision,bp,insert.insertId,actor]);
    await db.query("INSERT INTO enterprise_promotion_events(promotion_id,event,actor_id,details_json,created_at) VALUES(?,'local_sale_saved',?,?,UTC_TIMESTAMP())",[insert.insertId,actor,JSON.stringify({before:state||null,legacyBefore:legacyBefore[0],input:promotionInput})]);
    if(bp===0&&!supersedes.length) await db.query("UPDATE enterprise_promotions SET status='cancelled',square_status='cancelled',localline_status='restored' WHERE id=?",[insert.insertId]);
    await db.commit(); return {saved:true,promotionId:insert.insertId};
  } catch(e) {await db.rollback();throw e;} finally {for(const lock of locks.reverse()) await db.query('SELECT RELEASE_LOCK(?)',[lock]).catch(()=>{});db.release();}
}
