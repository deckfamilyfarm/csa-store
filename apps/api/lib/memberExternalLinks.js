import { getPool } from '../db.js';
import { assertFinancialSchema, financialError } from './memberFinancialSchema.js';

export async function requireVerifiedLocalLineLink(link, userId, db = getPool(), { creditReady = false } = {}) {
  if (!link || Number(link.userId ?? link.user_id) !== Number(userId)) throw financialError('Connect and verify your own Local Line account first.', 403);
  const [rows] = await db.query(`SELECT v.* FROM member_external_link_verifications v
    JOIN member_external_account_links l ON l.id=v.link_id AND l.user_id=v.user_id
      AND l.provider=v.provider AND l.external_customer_id=v.external_customer_id
    WHERE v.link_id=? AND v.user_id=? AND v.provider='localline'`, [link.id, userId]);
  const verification = rows[0];
  if (!verification || (creditReady && !verification.credit_ready_at)) {
    throw financialError(creditReady ? 'Review the starting Local Line balance before transferring member credit.' : 'This Local Line link needs ownership verification. Sign in to Local Line or ask a member administrator.', 403);
  }
  return verification;
}

export async function saveVerifiedLocalLineLink({ userId, externalCustomerId, externalEmail = null,
  method, actorUserId, evidence }, pool = getPool()) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0 || !/^\d+$/.test(String(externalCustomerId)) ||
      !['storefront_login', 'staff_review'].includes(method) || !actorUserId || !evidence) throw financialError('A verified Local Line identity and evidence are required.', 400);
  const db = await pool.getConnection();
  try {
    await assertFinancialSchema(db);
    await db.beginTransaction();
    // All claimants serialize here, including ownership changes and first links.
    const [members]=await db.query('SELECT id FROM users WHERE id=? FOR UPDATE', [userId]);
    if(!members.length)throw financialError('Member not found.',404);
    const [claims] = await db.query("SELECT id,user_id,external_customer_id FROM member_external_account_links WHERE provider='localline' AND (external_customer_id=? OR user_id=?) FOR UPDATE", [String(externalCustomerId), userId]);
    if (claims.some(row => Number(row.user_id) !== Number(userId))) throw financialError('That Local Line customer is already linked to another member. Ask a member administrator to review ownership.');
    const old = claims.find(row => Number(row.user_id) === Number(userId));
    if (old && old.external_customer_id !== String(externalCustomerId)) {
      const [history] = await db.query('SELECT id FROM member_financial_operations WHERE user_id=? LIMIT 1', [userId]);
      const [ledgerHistory]=await db.query('SELECT id FROM member_ledger_entries WHERE user_id=? LIMIT 1',[userId]);
      if (history.length || ledgerHistory.length) throw financialError('This financial account has operation or ledger history. Review the account change before relinking it.');
      await db.query('DELETE FROM member_external_link_verifications WHERE link_id=?', [old.id]);
    }
    const metadata = JSON.stringify({ connectionStatus: 'connected', linkedBy: method });
    let linkId = old?.id;
    if (old) await db.query('UPDATE member_external_account_links SET external_customer_id=?,external_email=?,metadata_json=?,updated_at=UTC_TIMESTAMP() WHERE id=?', [String(externalCustomerId), externalEmail, metadata, linkId]);
    else {
      const [insert] = await db.query(`INSERT INTO member_external_account_links (user_id,provider,external_customer_id,external_email,metadata_json,linked_at,created_at,updated_at)
        VALUES (?,'localline',?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())`, [userId, String(externalCustomerId), externalEmail, metadata]);
      linkId = insert.insertId;
    }
    await db.query(`INSERT INTO member_external_link_verifications (link_id,provider,external_customer_id,user_id,method,actor_user_id,evidence_json,verified_at)
      VALUES (?,'localline',?,?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE method=VALUES(method),actor_user_id=VALUES(actor_user_id),evidence_json=VALUES(evidence_json),verified_at=VALUES(verified_at)`,
      [linkId, String(externalCustomerId), userId, method, actorUserId, JSON.stringify(evidence)]);
    // A competing claim cannot turn another owner's verification into this link.
    await requireVerifiedLocalLineLink({ id: linkId, userId }, userId, db);
    await db.query("UPDATE member_profiles SET local_line_setup_status='connected',local_line_setup_mode=?,local_line_setup_note=NULL,updated_at=UTC_TIMESTAMP() WHERE user_id=?", [method, userId]);
    await db.commit();
    return { linkId, verificationStatus: 'verified' };
  } catch (error) { await db.rollback(); if (error.code === 'ER_DUP_ENTRY') throw financialError('This Local Line customer has a competing owner. Review its links.'); throw error; }
  finally { db.release(); }
}

export async function approveLocalLineCreditStartingPoint({ userId, actorUserId, evidence }, db = getPool()) {
  if (!String(evidence || '').trim()) throw financialError('Record the reviewed balance and supporting transaction evidence.', 400);
  const [links] = await db.query("SELECT * FROM member_external_account_links WHERE user_id=? AND provider='localline'", [userId]);
  const verification = await requireVerifiedLocalLineLink(links[0], userId, db);
  await db.query('UPDATE member_external_link_verifications SET credit_ready_at=UTC_TIMESTAMP(3),credit_ready_by=?,credit_evidence_json=? WHERE link_id=?', [actorUserId, JSON.stringify({ note: evidence }), verification.link_id]);
  return { ok: true };
}
