import {test} from 'node:test';
import assert from 'node:assert/strict';
import {orderSnapshotDecision} from './localLineOrderSnapshots.js';
test('existing order IDs can change, but stale and ambiguous revisions cannot overwrite them',()=>{
 const old={id:12,updated_at:'2026-10-20T12:00:00Z',total:10},previous={raw_json:JSON.stringify(old)};
 assert.equal(orderSnapshotDecision({...old},previous),'unchanged');
 assert.equal(orderSnapshotDecision({...old,updated_at:'2026-10-21T12:00:00Z',total:9},previous),'changed');
 assert.equal(orderSnapshotDecision({...old,updated_at:'2026-10-19T12:00:00Z',total:9},previous),'stale');
 assert.equal(orderSnapshotDecision({...old,total:9},previous),'review');
 assert.equal(orderSnapshotDecision({...old,updated_at:null},previous),'stale');
});
