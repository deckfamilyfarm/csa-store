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

Square Online v1 is a price mirror only. CSA Store remains the pricing source of truth; Square price drift is review data and should not back-capture into local formula/pricelist fields. Do not create Square products, sync stock, manage Square Online visibility, or push member/herd-share/SNAP prices without an explicit future workflow. The value pushed to Square is the CSA Store price for Square: for formula-priced products, use the local Vendor's Retail Price (`sourceUnitPrice`) directly without FFCSA factor, package weight/quantity, or customer markup; for standard products, use the local package price. Apply sale discounts as the normal Square variation price.

## Local Line API

The integration targets the Local Line Backoffice v2 API:

- Base URL: `https://localline.ca/api/backoffice/v2/` unless `LL_BASEURL` overrides it.
- Auth: `POST /token/` with `LL_USERNAME` and `LL_PASSWORD`; use the returned bearer token in `Authorization`.
- Product export: `GET /products/export/?direct=true`.
- Product detail: `GET /products/{id}/?expand=packages,product_price_list_entries`.
- Product update: `PATCH /products/{id}/`.

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

Store → Products combines the former Pricelist, Local Pricelist, and Inventory screens. Overview, Pricing, and Inventory are views of the same catalog with shared filters, selection, and drafts. The default is Overview with all vendors; Membership products remain excluded.

- Inline controls edit formula inputs, stock, visibility, sales, and standard single-package prices.
- `Details` shares the grid draft and edits metadata, descriptions, images, package prices, and cached Local Line price-list entries.
- `Save Local Changes` uses the shared coordinator in `design/template/vite-app/src/components/productWorkspace.js`. Acknowledge only successful fields/packages and preserve failures for retry. It must never push to Local Line.
- `Review & Sync` opens Store → Product Sync with the selected products. Audit first, then explicitly approve platform actions. The old direct push endpoints remain compatible for existing clients.
- Unsaved scheduled changes support only stock, tracking, visibility, and sales. Save other fields locally before scheduling pending pushes.
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

## Product Sync

- Store → Product Sync combines outgoing Local Line and Square audits, explicit action selection, incoming Local Line repairs, product matches, and release history. Local Line Data holds operational pulls.
- `apps/api/lib/productSync.js` coordinates database-backed audits and releases; `productSyncCore.js` owns permission and preflight rules; `productSyncAdapters.js` prepares and executes platform payloads; `productSyncIncoming.js` handles individual supported incoming repairs.
- New tables are bootstrapped by `productSyncSchema.js`. Never execute client-supplied remote payloads: release requests contain persisted audit action IDs only.
- Release payloads and local/remote/mapping baselines are frozen at audit time. Drift holds the affected action; unrelated actions continue. Retries verify remote state, preserve Square idempotency requests, skip completed actions, and apply local staging once per product.
- A confirmed Local Line create ID is checkpointed before further steps. An uncertain create is held for reconciliation and must never be automatically resent, even through a replacement audit.
- The existing `run:scheduled-pricelist` hourly runner handles both legacy Local Line-only batches and new platform releases. Database timestamps are UTC; the UI explicitly uses Pacific time.
- Audit reads refresh caches only. Incoming formula price drift is review-only. Membership remains excluded. Square scope in Product Sync defaults to Deck Family Farm, with an explicit all-vendors option.
- Test the core with `node --test apps/api/lib/productSyncCore.test.js apps/api/lib/productSyncAdapters.test.js`. The opt-in integration test requires a disposable MySQL socket under `/tmp/csa-product-sync-*`: `PRODUCT_SYNC_TEST_SOCKET=... node --test apps/api/lib/productSync.integration.test.js`. It creates an isolated test schema, mocks all platform requests, and never reads `.env`.
