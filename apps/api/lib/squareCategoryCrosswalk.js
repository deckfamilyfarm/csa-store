import { getPool } from '../db.js';
import { fetchSquare, getSquareConfig, listSquareCatalogItems } from './squareStoreSync.js';
import { fingerprint, same } from './productSyncCore.js';
import { requireSquareCategorySchema } from './squareCategorySchema.js';
import { withSyncLock } from './productSyncSchema.js';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
export function squareCategoryTarget() {
  const { environment, baseUrl, accessToken } = getSquareConfig();
  return fingerprint({ environment, baseUrl, accessToken });
}
export function categoryAssignment(item) {
  const data = item.item_data || {};
  const categoryIds = [...new Set([...(data.categories || []).map(row => row.id), data.category_id].filter(Boolean))].sort();
  return { categoryIds, reportingCategoryId: data.reporting_category?.id || (categoryIds.length === 1 ? categoryIds[0] : null) };
}
// Explicit, narrow defaults. Broad food categories remain product-specific.
export const defaultCategoryNames = ['Pasture-raised Pork 🐖', 'Grass-fed Beef 🐮', 'Pasture-raised Poultry🐔', 'Spring Lamb 🐑', 'Organic Eggs 🍳 🥚'];
export function buildSquareCategoryCrosswalk({ categories, items, links, localCategories }, defaults = defaultCategoryNames) {
  const registry = categories.filter(row => !row.is_deleted && row.category_data?.category_type === 'REGULAR_CATEGORY');
  const known = new Set(registry.map(row => row.id));
  const bindings = [], issues = [];
  const products = new Map(), groups = new Map();
  for (const item of items.filter(row => !row.is_deleted && !row.item_data?.is_archived)) {
    const assignment = categoryAssignment(item);
    if (!assignment.categoryIds.length || assignment.categoryIds.some(id => !known.has(id)) || !known.has(assignment.reportingCategoryId)) {
      issues.push({ squareItemId: item.id, name: item.item_data.name, reason: 'Missing or invalid category/reporting category.' }); continue;
    }
    bindings.push({ scope: 'square-item', sourceId: item.id, assignment, evidence: { name: item.item_data.name, version: item.version } });
    for (const link of links.filter(row => row.squareItemId === item.id)) {
      if (!products.has(link.productId)) products.set(link.productId, []);
      products.get(link.productId).push({ ...link, assignment });
    }
  }
  for (const [id, rows] of products) {
    const choices = new Set(rows.map(row => fingerprint(row.assignment)));
    if (choices.size !== 1) { issues.push({ productId: id, reason: 'Linked Square items have conflicting categories.' }); continue; }
    const first = rows[0];
    bindings.push({ scope: 'product', sourceId: String(id), assignment: first.assignment,
      evidence: { name: first.productName, localCategoryId: first.categoryId, localCategoryName: first.categoryName, squareItemIds: [...new Set(rows.map(row => row.squareItemId))].sort() } });
    if (!groups.has(first.categoryId)) groups.set(first.categoryId, []);
    groups.get(first.categoryId).push(first.assignment);
  }
  for (const name of defaults) {
    const local = localCategories.filter(row => row.name === name);
    const assignments = groups.get(local[0]?.id) || [];
    if (local.length !== 1 || !assignments.length || new Set(assignments.map(fingerprint)).size !== 1 || assignments[0].categoryIds.length !== 1) {
      issues.push({ categoryName: name, reason: 'No unambiguous default; choose product categories explicitly.' }); continue;
    }
    bindings.push({ scope: 'category', sourceId: String(local[0].id), assignment: assignments[0], evidence: { name, reviewedDefault: true } });
  }
  return { registry, bindings, issues };
}
export async function listSquareCategories() {
  const categories = []; let cursor;
  do {
    const query = new URLSearchParams({ types: 'CATEGORY' }); if (cursor) query.set('cursor', cursor);
    const result = await fetchSquare('/v2/catalog/list?' + query);
    categories.push(...(result.objects || [])); cursor = result.cursor;
  } while (cursor);
  return categories.sort((a,b)=>a.id.localeCompare(b.id));
}
export async function readSquareCategorySource(connection = getPool()) {
  const [links] = await connection.query(`SELECT l.product_id AS productId,l.package_id AS packageId,l.square_item_id AS squareItemId,
    p.name AS productName,p.category_id AS categoryId,c.name AS categoryName FROM square_variation_links l
    JOIN products p ON p.id=l.product_id LEFT JOIN categories c ON c.id=p.category_id ORDER BY l.product_id,l.package_id`);
  const [localCategories] = await connection.query('SELECT id,name FROM categories ORDER BY id');
  const categories = await listSquareCategories();
  const items = await listSquareCatalogItems();
  return { links, localCategories, categories: categories.sort((a,b)=>a.id.localeCompare(b.id)), items: items.sort((a,b)=>a.id.localeCompare(b.id)) };
}
export async function refreshSquareCategoryRegistry() {
  await requireSquareCategorySchema();
  const target = squareCategoryTarget();
  // Explicit refresh reads names/IDs only. Never recapture item assignments.
  const categories = (await listSquareCategories()).filter(row => !row.is_deleted && row.category_data?.category_type === 'REGULAR_CATEGORY');
  return withSyncLock('square-category-crosswalk', async connection => {
    if (target !== squareCategoryTarget()) throw fail('Square connection changed during refresh.');
    await connection.beginTransaction();
    try {
      const [saved] = await connection.query('SELECT square_category_id AS id,raw_json AS raw FROM square_category_registry WHERE target_hash=? FOR UPDATE',[target]);
      const updates = [...categories, ...saved.filter(row=>!categories.some(category=>category.id===row.id)).map(row=>({...parse(row.raw),is_deleted:true}))];
      for (const row of updates) await connection.query(`INSERT INTO square_category_registry (target_hash,square_category_id,name,raw_json,updated_at)
        VALUES (?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE name=VALUES(name),raw_json=VALUES(raw_json),updated_at=VALUES(updated_at)`,
      [target,row.id,row.category_data.name,JSON.stringify(row)]);
      await connection.commit();return {categories:categories.length};
    } catch(error) { await connection.rollback();throw error; }
  });
}
export async function importSquareCategoryCrosswalk(plan, expectedTarget) {
  if (expectedTarget !== squareCategoryTarget()) throw fail('Square connection changed since review.');
  await requireSquareCategorySchema();
  return withSyncLock('square-category-crosswalk', async connection => {
    await connection.beginTransaction();
    try {
      const [existing] = await connection.query('SELECT source_id FROM square_category_crosswalk WHERE target_hash=? FOR UPDATE', [expectedTarget]);
      if (existing.length) throw fail('Category crosswalk already exists. Review changes instead of overwriting saved mappings.');
      for (const row of plan.registry) await connection.query(`INSERT INTO square_category_registry
        (target_hash,square_category_id,name,raw_json,updated_at) VALUES (?,?,?,?,UTC_TIMESTAMP(3))`, [expectedTarget,row.id,row.category_data.name,JSON.stringify(row)]);
      for (const row of plan.bindings) await connection.query(`INSERT INTO square_category_crosswalk
        (target_hash,scope,source_id,assignment_json,evidence_json,updated_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))`,
      [expectedTarget,row.scope,row.sourceId,JSON.stringify(row.assignment),JSON.stringify(row.evidence)]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    return { categories: plan.registry.length, bindings: plan.bindings.length };
  });
}
export async function getSquareCategorySetup(productId, connection = getPool()) {
  if (!Number.isSafeInteger(Number(productId)) || Number(productId) <= 0) throw fail('A valid product is required.',400);
  await requireSquareCategorySchema(connection);
  const target = squareCategoryTarget();
  const [[product]] = await connection.query('SELECT id,category_id AS categoryId FROM products WHERE id=?', [productId]);
  if (!product) throw fail('Product not found.',404);
  const [registry] = await connection.query('SELECT square_category_id AS id,name,raw_json AS raw FROM square_category_registry WHERE target_hash=? ORDER BY name', [target]);
  const categories=registry.filter(row=>!parse(row.raw).is_deleted).map(({id,name})=>({id,name}));
  const [rows] = await connection.query(`SELECT scope,source_id AS sourceId,assignment_json AS assignment,evidence_json AS evidence FROM square_category_crosswalk
    WHERE target_hash=? AND ((scope='product' AND source_id=?) OR (scope='category' AND source_id=?) OR
    (scope='square-item' AND source_id IN (SELECT square_item_id FROM square_variation_links WHERE product_id=?))) ORDER BY scope,source_id`,
  [target,String(productId),String(product.categoryId),productId]);
  const explicit = rows.find(row => row.scope === 'product');
  const linked = rows.filter(row => row.scope === 'square-item');
  const fallback = rows.find(row => row.scope === 'category');
  let chosen = explicit || (linked.length ? linked[0] : fallback), issue = '';
  if (!explicit && new Set(linked.map(row => fingerprint(parse(row.assignment)))).size > 1) { chosen = null; issue = 'Linked Square items have different categories. Choose a product mapping.'; }
  const assignment = chosen ? parse(chosen.assignment) : null;
  if (assignment && (assignment.categoryIds.some(id => !categories.some(row => row.id === id)) || !categories.some(row => row.id === assignment.reportingCategoryId))) issue = 'The saved category is unavailable. Review the mapping.';
  return { categories, assignment, source: chosen?.scope || null, issue, override: Boolean(explicit),
    revision: fingerprint({ target, product, categories, rows }), categoryNames: (assignment?.categoryIds || []).map(id => categories.find(row => row.id === id)?.name || id) };
}
export async function saveSquareProductCategory(productId, body, userId) {
  return withSyncLock('square-category-crosswalk', async connection => {
    await connection.beginTransaction();
    try {
      const [[vendor]] = await connection.query('SELECT v.name FROM products p JOIN vendors v ON v.id=p.vendor_id WHERE p.id=?',[productId]);
      if (!vendor?.name?.trim()) throw fail('Choose a valid named vendor before saving the category mapping.',400);
      const setup = await getSquareCategorySetup(productId, connection);
      if (!body?.expectedRevision || setup.revision !== body.expectedRevision) throw fail('Category mapping changed. Refresh and review before saving.');
      const target = squareCategoryTarget();
      if (body.categoryId === null) await connection.query("DELETE FROM square_category_crosswalk WHERE target_hash=? AND scope='product' AND source_id=?", [target,String(productId)]);
      else {
        const category = setup.categories.find(row => row.id === body.categoryId);
        if (!category) throw fail('Choose a saved Square category.',400);
        await connection.query(`INSERT INTO square_category_crosswalk (target_hash,scope,source_id,assignment_json,evidence_json,updated_by,updated_at)
          VALUES (?,'product',?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE assignment_json=VALUES(assignment_json),evidence_json=VALUES(evidence_json),updated_by=VALUES(updated_by),updated_at=VALUES(updated_at)`,
        [target,String(productId),JSON.stringify({categoryIds:[category.id],reportingCategoryId:category.id}),JSON.stringify({selectedByUser:true}),userId || null]);
      }
      await connection.commit(); return getSquareCategorySetup(productId,connection);
    } catch(error) { await connection.rollback(); throw error; }
  });
}
export async function squareCategoryForCreation(productId) {
  const setup = await getSquareCategorySetup(productId);
  if (setup.issue || !setup.assignment?.categoryIds.length) throw fail(setup.issue || 'Choose a Square category in the product’s Square setup before creating it.');
  const categories = [];
  for (const id of new Set([...setup.assignment.categoryIds,setup.assignment.reportingCategoryId])) {
    const {object} = await fetchSquare('/v2/catalog/object/' + encodeURIComponent(id));
    const saved = setup.categories.find(row => row.id === id);
    if (object?.type !== 'CATEGORY' || object.is_deleted || object.category_data?.category_type !== 'REGULAR_CATEGORY' || object.category_data.name !== saved?.name) throw fail('Square category changed or was deleted. Review the saved category mapping.');
    if (setup.assignment.categoryIds.includes(id)) categories.push({id,name:saved.name});
  }
  return { ...setup.assignment, categories, mappingRevision: setup.revision };
}
export function verifyCreatedSquareCategories(snapshot, item) {
  // Old in-flight requests keep their exact original category scope.
  if (snapshot && (!same(categoryAssignment(item).categoryIds,[...snapshot.categoryIds].sort())
    || item.item_data?.reporting_category?.id !== snapshot.reportingCategoryId)) throw fail('Square has not confirmed the approved category assignments. Retry confirmation of the same item.');
}
