# Turkey preorders

The dedicated host `turkeys.deckfamilyfarm.com` shows the turkey preorder experience, like the separate Subscribe and Dropsites hosts. Locally, open `http://localhost:5176/turkeys`. The main `store.deckfamilyfarm.com` and local `/` keep the original store landing page, initially showing **Coming Soon, Full Farm Version 2 store** without products. It shares the subscribe page's header, Shop navigation, typography, colors, and footer. **Shop → Turkeys** links here from both Subscribe and Dropsites. Admin, account, subscription, dropsite, and liability routes remain available. Other hosts keep their existing storefront behavior; `?experience=turkeys` supports previews on other local ports.

The initial sale is a **draft**, with pickup on **November 21, 2026**. The initial Thanksgiving pickup group contains PSU Farmers Market, Hollywood Farmers Market, Lane County Farmers Market, and Farm Pickup. Staff can add named groups and any number of locations within them (up to 100 groups / 500 locations per sale). No prices, quantities, or location addresses are invented. Configure these in **Admin → Store → Turkey Preorders**.

## Main store visibility

**Admin → Store → Storefront** has **Show products on the public store**, initially off. Save explicitly to change public visibility. **Preview products as staff** opens the original catalog layout without changing the public setting and requires Storefront Admin (or full Admin). The setting is independent of the turkey sale status and preorder inventory. Turning it off hides catalog sections for guests and signed-in members; the frontend does not request catalog products while hidden. The existing catalog API remains available to its other callers. Settings use an optimistic version check, so a stale admin tab cannot overwrite a newer choice.

## Turkey hostname setup

Point `turkeys.deckfamilyfarm.com` at the same server as `subscribe.deckfamilyfarm.com` and `dropsites.deckfamilyfarm.com`. Add it to that server's HTTPS reverse-proxy configuration and certificate, proxying to the same CSA Store application, including `/api`. No separate app process or database is needed. The hostname selects the turkey page; local `/turkeys` and existing `#/turkeys` links also work. DNS and TLS configuration must be completed on the hosting server.

Set the production `STOREFRONT_BASE_URL` to the turkey origin so Stripe returns customers to the same host where they started checkout. Keep `http://localhost:5176` for local tests. Existing Stripe webhook endpoints on the store host can remain if they reach this same backend; use the new turkey URL for a new endpoint and its matching signing secret. Keep the old store hostname available for checkout sessions already created there.

## Configuration and launch

Configure these values in the server's existing `.env`, then restart the API:

```dotenv
STOREFRONT_CHECKOUT_ENABLED=false
STOREFRONT_BASE_URL=https://turkeys.deckfamilyfarm.com
STOREFRONT_STRIPE_WEBHOOK_SECRET=whsec_REPLACE_WITH_NEW_ENDPOINT_SECRET
# Existing shared account credential: STRIPE_SECRET_KEY
# Existing SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS, or MAIL_USER/MAIL_ACCESS
```

`STRIPE_SECRET_KEY` is shared with membership billing. Verify the intended Stripe account and test/live mode; do not replace an existing membership key casually. The storefront has a **separate webhook secret** and does not change `/api/member/stripe/webhook` or `STRIPE_WEBHOOK_SECRET`.

1. Deploy and build the frontend with `npm --prefix design/template/vite-app run build`; restart the existing server process. Keep checkout disabled initially.
2. Register `https://turkeys.deckfamilyfarm.com/api/storefront/stripe/webhook` in the matching Stripe mode for `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `refund.created`, `refund.updated`, `refund.failed`, and `charge.refunded`. Set the endpoint's signing secret above. The raw-body handler precedes JSON parsing.
3. Assign staff **Storefront Admin** (full Admin already has access). In Setup, choose catalog turkeys individually or use **Add all whole turkeys**. Names, photos, and **Retail Price** come from Products. **Local preorder descriptions** has one editable description for Heritage Black and one for Broad Breasted White, shared by every size of that breed. Enter **Pre-order inventory** directly on each turkey card, including newly added turkeys; these counts save with Setup. Review the retail price per turkey and edit it in **Store → Products** if needed. Name pickup groups and add locations with a title, address, hours, and instructions. Enter the sales cutoff in Pacific time and customer contact/staff notification emails. Save as Draft.
4. At the bottom of Setup, the additional **Pre-order inventory** table shows sold, on-hand, reserved, and available quantities for each turkey and in total. Set on-hand counts for birds physically allocated to preorders, with an adjustment reason. On-hand includes reservations; stale counts and counts below reservations are rejected. The **Pre-order inventory** tab offers the same controls. Table stock saves preserve unrelated Setup drafts. Setup saves apply only explicitly edited counts and reject concurrent stock/reservation changes, so saving other settings cannot overwrite orders. These counts are distinct from Local Line inventory; do not adjust them through the Local Line inventory screen.
5. Use **Preview saved setup** while signed in. It shows the saved draft and disables checkout. The default banner is the provided `turkeys5.jpg`, copied to `/images/turkey-home/turkey-banner.jpg`. A single holiday-turkey photo appears below shopping. An optional Photo URL in Setup overrides the banner.
6. On staging with test Stripe credentials, enable checkout, publish a test sale, and complete payment, expired/cancelled checkout, refund, confirmation email, and pickup checks. Backend automated tests mock Stripe; a real Stripe test-mode smoke test is still required before launch.
7. Install the maintenance cron below, verify mail delivery, verify live Stripe mode on the production server, and set `STOREFRONT_CHECKOUT_ENABLED=true`. Restart, then publish the configured sale in Admin. The public sale opens only when both the server flag and sale status allow it. No code in this change enables live checkout automatically.

```cron
# Every 5 minutes — reconcile turkey payments, release expired reservations, and retry confirmation emails
*/5 * * * * cd /home/jdeck/code/csa-store && /usr/bin/node --env-file=.env apps/api/scripts/runStorefrontMaintenance.js >> /home/jdeck/.pm2/logs/csa-store-turkey-maintenance.log 2>&1
```

Run manually with `npm run run:storefront-maintenance`. The runner closes its database pool when finished. Schema creation is additive and idempotent; the first storefront request/maintenance run creates or upgrades only `storefront_*` tables. Existing pickup IDs, details, reservations, and order snapshots are preserved. Legacy offerings without a catalog link must be linked to an existing turkey before they can be offered.

## A published selection that does not appear

Changing the Sale status dropdown does not publish until **Save preorder setup** succeeds. **Saved status** shows the persisted state and saved inventory. Publication requires the checkout server flag, Stripe key, storefront webhook, email delivery, and complete sale/pickup details. A rejected save rolls back inventory and setup together; errors appear beside Save as well as at the top. Use **Save as draft** to persist turkey selections and counts while launch configuration is incomplete, then **Preview saved setup** to view them as staff. Draft turkeys remain hidden from the public store. Keep unsaved edits open until a save succeeds.

## Stock and order behavior

- All preorder stock lives in `storefront_options`. Each offering links to an existing local turkey product for its identity, photos, and retail price. Catalog reads exclude deleted products and Membership. Each product can appear once per sale; saved links cannot be reassigned. Preorder operations never write Local Line/Square stock, catalog pricing inputs, or pricelist exports. Catalog stock updates cannot overwrite pre-order inventory.
- Prices use the **Retail Price** column in Store → Products directly. For formula vendors this is `sourceUnitPrice` per each, with no CSA factor or customer markup. A per-pound or missing price cannot be charged as a whole turkey. Standard products require a single package priced for one turkey. New checkouts read current catalog retail prices; existing orders and Stripe checkout retries keep their original price snapshots. A changed price between page display and checkout asks the shopper to refresh. Manual preorder prices and client-supplied prices are not authoritative.
- **Available = on hand − reserved.** A checkout transaction reserves every requested size together, or none. Payment moves the reserved birds out of on-hand stock once. Stock adjustments cannot consume reserved birds.
- Turkeys share one stock pool across every pickup location. Each guest order has one location and can contain several turkeys/quantities. The listed price is the complete fixed USD charge; there is no later weighing adjustment, shipping, subscription, credit, discount, or tax-calculation workflow.
- Checkout supports card payments and eligible card wallets through Stripe's hosted page. Customers' name, email, phone, and postal address are captured by the storefront; card details are handled by Stripe.
- Checkout reservations last approximately 30 minutes (31 minutes is submitted to Stripe to allow for its minimum-expiration requirement and network transit). Stock is released after Stripe confirms the session expired, never just because a browser leaves the page or a webhook is late. A valid session started before the sales cutoff may finish until its reservation expires.
- The client creates a random 256-bit access token, stored in browser session storage; only its hash is stored by the server. Checkout retries reuse this token and the original request. The success URL contains only the order ID. Status access requires the token in an Authorization header, and payment is verified server-side.
- Stored order lines, prices, contact details, pickup group names, and pickup instructions are snapshots. Editing Setup or catalog names/photos does not rewrite existing orders. Archive saved pickup groups/locations using their Offer checkboxes; they remain available in historical order filters. New reservations can only use active locations inside active groups. Each active group must contain at least one complete active location to publish. Coordinate any pickup changes with customers using their order contact information.
- The storefront and admin cards use separate local preorder descriptions saved on the sale. Heritage Black defaults describe organic pastures, slow growth, a higher proportion of dark meat, and a smaller breast; Broad Breasted White defaults describe organic pastures, generous breasts, mild white meat, and flavorful dark meat. Both explain pickup at the selected location on the Saturday before Thanksgiving. Edit each breed once under **Local preorder descriptions**; all its sizes use that copy. Catalog/Local Line descriptions and legacy offering text do not override it. Unrecognized breeds receive the generic local pickup wording. Schema upgrades preserve stock and existing setup; empty new description fields use the supplied defaults. Executable markup and HTML attributes are not rendered. Retail prices stay linked to Products; pre-order inventory stays separate.
- Confirmation and refund emails include the staff notification address as Bcc. Failures remain in the outbox for maintenance retries and are visible under Orders. SMTP delivery is at least once, with a stable Message-ID; a process interruption immediately after delivery may produce a duplicate email, but cannot duplicate the payment or inventory movement.

## Staff operations and recovery

Filter Orders by location and Paid status to produce remaining pickup lists; export CSV or print. **Mark collected** is repeat-safe. **Cancel & refund** requests a full refund for an uncollected paid order and returns birds only once Stripe reports success. Pending/failed refunds keep stock committed. Partial refunds and refunds of collected orders never automatically replenish stock.

Use **Reconcile payment** to read back Stripe state. Uncertain checkout creation reuses the same Stripe idempotency key; after 23 hours it is held for manual review instead of risking a second session after key expiration. **Link Stripe receipt** appears for these held orders and accepts a Checkout Session ID only after verifying its order metadata, currency, and total. If no session can be found, keep the stock held until an operator establishes the outcome; never delete or reset the order to retry a payment.

External pending refunds block both collection and a second refund. Failed refunds need review in Stripe; a later successful full refund is reconciled normally. Monitor the cron log, Orders errors, and pending email deliveries. Closing the sale prevents new reservations but allows existing payments/refunds to reconcile.

## Verification

```bash
node --test apps/api/lib/storefrontCore.test.js apps/api/lib/storefrontProducts.test.js apps/api/lib/storefrontDescriptions.test.js apps/api/routes/storefront.test.js design/template/vite-app/src/storefrontRouting.test.js design/template/vite-app/src/components/subscribeNavigation.test.js
STOREFRONT_TEST_SOCKET=/tmp/csa-storefront-test-INSTANCE/mysql.sock node --test apps/api/lib/storefront.integration.test.js
npm --prefix design/template/vite-app run build
```

The integration suite requires a disposable MySQL socket under `/tmp/csa-storefront-test*`, creates and drops its own schema, mocks all Stripe calls and emails, and never loads `.env`. It exercises concurrent reservations, payment/refund duplication and uncertainty, expiration races, catalog links/photos, legacy schema upgrades, configurable pickup groups, stale inventory protection, isolation from Local Line stock, permissions, cutoff handling, and pickup snapshots. Never point it at the application database.
