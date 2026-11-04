import dotenv from 'dotenv';
import { getPool, migrateLegacySubscriptionPortalSchema } from '../db.js';
import { financialPreflight, migrateMemberFinancialSchema } from '../lib/memberFinancialSchema.js';

// Intentionally explicit: deployment runs --check, reviews conflicts, then --apply.
if (!process.argv.includes('--check') && !process.argv.includes('--apply')) {
  throw new Error('Use --check (read-only) or --apply (schema migration).');
}
dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
const pool = getPool();
const connection = await pool.getConnection();
try {
  const result = process.argv.includes('--apply')
    ? await migrateMemberFinancialSchema(connection, migrateLegacySubscriptionPortalSchema)
    : { issues: await financialPreflight(connection) };
  console.log(JSON.stringify(result, null, 2));
  if (result.issues?.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: error.message, issues: error.issues || [] }, null, 2));
  process.exitCode = 1;
} finally { connection.release(); await pool.end(); }
