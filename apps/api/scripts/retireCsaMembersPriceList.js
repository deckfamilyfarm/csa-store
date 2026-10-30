// Run with root .env credentials. No Local Line or Square calls.
import fs from 'node:fs';
import path from 'node:path';
import { getPool } from '../db.js';
const apply = process.argv.includes('--apply');
const backup = process.argv.find(arg => arg.startsWith('--backup='))?.slice(9);
if (apply && !backup) throw new Error('Provide --backup=path.json before applying.');
const pool = getPool(), connection = await pool.getConnection();
try {
  await connection.beginTransaction();
  const [rows] = await connection.query("SELECT * FROM price_lists WHERE LOWER(TRIM(name))='csa members' OR local_line_price_list_id=? FOR UPDATE", [Number(process.env.LL_PRICE_LIST_CSA_MEMBERS_ID || 2718)]);
  if (apply && rows.length) {
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, JSON.stringify({ recordedAt: new Date().toISOString(), rows }, null, 2), { flag: 'wx', mode: 0o600 });
    await connection.query('UPDATE price_lists SET active=0,updated_at=UTC_TIMESTAMP() WHERE id IN (?) AND active<>0', [rows.map(row => row.id)]);
    await connection.commit();
  } else await connection.rollback();
  console.log(JSON.stringify({ applied: apply, lists: rows.map(row => ({ id: row.id, name: row.name, remoteId: row.local_line_price_list_id, active: apply ? 0 : row.active })), historicalMappingsPreserved: true }));
} catch (error) { await connection.rollback(); throw error; }
finally { connection.release(); await pool.end(); }
