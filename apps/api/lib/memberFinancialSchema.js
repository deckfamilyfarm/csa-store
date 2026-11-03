// No environment loading or connections at import time. Only the explicit migration
// command may call migrateMemberFinancialSchema; readiness performs SELECTs only.
export const MEMBER_FINANCIAL_VERSION = '20261103-financial-safety-v1';
export const financialError = (message, status = 409) => Object.assign(new Error(message), { status });

export const FINANCIAL_TABLES = [
  `CREATE TABLE IF NOT EXISTS local_line_inventory_operations (
    id CHAR(36) PRIMARY KEY, product_id INT NOT NULL, user_id INT NOT NULL, remote_id BIGINT NOT NULL,
    request_hash CHAR(64) NOT NULL, payload_json JSON NOT NULL, status VARCHAR(32) NOT NULL,
    receipt_json JSON, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    KEY idx_inventory_operation_product (product_id,status)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS member_external_link_verifications (
    link_id INT PRIMARY KEY, provider VARCHAR(64) NOT NULL, external_customer_id VARCHAR(255) NOT NULL,
    user_id INT NOT NULL, method VARCHAR(32) NOT NULL, actor_user_id INT NOT NULL,
    evidence_json JSON NOT NULL, verified_at DATETIME(3) NOT NULL,
    credit_ready_at DATETIME(3), credit_ready_by INT, credit_evidence_json JSON,
    UNIQUE KEY ux_verified_external_owner (provider,external_customer_id),
    UNIQUE KEY ux_verified_user_provider (user_id,provider)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS member_financial_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, source VARCHAR(64) NOT NULL, source_id VARCHAR(191) NOT NULL,
    user_id INT NOT NULL, kind VARCHAR(64) NOT NULL, status VARCHAR(32) NOT NULL,
    facts_json JSON NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY ux_member_event_source (source,source_id), KEY idx_member_events_user (user_id,status)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS member_financial_operations (
    id CHAR(36) PRIMARY KEY, user_id INT NOT NULL, provider VARCHAR(32) NOT NULL, provider_mode VARCHAR(16) NOT NULL,
    kind VARCHAR(64) NOT NULL, request_key VARCHAR(191) NOT NULL, request_hash CHAR(64) NOT NULL,
    request_json JSON NOT NULL, status VARCHAR(32) NOT NULL, result_json JSON, error_message TEXT,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY ux_member_operation_request (user_id,provider,request_key), KEY idx_member_operation_work (status,created_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS member_financial_steps (
    operation_id CHAR(36) NOT NULL, step_key VARCHAR(64) NOT NULL, request_json JSON NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL, status VARCHAR(32) NOT NULL, receipt_json JSON,
    attempted_at DATETIME(3), updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (operation_id,step_key)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS member_stripe_inbox (
    event_id VARCHAR(191) PRIMARY KEY, event_type VARCHAR(100) NOT NULL, provider_mode VARCHAR(16) NOT NULL,
    payload_json JSON NOT NULL, status VARCHAR(32) NOT NULL, error_message TEXT,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS member_subscription_policies (
    stripe_subscription_id VARCHAR(191) NOT NULL, effective_at BIGINT NOT NULL, user_id INT NOT NULL,
    provider_mode VARCHAR(16) NOT NULL, policy_json JSON NOT NULL, operation_id CHAR(36),
    PRIMARY KEY (stripe_subscription_id,effective_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS member_order_reconciliations (
    local_line_order_id BIGINT PRIMARY KEY, user_id INT NOT NULL, facts_json JSON NOT NULL,
    debit_cents INT NOT NULL DEFAULT 0, dividend_cents INT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL, updated_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS member_financial_postings (
    event_id BIGINT NOT NULL, posting_key VARCHAR(64) NOT NULL, ledger_entry_id INT NOT NULL,
    PRIMARY KEY (event_id,posting_key), UNIQUE KEY ux_member_posting_entry (ledger_entry_id)
  ) ENGINE=InnoDB`
];

async function tableExists(db, table) {
  const [rows] = await db.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table]);
  return rows.length > 0;
}

export async function financialPreflight(db) {
  const issues = [];
  for (const [table, columns] of [
    ['member_ledger_entries', 'user_id,reference_type,reference_id'],
    ['member_ledger_accounts', 'user_id,account_type'],
    ['member_external_account_links', 'provider,external_customer_id'],
    ['member_external_account_links', 'user_id,provider'],
    ['member_profiles', 'user_id'], ['member_subscriptions', 'user_id'],
    ['member_subscriptions', 'stripe_subscription_id'], ['member_herdshare_statuses', 'user_id'],
    ['member_credit_mirrors', 'external_link_id']
  ]) {
    if (!await tableExists(db, table)) continue;
    const where = columns.split(',').map(column => `${column} IS NOT NULL`).join(' AND ');
    // Report identifiers/counts only. Never delete or choose a financial winner.
    const [rows] = await db.query(`SELECT ${columns},COUNT(*) AS count FROM ${table} WHERE ${where} GROUP BY ${columns} HAVING COUNT(*)>1 LIMIT 100`);
    if (rows.length) issues.push({ table, columns, duplicates: rows });
  }
  return issues;
}

export async function migrateMemberFinancialSchema(db, migrateLegacy) {
  const [[lock]] = await db.query("SELECT GET_LOCK('csa-store:member-financial-migration',10) AS acquired");
  if (Number(lock.acquired) !== 1) throw financialError('Another member financial migration is running.');
  try {
    const issues = await financialPreflight(db);
    if (issues.length) throw Object.assign(financialError('Financial migration stopped: review duplicate records. No records were deleted.'), { issues });
    await migrateLegacy(db);
    for (const ddl of FINANCIAL_TABLES) await db.query(ddl);
    await db.query(`CREATE TABLE IF NOT EXISTS member_financial_migrations (version VARCHAR(100) PRIMARY KEY,applied_at DATETIME(3) NOT NULL) ENGINE=InnoDB`);
    await db.query('INSERT IGNORE INTO member_financial_migrations (version,applied_at) VALUES (?,UTC_TIMESTAMP(3))', [MEMBER_FINANCIAL_VERSION]);
    // Existing links deliberately remain unverified; old metadata is not proof.
    await assertFinancialSchema(db);
    return { ok: true, version: MEMBER_FINANCIAL_VERSION };
  } finally { await db.query("SELECT RELEASE_LOCK('csa-store:member-financial-migration')"); }
}

export async function assertFinancialSchema(db) {
  try {
    const [rows] = await db.query('SELECT version FROM member_financial_migrations WHERE version=?', [MEMBER_FINANCIAL_VERSION]);
    if (!rows.length) throw new Error('Missing version');
    const required = {
      'member_ledger_entries:ux_member_ledger_entries_user_reference':'user_id,reference_type,reference_id',
      'member_ledger_accounts:ux_member_ledger_accounts_user_type':'user_id,account_type',
      'member_external_account_links:ux_member_external_links_user_provider':'user_id,provider',
      'member_external_link_verifications:ux_verified_external_owner':'provider,external_customer_id',
      'member_external_link_verifications:ux_verified_user_provider':'user_id,provider',
      'member_financial_events:ux_member_event_source':'source,source_id',
      'member_financial_operations:ux_member_operation_request':'user_id,provider,request_key',
      'member_financial_steps:PRIMARY':'operation_id,step_key',
      'member_financial_postings:PRIMARY':'event_id,posting_key',
      'member_stripe_inbox:PRIMARY':'event_id',
      'member_order_reconciliations:PRIMARY':'local_line_order_id'
    };
    const [indexes] = await db.query(`SELECT TABLE_NAME AS tableName,INDEX_NAME AS indexName,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columnsCsv
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND NON_UNIQUE=0
      AND TABLE_NAME IN (?) GROUP BY TABLE_NAME,INDEX_NAME`,[[...new Set(Object.keys(required).map(key=>key.split(':')[0]))]]);
    for(const [key,columns] of Object.entries(required))if(!indexes.some(row=>`${row.tableName}:${row.indexName}`===key && row.columnsCsv===columns))throw new Error('Missing financial constraint');
  } catch {
    throw financialError('Member finances are unavailable until the explicit member financial migration and constraint checks succeed.', 503);
  }
}
