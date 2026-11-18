import dotenv from 'dotenv';
import { getPool } from '../db.js';
import { merchandisePreflight,migrateMerchandise } from '../lib/merchandiseSchema.js';
const apply=process.argv.includes('--apply');
if (apply===process.argv.includes('--check')) throw new Error('Use exactly one of --check or --apply.');
if (process.env.CSA_LOCAL_ONLY!=='true') dotenv.config({path:new URL('../../../.env',import.meta.url).pathname,quiet:true});
const pool=getPool();
try { console.log(JSON.stringify(await (apply?migrateMerchandise(pool):merchandisePreflight(pool)),null,2)); }
finally {await pool.end();}
