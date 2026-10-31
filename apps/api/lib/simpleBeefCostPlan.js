// A deliberately simple proxy mix, independent of catalog pricing rules.
export function simpleBeefCostPlan(input,catalog,groundIds=null){
 const beef=catalog.filter(p=>p.producer==='deck'&&(/beef/i.test(p.category||'')||/beef/i.test(p.name)));
 // Package variants must not give the same product extra weight in the average.
 const products=[...new Map([...beef].sort((a,b)=>Number(b.packageId)-Number(a.packageId)).map(p=>[p.productId,p])).values()];
 const ground=products.filter(p=>/ground beef/i.test(p.name));
 const chosen=groundIds||ground.map(p=>p.productId);
 const row=p=>({...p,share:'',proposed:'',conversion:''});
 return {...input,producer:'deck',program:'Beef',unit:'lb',model:'simple-beef',quantity:input.quantity||'100',groups:[
  {name:'Ground beef',share:'44',rows:ground.filter(p=>chosen.includes(p.productId)).map(row)},
  {name:'Other beef products',share:'56',rows:products.filter(p=>!/ground beef/i.test(p.name)).map(row)}
 ]};
}
