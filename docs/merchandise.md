# Branded merchandise

The reviewed first phase is merchandise-only checkout inside CSA Store. All 14
Printify products are imported as disabled drafts in the isolated local database.
They reference the existing named Deck Family Farm vendor (local ID 3153);
that ID is not a Printify provider/shop ID.
Mixed farm checkout remains a separate phase; farm pickup/delivery, Local Line
mirrors, member finances and turkey preorder tables are never written here.

## Catalog and price review

Store → Merchandise requires `merchandise_admin` (or full `admin`). The dedicated
`merch_products`/`merch_variants` collection is **Branded Merchandise**. Explicit
supplier identity keeps these products out of farm inventory/formula pricing and
Local Line/Square publication. Retail approval is separate from Printify pricing.
Every merchandise save also requires an existing named local vendor. The local
vendor is a separate reference from Printify shop, blueprint and provider IDs;
the importer never creates a vendor or assumes IDs are interchangeable.
Supplier refresh preserves approved retail values but disables changed products
and resets artwork review. Versions reject stale edits and refreshes.

All supplier variants, options, images, descriptions and production records are
preserved, including disabled and unavailable variants. Do not enable unavailable
hoodies, substitute their missing provider, or discard generated neck layers.
Confirm supplier currency and artwork/placements before enabling any product.

The **Default** retail price is **Printify production cost plus a 40% markup**,
rounded to the nearest cent, with a **$10.00 minimum**. It excludes shipping,
supplier tax and payment fees. An optional **Modified Price** overrides the
default. Clearing it restores the default. Existing saved prices are retained as
modified prices.

## Explicit migration and isolated import

Runtime readiness only inspects schema metadata. The migration creates eight
merchandise/commerce tables and upgrades their own columns when needed. It does
not change existing farm, vendor, member or turkey tables. Do not run startup to
install this schema.

```sh
node scripts/local-pricing/merchandise.mjs migrate --check
node scripts/local-pricing/merchandise.mjs migrate --apply
node scripts/local-pricing/merchandise.mjs vendors
node scripts/local-pricing/merchandise.mjs import --snapshot=reports/printify-discovery-2026-11-17/raw/catalog-2026-11-17/complete-catalog.json --vendor-id=EXISTING_ID
node scripts/local-pricing/merchandise.mjs import --snapshot=reports/printify-discovery-2026-11-17/raw/catalog-2026-11-17/complete-catalog.json --vendor-id=EXISTING_ID --apply
node scripts/local-pricing/merchandise.mjs review
```

The wrapper discards inherited credentials, restricts networking to loopback and
asserts the existing isolated local DB configuration. The import never loads
production `.env`. Full supplier JSON/artwork references remain in the restricted,
Git-ignored raw directory. `local-import-mapping.json` records actual local IDs.
Replace `EXISTING_ID` with the reviewed existing vendor ID returned by the vendor
lookup. No migration or import changes the vendor record itself.

Connected setup uses the database in `.env`. It must be selected explicitly:

```sh
node --env-file=.env apps/api/scripts/migrateMerchandise.js --check
node --env-file=.env apps/api/scripts/migrateMerchandise.js --apply
node --env-file=.env apps/api/scripts/importMerchandise.js --connected-drafts --expect-database=store --vendor-id=3153 --snapshot=reports/printify-discovery-2026-11-17/raw/catalog-2026-11-17/complete-catalog.json
node --env-file=.env apps/api/scripts/importMerchandise.js --connected-drafts --expect-database=store --vendor-id=3153 --snapshot=reports/printify-discovery-2026-11-17/raw/catalog-2026-11-17/complete-catalog.json --apply
```

The import command without `--apply` is a preview. Connected setup requires test
mode and every merchandise catalog/checkout/supplier/production switch off. It
only initializes disabled, unpriced drafts; retries preserve the same IDs and
reject overwriting existing edits. Database `store` and vendor 3153 were verified
for this deployment; verify both before reusing these commands elsewhere.
Connected development uses the shared database. Only explicitly approved
controlled purchases belong there; ordinary regression tests use disposable
databases and mocked providers.

## Payments and disabled controls

The integration reuses `storefrontStripeClients`, `storefrontWebhookEvent`, common
checkout validation and operational email delivery. The existing raw-body route
`/api/storefront/stripe/webhook` now dispatches verified events to the turkey or
merchandise service using order metadata and persisted payment ownership for
refunds. Turkey checkout, credentials and payment processing remain unchanged;
turkey events do not require merchandise configuration or tables. `commerce_orders` owns the payment and one
independent `commerce_fulfillments` child currently handles Printify. No farm
order/reservation contract is implemented; mixed carts are explicitly rejected.

All switches default off:

| Configuration | Purpose |
| --- | --- |
| `MERCH_CATALOG_ENABLED` | Public merchandise catalog |
| `MERCH_CHECKOUT_ENABLED` | Merchandise checkout |
| `MERCH_LIVE_CHECKOUT_ENABLED` | Additional live-payment gate |
| `PRINTIFY_ORDER_CREATION_ENABLED` | Supplier creation/cancellation gate |
| `PRINTIFY_PRODUCTION_ENABLED` | Additional production-release gate |
| `PRINTIFY_MANUAL_APPROVAL_VERIFIED` | Recorded operator verification |
| `PRINTIFY_APPROVED_SHOP_ID` | Exact reviewed supplier shop |

`MERCH_STRIPE_MODE` defaults to `test`. Reuse the existing primary key when it
matches that mode, or `STOREFRONT_STRIPE_TEST_SECRET_KEY` alongside the existing
primary live key. Set `MERCH_STRIPE_ACCOUNT_ID` to the reviewed existing account.
Reuse the existing Stripe destinations and their signing secrets; no new Stripe
account or merchandise destination is required. Configure
`STOREFRONT_STRIPE_TEST_WEBHOOK_SECRET` for the test destination and
`STOREFRONT_STRIPE_LIVE_WEBHOOK_SECRET` for live. The existing generic
`STOREFRONT_STRIPE_WEBHOOK_SECRET` continues working for the primary key's mode.
A live destination secret does not configure test delivery. Keep the current
turkey live key and secret unchanged.

Read-only verification on November 18, 2026 found these enabled destinations,
both already subscribed to checkout completion/expiry/async success/failure and
refund/charge refund events:

- Live: `https://turkeys.deckfamilyfarm.com/api/storefront/stripe/webhook`
- Test: `https://store.deckfamilyfarm.com/api/storefront/stripe/webhook`

The server has the existing live signing secret but no test-specific signing
secret. Local `.env` has a test API key but no signing secret. Copy the **existing
test destination's** signing secret from Stripe Workbench → Webhooks into
`STOREFRONT_STRIPE_TEST_WEBHOOK_SECRET` for the process receiving its events, then
restart that API process. Deploy the shared dispatcher before using that remote
test destination for merchandise. For a local API, forward Stripe test events
with Stripe CLI to `/api/storefront/stripe/webhook` on the local API port and use
that CLI listener's signing secret locally. An endpoint's secret cannot be
obtained by retrieving its existing endpoint through Stripe's API.

The separate `/api/merchandise/stripe/webhook` route remains optional for existing
deployments using `MERCH_STRIPE_TEST_WEBHOOK_SECRET` or
`MERCH_STRIPE_LIVE_WEBHOOK_SECRET`; these secrets apply only to that destination.
The matching signing secret must be configured before checkout.
Stripe test payments are **always held
from real Printify order creation**, even if every supplier flag is enabled.

`MERCH_BASE_URL` is the trusted checkout return origin. Staff preview is
`/#/merchandise?preview=1`; it requires admin authentication and cannot buy drafts.
The current isolated preview is served at `http://127.0.0.1:5176/admin` →
Store → Merchandise. Public merchandise remains hidden by default. The shared
Shop → Merchandise link opens the dedicated merchandise host (locally
`/merchandise`); the catalog and checkout switches still control availability.

## Dedicated hostname and nginx

`https://merchandise.deckfamilyfarm.com/` opens the existing branded merchandise
shop. Local `/merchandise`, `?experience=merchandise` and existing
`store.deckfamilyfarm.com/#/merchandise` links remain supported. Subscribe,
Dropsites, Turkeys and Merchandise use `buildSubscribeNavLinks`, so the same
Shop → Merchandise destination is used in every desktop and mobile menu.
Account recovery, staff login, liability links and turkey order routes remain
available on the merchandise host.

On November 19, 2026, both merchandise and turkey DNS resolved to this server,
`146.190.123.155`. Merchandise still needed its own nginx block and HTTPS
certificate. The existing hosts all proxy to the same app at `127.0.0.1:5176`;
no additional process, database or Stripe webhook destination is required.

From `/home/jdeck/code/csa-store`, install the prepared HTTP configuration, then
let Certbot add the certificate and HTTP-to-HTTPS redirect:

```sh
sudo install -m 644 deploy/nginx/merchandise.deckfamilyfarm.com.conf /etc/nginx/sites-available/merchandise.deckfamilyfarm.com
sudo ln -s /etc/nginx/sites-available/merchandise.deckfamilyfarm.com /etc/nginx/sites-enabled/merchandise.deckfamilyfarm.com
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d merchandise.deckfamilyfarm.com --redirect
sudo nginx -t && sudo systemctl reload nginx
```

The template is for first installation only: do not copy it over a working
HTTPS configuration on a later deployment. If a site file or enabled link
already exists, inspect it first. The nginx Host header must reach the app
unchanged so the browser selects the merchandise landing page. Proxy all paths,
including `/api`, `/images`, `/assets` and `/liability`.

After routing tests and the required stabilization runner pass, build the
frontend. The running production app serves `design/template/vite-app/dist`
directly. A frontend-only build does not require an API restart. The checkout
origin allowlist change in `storefrontCore.js` requires restarting the PM2
`store` process once:

```sh
npm --prefix design/template/vite-app run build
pm2 restart store
curl -fsS https://merchandise.deckfamilyfarm.com/api/health
curl -fsS https://merchandise.deckfamilyfarm.com/api/merchandise/catalog
```

New checkouts preserve the browser's trusted starting hostname, including the
merchandise host, even if `MERCH_BASE_URL` still names the store. Optionally set
`MERCH_BASE_URL=https://merchandise.deckfamilyfarm.com` as the default for requests
without an Origin header. Existing checkout requests, return URLs, keys and
receipts stay frozen. Keep the store hostname and existing webhook endpoints
working for earlier purchases; browser carts and guest order access are scoped
to each origin and are not copied across hosts.

Verify the landing page, product photos, cart and the four shared menu
destinations in a browser. Opening a page does not require a purchase or a
Printify submission.

## Initial production payment verification

The November 18 rollout enables live merchandise checkout using the existing
Stripe account (`acct_1CbGeKISp82feLus`) and existing live storefront webhook.
New settings are appended as one marked block at the bottom of `.env`; existing
primary Stripe, membership and turkey settings are preserved. The local profile
also has a mode-specific live key and signing secret copied securely from the
existing production configuration, without replacing its primary test key.

`MERCH_STRIPE_MODE=live`, `MERCH_CATALOG_ENABLED=true`,
`MERCH_CHECKOUT_ENABLED=true` and `MERCH_LIVE_CHECKOUT_ENABLED=true` enable the
payment path at `https://store.deckfamilyfarm.com/#/merchandise`.
`MERCH_BASE_URL=https://store.deckfamilyfarm.com` sets its return origin.
The pilot used `MERCH_TAX_RULES_JSON={"US:OR":{"exempt":true}}` for Oregon shipping.
Oregon has no general sales tax. [Oregon Department of Revenue](https://www.oregon.gov/dor/programs/businesses/Pages/sales-tax.aspx)

`PRINTIFY_APPROVED_SHOP_ID=18832188` identifies the existing shop.
`PRINTIFY_ORDER_CREATION_ENABLED=false`, `PRINTIFY_PRODUCTION_ENABLED=false`
and `PRINTIFY_MANUAL_APPROVAL_VERIFIED=false` deliberately hold supplier submission
for the first live payment verification. A live purchase charges a real card;
it does not manufacture anything while these gates are off. The signed Printify
webhook and five-minute merchandise maintenance runner handle future tracking
and reconciliation. Preserve all existing Wix webhook subscriptions.

Approve a product in Admin → Store → Merchandise before buying. Confirm artwork
and USD, select the variants individually or use **Sell all available variants**,
show the product in the CSA Store, then save. Verify
the resulting payment in Merchandise orders before separately enabling supplier
creation after Manual order approval is verified in Printify.

## Shipping and tax

The first version supports US addresses and standard supplier shipping. The
address is collected before a supplier quote, frozen server-side, and never
replaced with an unquoted Checkout address. Product, quantity, cost, production,
shipping and tax drift invalidate a quote. Quotes expire after ten minutes;
the resulting frozen Stripe Checkout Session lasts thirty minutes.

Shipping is a separate labeled Stripe line, independent of farm delivery.
`MERCH_US_DEFAULT_TAX=not_collecting` allows checkout for all 50 states and
Washington, D.C. using Printify's shipping quote. Use it after reviewing where
the business must collect sales tax. For a destination with no explicit rule,
checkout records the configured decision to collect zero customer sales tax.
Each `US:STATE` entry in `MERCH_TAX_RULES_JSON` takes precedence. Use
`{ "exempt": true }` or `{ "rateId": "txr_...", "shippingTaxable": true }` as
appropriate. Without the default setting, checkout requires an explicit state
rule. The server verifies active exclusive Stripe tax rates and checks the saved
shipping and tax amounts again before creating a payment session.

## Durable fulfillment, status and recovery

Only a verified Stripe webhook, followed by account/mode/session/PaymentIntent
attribution, marks payment received and atomically queues fulfillment and email.
Success pages only read status. A browser stores IDs, quantities, displayed prices
and guest access tokens; it does not persist customer/address details. Guest
access lasts seven days and includes clear missing-access recovery guidance.

Run `npm --prefix apps/api run run:merchandise` on a separately installed five-minute
schedule after deployment review. It handles the durable fulfillment queue,
tracking polling, fee refresh and email retry. It has independent error handling
and does not share farm/turkey fulfillment transactions. There is no automatic
production release: review and confirm it in the merchandise dashboard.

Every external operation retains its frozen request, reference, attempt and
receipt. Printify creation uses one external ID. Unknown creation results are
looked up; an unsuccessful lookup never causes a replacement POST. Confirmed IDs
are checkpointed before readback. Unknown cancellations/production releases only
poll. Stripe checkout retries reuse their frozen key inside 23 hours; older unknown
results stay held until an admin verifies and attaches the original Session ID.

Configure `PRINTIFY_WEBHOOK_SECRET` for `/api/merchandise/printify/webhook`.
Signatures cover raw bytes; a durable event inbox deduplicates delivery. Events
cause a current shop-scoped read, so older events do not replace state with stale
payloads. Foreign Wix orders are not adopted. Polling recovers missed tracking.
Before registration, review the shop and add the needed token scopes for orders
and webhook installation. The read-only discovery token may lack those scopes.

Refund and supplier cancellation are separate review/confirm actions. A refund
does not cancel Printify. External refunds create a financial hold; acknowledgment
records the exact reviewed receipt set and new receipts invalidate that review.
Unknown refunds reconcile the original operation without a new POST. Supplier
cancellation is held once production has begun.

Reporting separates live and test orders and records sales, shipping/tax charged,
refunds, supplier production/shipping/tax and attributed Stripe balance-transaction
fees. Estimates explicitly count missing fees/costs; unknown amounts are not
represented as confirmed profit.

## Validation and launch gates

```sh
node --test apps/api/lib/merchandise.test.js design/template/vite-app/src/components/merchandiseCart.test.js
python3 scripts/test-stabilization.py --docker
npm --prefix design/template/vite-app run build
```

The required runner includes merchandise and unchanged turkey integration suites
on disposable MySQL, mocks every provider and never loads `.env`. Skipped suites
do not count. Browser/admin review, real Stripe test-mode webhook delivery, live
tax/currency confirmation, supplier approval settings and artwork fidelity remain
launch gates. Mocked payment tests do not prove those external configurations.

Do not create a real Printify test order merely because production POSTs are off:
shop auto-approval can independently release orders. Verify manual approval first.
One controlled real paid/produced order requires separate explicit approval.
Retiring Wix, connecting a new shop, copying source products and enabling live
checkout/production also require the corresponding reviewed launch decision.
On rollback disable merchandise controls and retain all financial/operation
receipts; do not drop order tables or modify turkey/member records.
