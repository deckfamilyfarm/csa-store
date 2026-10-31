import React, {useEffect, useState} from 'react';
import {adminGet, adminPost} from '../adminApi.js';
import {SimpleBeefCostPlan} from './SimpleBeefCostPlan.jsx';
import './EnterpriseCostPlans.css';
const endpoint='enterprise-cost-plans';
const money=n=>n==null?'—':`$${Number(n).toFixed(2)}`;
const producers={deck:'Deck Family Farm',hyland:'Hyland','creamy-cow':'Creamy Cow'};
const fresh=()=>({name:'New category',producer:'deck',program:'',category:'',unit:'lb',quantity:'100',cogs:'',targetMargin:'23',notes:'',model:'simple-average',groups:[{name:'Products',share:'100',rows:[]}]});

export function EnterpriseCostPlans({token,roles=[]}){
 const [plans,setPlans]=useState([]),[catalog,setCatalog]=useState([]),[record,setRecord]=useState(null),[draft,setDraft]=useState(null),[output,setOutput]=useState(null);
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[refresh,setRefresh]=useState(null),[accepted,setAccepted]=useState(false),[showModel,setShowModel]=useState(false);
 const editable=roles.some(r=>['admin','pricing_admin','pricing_editor','local_pricelist_admin'].includes(r));
 const update=patch=>{setDraft(d=>({...d,...patch}));setDirty(true);setOutput(null);setRefresh(null);};
 const action=async fn=>{setBusy(true);setMessage('');try{await fn();}catch(e){setMessage(e.message);}finally{setBusy(false);}};
 const load=async id=>{
  if(dirty&&!window.confirm('Discard unsaved changes?'))return;
  await action(async()=>{
   const r=await adminGet(`${endpoint}/${id}`,token);setRecord(r);
   let input=r.input,result=r.output;
   const starter=!input.groups.some(g=>g.rows.length)&&Boolean(input.category||input.program);
   if(starter&&editable){const p=await adminPost(`${endpoint}/simple-category`,token,{id:r.id,input});input=p.input;result=p.output;}
   setDraft(input);setOutput(result);setDirty(starter&&editable);setAccepted(false);setRefresh(null);setShowModel(false);
  });
 };
 useEffect(()=>{let live=true;Promise.all([adminGet(endpoint,token),adminGet(`${endpoint}/catalog`,token)]).then(([p,c])=>{if(live){setPlans(p);setCatalog(c);if(p[0])load(p[0].id);}}).catch(e=>setMessage(e.message));return()=>{live=false;};},[token]);
 useEffect(()=>{
  if(!draft)return;let live=true;
  const timer=setTimeout(()=>adminPost(`${endpoint}/preview`,token,{id:record?.id,input:draft,refresh:accepted}).then(r=>{if(live)setOutput(r.output);}).catch(e=>{if(live)setMessage(e.message);}),450);
  return()=>{live=false;clearTimeout(timer);};
 },[draft,record?.id,accepted,token]);
 const save=()=>action(async()=>{
  const r=await adminPost(record?`${endpoint}/${record.id}`:endpoint,token,{input:draft,expectedRevision:record?.revision,refresh:accepted});
  setRecord(r);setDraft(r.input);setOutput(r.output);setDirty(false);setAccepted(false);setPlans(await adminGet(endpoint,token));setMessage('Saved. Product prices are unchanged.');
 });
 const selectCategory=category=>action(async()=>{
  const input={...draft,category,program:category,name:`${producers[draft.producer]} — ${category}`};
  const r=await adminPost(`${endpoint}/simple-category`,token,{input});update(r.input);setOutput(r.output);
 });
 const numeric=(label,key,step='0.01')=><label>{label}<input className="input" type="number" min="0" step={step} value={draft[key]??''} onChange={e=>update({[key]:e.target.value})}/></label>;
 const categories=[...new Set(catalog.filter(p=>p.producer===draft?.producer).map(p=>p.category).filter(Boolean))].sort();
 const comparison=output?.comparison;
 const missing=output&&!output.complete;
 const gap=(n,suffix)=>n==null?'—':`${n>0?'+':''}${n.toFixed(1)}${suffix}`;
 return <section className="card cost-plans">
  <h2>Deck Product Costs</h2><p className="small">Plan producer charges. Saving here does not change product prices.</p>
  <div className="cost-toolbar">
   <label>Category<select className="input" aria-label="Saved category" value={record?.id||''} disabled={busy} onChange={e=>load(e.target.value)}><option value="" disabled>Choose category</option>{plans.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
   {editable&&<><button className="button alt" disabled={busy} onClick={()=>{if(dirty&&!window.confirm('Discard unsaved changes?'))return;setRecord(null);setDraft(fresh());setOutput(null);setDirty(true);setAccepted(false);setRefresh(null);setShowModel(false);}}>Add category</button>
   <button className="button" disabled={busy||!draft} onClick={save}>Save{dirty?' *':''}</button>
   <button className="button alt" disabled={busy||!draft} onClick={()=>action(async()=>setRefresh(await adminPost(`${endpoint}/preview`,token,{id:record?.id,input:draft,refresh:true})))}>Refresh Costs</button></>}
  </div>
  {message&&<p role="status">{message}</p>}
  {refresh&&<div className="cost-refresh"><strong>Review updated Costs</strong>{refresh.changes.length?refresh.changes.map((c,i)=><p key={i}>{c.name}: {money(c.before.cost)}/{c.before.basis} → {money(c.after.cost)}/{c.after.basis}{c.before.packageWeightLb!==c.after.packageWeightLb?` · Package weight: ${c.before.packageWeightLb||'unknown'} → ${c.after.packageWeightLb||'unknown'} lb`:''}{c.after.issue?` — ${c.after.issue}`:''}</p>):<p>No Cost or unit differences found.</p>}<button className="button" onClick={()=>{setDraft(refresh.input);setOutput(refresh.output);setAccepted(true);setDirty(true);setRefresh(null);}}>Use these Costs</button> <button className="button alt" onClick={()=>setRefresh(null)}>Cancel</button></div>}
  {draft&&<>
   {!record&&<fieldset disabled={!editable||busy}><div className="cost-inputs"><label>Producer<select className="input" value={draft.producer} onChange={e=>update({...fresh(),producer:e.target.value})}>{Object.entries(producers).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>Product category<select className="input" value={draft.category||''} onChange={e=>selectCategory(e.target.value)}><option value="" disabled>Choose category</option>{categories.map(c=><option key={c}>{c}</option>)}</select></label></div></fieldset>}
   <fieldset disabled={!editable||busy}><div className="cost-inputs cost-basic-inputs">
    {numeric(`Production COGS / ${draft.unit}`,'cogs','0.0001')}{numeric('Producer margin goal %','targetMargin')}
   </div></fieldset>
   <div className="table-wrap"><table className="admin-table cost-summary"><thead><tr><th/><th>Calculated from local Costs</th><th>Needed for goal</th><th>Difference</th></tr></thead><tbody>
    <tr><th>Average Cost / {draft.unit}</th><td>{money(comparison?.average)}</td><td>{money(comparison?.requiredUnit)}</td><td>{comparison?.gapPerUnit==null?'—':`${comparison.gapPerUnit>0?'+':''}${money(comparison.gapPerUnit)}/${draft.unit}`}</td></tr>
    <tr><th>Producer margin</th><td>{comparison?.margin==null?'—':`${comparison.margin.toFixed(1)}%`}</td><td>{draft.targetMargin}%</td><td>{gap(comparison?.marginGap,' percentage points')}</td></tr>
   </tbody></table></div>
   {comparison?.available&&<p role="status"><strong>{comparison.estimated?'Estimate: ':''}{comparison.gapPerUnit>=0?'Meets margin goal':`${money(-comparison.gapPerUnit)}/${draft.unit} below the Cost needed for your margin goal`}.</strong></p>}
   {comparison?.estimated&&<p className="small">Based on {comparison.included} of {comparison.total} products. {comparison.omitted.length} missing a Cost or package measurement; excluded from this estimate.</p>}
   {missing&&<p role="status">{!comparison?.available?'More inputs are needed to calculate the average. ':''}<button className="button alt" onClick={()=>setShowModel(true)}>Review missing inputs</button></p>}
   <button className="button alt" aria-expanded={showModel} aria-controls="cost-model-details" onClick={()=>setShowModel(v=>!v)}>{showModel?'Hide model details':'Model details'}</button>
   {showModel&&<div id="cost-model-details" className="cost-model-details">
    {output?.issues.length>0&&<ul>{output.issues.map(s=><li key={s}>{s}</li>)}</ul>}
    <fieldset disabled={!editable||busy}><div className="cost-inputs">
     <label>Name<input className="input" value={draft.name} onChange={e=>update({name:e.target.value})}/></label>
     <label>Analysis unit<select className="input" disabled={draft.model==='simple-beef'} value={draft.unit} onChange={e=>update({unit:e.target.value,groups:draft.groups.map(g=>({...g,rows:g.rows.map(r=>({...r,conversion:''}))}))})}>{['lb','gallon','each'].map(u=><option key={u}>{u}</option>)}</select></label>
     {numeric(`Total packaged ${draft.unit}`,'quantity','0.001')}
     <label>Spreadsheet reference / notes<input className="input" value={draft.notes||''} onChange={e=>update({notes:e.target.value})}/></label>
    </div></fieldset>
    <p className="small">{draft.model==='simple-beef'?'Beef uses 44% ground and 56% other products.':draft.model==='simple-average'?'Each included product contributes equally to the category average.':'This saved plan retains its custom product weights.'} One package per product is used in category averages. Fixed package weights are converted to the analysis unit. Costs are snapshots; use Refresh Costs to review later pricing changes.</p>
    {draft.model==='simple-beef'?<SimpleBeefCostPlan draft={draft} output={output} catalog={catalog} update={update} editable={editable&&!busy}/>:<CategoryDetails draft={draft} output={output} catalog={catalog} update={update} editable={editable&&!busy}/>}
    {editable&&<div className="cost-toolbar"><button className="button alt" disabled={busy||!record||dirty} onClick={()=>action(async()=>{const r=await adminPost(`${endpoint}/${record.id}/duplicate`,token,{});setPlans(await adminGet(endpoint,token));setRecord(r);setDraft(r.input);setOutput(r.output);setAccepted(false);setShowModel(false);})}>Duplicate saved plan</button>
     {draft.model!=='simple-average'&&draft.model!=='simple-beef'&&<button className="button alt" disabled={busy} onClick={()=>action(async()=>{const r=await adminPost(`${endpoint}/simple-category`,token,{id:record?.id,input:draft});update(r.input);setOutput(r.output);})}>Use category average</button>}
    </div>}
   </div>}
  </>}
 </section>;
}

function CategoryDetails({draft,output,catalog,update,editable}){
 const change=(index,patch)=>update({groups:draft.groups.map((g,i)=>i===index?{...g,...patch}:g)});
 const average=draft.model==='simple-average';
 const candidates=catalog.filter(p=>p.producer===draft.producer&&(!draft.category||p.category===draft.category));
 return <fieldset disabled={!editable}><div className="cost-table-scroll">
  {draft.groups.map((g,i)=><section className="cost-group" key={i}><h4>{g.name}</h4>
   {!average&&<div className="cost-toolbar"><label>Group %<input className="input" type="number" min="0" max="100" value={g.share||''} onChange={e=>change(i,{share:e.target.value})}/></label><label>COGS override<input className="input" type="number" min="0" step="0.0001" value={g.cogs||''} onChange={e=>change(i,{cogs:e.target.value})}/></label></div>}
   <table className="admin-table"><thead><tr><th>Product</th><th>Saved Cost</th>{!average&&<th>Share %</th>}<th>Conversion</th><th>Cost / {draft.unit}</th><th/></tr></thead><tbody>{g.rows.map((r,j)=>{
    const set=patch=>change(i,{rows:g.rows.map((p,n)=>n===j?{...p,...patch}:p)});
    const live=catalog.find(p=>p.productId===r.productId&&p.packageId===r.packageId);
    return <tr key={`${r.productId}:${r.packageId}`}><td>{r.name}<small>{r.packageName}</small>{(!live||live.baseline.basis!==r.baseline?.basis)&&<small>Catalog changed. Refresh Costs to review.</small>}</td><td>{money(r.baseline?.cost)}/{r.baseline?.basis}</td>{!average&&<td><input className="input" type="number" min="0" max="100" value={r.share||''} onChange={e=>set({share:e.target.value})}/></td>}<td>{r.baseline?.basis===draft.unit?'1:1':<label>{draft.unit} per {r.baseline?.basis}<input className="input" type="number" min="0.001" step="0.0001" aria-label={`${draft.unit} per package for ${r.name}`} value={r.conversion||(draft.unit==='lb'?r.baseline?.packageWeightLb:'')||''} onChange={e=>set({conversion:e.target.value})}/></label>}</td><td>{money(output?.groups[i]?.rows[j]?.currentUnit)}</td><td><button className="button alt" onClick={()=>change(i,{rows:g.rows.filter((_,n)=>n!==j)})}>Exclude</button></td></tr>;
   })}</tbody></table>
   <select className="input" aria-label={`Add product to ${g.name}`} value="" onChange={e=>{const p=candidates.find(p=>String(p.packageId)===e.target.value);if(p)change(i,{rows:[...g.rows,{...p,share:'',conversion:'',proposed:''}]});}}><option value="">Include product…</option>{candidates.filter(p=>!draft.groups.some(g=>g.rows.some(r=>r.productId===p.productId))).map(p=><option key={p.packageId} value={p.packageId}>{p.name} · {p.packageName}</option>)}</select>
  </section>)}
 </div></fieldset>;
}
