# Local-only pricing refactor workspace

This workspace uses isolated Docker MySQL. It supports synthetic fixtures and a full production clone for migration testing. See [the production clone and migration guide](pricing-migration.md) for the current workflow. The root `.env` remains untouched.

## Start

From the repository root:

```sh
npm run db:local:up
npm run db:local:init
npm run dev
```

Open `http://127.0.0.1:5176/admin` and sign in as `local.admin` with password `local-pricing-admin`. The sample products are Synthetic Ground Beef (formula, per pound), Synthetic Apple Box (standard package), and Synthetic Deposit (zero markup). The database persists in Docker's `csa-store_csa_pricing_mysql` volume. `npm run db:local:down` stops it without deleting the volume.

The API listens on `127.0.0.1:5177`; MySQL listens on `127.0.0.1:33077`. Both use dedicated local credentials. Running `db:local:init` again creates missing schema and fixtures without overwriting edited fixture rows.

## Real catalog samples for local testing

The isolated database also contains 15 selected production catalog snapshots, imported on October 21, 2026. They use new local product and package IDs, the source vendor names, and no actionable Local Line or Square IDs, variation mappings, price-list entries, credentials, or inventory. A separate read-only evidence snapshot holds destination prices and legacy sale/sync fields without creating integration links. The production export used a read-only MySQL transaction. Reimporting the snapshot preserves any local edits to existing sample products.

| Vendor | Sample products | Existing pricing units |
|---|---|---|
| Deck Family Farm | Bratwurst; chicken eggs (dozen); Chuck roast; bone-in pork chop; small Red Ranger chicken | 2 each, 3 lbs |
| Hyland | Bulk chorizo; chicken broth; beef tallow; sausage potato dumplings; Cajun Chaurice links | 4 each, 1 lbs |
| Creamy Cow | A2 milk quart; Raw A2/A2 milk; cultured buttermilk; whole milk half gallon; fresh sweet cream | All five lack an explicit pricing profile/unit in the current catalog |

Hyland has only one product explicitly marked `lbs` in the current store. The Creamy Cow missing units remain unresolved, and those samples have two of the four Local Line baskets in the snapshot. The local Pricing table displays the source prices, markups, Square and Local Line prices, and sale flags directly. It seeds a two-decimal **Buy Price** from each stored package price: per item for `each`, per average pound for `lbs`, and per package when the unit is missing. For example, Chuck roast's $22.51 package at 2.6 lb becomes $8.66/lb. The Buy Price cell can be edited and saved to the isolated local database; reimporting samples preserves that edit. A Buy Price edit now recalculates and activates local prices immediately when the product has complete pricing inputs; synchronization remains separate. The production store has no separate purchase-cost or wholesale-price table, so confirm the economic meaning of these migrated values before any production publication.

To rebuild the samples after recreating the local database, run the explicitly production-reading `node apps/api/scripts/exportPricingSamplesReadOnly.js` and then `npm run db:local:samples`. The export writes `/private/tmp/csa-store-pricing-samples.json` and performs no production writes. `node scripts/local-pricing/verifySamples.mjs` checks the imported records and absence of Square links. Restart `npm run dev` after backend code changes; Vite reloads the frontend but the API process does not hot reload.

## Isolation checks

`npm run dev` and `npm --prefix apps/api run dev` now use the local-only launcher. It removes inherited credentials, skips both `.env` loaders used by the API, requires the dedicated localhost database settings, disables Local Line and Square credentials, and rejects outbound network connections from the API process. The Vite server also binds to localhost. The previous connected development command is available only as the explicit `npm run dev:connected` script; it reads `.env` and can reach production services.

Run the guard test at any time:

```sh
node --test scripts/local-pricing/guard.test.mjs
```

Do not use scripts that explicitly pass `--env-file=.env` for local-only work. They are separate production-capable maintenance commands. The local launcher protects the API process and the `db:local:init` command, not arbitrary shell commands.

## Refactor and test sequence

1. Keep pricing calculations in pure functions where possible; use the three fixtures for manual admin checks of formula pricing, standard package pricing, and deposits.
2. Add focused unit tests for any changed pricing rule and run the existing pricing and Product Sync tests:

   ```sh
   node --test apps/api/lib/productMarkup.test.js apps/api/lib/customerPriceOverrides.test.js apps/api/lib/productSyncCore.test.js apps/api/lib/productSyncAdapters.test.js apps/api/lib/squarePricingUnits.test.js apps/api/lib/productPricingUnitInput.test.js design/template/vite-app/src/components/productWorkspace.test.js
   ```

3. Check `/admin` and the Pricing workspace with `npm run dev`. Any Local Line or Square audit or apply request should fail locally because remote access is blocked. Local saves can be tested against the synthetic database.
4. Review the diff and test output before considering any connected environment. Keep production data and remote publication out of this refactor loop.

The opt-in Product Sync integration suites require their own disposable MySQL socket under `/tmp/csa-product-sync-*`; they skip by default. The persistent local app database is not used by those suites.

### Local markup presets

The preset defaults are Highly perishable 100%, Perishable 65%, Shelf stable 50%, and Deck/Hyland Markup 85%. Product-specific percentages remain available through Custom. Existing settings versions keep their recorded rates; changing code defaults alone does not reprice previously saved revisions.

`node scripts/local-pricing/applyMarkupPresets.mjs` previews the requested local assignments. Add `--apply` to activate a new local settings version and save local pricing revisions. The script uses only the selected Docker database, blocks external connections, and records before/after values and results under `.local-pricing/markup-presets-*.json`. It assigns eligible Deck/Hyland products first, then products whose configured markup is 43–48% inclusive to Shelf stable. Deposits and membership products are excluded and verified unchanged. Fixed retail overrides remain intact.

Products lacking complete pricing inputs retain their category in `enterprise_pricing_markup_assignments`; no costs or units are invented. The editor loads that category, and a successful pricing save consumes the pending assignment in the same transaction. These assignments and schema changes do not authorize external publication. Restart `npm run dev` after updating backend code.

### Local UI and API connected to the production database

Run `npm run dev:connected` and open `http://127.0.0.1:5180/admin`. Both development commands watch backend imports and restart the API after code changes. Processes started before watch mode was added need one manual restart; refreshing the browser alone does not reload an older API.
This deliberately uses the database, Timesheets login, and integration credentials
in the root `.env`. Saved product edits affect the production database. Sign in
with your normal server account. Review & Publish still requires explicit approval
and publication; starting this command does not run a catalog sync or seed users.
The API binds to loopback on port 5181; both processes stop with Ctrl-C.
`npm run dev` continues to use the isolated Docker database on ports 5176/5177.

Review & Publish → Products shows all current pricing revisions, with search,
vendor/status filters, and a checkbox selecting all matching rows. Changing a
filter clears selection. **Approve & check selected** approves saved inputs and
checks applicable channels without publishing. Review the prices and open a
product for the full package/basket comparison and saved warnings, then use
**Publish selected** to submit only ready, selected products. Blocked products are
skipped. Each product retains its coordinated channel approval and durable release
receipt. Failed publications offer a retry of that receipt; refreshing the page
recovers saved audit warnings and publication progress. Bundles and Sales retain
their separate review controls in tabs.

### Retired CSA Members price list

CSA Members (Local Line list 2718) is no longer an active pricing destination.
Regular pricing, promotions, bundles, new product mappings, comparisons, and
migration previews use Guest Basket, Herd Share Members, and SNAP. Missing one
of those three still blocks publication. Old frozen product approvals require a
fresh check; previously reviewed bundle publications also detect the list change.
The old environment ID remains available to identify and reject retired payloads.
Historical list entries and prices are retained; cache refreshes keep the list inactive.

The idempotent database retirement is:
`node --env-file=.env apps/api/scripts/retireCsaMembersPriceList.js --apply --backup=PRIVATE_PATH.json`
Without `--apply`, it previews the affected list. The backup path must be new.
This updates only the local/server database's `price_lists.active` flag, never the
remote list, memberships, or published prices. Deploy the corresponding code to
every running publisher before treating retirement as active across all servers.

### Creating products in Pricing

Store → Pricing → Products → **Add product** uses the same metadata, pricing,
package, and wholesale controls as the product editor. Select an explicit pricing
unit (each or lb) for any vendor; a fixed 12 oz package sold each has quantity 1.
Vendor selection suggests the configured Square eligibility and markup preset.
Deposits and Membership stay in their existing workflows.

`POST /api/admin/enterprise-pricing/products/preview` validates the draft with the
shared pricing engine. `POST /api/admin/enterprise-pricing/products` requires its
preview hash and a creation key. One transaction saves the hidden product,
packages, active local pricing revision, cost/wholesale history, and retry receipt.
Stock starts at zero, tracking is off, and on-farm status/pounds remain unknown.
No Local Line or Square requests run during creation. Pricing editors can create;
publish-only users cannot. Channel approval remains a separate action.

Photos upload after product creation and can be retried without creating another
product. The existing product editor also supports photo uploads and removal.
Image uploads require the existing Spaces configuration; photo storage is not
part of the catalog/pricing database transaction. An uncertain creation request
is retained in the browser tab for retry with its original key and frozen values.

Regression coverage: the new-product subtest in
`apps/api/lib/enterprisePricing.integration.test.js` uses the disposable
`PRODUCT_SYNC_TEST_SOCKET` database convention and mocks all channel requests.

### Inline product sales

Pricing has an All / On sale / Not on sale filter and a `set` control immediately
before FF Package Price. Enter a percentage (0–99.99), then Enter, Tab, or leave
the field to save locally. Zero or blank removes it; Escape cancels. Sales run
until turned off and apply to all packages and eligible channels. Review & Publish
→ Sales approves and publishes changes; local saves make no channel requests.
Square uses managed automatic discounts and keeps its normal catalog prices.

The additive `enterprise_product_sales` table holds versioned desired local sales;
`enterprise_promotions` retains immutable approved payloads and publication receipts.
Existing explicit product sale flags/percentages remain visible until edited. An
explicit product sale-off flag wins over obsolete formula-profile sale defaults.
Editing adopts the versioned model and records prior legacy fields in the sale event.
Scheduled, partial-package, or channel-specific promotions require detailed review.
Regular channel pricing and Square locations must be verified before sale approval.
Bundle publication waits for component sale publication to finish.

`node --env-file=.env apps/api/scripts/clearInactiveSaleDiscounts.js` previews
inactive local discount cleanup. Add `--apply` to clear only rows with both local
sale flags off and no pending/active promotion. Original values are saved under
`.local-pricing/sale-cleanup/`; channel caches and remote catalogs are untouched.

### Package-specific Buy Prices

Each/package products can store a `packageBuyPrice` (two decimal places) on each
pricing input package, bound to `packageBuyPriceEnterpriseId`. This is the total
cost of that package, not a per-item cost to multiply by quantity. Blank inherits
the default Buy Price × quantity. Per-pound products continue to use unit cost
and reviewed weights. Product retail overrides still take precedence.

Package costs are retained in immutable pricing revisions and survive markup
changes, creation, duplication, and settings recalculation. The Pricing table
shows these costs by package; Product → Packages edits them. Square-enabled each
packages round their own calculated retail prices before the FF discount. Changing
purchasing enterprises requires reviewing or clearing the bound package costs.

Migration now preserves differing each-package costs. The controlled repair for
the seven previously flattened products is `apps/api/scripts/repairPackageBuyPrices.js`:
preview using `node --env-file=.env apps/api/scripts/repairPackageBuyPrices.js`, then
add `--apply` to apply that frozen plan. It writes local pending revisions only,
checks concurrent edits and in-flight publication, and keeps original records in
the private plan file. Deploy the updated pricing code before editing these costs
through an older deployed server, whose normalizer does not support the new fields.
