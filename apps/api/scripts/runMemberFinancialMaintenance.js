import { getPool } from '../db.js';
import { runMemberFinancialMaintenance } from '../lib/memberFinancialMaintenance.js';
try { console.log(JSON.stringify(await runMemberFinancialMaintenance(),null,2)); }
catch(e) {console.error(e.message);process.exitCode=1;}
finally {await getPool().end();}
