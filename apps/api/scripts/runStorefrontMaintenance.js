import { getPool } from '../db.js';
import { getStorefrontService } from '../lib/storefrontRuntime.js';

getStorefrontService().maintain()
  .then(results => console.log(JSON.stringify({ at: new Date().toISOString(), results })))
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(async () => { await getPool().end(); });
