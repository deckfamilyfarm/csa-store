# Financial and publication stabilization

This change addresses audit findings 1–9. It adds no production data corrections,
changes no existing role assignments, and does not infer an opening balance.
Local Line remains the authority for spendable member credit. The CSA ledger
records identified financial events; it must not reset Local Line to its sum.

## Behavior and acceptance checks

| Finding | Implemented boundary | Behavioral check |
| --- | --- | --- |
| 1: customer ownership | Manual customer-ID linking returns 410. Customer login derives the ID from `customers/current`. Privileged reads/imports/transfers require separately stored verification. One verified financial owner per Local Line customer. | Signed member requests cannot read another member's operation or use an unverified link. Competing ownership claims fail. |
| 2: legacy publication | Bulk edits save locally; explicit remote or forced-price requests fail. Membership saves explicitly remain local. The legacy outbound price service and Killdeer imports reject enterprise pricing; remote IDs require saved mappings. | Bulk remote/forced requests fail before local changes or provider writes; reviewed publications retain vendor Cost. |
| 3: whole-balance overwrite | Only recorded funding/refund events queue transfers. A verified link and staff-reviewed starting point are mandatory. Attempts and target customers are durable before POST. Uncertain transfers reconcile by exact operation note, amount, type and remote ID; no blind resend. | A remote purchase does not cause a top-up. Lost transfer responses resolve from history with one POST. Test funding cannot reach live Local Line. |
| 4: repeated Stripe commands | Frozen operations, per-member execution locks, per-step keys and receipts, owner-scoped status, persistent browser retry keys. New billing defaults paused. | Concurrent setup/retries share one customer/request. Plan updates do not cancel/recreate. Initial invoices isolate pending items and finalize before payment. Paused fees and uncertain old requests do not double-charge. |
| 5: invoice correctness | Verified webhook inbox, explicit subscription or initial-funding receipt attribution, frozen effective policies, integer cents, atomic source/ledger/transfer-intent posting. Mirrors reflect observations only. | A failed fee insert rolls back the deposit. Duplicate invoices/refunds post once. Current-plan edits do not revalue old invoices. Delayed lifecycle events use current Stripe state. |
| 6: enterprise creation | Approved Cost and retail snapshots feed the durable Product Sync create/link/verify workflow, including package-specific costs and basket exclusions. | Create → approve → audit → publish → verify saves distinct package links. A lost create response never sends another POST, including transport retries. |
| 7: changed orders | Full order-page scans revisit existing IDs. Identical data is not rewritten; older/ambiguous revisions are held. Both old and new reporting months refresh. Purchase reconciliation records atomic deltas, preserving original dividend policy. | An older order ID can change price, package lines and fulfillment month. Cash-only orders never debit credit. Cancellation does not invent a refund. Explicit provider credit transactions support reviewed refund adjustments. |
| 8: stock race | Existing-product quantity PATCHes are blocked at the transport boundary; UI quantities are read-only. Refreshes remain available. Tracking/visibility use durable receipts and readback. Farm counts and preorder allocations remain independent. | Unsupported quantity writes, including older approved actions, send zero requests. A reviewed pricing update preserves stock. |
| 9: destructive bootstrap | Explicit versioned migration and read-only readiness replace member financial DDL at startup/request time. Duplicate references/owners stop migration. Historical entries are never deleted or silently consolidated. | Repeated migration is safe. Duplicate fixtures remain intact after refusal. Missing constraints fail readiness. |

## Deployment sequence

1. Back up the database using the normal operational procedure. Review the diff
   and pass the unit, disposable MySQL 8.4, and frontend build checks below.
   Keep `MEMBER_BILLING_ENABLED` and `MEMBER_CREDIT_TRANSFERS_ENABLED` unset or
   `false`. Their default is paused. Existing webhook processing remains enabled.
2. Run `npm --prefix apps/api run migrate:member-finances -- --check` against the
   intended deployment environment. This command reports duplicate identifiers,
   references and ownership conflicts. It does not select a winner or delete data.
   Resolve conflicts by a separately reviewed disposition; preserve original
   financial facts and use compensating postings where needed.
3. Run `npm --prefix apps/api run migrate:member-finances -- --apply` before
   routing requests to the new code. MySQL DDL is not transactional: an interrupted
   migration can leave additive tables/indexes behind. Re-running is supported;
   the version is recorded only after schema creation. Verify `/api/ready` returns
   200. `/api/health` remains liveness only.
4. Deploy API, frontend and hourly runner together. Existing account links start
   unverified, regardless of old free-form metadata. Members can verify through
   Local Line login. Staff with `member_admin` can record reviewed identity
   evidence at `POST /api/admin/members/:id/localline-verification`.
5. In Membership's financial review, inspect pending provider operations and
   webhook holds. Review historical subscription policies instead of inferring
   them from today's plan. Staff can add immutable historical policies through
   `POST /api/admin/members/:id/funding-policy` with `creditCents`, `feeCents`,
   `priceId`, `effectiveAt` (Unix seconds), and evidence. Existing legacy invoice
   postings are held for explicit reconciliation rather than posted again.
6. Establish each verified member's starting Local Line balance and transaction
   history. Record evidence through
   `POST /api/admin/members/:id/localline-credit-starting-point`. This approves a
   transfer boundary, **not** a balance adjustment. Historical deposits with no
   reliable delivery receipt are not converted into new transfers automatically.
7. Enable new billing and event transfers for a reviewed rollout cohort using
   existing deployment access controls. The environment gates enable new commands
   deployment-wide; verify every exposed account before enabling them. Inspect
   provider receipts and balances after the first funded cycle. Broader cohort
   authorization is a later feature, not an inferred permission change here.

The existing hourly scheduled-pricelist runner resumes unfinished Stripe work
and webhook inbox entries. `npm --prefix apps/api run run:member-finances` is the
equivalent manual recovery command. Local Line event transfers are explicitly
previewed/sent from the financial review UI's Event Transfers controls; the old
credit-sync endpoint is compatibility routing to that queue, not a balance setter.

## Holds and recovery

- A failed remote read never authorizes a financial write. Cached balances are
  comparison data. Local Line's observed balance, local ledger total and pending
  transfer totals may legitimately differ.
- Stripe requests preserve exact per-step bodies and keys. Uncertain attempts
  older than 22 hours are held before provider key retention becomes unsafe.
  Confirm their original provider receipts through an explicit operational review;
  do not delete the operation or create a replacement charge. Automatic replay
  will not resolve these holds by guessing. A future dedicated receipt-adoption
  UI can streamline this exceptional workflow.
- Unknown historical policies, legacy partial invoice/fee postings, unsupported
  invoices, split-payment refunds and conflicting links remain held. Refunds
  reverse original credit/bonus/fee proportionately, never today's pricing.
- Local Line order refunds require actual positive credit transactions explicitly
  linked to the order. Staff can preview/apply selected transaction IDs at
  `POST /api/admin/members/:id/localline-order-refund` (`orderId`,
  `transactionIds`, `dryRun`, default true). Unsupported provider evidence remains
  held; cancellation alone never creates money. Include the cumulative set of
  refund transactions for the order.
- Local Line creation uncertainty remains held even through a replacement audit.
  Inspect the actual created product and repair its mapping before a new review.
- A tracking/visibility request with a lost response is confirmed from the current
  remote result on retry. A conflicting result is held, not resent. The durable
  receipt is in `local_line_inventory_operations`.
- Make Full Farm quantity corrections in Local Line, then refresh CSA Store.
  No verified conditional or atomic-delta contract was available in local source
  evidence. Re-enabling quantity pushes requires a provider capability check and
  a regression proving that a sale between read and write cannot be overwritten.

Rollback stops new commands via the gates, preserves all operation/event receipts,
and keeps verified webhook/recovery processing running. Do not roll back to the
whole-balance writer, automatic ledger deletion, or legacy bulk publication.

## Local verification

```sh
npm --prefix apps/api run test:stabilization
python3 scripts/test-stabilization.py --docker
npm --prefix design/template/vite-app run build
```

The integration runner requires an already cached `mysql:8.4` image and Docker;
it never downloads an image. It uses tmpfs data, a random loopback port and a
temporary Unix socket, excludes inherited credentials, never reads `.env`, mocks
all providers, and removes the test container/data afterward. All required suites
run with explicit disposable socket variables; no missing-socket skips are
accepted by this runner. Without `--docker`, the runner uses an installed local
`mysqld` with TCP networking disabled. CI separately acquires MySQL 8.4 before
running the same tests. No live provider/POS validation or production reconciliation
is implied by these local checks.
