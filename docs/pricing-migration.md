# Production data and enterprise pricing migration

## Reviewed local data: production cutover

Use `apps/api/scripts/pricingCutover.js` to transfer the reviewed local work. **Do not restore the development database over production.** The older conversion commands below create initial proposals from legacy data; they are not the transfer mechanism for the completed local edits.

The cutover compares three sources: the original production snapshot, the reviewed local catalog, and current production. It copies only reviewed catalog fields and enterprise pricing/bundle records. Conflicting edits stop the entire transaction. Orders, users, roles, payments, stock, farm counts, channel receipts, and promotions are excluded. Imported local editor IDs are attributed to the specified real production editor, with the original IDs retained in the migration provenance. The development administrator is never imported.

A new settings version preserves the reviewed monetary outputs while making current revisions publishable under that version. `--allow-same-approver` implements John's October 29 decision: the same authorized person may edit and approve; saving still never publishes. Historical revisions and purchase-cost history are retained. No channel approval or verification is inferred from the development copy.

Rehearsal completed October 29, 2026 on `csa_pricing_local_20261029150000`, separate from the selected development database. The fresh production snapshot contained 88 tables / 280,932 rows. The migration transferred 769 saved pricing records and 10 bundles. Verification confirmed all 78 excluded tables and every existing inventory count unchanged; rollback restored all 88 original tables. Private plans, verification reports and snapshots are under `.local-pricing/cutover/` and must stay out of Git.

Production cutover completed October 29, 2026: 6,662 reviewed operations, 769 saved pricing records and 10 bundles, with no conflicts. The fresh backup contains 88 tables / 280,949 rows. Every migrated field was checked against the plan; inventory, users, role assignments and legacy sales matched their pre-cutover fingerprints. Authenticated pricing/inventory API checks and the public admin health check passed. Private backup, plan, verification and deployment receipts are in `/home/jdeck/csa-rollouts/20261029-226669f/`, with a checksum-verified backup copy under the local `.local-pricing/cutover/` directory. No Square or Local Line publication was performed; the sales-adoption and channel-pilot holds below still apply.

### Production sequence (requires deployment approval)

1. Commit and push the reviewed branch. On `ffcsa-server`, the app is `/home/jdeck/code/csa-store`, PM2 process `store`, currently on `main`. Deploy the exact tested commit together with this migration; do not run the old app against migrated data. The shell uses Node 22.17 and the existing PM2 process uses Node 20.19.6. Keep the existing process configuration and `.env`; never use `npm run dev` or copy local credentials on the server.
2. Pause catalog editing and the CSA catalog-pull / scheduled-price jobs for the cutover window. Keep order/payment maintenance running. Take a fresh complete production backup. Transfer the reviewed local catalog snapshot and original catalog baseline privately; neither belongs in Git. Capture the current commit and crontab for rollback.
3. From the new checkout, prepare the additive schema, then generate a fresh production comparison. Schema preparation does not activate pricing or contact channels:

   ```sh
   node --env-file=.env apps/api/scripts/pricingCutover.js --prepare-schema --confirm-database=store --editor-id=5
   node --env-file=.env apps/api/scripts/pricingCutover.js --baseline=PRIVATE_ORIGINAL_SNAPSHOT --source=PRIVATE_REVIEWED_CATALOG.json --out=PRIVATE_PRODUCTION_PLAN.json --editor-id=5 --allow-same-approver
   ```

4. Review the resulting conflicts, operation counts and hash. Stop if anything differs from the rehearsed intent. Apply that exact plan with its hash and the fresh backup manifest:

   ```sh
   node --env-file=.env apps/api/scripts/pricingCutover.js --apply --plan=PRIVATE_PRODUCTION_PLAN.json --approved-hash=REVIEWED_HASH --backup-manifest=PRIVATE_BACKUP/manifest.json --confirm-database=store --editor-id=5
   ```

   Apply rechecks affected rows inside a transaction. Repeating the same successful plan is a no-op. It makes no Local Line, Square, email, payment or Google requests.

5. Build the frontend and restart only PM2 `store` using its existing configuration. Verify Timesheets login (`deck.john`, linked to CSA user `jdeck` / ID 5), Pricing, Inventory, saved prices and order/payment health. Run `node --env-file=.env apps/api/scripts/pricingDeploymentCheck.js` on the server. Check cached comparisons separately from actual remote verification.
6. Restore scheduled jobs with the new code. Once local pricing is authoritative, the legacy catalog audit/cache importers run review-only and cannot overwrite catalog, photos or sales. Order/customer/reporting imports remain separate. Old scheduled product releases are held for migrated products before either local changes or remote publication.
7. Merge the tested refactor into `main`, then align the deployed checkout with that same merged code. A database migration and a Git merge are distinct operations. Publish channel changes separately, beginning with a small reviewed batch.

Before any channel publication, preserve the remaining holds: Green Bag has no remote package; vendorless products cannot be edited/published; legacy Local Line sales require explicit reconciliation, including flags on hidden products. Legacy batch 3 has two failed chicken rows and must not be blindly retried. Bundle publication checks all component selling prices in all four baskets first, so sale conflicts also hold dependent bundles. Deposits and Membership keep their special workflows.

Bundle publication requires both `LL_BUNDLE_PUBLICATION_ENABLED=true` and `LL_BUNDLE_PILOT_BOX_IDS` containing the explicitly approved remote box IDs. For example, `2260` scopes the pilot to Ground Beef & Pork; it is not authorization to publish it. Square automatic discounts retain `SQUARE_PROMOTION_POS_VERIFIED=true` after an actual market POS test. Neither gate was enabled during development. Bundle inventory-mode/stock changes and newly uploaded images require separate validation; publication does not guess or overwrite those fields.

### Sales reconciliation before the first bundle pilot

Use `snapshotPricingReview.mjs --out=<private-dir>/local.json` in the isolated local environment, then the standalone read-only `capturePricingReview.mjs --local=<private-dir>/local.json --out=<private-dir>`. For a full-store check also run `captureRemoteCatalog.mjs --out=<private-dir>/full-channel-check`. Generate the offline comparison with `reportPricingSales.mjs --dir=<private-dir> --full-capture=<private-dir>/full-channel-check` (all three scripts are under `scripts/local-pricing/`). The full report identifies remote sale flags absent from local legacy flags. Explicit `product_is_box` export aliases are listed separately; other capture failures stop the report. Snapshots and the HTML/JSON report stay private and contain no credentials.

1. Review visible sales and hidden-product exceptions separately. An inferred percentage requires the same sale display and selling price in all four baskets; it is not permission to publish. Keep hidden products hidden. Missing/inconsistent basket entries remain held.
2. Record the intended percentage, channels, dates and real approving user. Retain current remote prices as baselines. The October 29 decision is to retain existing discounts on the new model and remove the incorrect salami display at a $13.50 regular FF package price; sales remain active until explicitly turned off in the interface (`endAt: null`), with no automatic expiry. The nine consistent visible discounts are eight at 10% and Ground Pork at 20%.
3. Legacy sale flags and managed promotions are excluded from the pricing cutover. Reconcile them through an explicit audited publication workflow; importing the regular pricing model alone does not complete this step. Do not clear flags merely to bypass approval guards. Square catalog prices already include discounts on several items; restoring the base and adding automatic discounts must be coordinated and verified to avoid a temporary price jump or double discount. Unmapped chicken variations and actual POS behavior remain separate holds.
4. Verify the individual component prices first. With retained discounts, the Ground Beef & Pork pilot is `2 × $12.60 + 2 × $8.64 = $42.48`, less 5%, rounded to **$40.36**. Its Buy Price remains **$26.73**; its current observed LL selling price is **$41.43**. These are October 29 observations, requiring fresh review before publication.
5. After approval, enable only the chosen box ID, inspect the frozen patch and publish with the persisted receipt. Verify all four basket prices, unchanged visibility/Buy Price, and bundle behavior in Local Line. Disable the pilot gate afterward. Repeat the component/bundle review when a component sale ends; automatic bundle republishing is not implemented.

### Rollback

Before channel publication or subsequent edits, reverse the precise applied plan:

```sh
node --env-file=.env apps/api/scripts/pricingCutover.js --rollback=APPLIED_HASH --confirm-database=store --editor-id=5
```

Rollback refuses later edits/publications or new references to inserted catalog records. It preserves unrelated inventory changes. Schema and the audit receipt remain. Once data rollback verifies, restore the earlier app commit and restart `store`. Do not downgrade the app first or restore an old full backup over newer orders. If rollback is held, reconcile the affected records explicitly. A rolled-back plan cannot be reapplied; generate a new reviewed plan.

Rollback compares DECIMAL scale and date-only DATETIME inputs using their database types (for example, `50.00` equals stored `50.0000`), while still rejecting actual value changes. Text and JSON comparisons remain exact.

## Local development

`npm run dev` uses Docker MySQL on `127.0.0.1:33077`, the `csa_local` account, and the database selected in `.local-pricing/active.json`. The selection accepts only `csa_pricing_local` or a timestamped `csa_pricing_local_YYYYMMDDHHMMSS` database. The original fixture database remains available.

Create a fresh complete production clone and pricing conversion:

```sh
npm run db:local:up
npm run db:local:clone
```

The clone command reads `.env` only in its standalone production exporter. It exports every production table in one repeatable-read, read-only transaction. It preserves IDs, mappings, histories, users, inventory, orders, and cached catalogs. The exporter rejects views, triggers, routines, events, and non-InnoDB tables rather than restoring executable objects or claiming an inconsistent snapshot is complete.

Restore creates a fresh local schema and verifies snapshot checksums, exact table row counts, and foreign-key relationships. It never drops an existing schema. Pricing conversion then runs locally. The active database selection changes only when every preceding step succeeds. Restart your own `npm run dev` process after the command completes.

Sign in at `http://127.0.0.1:5176/admin` with `local.admin` / `local-pricing-admin`. The clone adds this local administrator; existing production user records and password hashes are preserved. Local Line, Square, Timesheets, payments, email, and cloud credentials are removed from the local API environment, and outbound network connections are blocked. Catalog price-list IDs are loaded from the clone so the legacy screens still calculate correctly.

Pricing saves take effect immediately in the isolated local store. Markup, package, and complete-product saves record a `local-preview` revision and update the active local price in the same transaction. Buy Price changes also recalculate and activate prices when the product has complete pricing inputs. Incomplete products retain the saved cost until their remaining inputs are supplied.

Review & Publish compares these local prices against the imported Square and all four Local Line basket prices, showing differences and missing mappings. Matching imported prices are not a live verification. Saving creates no publication, approval, or remote request. Production saves also activate the saved store price immediately; channel synchronization requires separate approval and publication. Promotional sales remain separately reviewed.

To bring previously saved pending prices into use in an existing local clone, run `node scripts/local-pricing/activateSavedPrices.mjs`. It validates each record, preserves earlier revisions, reports any held records, and cannot run against a production database.

Switch back without deleting either database:

```sh
npm run db:local:select -- --previous
# Or choose the original fixture database explicitly:
npm run db:local:select -- --database=csa_pricing_local
```

Restart `npm run dev` after switching. Do not run the synthetic `db:local:init` or sample importer against a full clone; those tools refuse it.

Snapshots, selected-database state, comparison reports, and migration receipts live in the ignored `.local-pricing/` directory. Snapshot directories are private and data/report files are created with mode `0600`.

## Conversion rules

- Buy Price starts with the stored price of the first visible package divided by its quantity or average pounds, rounded to cents. The report records the source package and inference. Differing package costs are explicitly flagged. These are proposed purchase costs to validate before production approval.
- Square eligibility follows the configured vendor defaults. Existing mappings are preserved, including mappings on vendors now excluded by default; those exclusions are reported.
- For Square-enabled products, the current mapped Square unit price is the starting retail reference. For an existing sale, the stored regular retail price is preferred so a discounted catalog price does not become permanent. Missing mappings can use the stored regular retail price for a proposal, with mapping review required.
- Square rounds to $0.50. The migration calibrates a custom cost markup to reproduce that price. Local Line then uses Square less the configured 10%, multiplied by package weight or quantity.
- CSA-only products calibrate markup against the existing Guest Basket regular price. If unavailable, the other stored basket prices or the existing local pricing calculation provide the reference.
- All four basket prices are calculated from one package price. Basket conflicts, missing baskets, customer-specific overrides, different package costs, and changes exceeding 20% are recorded for review. Wholesale prices are not invented.
- Missing vendors, unknown Square pricing units, invalid weights, missing packages, absent prices, and below-cost reference prices are held. Deposits and Membership products retain their existing workflow.
- Existing sales are recorded separately. Reports show both proposed regular prices and the result of the existing sale percentage; migration does not create live discounts or approve promotions.

Local seeding applies only uncomplicated cases to the local storefront. Cases needing review still have editable new-model proposals where inputs are sufficient. Every source product receives a migration record, so held cases retain their source values in the Pricing screen. The legacy catalog fields are not rewritten.

## Rehearsing the production migration

Preview the currently selected clone without writing pricing data:

```sh
npm run db:local:migrate -- --out=.local-pricing/review.json
```

The JSON plan contains frozen source fingerprints, all inputs and calculated outputs, purchase-cost provenance, review decisions, and per-package comparisons. The companion CSV compares each existing Square price and each Local Line basket with proposed regular and sale prices.

To change a plan's inputs, edit its `input` fields and regenerate the comparison before applying:

```sh
npm run db:local:migrate -- --plan=.local-pricing/review.json --out=.local-pricing/reviewed.json
```

Set `approvedForMigration: true` only on rows whose Buy Price, unit, packages, markup, sales, basket changes, and mappings have been reviewed. The same code can later preview production using a read-only transaction:

```sh
node --env-file=.env apps/api/scripts/migrateEnterprisePricing.js --out=.local-pricing/production-review.json
```

Production apply is a separate explicit operation, to run only after review and a fresh backup:

```sh
node --env-file=.env apps/api/scripts/migrateEnterprisePricing.js \
  --apply --plan=.local-pricing/production-review.json \
  --confirm-database=store --editor-id=YOUR_CSA_USER_ID
```

Use the actual database name in place of `store`. Apply validates the editor's pricing permission, the settings version, unchanged source fingerprints, and recalculated outputs. It creates pending proposals and Buy Price drafts only for reviewed rows. It never activates production prices, sends a Square or Local Line request, creates a promotion, changes inventory, rewrites historical orders, or rewrites legacy pricing fields. The ordinary publication approval process remains required.

The migration is transactional and preserves existing enterprise edits. Repeating it skips already migrated products. Receipts identify the migration run and each created revision. Rollback removes only untouched pending migration drafts; it refuses to discard later edits or publications:

```sh
node --env-file=.env apps/api/scripts/migrateEnterprisePricing.js \
  --rollback=RUN_KEY --confirm-database=store --editor-id=YOUR_CSA_USER_ID
```

Legacy source data remains available after apply and rollback. Schema additions and migration history remain for audit. A rolled-back migration is retained in the ledger and is not automatically reapplied; generate and review a subsequent migration version if needed.

## Verification

```sh
node --test apps/api/lib/enterprisePricingMigration.test.js scripts/local-pricing/guard.test.mjs
node scripts/local-pricing/verifyProductionClone.mjs --plan=.local-pricing/production-pricing-migration.json
```

The full-clone verifier compares original catalog fingerprints, checks equal basket prices and absence of publication actions, and tests local login, Pricing, migration comparisons, inventory reads, and storefront calculations through a temporary localhost server. It closes the server before returning.
