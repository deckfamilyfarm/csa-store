import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSquareCategoryCrosswalk, categoryAssignment, verifyCreatedSquareCategories} from './squareCategoryCrosswalk.js';
import {squareCreationRequest} from './squareProductCreation.js';
const categories=['beef','sausage','other'].map(id=>({id,type:'CATEGORY',category_data:{name:id,category_type:'REGULAR_CATEGORY'}}));
const item=(id,cat)=>({id,type:'ITEM',version:1,item_data:{name:id,categories:[{id:cat}],reporting_category:{id:cat}}});
const link=(productId,squareItemId,categoryId=1)=>({productId,squareItemId,categoryId,productName:'Local '+productId,categoryName:categoryId===1?'Meat':'Mixed'});
test('crosswalk stores exact product and Square-only assignments, with only explicitly requested unambiguous defaults',()=>{
  const result=buildSquareCategoryCrosswalk({categories,items:[item('one','beef'),item('two','sausage'),item('unlinked','other')],
    links:[link(1,'one'),link(2,'two',2)],localCategories:[{id:1,name:'Meat'},{id:2,name:'Mixed'}]},['Meat']);
  assert.equal(result.bindings.filter(row=>row.scope==='square-item').length,3);
  assert.equal(result.bindings.filter(row=>row.scope==='product').length,2);
  assert.deepEqual(result.bindings.filter(row=>row.scope==='category').map(row=>row.sourceId),['1']);
  assert.equal(result.issues.length,0);
});
test('conflicting linked items and mixed category defaults are held, not guessed or merged',()=>{
  const result=buildSquareCategoryCrosswalk({categories,items:[item('one','beef'),item('two','sausage'),item('three','other')],
    links:[link(1,'one'),link(1,'two'),link(2,'two'),link(3,'three')],localCategories:[{id:1,name:'Meat'}]},['Meat']);
  assert(!result.bindings.some(row=>row.scope==='product'&&row.sourceId==='1'));
  assert(!result.bindings.some(row=>row.scope==='category'));
  assert.equal(result.issues.length,2);
});
test('missing, deleted and menu categories never become creation mappings',()=>{
  const result=buildSquareCategoryCrosswalk({categories:[...categories,{id:'deleted',is_deleted:true},{id:'menu',category_data:{category_type:'MENU_CATEGORY'}}],
    items:[item('bad','deleted'),item('menu-item','menu'),{id:'none',item_data:{name:'none'}}],links:[],localCategories:[]},[]);
  assert.equal(result.bindings.length,0);assert.equal(result.issues.length,3);
});
test('creation freezes category IDs and reporting category, confirms both, and preserves legacy request scope',()=>{
  const squareCategory={categoryIds:['beef','other'],reportingCategoryId:'beef'};
  const preview={productId:1,productName:'Steak',variations:[],squareCategory};
  const request=squareCreationRequest(preview,'key');
  assert.deepEqual(categoryAssignment(request.object),squareCategory);
  verifyCreatedSquareCategories(squareCategory,request.object);
  const missing=structuredClone(request.object);missing.item_data.categories.pop();
  assert.throws(()=>verifyCreatedSquareCategories(squareCategory,missing),/category assignments/);
  const reporting=structuredClone(request.object);reporting.item_data.reporting_category.id='other';
  assert.throws(()=>verifyCreatedSquareCategories(squareCategory,reporting));
  const missingReporting=item('new','beef');delete missingReporting.item_data.reporting_category;
  assert.throws(()=>verifyCreatedSquareCategories({categoryIds:['beef'],reportingCategoryId:'beef'},missingReporting));
  verifyCreatedSquareCategories(undefined,missing);
  assert.equal(squareCreationRequest({...preview,squareCategory:undefined},'old-key').object.item_data.categories,undefined);
});
