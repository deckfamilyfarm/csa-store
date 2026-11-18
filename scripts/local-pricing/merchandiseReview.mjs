// Local evidence/export only. The invoking wrapper installs the isolated DB guard.
import fs from 'node:fs/promises';
import {getPool} from '../../apps/api/db.js';
import {createMerchandiseService} from '../../apps/api/lib/merchandiseService.js';
import {proposedRetail} from '../../apps/api/lib/merchandiseCore.js';
const pool=getPool(),out=new URL('../../reports/printify-discovery-2026-11-17/',import.meta.url);
const csv=value=>{let text=String(value??'');if(/^[=+@\-\t\r]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
try {
  const {products}=await createMerchandiseService({pool}).catalog(true);
  const summary=products.map(p=>{
    const source=p.variants.filter(v=>v.sourceEnabled),costs=source.map(v=>v.costCents).filter(Number.isInteger),prices=source.map(v=>v.channelPriceCents).filter(Number.isInteger),proposals=costs.map(proposedRetail);
    return {product:p.name,localProductId:p.id,localVendorId:p.vendorId,printifyShopId:p.shopId,printifyProductId:p.externalId,
      supplierEnabledVariants:source.length,availableEnabledVariants:source.filter(v=>v.available).length,
      savedRetailMinCents:prices.length?Math.min(...prices):null,savedRetailMaxCents:prices.length?Math.max(...prices):null,
      reportedCostMinCents:costs.length?Math.min(...costs):null,reportedCostMaxCents:costs.length?Math.max(...costs):null,
      proposedRetailMinCents:proposals.length?Math.min(...proposals):null,proposedRetailMaxCents:proposals.length?Math.max(...proposals):null,
      proposalCurrency:'USD — requires supplier currency confirmation',priceApproved:false,active:p.active,
      notes:[...p.holds,...(!p.sourceVisible?['Source product hidden.']:[]),...(source.some(v=>v.channelPriceCents<v.costCents)?['Saved source retail below reported production cost.']:[])].join(' ')};
  });
  const columns=Object.keys(summary[0] || {});
  await fs.writeFile(new URL('retail-price-proposal.csv',out),[columns.map(csv).join(','),...summary.map(row=>columns.map(c=>csv(row[c])).join(','))].join('\n')+'\n',{mode:0o600});
  const mappings=products.flatMap(p=>p.variants.map(v=>({localProductId:p.id,localVariantId:v.id,localVendorId:p.vendorId,sourceShopId:p.shopId,sourceProductId:p.externalId,sourceVariantId:v.externalId,
    retailCents:v.retailCents,enabled:v.enabled,available:v.available,sourceEnabled:v.sourceEnabled})));
  const status={createdAt:new Date().toISOString(),database:process.env.STORE_DB_DATABASE,environment:'isolated_local',products:products.length,variants:mappings.length,
    activeProducts:products.filter(p=>p.active).length,approvedRetailVariants:mappings.filter(v=>v.retailCents!==null).length,
    enabledLocalVariants:mappings.filter(v=>v.enabled).length,liveConfigurationChanged:false,supplierOrdersCreated:0,
    priceProposal:{productionMargin:0.45,rounding:'up to whole dollars',approved:false,excludes:['shipping','supplier tax','Stripe fees'],currencyRequiresConfirmation:true}};
  await fs.writeFile(new URL('local-import-mapping.json',out),JSON.stringify({status,mappings},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status,priceProposal:summary.map(({product,proposedRetailMinCents,proposedRetailMaxCents})=>({product,proposedRetailMinCents,proposedRetailMaxCents}))},null,2));
}finally{await pool.end();}
