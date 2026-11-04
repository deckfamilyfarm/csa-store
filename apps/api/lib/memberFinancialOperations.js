import { createHash, randomUUID } from 'node:crypto';
import { getPool } from '../db.js';
import { assertFinancialSchema, financialError } from './memberFinancialSchema.js';

export const json = value => typeof value === 'string' ? JSON.parse(value) : value;
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(stableJson(value)).digest('hex');
export function cents(value, label = 'Amount') {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 2147483647) throw financialError(`${label} must be integer cents within the ledger range.`, 400);
  return value;
}
export function stripeMode() {
  const key = String(process.env.STRIPE_SECRET_KEY || '');
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  throw financialError('Stripe mode cannot be established.', 503);
}
export async function withMemberLock(userId, run, pool = getPool()) {
  const db = await pool.getConnection();
  const key = `csa-store:member-finance:${Number(userId)}`;
  let acquired = false;
  try {
    await assertFinancialSchema(db);
    const [[lock]] = await db.query('SELECT GET_LOCK(?,10) AS acquired', [key]);
    if (Number(lock.acquired) !== 1) throw financialError('Another member financial operation is running. Retry the same request.');
    acquired = true;
    return await run(db);
  } finally { if (acquired) await db.query('SELECT RELEASE_LOCK(?)', [key]); db.release(); }
}

// prepare and execute are server code, never client-supplied actions. Every remote
// mutation is checkpointed BEFORE sending. Unknown outcomes retain the same key.
export async function runMemberOperation({ userId, provider = 'stripe', mode, kind, requestKey, input, prepare, execute, requireExisting = false }, pool = getPool()) {
  if (!/^[\w:.-]{8,191}$/.test(String(requestKey || ''))) throw financialError('Send a stable Idempotency-Key of 8–191 characters.', 400);
  return withMemberLock(userId, async db => {
    const requestHash = hash({ kind, input });
    const [[existing]] = await db.query('SELECT * FROM member_financial_operations WHERE user_id=? AND provider=? AND request_key=?', [userId, provider, requestKey]);
    let operation = existing;
    if (operation && (operation.request_hash !== requestHash || operation.kind !== kind)) throw financialError('That request key was already used for different inputs.');
    if (operation && operation.provider_mode !== mode) throw financialError('Provider mode changed. Reconcile the original operation in its original account.');
    if (operation?.status === 'completed') return { ...json(operation.result_json), operationId: operation.id, status: 'completed' };
    if (operation?.status === 'held') throw Object.assign(financialError(operation.error_message || 'This operation requires review.'), { operationId: operation.id });
    if (!operation && requireExisting) throw financialError('New member billing is paused pending financial reconciliation.',503);
    if (!operation) {
      const [unfinished] = await db.query("SELECT id FROM member_financial_operations WHERE user_id=? AND provider=? AND status<>'completed' LIMIT 1", [userId, provider]);
      if (unfinished.length) throw Object.assign(financialError('Reconcile the previous operation before starting another.'), { operationId: unfinished[0].id });
      const request = await prepare(db);
      operation = { id: randomUUID(), user_id: userId, provider, provider_mode: mode, kind, request_key: requestKey, request_json: request };
      await db.query(`INSERT INTO member_financial_operations (id,user_id,provider,provider_mode,kind,request_key,request_hash,request_json,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'running',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [operation.id, userId, provider, mode, kind, requestKey, requestHash, JSON.stringify(request)]);
    }
    const step = async (key, body, send, { retryUncertain = provider === 'stripe' } = {}) => {
      const [[saved]] = await db.query('SELECT * FROM member_financial_steps WHERE operation_id=? AND step_key=?', [operation.id, key]);
      if (saved?.status === 'confirmed') return json(saved.receipt_json);
      if (saved && hash(json(saved.request_json)) !== hash(body)) throw financialError('A frozen operation step changed. Review the original request.');
      if (saved?.attempted_at && (!retryUncertain || Date.now() - new Date(saved.attempted_at).getTime() >= 22 * 3600 * 1000)) {
        throw Object.assign(financialError('The previous request has an uncertain outcome. Reconcile its provider receipt before retrying.'), { hold: true });
      }
      const idempotencyKey = saved?.idempotency_key || `csa-member:${operation.id}:${key}`;
      await db.query(`INSERT INTO member_financial_steps (operation_id,step_key,request_json,idempotency_key,status,attempted_at,updated_at)
        VALUES (?,?,?,?,'attempted',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE status='attempted',updated_at=UTC_TIMESTAMP(3)`,
        [operation.id, key, JSON.stringify(body), idempotencyKey]);
      const receipt = await send(json(saved?.request_json || JSON.stringify(body)), { idempotencyKey });
      await db.query("UPDATE member_financial_steps SET status='confirmed',receipt_json=?,updated_at=UTC_TIMESTAMP(3) WHERE operation_id=? AND step_key=?", [JSON.stringify(receipt), operation.id, key]);
      return receipt;
    };
    try {
      const result = await execute({ db, operation, request: json(operation.request_json), step });
      await db.query("UPDATE member_financial_operations SET status='completed',result_json=?,error_message=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify(result), operation.id]);
      return { ...result, operationId: operation.id, status: 'completed' };
    } catch (error) {
      await db.query('UPDATE member_financial_operations SET status=?,error_message=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [error.hold ? 'held' : 'uncertain', error.message, operation.id]);
      throw Object.assign(error, { operationId: operation.id });
    }
  }, pool);
}

export async function getMemberOperation(id, userId, db = getPool()) {
  const [[row]] = await db.query('SELECT id,kind,status,result_json,error_message,created_at,updated_at FROM member_financial_operations WHERE id=? AND user_id=?', [id, userId]);
  if (!row) throw financialError('Operation not found.', 404);
  return { id: row.id, kind: row.kind, status: row.status, error: row.error_message, updatedAt: row.updated_at };
}

// Caller owns the transaction. Posting facts and their durable source commit together.
export async function postMemberEvent(db, { source, sourceId, userId, kind, facts, postings, transfer = null }) {
  const [[existing]] = await db.query('SELECT * FROM member_financial_events WHERE source=? AND source_id=? FOR UPDATE', [source, sourceId]);
  if (existing) {
    if (Number(existing.user_id) !== Number(userId) || hash(json(existing.facts_json)) !== hash(facts)) throw financialError('Financial source facts conflict with the recorded event.');
    return { eventId: existing.id, duplicate: true };
  }
  const [insert] = await db.query(`INSERT INTO member_financial_events (source,source_id,user_id,kind,status,facts_json,created_at,updated_at)
    VALUES (?,?,?,?,'posted',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [source, sourceId, userId, kind, JSON.stringify(facts)]);
  const eventId = insert.insertId;
  for (const posting of postings) {
    cents(posting.amountCents);
    await db.query(`INSERT INTO member_ledger_accounts (user_id,account_type,currency,created_at,updated_at) VALUES (?,?,'USD',UTC_TIMESTAMP(),UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`, [userId, posting.account]);
    const [[account]] = await db.query('SELECT id FROM member_ledger_accounts WHERE user_id=? AND account_type=?', [userId, posting.account]);
    const [entry] = await db.query(`INSERT INTO member_ledger_entries (account_id,user_id,entry_type,amount_cents,effective_date,reference_type,reference_id,description,metadata_json,created_at,updated_at)
      VALUES (?,?,?,?,?,'financial_event',?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())`, [account.id, userId, posting.entryType || kind, posting.amountCents, new Date(), `${eventId}:${posting.key}`, posting.description || kind, JSON.stringify({ eventId, ...facts })]);
    await db.query('INSERT INTO member_financial_postings (event_id,posting_key,ledger_entry_id) VALUES (?,?,?)', [eventId, posting.key, entry.insertId]);
  }
  if (transfer && transfer.amountCents !== 0) {
    cents(transfer.amountCents);
    const id = randomUUID(), request = { ...transfer, eventId };
    await db.query(`INSERT INTO member_financial_operations (id,user_id,provider,provider_mode,kind,request_key,request_hash,request_json,status,created_at,updated_at)
      VALUES (?,?,'localline',?,'event_transfer',?,?,?,'pending',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [id, userId, transfer.providerMode || 'live', `event:${eventId}`, hash({ kind: 'event_transfer', input: { eventId } }), JSON.stringify(request)]);
  }
  return { eventId, duplicate: false };
}
