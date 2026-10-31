// Planning only: no database or publication dependencies.
export function decimal(value, scale = 4) {
  const s = String(value ?? '').trim();
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`).test(s)) return null;
  const [a,b=''] = s.split('.');
  const n = BigInt(a) * 10n ** BigInt(scale) + BigInt(b.padEnd(scale,'0'));
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? n : null;
}
const round = (a,b) => (a + b/2n)/b;
const dollars = n => Number(n)/10000;
function calculateCostPlanRaw(plan) {
  const issues=[]; const qty=decimal(plan.quantity,3), base=decimal(plan.cogs), target=decimal(plan.targetMargin,2);
  if (!qty || qty<=0n) issues.push('Enter total packaged quantity.');
  if (base===null) issues.push('Enter production COGS.');
  if (target===null || target>=10000n) issues.push('Target margin must be at least 0% and below 100%.');
  if (!['lb','gallon','each'].includes(plan.unit)) issues.push('Choose an analysis unit.');
  let groupTotal=0n, cost=0n, current=0n, proposed=0n; const seen=new Set();
  const beef=plan.model==='simple-beef';
  const simple=beef||plan.model==='simple-average';
  if(beef&&(plan.producer!=='deck'||plan.unit!=='lb'||plan.groups?.length!==2))issues.push('Simple beef requires two groups, Deck, and pounds.');
  if(plan.model==='simple-average'&&plan.groups?.length!==1)issues.push('Category average requires one product group.');
  if(simple){const productIds=(plan.groups||[]).flatMap(g=>g.rows||[]).map(r=>Number(r.productId));if(new Set(productIds).size!==productIds.length)issues.push('Use one package per product in the simple average.');}
  const groups=(plan.groups||[]).map((g,index)=>{
    const share=beef?(index===0?4400n:5600n):simple?10000n:decimal(g.share,2), cogs=decimal(simple||g.cogs==null||g.cogs===''?plan.cogs:g.cogs);
    if(share===null||share>10000n) issues.push(`${g.name}: enter a group percentage from 0 to 100.`);
    groupTotal+=share||0n;
    const amount=round((qty||0n)*(share||0n),10000n);
    if(cogs===null) issues.push(`${g.name}: enter production COGS.`);
    let rowTotal=0n, revenue=0n, scenario=0n, unitSum=0n, proposedSum=0n;
    const rowCount=BigInt(g.rows?.length||1);
    const rows=(g.rows||[]).map(r=>{
      const key=`${r.productId}:${r.packageId}`;
      if(seen.has(key)) issues.push('A package can only appear once in a plan.');seen.add(key);
      const part=simple?10000n:decimal(r.share,2), conversion=decimal(costPlanConversion(r,plan.unit));
      if(part===null||part>10000n) issues.push(`${r.name}: enter a product percentage from 0 to 100.`);
      rowTotal+=part||0n;
      const charge=decimal(r.baseline?.cost), next=decimal(r.proposed==null||r.proposed===''?r.baseline?.cost:r.proposed);
      if(r.baseline?.issue) issues.push(`${r.name}: ${r.baseline.issue}`);
      if(charge===null||next===null) issues.push(`${r.name}: Cost is missing or invalid.`);
      const direct=r.baseline?.basis===plan.unit;
      if(!direct&&!conversion) issues.push(`${r.name}: enter ${plan.unit} per ${r.baseline?.basis||'package'}.`);
      const divisor=direct?10000n:conversion||10000n;
      const units=simple?round(amount,rowCount):round(amount*(part||0n),10000n);
      const normalized=round((charge||0n)*10000n,divisor), normalizedNext=round((next||0n)*10000n,divisor);
      const rev=round(units*normalized,1000n), prop=round(units*normalizedNext,1000n);
      revenue+=rev;scenario+=prop;unitSum+=normalized;proposedSum+=normalizedNext;
      const usable=charge!==null&&!r.baseline?.issue&&(direct||Boolean(conversion));
      return {...r,quantity:Number(units)/1000,currentUnit:usable?dollars(normalized):null,proposedUnit:dollars(normalizedNext),revenue:dollars(rev),proposedRevenue:dollars(prop)};
    });
    if(simple&&g.proposedAverage!=null&&g.proposedAverage!==''){const override=decimal(g.proposedAverage);if(override===null)issues.push(`${g.name}: enter a valid proposed average Cost.`);else proposedSum=override*rowCount;}
    if(simple){if(!g.rows?.length)issues.push(`${g.name}: select at least one product.`);revenue=round(amount*unitSum,1000n*rowCount);scenario=round(amount*proposedSum,1000n*rowCount);}
    if(!simple&&share>0n&&rowTotal!==10000n) issues.push(`${g.name}: product mix totals ${Number(rowTotal)/100}% (must be 100%).`);
    const production=round(amount*(cogs||0n),1000n);cost+=production;current+=revenue;proposed+=scenario;
    return {...g,share:Number(share)/100,averageUnit:simple?dollars(round(unitSum,rowCount)):null,proposedAverageUnit:simple?dollars(round(proposedSum,rowCount)):null,rows,quantity:Number(amount)/1000,cogsUnit:cogs===null?null:dollars(cogs),cost:dollars(production),currentRevenue:dollars(revenue),proposedRevenue:dollars(scenario)};
  });
  if(groupTotal!==10000n) issues.push(`Group mix totals ${Number(groupTotal)/100}% (must be 100%).`);
  if(plan.proposedAverage!=null&&plan.proposedAverage!==''){const value=decimal(plan.proposedAverage);if(value===null)issues.push('Enter a valid proposed average Cost.');else proposed=round((qty||0n)*value,1000n);}
  const required=target!==null&&target<10000n?round(cost*10000n,10000n-target):null;
  const summary=r=>({revenue:dollars(r),margin:r>0n?Number(r-cost)/Number(r)*100:null,profit:dollars(r-cost),unitCharge:qty?dollars(round(r*1000n,qty)):null,gap:required===null?null:dollars(r-required)});
  const groundCurrent=groups[0]?.averageUnit,groundProposed=groups[0]?.proposedAverageUnit;
  const requiredUnit=required!==null&&qty?dollars(round(required*1000n,qty)):null;
  const requiredOther=ground=>{
    if(required===null||!qty||ground==null)return null;
    const difference=round(required*1000n,qty)*10000n-decimal(ground.toFixed(4))*4400n;
    return difference<=0n?0:dollars(round(difference,5600n));
  };
  return {requiredOtherUnit:beef?requiredOther(groundCurrent):null,proposedRequiredOtherUnit:beef?requiredOther(groundProposed):null,complete:issues.length===0,issues:[...new Set(issues)],groups,groupPercent:Number(groupTotal)/100,cost:dollars(cost),requiredRevenue:required===null?null:dollars(required),requiredUnit:required!==null&&qty?dollars(round(required*1000n,qty)):null,current:summary(current),proposed:summary(proposed)};
}

// Only explicit, fixed package weights are usable automatically. Never infer a
// selling unit, a range midpoint, or a processed-product yield from these labels.
export function fixedPackagePounds(name){
 const match=String(name||'').trim().match(/^(\d+(?:\.\d+)?|\.\d+)\s*(lbs?|pounds?|oz|ounces?)(?:\s*(?:ea|each))?$/i);
 if(!match)return null;
 const amount=decimal(match[1].startsWith('.')?`0${match[1]}`:match[1]);
 if(!amount)return null;
 return dollars(/^(oz|ounce)/i.test(match[2])?round(amount,16n):amount).toFixed(4);
}
export function costPlanConversion(row,unit){
 return row.conversion!=null&&row.conversion!==''?row.conversion:
  unit==='lb'&&row.baseline?.basis==='package'?row.baseline.packageWeightLb:null;
}

export function calculateCostPlan(plan){
 const result=calculateCostPlanRaw(plan);
 const simple=['simple-beef','simple-average'].includes(plan.model);
 const omitted=[];
 const groups=(plan.groups||[]).map(g=>({...g,proposedAverage:'',rows:(g.rows||[]).filter(r=>{
  const reason=r.baseline?.issue||(decimal(r.baseline?.cost)===null?'Cost is missing or invalid.':
   r.baseline?.basis!==plan.unit&&!decimal(costPlanConversion(r,plan.unit))?`Package ${plan.unit} is missing.`:null);
  if(simple&&reason){omitted.push({productId:r.productId,name:r.name,reason});return false;}
  return true;
 }).map(r=>({...r,proposed:''}))}));
 const current=calculateCostPlanRaw({...plan,proposedAverage:'',groups});
 const total=(plan.groups||[]).reduce((sum,g)=>sum+(g.rows||[]).length,0);
 // For the simple model, missing products are omitted from the estimate, never
 // assigned zero Cost. Both beef groups must still contain usable products.
 const comparison={available:current.complete,estimated:omitted.length>0,omitted,included:total-omitted.length,total,
  average:current.complete?current.current.unitCharge:null,
  margin:current.complete?current.current.margin:null,
  groups:current.groups.map(g=>({averageUnit:g.rows.length?g.averageUnit:null})),
  requiredUnit:decimal(plan.cogs)!==null&&decimal(plan.targetMargin,2)!==null&&Number(plan.targetMargin)<100?
   (simple?dollars(round(decimal(plan.cogs)*10000n,10000n-decimal(plan.targetMargin,2))):current.complete?current.requiredUnit:null):null,
  gapPerUnit:current.complete?Number((current.current.unitCharge-current.requiredUnit).toFixed(4)):null,
  marginGap:current.complete&&current.current.margin!=null?current.current.margin-Number(plan.targetMargin):null};
 return {...result,comparison};
}
