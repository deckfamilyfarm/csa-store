import { test } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import * as schema from '../schema.js';

// Disposable database only; never reads .env and never calls either remote catalog.
const socket = process.env.PRODUCT_SYNC_TEST_SOCKET;
test('farm availability migration, persistence, defaults, permissions and independent writes', { skip: !socket }, async t => {
  assert.match(socket, /^\/(?:private\/)?tmp\/csa-product-sync-/);
  const database = `csa_farm_stock_test_${process.pid}_${Date.now()}`;
  const root = await mysql.createConnection({ socketPath: socket, user: 'root' });
  await root.query(`CREATE DATABASE \`${database}\``);
  Object.assign(process.env, { STORE_DB_HOST: '127.0.0.1', STORE_DB_PORT: '1', STORE_DB_DATABASE: database, STORE_DB_USER: 'root', STORE_DB_PASSWORD: '' });
  const { getPool, getDb, ensureFarmStockSchema } = await import('../db.js');
  const pool = getPool();
  pool.pool.config.connectionConfig.socketPath = socket;
  t.after(async () => { await pool.end(); await root.query(`DROP DATABASE \`${database}\``); await root.end(); });
  t.mock.method(globalThis, 'fetch', () => assert.fail('Local farm availability must not call remote services'));
  for (const table of [schema.products, schema.vendors, schema.categories]) {
    const config = getTableConfig(table);
    const columns = config.columns.filter(col => col.name !== 'stock_on_farm').map(col => `\`${col.name}\` ${col.getSQLType()}${col.notNull ? ' NOT NULL' : ''}${col.autoIncrement ? ' AUTO_INCREMENT' : ''}${col.primary ? ' PRIMARY KEY' : ''}`);
    await pool.query(`CREATE TABLE \`${config.name}\` (${columns.join(',')}) ENGINE=InnoDB`);
  }
  await pool.query("INSERT INTO vendors (id,name) VALUES (1,'Deck Family Farm'),(2,'')");
  await pool.query("INSERT INTO categories (id,name) VALUES (1,'Meat'),(2,'Membership')");
  await pool.query("INSERT INTO products (id,name,vendor_id,category_id,inventory,track_inventory,visible,is_deleted) VALUES (1,'Existing',1,1,12,1,1,0),(2,'No vendor',NULL,1,0,0,0,0),(3,'Deleted',1,1,0,0,0,1),(4,'Membership',1,2,0,0,0,0),(5,'Unnamed vendor',2,1,0,0,0,0)");
  await ensureFarmStockSchema();
  const connection = await pool.getConnection();
  try { await ensureFarmStockSchema(connection); } finally { connection.release(); }
  const { saveProductFarmStock } = await import('./productFarmStock.js');
  const read = async () => (await getDb().select().from(schema.products)).find(row => row.id === 1);
  const before = await read();
  assert.equal(before.stockOnFarm, null);
  const unchanged = ({ stockOnFarm, updatedAt, ...rest }) => rest;
  for (const role of ['inventory_admin', 'pricing_admin', 'local_pricelist_admin', 'admin']) {
    for (const stockOnFarm of [true, false]) {
      const saved = await saveProductFarmStock(1, { stockOnFarm }, { adminRoles: [role] });
      assert.equal(saved.stockOnFarm, stockOnFarm);
      assert.equal(saved.localOnly, true);
      const after = await read();
      assert.equal(after.stockOnFarm, Number(stockOnFarm));
      assert.deepEqual(unchanged(after), unchanged(before));
    }
  }
  const user = { adminRoles: ['inventory_admin'] };
  for (const id of [2,3,4,5,999]) await assert.rejects(saveProductFarmStock(id, { stockOnFarm: true }, user));
  await assert.rejects(saveProductFarmStock(1, { stockOnFarm: true, inventory: 0 }, user));
  assert.equal((await read()).stockOnFarm, 0);
  await pool.query("INSERT INTO products (id,name,vendor_id) VALUES (6,'New product',1)");
  const [[created]] = await pool.query('SELECT stock_on_farm FROM products WHERE id=6');
  assert.equal(created.stock_on_farm, null);
});
