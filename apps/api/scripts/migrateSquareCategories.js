import dotenv from 'dotenv';
import { getPool } from '../db.js';
import { squareCategoryPreflight, migrateSquareCategorySchema } from '../lib/squareCategorySchema.js';
if (!process.argv.includes('--check') && !process.argv.includes('--apply')) throw new Error('Use --check or --apply.');
dotenv.config({path:new URL('../../../.env',import.meta.url).pathname,quiet:true});
const pool=getPool();
try { console.log(JSON.stringify(await (process.argv.includes('--apply') ? migrateSquareCategorySchema(pool) : squareCategoryPreflight(pool)),null,2)); }
finally { await pool.end(); }
