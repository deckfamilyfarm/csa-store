import { resolveLocalLineUnitIds } from '../localLine.js';
import { expectedLocalLineLists } from './localLinePricingLists.js';
import { enterprisePackageCostCents } from './enterpriseLocalLineCost.js';

// One approved snapshot supplies both initial Cost and the subsequent basket
// prices. No intermediate retail-as-Cost product may be created.
export function enterpriseLocalLineCreation(context, revision, units) {
  if (!revision?.output?.packages?.length || Number(revision.output.saleBp || 0)) throw new Error('Review regular enterprise prices before creating this Local Line product.');
  const names = context.packages.map(pkg => String(pkg.name || '').trim());
  if (names.some(name => !name) || new Set(names).size !== names.length) throw new Error('Give each package a distinct name before creating it in Local Line.');
  const lists = expectedLocalLineLists(context.product);
  const {baseUnitId,chargeUnitId} = resolveLocalLineUnitIds(units,{unitOfMeasure:revision.output.pricingUnit==='lb'?'lbs':'each'},[]);
  const packages = context.packages.map(pkg=>{
    const price = revision.output.packages.find(row=>Number(row.packageId)===Number(pkg.id));
    if (!price || !Number.isSafeInteger(price.localLineRegularCents)) throw new Error('The approved package selling price is missing.');
    return {name:pkg.name,unit_price:enterprisePackageCostCents(revision.output,pkg.id)/100,inventory_per_unit:1,
      ...(pkg.packageCode ? {package_code:pkg.packageCode}:{}),price_list_entries:lists.map(id=>({price_list:id}))};
  });
  const createPayload = {name:context.product.name,vendor:context.localLineVendorId,description:context.product.description || '',visible:false,
    track_inventory:Boolean(context.product.trackInventory),set_inventory:0,base_unit_id:baseUnitId,charge_unit_id:chargeUnitId,
    track_type:'package',charge_type:'package',package_codes_enabled:packages.some(pkg=>pkg.package_code),packages,
    product_price_list_entries:lists.map(id=>({price_list:id,taxed:false,valid_for_storecredits:true}))};
  // Keep the item hidden until the reviewed basket prices and visibility can be
  // applied together. A default remote markup must never become a live price.
  const payload = {name:createPayload.name,vendor:createPayload.vendor,description:createPayload.description,visible:Boolean(context.product.visible),
    packages:packages.map((pkg,index)=>{
      const localId=context.packages[index].id,price=revision.output.packages.find(row=>Number(row.packageId)===Number(localId));
      return {...pkg,id:Number(localId),price_list_entries:lists.map(id=>({price_list:id,product_price_list_entry:id,adjustment:true,adjustment_type:3,
        adjustment_value:price.localLineRegularCents/100,on_sale_toggle:false,strikethrough_display_value:null}))};
    })};
  return {createPayload,payload};
}
