import { promotionIsActive } from './enterprisePromotionsCore.js';
import {roundRatio} from './enterprisePricingEngine.js';
const parse=value=>typeof value==='string'?JSON.parse(value):value;
// active_revision_id means the saved store price. Channel approval is separate.
export async function readSavedEnterprisePricing(connection, productIds=null, now=Date.now()) {
  if(productIds && !productIds.length)return new Map();
  let rows;
  try{[rows]=await connection.query(`SELECT s.product_id AS productId,r.id AS revisionId,r.status,r.input_json AS inputJson,r.output_json AS outputJson,r.created_at AS createdAt
    FROM enterprise_pricing_product_state s JOIN enterprise_pricing_revisions r ON r.id=s.active_revision_id
    ${productIds?'WHERE s.product_id IN (?)':''}`,productIds?[productIds]:[]);}catch(error){if(error.code==='ER_NO_SUCH_TABLE')return new Map();throw error;}
  const result=new Map(rows.map(r=>[Number(r.productId),{...r,input:parse(r.inputJson),output:parse(r.outputJson)}]));
  if(!result.size)return result;
  const [sales]=await connection.query("SELECT status,input_json AS inputJson,output_json AS outputJson,square_status AS squareStatus,localline_status AS localLineStatus FROM enterprise_promotions WHERE status IN ('active','scheduled','partial')");
  for(const row of sales){const input=parse(row.inputJson),output=parse(row.outputJson);
    if(!(promotionIsActive(input, now)))continue;
    for(const price of result.values())for(const pkg of price.output.packages){
      if(!input.packageIds.includes(pkg.packageId))continue;
      const sale=output.localLinePrices?.find(p=>p.packageId===pkg.packageId);
      if(input.channels.includes('localline')&&row.localLineStatus==='active'&&sale)pkg.localLineSaleCents=sale.saleCents;
      if(input.channels.includes('square')&&row.squareStatus==='verified'&&pkg.squareVariationCents!=null)pkg.squareSaleCents=roundRatio(BigInt(pkg.squareVariationCents)*BigInt(10000-input.discountBp),10000n);
    }
  }
  return result;
}
