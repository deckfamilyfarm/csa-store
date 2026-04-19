# CSA Store Agent Notes

## Intended Sync Model

This application sits between three sources:

- Local Line, the remote store and product API.
- The local `store` MySQL database used by this CSA storefront.
- Legacy/Killdeer pricelist data used for some source pricing workflows.

The intended behavior is two-way, but not symmetric:

- Pull from Local Line: admins should be able to run a Local Line audit/sync from the UI, review all proposed changes, warnings, and errors, then approve specific supported fixes before the local database is written.
- Push to Local Line: admins should be able to save local pricing changes, then explicitly apply pending remote changes to Local Line.
- Automatic Local Line pull writes must stay narrow. Current supported pull writes are local catalog repair actions such as missing local products/packages and local product/package field updates. Price-list drift and overrides from Local Line are review-only unless a future change adds an explicit schema and approval flow.

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

Products in the `Membership` category are membership levels, not pricelist items. Keep them out of the admin pricelist/formula-pricing workflow and manage them from the dedicated admin `Membership` section. That section tracks the membership-level product/package records without treating them as normal price-list rows.

The admin pricelist intentionally has two edit paths:

- `Edit Row` edits formula/pricelist fields inline for the row.
- `Details` opens the same product detail editor used by the Products section for product metadata, descriptions, images, package prices, and cached Local Line price-list entries.

Key implementation points:

- Formula-pricing vendor detection lives in `apps/api/lib/productPricing.js`.
- Deposit/no-markup detection also lives in `apps/api/lib/productPricing.js`.
- Admin pricelist reads and remote apply flows live in `apps/api/routes/admin.js`.
- Local Line push payloads are built in `apps/api/localLine.js`.
- Local Line pull/audit behavior lives in `apps/api/scripts/auditLocalLineSync.js`.
- Local Line cache/full-sync behavior lives in `apps/api/scripts/syncLocalLineCache.js` and `apps/api/scripts/syncLocalLineFull.js`.
