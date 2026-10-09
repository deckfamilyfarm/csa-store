# CSA Store Agent Notes

## Intended Sync Model

This application sits between three sources:

- Local Line, the remote store and product API.
- Square Online, the public online store catalog.
- The local `store` MySQL database used by this CSA storefront.
- Legacy/Killdeer pricelist data used for some source pricing workflows.

The intended behavior is two-way, but not symmetric:

- Pull from Local Line: admins should be able to run a Local Line audit/sync from the UI, review all proposed changes, warnings, and errors, then approve specific supported fixes before the local database is written.
- Push to Local Line: admins should be able to save local pricing changes, then explicitly apply pending remote changes to Local Line.
- Push to Square: admins should review and approve local package-to-Square variation matches, audit proposed guest-price changes, then explicitly apply supported price changes to Square.
- Automatic Local Line pull writes must stay narrow. Current supported pull writes are local catalog repair actions such as missing local products/packages and local product/package field updates. Price-list drift and overrides from Local Line are review-only unless a future change adds an explicit schema and approval flow.

Square sync mirrors prices, with a separate reviewed Create in Square workflow for missing catalog items. CSA Store remains the pricing source of truth; Square price drift is review data and should not back-capture into local formula/pricelist fields. Do not sync stock, manage Square Online visibility, or push member/herd-share/SNAP prices. The value pushed to Square is the CSA Store price for Square: for formula-priced products, use the local Vendor's Retail Price (`sourceUnitPrice`) directly without FFCSA factor, package weight/quantity, or customer markup; for standard products, use the local package price. Apply sale discounts as the normal Square variation price.

## Local Line API

The integration targets the Local Line Backoffice v2 API:

- Base URL: `https://localline.ca/api/backoffice/v2/` unless `LL_BASEURL` overrides it.
- Auth: `POST /token/` with `LL_USERNAME` and `LL_PASSWORD`; use the returned bearer token in `Authorization`.
- Product export: `GET /products/export/?direct=true`.
- Product detail: `GET /products/{id}/?expand=packages,product_price_list_entries`.
- Product update: `PATCH /products/{id}/`.

Product saves require an existing, named local vendor, including creation, duplication, pricing, packages, and inventory. Reject missing or invalid vendors before saving. Local Line publication resolves the local vendor against `/vendors/` (matching ID and name, or a unique normalized name), includes the verified remote `vendor` ID in create/update payloads, and reads the product back to confirm it. Never assume a local vendor ID is a remote ID or create a remote vendor implicitly. Product Sync freezes the vendor in the audit; older approvals without a vendor must be audited again. Inventory only checks vendors and never changes them; repair vendor mismatches through Product Sync.

The official Swagger at `https://localline.ca/swagger/backoffice/v2?format=openapi` confirms `/products/{id}/` supports GET/PATCH, `/products/export/` supports GET, and `/token/` supports POST.

## Formula Pricing Guardrail

Products whose vendor name contains `deck family farm`, `hyland`, or `creamy cow` use local formula pricing. Treat local formula fields as the source of truth for those vendors:

- `sourceUnitPrice`
- `unitOfMeasure`
- `minWeight`
- `maxWeight`
- `avgWeightOverride`
- `sourceMultiplier`
- guest/member/herd-share/SNAP markups
- sale fields

Do not back-capture Local Line price changes for these vendors as authoritative local pricing without an explicit review and approval path. Local Line price drift for these vendors should be surfaced as warnings/review data, not silently persisted into formula inputs.

Products whose product name contains `deposit` are deposit products and must use no markup, even when they are Deck Family Farm products. The shared pricing resolver classifies these as `deposit-no-markup`, sets guest/member/herd-share/SNAP markups to `0`, and the admin pricelist exposes the rule so these cases are visible.

Products in the `Membership` category are membership levels, not pricelist or inventory items. Keep them out of the admin pricelist/formula-pricing workflow and the admin inventory workflow. Manage them from the dedicated admin `Membership` section, which tracks the membership-level product/package records without treating them as normal price-list rows.

Store → Products combines the former Pricelist, Local Pricelist, and Inventory screens. Pricing and Inventory are views of the same catalog with shared filters, selection, and drafts. The default is Pricing with all vendors; Membership products remain excluded. Retail Price is always visible in Pricing and shows the vendor's price per lb/each before CSA adjustments, or package prices for standard products.

- The Vendor filter includes `Deck Enterprises`, a combined filter for Deck Family Farm, Hyland, and Creamy Cow, rather than a replacement vendor record. Switching into Inventory selects this group by default; users can then select another vendor. It uses the `vendorGroup=deck-enterprises` query alongside the other catalog filters.

- Inline controls edit formula inputs, stock, visibility, sales, and standard single-package prices.
- `Details` shares the grid draft and edits metadata, descriptions, images, package prices, and cached Local Line price-list entries.
- Inventory has a fixed layout: Product, Vendor, Stock, Track Inventory, and Visible, with no column controls or saved column preferences. Stock editing requires Track Inventory to be enabled.
- `Save Local Changes` in Pricing uses the shared coordinator in `design/template/vite-app/src/components/productWorkspace.js` and never publishes. Inventory has a separate `Save Inventory to Local Line` action: `saveInventoryDraft` sends only dirty stock/tracking/visibility fields to `/api/admin/products/:id/inventory`, handled by `inventorySync.js`. Inventory Admin alone authorizes this inventory save; other local product editors also require Local Line Push. All other Local Line publications still require Local Line Push. The inventory save confirms the remote result before committing local inventory, and never modifies sales, prices, images, Square, or pricing sync flags. Acknowledge only successful fields/packages and preserve failures and unrelated drafts for retry.
- Products focuses on catalog edits, with immediate stock/tracking/visibility publishing from Inventory. Open Store → Product Sync for prices, sales, descriptions, images, and releases. Ordinary new Local Line audit actions omit stock/tracking from their payload and baselines; visibility is included only for creation, explicit staging, or reviewed visibility drift. This keeps unrelated pricing approvals valid across inventory saves. Explicit inventory staging and older frozen approvals retain their checks. Sync status and release history remain on Product Sync. The old direct push endpoints remain compatible for existing clients.
- Unsaved staged changes support only stock, tracking, visibility, and sales. Save formula, package, and Details changes locally before opening Product Sync. With no selection, opening Product Sync from Products scopes to dirty products when drafts exist; otherwise it opens the full sync workspace.
- Preserve role keys and assignments. Unified publications require every selected platform’s push grant; scheduling also requires `pricing_admin`. Staging requires a local editing grant. Incoming repairs require `localline_pull`. `local_pricelist_admin` remains the local product pricing role.
- The workspace uses `/api/admin/pricelist` and `/api/admin/products/:id`. The old local-pricelist and inventory read endpoints remain compatible for other callers.

Admin access uses Timesheets as the credential authority when `TIMESHEETS_API_URL` is configured. CSA Store still owns authorization: the local `users` table stores the CSA user record and Timesheets link fields, while `admin_roles` and `admin_user_roles` store backend permissions. The full `admin` role grants every permission. Granular backend roles are `user_admin`, `inventory_admin`, `pricing_admin`, `localline_pull`, `localline_push`, `square_pull`, `square_push`, `dropsite_admin`, `membership_admin`, and `member_admin`. Do not infer CSA admin permissions from the Timesheets role; Timesheets only proves identity.

Admin `Users` creates local CSA backend users, assigns roles, and links them to Timesheets via `timesheets_user_id` and `timesheets_employee_id`. John Deck's Timesheets login (`deck.john`) is the default seed administrator unless `ADMIN_USER` overrides it. The Users screen can preview/apply exact Timesheets matches, and `npm run sync:timesheets-users` does the same from the API directory. The sync matches backend users to Timesheets users by username, email/full name, or unique last-name match; ambiguous last-name matches must be reviewed manually.

Storefront/member login still uses the local CSA `/api/auth/login` password flow. Password reset/contact delivery is `users.email`, which may be shared by multiple users, such as `deckfamilyfarm@gmail.com`. Storefront forgot-password emails include the username so shared inboxes can tell which account is being reset. Reset tokens live in `password_reset_tokens`; tokens are one-time use and expire. Mail delivery uses SMTP env vars (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, optional `SMTP_SECURE`), Gmail-style `EMAIL_USER`/`EMAIL_PASS`, or the local `MAIL_USER`/`MAIL_ACCESS` pair. Set `PUBLIC_APP_BASE_URL` or `FRONTEND_BASE_URL` when reset links should point somewhere other than the API host.

Key implementation points:

- Formula-pricing vendor detection lives in `apps/api/lib/productPricing.js`.
- Deposit/no-markup detection also lives in `apps/api/lib/productPricing.js`.
- Admin roles and user management live in `apps/api/lib/adminRoles.js`, `apps/api/routes/admin.js`, and `design/template/vite-app/src/components/AdminUsersSection.jsx`.
- Timesheets admin login and user linking live in `apps/api/lib/timesheetsAuth.js`, `apps/api/lib/timesheetsUserSync.js`, `apps/api/routes/auth.js`, `apps/api/routes/admin.js`, and `apps/api/scripts/syncTimesheetsUsers.js`.
- Password reset email and token behavior lives in `apps/api/lib/email.js`, `apps/api/lib/passwordReset.js`, and `apps/api/routes/auth.js`.
- Admin pricelist reads and remote apply flows live in `apps/api/routes/admin.js`.
- Local Line push payloads are built in `apps/api/localLine.js`.
- Local Line pull/audit behavior lives in `apps/api/scripts/auditLocalLineSync.js`.
- Local Line cache/full-sync behavior lives in `apps/api/scripts/syncLocalLineCache.js` and `apps/api/scripts/syncLocalLineFull.js`.
- Square cache, match approval, price audit, and apply behavior lives in `apps/api/lib/squareStoreSync.js` and `apps/api/routes/admin.js`.

## Turkey storefront

- The main store root restores `HomeLandingPage`, initially showing **Coming Soon, Full Farm Version 2 store**. `storefront_settings` controls regular catalog visibility independently of turkey sales. Store → Storefront requires `storefront_admin`, uses versioned saves, and provides an authenticated staff preview. Hidden storefronts must not display or fetch catalog products; existing catalog API callers remain supported. Subscribe, Dropsites, and Turkey hostnames use the same application with distinct landing pages.

- The turkey preorder storefront at `turkeys.deckfamilyfarm.com` and local `/turkeys` uses independent `storefront_*` stock/order tables. It shares the Subscribe header/footer and Shop → Turkeys navigation with Subscribe and Dropsites. Never sync preorder stock counts or orders with Local Line or Square, and never reuse catalog product/package inventory for preorder reservations.
- Preorder offerings link to local turkey products for names, photos, and retail prices through `storefrontProducts.js`; catalog reads are allowed, catalog writes are not. Use the Products Retail Price (`sourceUnitPrice` per each for formula vendors) directly, without CSA factors or customer markups; block missing or per-pound retail prices from whole-bird checkout. Standard products require one package priced for one turkey. Checkout reads current retail prices server-side; keep existing order labels, prices, and Stripe requests frozen. Local preorder descriptions are separate from Products and Local Line. Store one editable Heritage Black description and one Broad Breasted White description on the sale; all sizes of a breed share that copy. Defaults and breed matching live in storefrontDescriptions.js. Never replace catalog descriptions when saving preorder copy; render only safe formatting.
- The initial draft sale is for November 21, 2026, with PSU Farmers Market, Hollywood Farmers Market, Lane County Farmers Market, and Farm Pickup. Pickup groups support one or more titled locations with addresses, instructions, and hours; groups and locations can be added or deactivated. Existing order pickup snapshots survive edits. Label turkey stock controls **Pre-order inventory** to distinguish them from Local Line inventory. Each turkey card has a Pre-order inventory count, including newly added products, saved transactionally with Setup. Send inventory edits only when changed and require stock/reservation baselines for existing offerings. Setup's bottom section and the Pre-order inventory tab also show sold/on-hand/reserved/available counts and allow checked on-hand updates without discarding Setup drafts.
- `storefront_admin` authorizes preorder setup, inventory, orders, collection, and full refunds; full `admin` includes it. Preserve other role assignments. `STOREFRONT_CHECKOUT_ENABLED` defaults off, and the separate raw-body webhook uses `STOREFRONT_STRIPE_WEBHOOK_SECRET`.
- Stripe returns must use the validated checkout origin (the Store and Turkeys HTTPS hosts or configured local/staging origin); reject arbitrary origins and freeze URLs for retries. Guest receipts still require the order token, never an order ID alone. Tokens have a seven-day same-origin local-storage fallback for new tabs, without persisting customer details there. Missing access and receipt failures must show recovery guidance, not an indefinite loading state.
- Turkey shopping uses listing → product detail → cart → hosted Stripe Checkout at `#/turkeys`, `#/turkeys/product`, and `#/turkeys/cart`. The grouped Thanksgiving Turkey product stores `about_description` and optional `product_image_url` on `storefront_sales`; keep it separate from catalog/Local Line descriptions. Each existing offering ID remains a variant. Derive its breed from the linked product and weight range from package names; reject missing/ambiguous or duplicate active mappings. New order items snapshot product ID, type, and size; preserve old item labels and frozen Stripe requests. Cart state persists only IDs, quantities, and displayed prices; revalidate server-side, retain uncertain retry tokens, and clear only the matching cart after confirmed payment. The `checkoutRejected` response flag is reserved for known new checkout rejections without a committed order.
- Stock changes and payments must remain transactional and idempotent. Keep uncertain outcomes held until Stripe confirms them; never release on browser redirect or a timer alone. The maintenance runner reconciles payments/refunds and retries email delivery.
- Implementation lives in `apps/api/lib/storefrontService.js`, `storefrontSchema.js`, and `routes/storefront.js`. Operational setup and tests are documented in `docs/turkey-preorders.md`.

## Product Sync

- Pending product rows have a Link to Square shortcut into Product Matches. Square matching defaults to all Deck Enterprises vendors. Matches show labeled CSA Store retail and Square prices; an active CSA sale also shows the selling price. `Link & update Square price` requires both `square_pull` and `square_push`, confirms the match, audits only the selected product, and publishes only the selected package's persisted Square price action. Hold if the displayed prices or mapping differ from the new audit. Use background Product Sync releases and retain audit/action/release receipts for interrupted-request recovery; never generate a replacement release after an uncertain response without looking up the existing action's release. The approved variation is the default selection even when another suggestion scores higher. Link-only approval remains available with `square_pull` and explicitly leaves the Square price unchanged. Create in Square requires both `square_pull` and `square_push`. Creation previews one item with all local package variations and requires explicit approval. New items and variations default to availability at all Square locations, even when `SQUARE_LOCATION_ID` is configured. It checks the live catalog for duplicate names/SKUs, then confirms the created item and transactionally saves the package links. It does not publish Square Online availability or sync inventory, photos, or taxes.
- `apps/api/lib/squareProductCreation.js` persists frozen previews, account configuration fingerprints, request keys, and remote receipts in `square_product_creations`. Uncertain requests reuse the exact Square idempotency key and body, even across reloads or local edits. Confirmed receipts are saved before linking; retries confirm and finish the existing item. Never discard an uncertain/completed creation or generate a replacement request for it. Test with `node --test apps/api/lib/squareProductCreation.test.js`; the opt-in integration test uses the same disposable `PRODUCT_SYNC_TEST_SOCKET` convention as Product Sync and mocks every Square request.

- Store → Product Sync has stacked, expandable Local Line — Products & updates and Square — Matches & prices sections, both open by default, with Scheduled updates & history below. `ProductSyncDestination.jsx` owns independent filters, selection, checks, and approvals for each destination; `ProductSyncReview.jsx` shares comparison/progress rendering. Incoming Local Line repairs open as a separate review from Local Line Data, which also holds operational pulls.
- `apps/api/lib/productSync.js` coordinates database-backed audits and releases; `productSyncCore.js` owns permission and preflight rules; `productSyncAdapters.js` prepares and executes platform payloads; `productSyncIncoming.js` handles individual supported incoming repairs.
- New tables are bootstrapped by `productSyncSchema.js`. Never execute client-supplied remote payloads: release requests contain persisted audit action IDs only.
- Release payloads and local/remote/mapping baselines are frozen at audit time. Drift holds the affected action; unrelated actions continue. Retries verify remote state, preserve Square idempotency requests, skip completed actions, and apply local staging once per product.
- A confirmed Local Line create ID is checkpointed before further steps. An uncertain create is held for reconciliation and must never be automatically resent, even through a replacement audit.
- The existing `run:scheduled-pricelist` hourly runner handles both legacy Local Line-only batches and new platform releases. Database timestamps are UTC; the UI explicitly uses Pacific time.
- Audit reads refresh caches only. Incoming formula price drift is review-only. Membership remains excluded. Both destination sections default to Deck Enterprises (Deck Family Farm, Hyland, and Creamy Cow), with an explicit All vendors option. Product selections intersect with that scope; an empty intersection must never expand to all products. Lists show 30 rows per page before checking, with local/remote IDs and links. Local Line Last checked uses a successful per-product comparison; Last published uses confirmed publication receipts or legacy remote_synced_at. Cache refreshes and failed publications never advance Last published. `productSyncMatches.js` provides the additive Local Line match details.
- Each destination has full-scope and selected-product checks. Full checks include all products in the chosen vendor scope regardless of list search/status filters; Square is never limited by Local Line pending flags. Products handoffs retain their explicit scope and drafts. New Local Line checks publish local changes only (`incoming: false`); incoming repair reviews remain separately accessible. Persist the audit scope; show product counts separately from package results. Latest-audit lookup accepts a platform filter, older combined audits remain viewable, and running audits resume automatically. Selection and publication stay scoped to one destination; approval still uses persisted action IDs. Existing combined releases and scheduling remain supported.
- Immediate publication uses `background: true` to return a durable release receipt, then polls lean `/releases/:id/progress` data. Queued workers share the existing execution lock and the hourly runner resumes queued/running work. Persist checking/applying/confirming steps; polling never executes writes. The audit UI polls only audit progress until completion, retains existing rows during filtered-result refreshes, and disables stale selections.
- Test the core with `node --test apps/api/lib/productSyncCore.test.js apps/api/lib/productSyncAdapters.test.js apps/api/lib/productSyncScope.test.js`. The opt-in integration test requires a disposable MySQL socket under `/tmp/csa-product-sync-*`: `PRODUCT_SYNC_TEST_SOCKET=... node --test apps/api/lib/productSync.integration.test.js`. It creates an isolated test schema, mocks all platform requests, and never reads `.env`.
