# Production data and enterprise pricing migration

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

Review & Publish compares these local prices against the imported Square and all four Local Line basket prices, showing differences and missing mappings. Matching imported prices are not a live verification. Saving creates no publication, approval, or remote request. Production saves still require the existing approval and publication flow. Promotional sales remain separately reviewed.

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
