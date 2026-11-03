import { hash, json } from './memberFinancialOperations.js';

export function orderSnapshotDecision(incoming, previous) {
  if (!previous) return 'changed';
  let old;
  try { old=json(previous.raw_json ?? previous.rawJson); } catch { return 'review'; }
  if (hash(incoming) === hash(old)) return 'unchanged';
  const nextTime=Date.parse(incoming.updated_at || ''),oldTime=Date.parse(old?.updated_at || previous.updated_at_remote || '');
  if (Number.isFinite(oldTime) && (!Number.isFinite(nextTime) || nextTime<oldTime)) return 'stale';
  if (Number.isFinite(oldTime) && nextTime===oldTime) return 'review';
  return 'changed';
}
