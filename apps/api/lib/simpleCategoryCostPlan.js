import {simpleBeefCostPlan} from './simpleBeefCostPlan.js';
export function simpleCategoryCostPlan(input,catalog){
 const chosen=catalog.filter(p=>p.producer===input.producer&&(input.category? p.category===input.category : input.program&&String(p.category||'').toLowerCase().includes(input.program.toLowerCase())));
 if(input.producer==='deck'&&(/beef/i.test(input.category||'')||input.program==='Beef'))return simpleBeefCostPlan(input,catalog);
 const products=[...new Map([...chosen].sort((a,b)=>Number(b.packageId)-Number(a.packageId)).map(p=>[p.productId,p])).values()];
 return {...input,model:'simple-average',quantity:input.quantity||'100',groups:[{name:input.category||input.program||'Products',share:'100',rows:products.map(p=>({...p,share:'',conversion:'',proposed:''}))}]};
}
