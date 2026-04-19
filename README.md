# CSA Storefront Template

This repo holds the design and template work for the Full Farm CSA storefront, plus a small API that
serves the catalog from the `store` database.

Design source
- The core plan and requirements live in `design/design.md`.
- Issues and motivation are in `design/whatswrong.md`.

Template location
- The Vite-based template is in `design/template/vite-app`.

API location
- The API lives in `apps/api` (Express + Drizzle + MySQL).
- Local Line schema additions for the store DB are in `apps/api/sql/localline_sync.sql`.

Admin panel
- Visit `/#/admin` to log in as an admin.
- Backend admin access is local to this app. Full admins can use the admin `Users` section to add backend users and assign one or more roles: `admin`, `user_admin`, `inventory_admin`, `pricing_admin`, `localline_pull`, `localline_push`, `dropsite_admin`, `membership_admin`, and `member_admin`.
- Timesheets identity is not currently the CSA Store permission authority. Optional Timesheets user/employee ids are reserved for future linking only.
- Admin login uses a unique `username`. Password reset email is stored separately and can be shared by multiple users, for example `deckfamilyfarm@gmail.com`.
- Admin user setup and recovery use password reset emails. Creating a backend user sends a one-time setup link to that user's reset email instead of requiring an admin-entered password; existing users can be sent reset links from the `Users` screen or from login forgot-password by username.
- Signed-in admins can also change their own password directly in the `Users` screen with `Change My Password`, which requires their current password and does not send email.
- Password email delivery uses `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`, Gmail-style `EMAIL_USER`/`EMAIL_PASS`, or the local `MAIL_USER`/`MAIL_ACCESS` pair. Set `PUBLIC_APP_BASE_URL` or `FRONTEND_BASE_URL` so emailed links point to the storefront host.

Run locally (dev)
1) `npm install`
2) Copy `.env.example` to `.env` and fill in DB creds
3) `npm run dev`

The dev server defaults to port 5176.

Run the API (dev)
1) `cd apps/api`
2) `npm install`
3) Copy `.env.example` to `.env` and fill in DB creds
4) `npm run dev`

Run online (preview/prod)
1) `cd design/template/vite-app`
2) `npm install`
3) `npm run build`
4) `npm run preview -- --host 0.0.0.0 --port 5176`

PM2 helpers
- `start.sh` runs a preview server under PM2 on port 5176.
- `restart.sh` restarts that PM2 process.

Killdeer integration
- Preview the wired export command from this repo with `npm run killdeer:export-master-pricelist:preview`.
- Run the Killdeer master pricelist export from this repo with `npm run killdeer:export-master-pricelist`.
- The export wrapper now loads this repo's `.env` by default, falls back from `DFF_DB_*` to the full `STORE_DB_*` config including the database name, and skips Google Sheets sync by default. Pass `-- --google-sync` to enable sheet updates or `-- --env-file=/path/to/.env` to override the env source.
- Dry-run the store sync with `npm run sync:killdeer-pricelist`.
- Apply the sync only when ready with `npm run sync:killdeer-pricelist -- --write`.

Local Line sync
- Intended workflow: Local Line can be pulled into this app for review, and locally approved/priced changes can be pushed back to Local Line. Pull and push are explicit admin actions, not silent background source-of-truth swaps.
- The Local Line API target is Backoffice v2: `LL_BASEURL` defaults to `https://localline.ca/api/backoffice/v2/`, auth posts to `/token/`, product export reads `/products/export/`, product detail reads `/products/{id}/?expand=packages,product_price_list_entries`, and product writes PATCH `/products/{id}/`.
- Dry-run the Local Line catalog and pricelist audit with `npm run audit:localline-sync`.
- In the admin UI, use the `Local Line Sync` button in the Products section to run the same analysis and review warnings/errors before applying any local-store changes.
- In the admin UI, use `Local Line Full Sync` to apply the csa-store catalog updates and then populate the Local Line price-list/media/image data in one pass.
- After the audit finishes, each actionable suggested fix in the admin audit panel gets its own `Apply` button. There is no global apply while the audit is still running.
- The audit downloads the full Local Line products export, compares it to local `products` and `packages`, then fetches live Local Line details for the current pricelist-mapped products.
- The audit writes a full JSON report to `tmp/localline-audit-report.json` by default and prints a summary plus sample mismatches.
- Apply the actionable local-store catalog updates from the CLI with `npm run sync:localline-store`.
- Apply a specific fix bucket from the CLI with `npm run sync:localline-store -- --fixes=create-store-products` or `--fixes=sync-store-catalog-fields`.
- Use `--limit=50` to print more sample rows and `--concurrency=8` to raise Local Line fetch parallelism.
- Use `--include-inactive` if you want to include inactive rows from the Killdeer pricelist in the live comparison.
- Add `--write` when running `apps/api/scripts/auditLocalLineSync.js` directly.
- The apply path writes actionable csa-store fixes only: create missing local products, create missing local packages, and update local product/package fields. Pricelist drift, dead Local Line mappings, and price-list override warnings are still reported but not written.
- Formula-pricing vendors are local-authoritative: vendor names containing `deck family farm`, `hyland`, or `creamy cow` compute pricing from local source price, weight/quantity, multiplier, and markups. Do not back-capture Local Line price changes for those vendors as formula inputs without a separate explicit approval/schema path.
- Deposit products are no-markup exceptions: product names containing `deposit` are classified as `Deposit / no markup` in the admin pricelist and use `0%` guest/member/herd-share/SNAP markup, even when the vendor is Deck Family Farm.
- Membership category products are membership levels, not pricelist or inventory rows. The admin pricelist and inventory sections exclude the `Membership` category; manage those product/package records from the admin `Membership` section.
- The Local Line push logic now preserves the live adjustment type when price-list entries already exist, so dollar (`adjustment_type=1`), percentage (`adjustment_type=2`), and set-price (`adjustment_type=3`) rows can be updated without being coerced into percentage adjustments.
- The audit still surfaces fixed-adjustment rows explicitly so you can review where Local Line pricing behavior differs from the current pricelist assumptions.
- Populate the new Local Line cache tables in csa-store with `npm run sync:localline-cache`.
- The audit/full-sync scripts use this repo's `.env` by default. `DFF_DB_*` is optional; when omitted, the scripts reuse the full `STORE_DB_*` connection, including the database name. Pass `-- --killdeer-env=/path/to/.env` only when you explicitly want a separate override file.
- Preview the cache sync first with `npm run sync:localline-cache -- --limit=25`.
- Write the cache tables with `npm run sync:localline-cache -- --write`.
- Run the combined catalog + Local Line data/image sync with `npm run sync:localline-full`.
- Cached Local Line product media is stored in csa-store `product_media`.
- When cache sync runs in write mode and Spaces is configured, Local Line product images are also mirrored into local storage and written into `product_images`.
- Admin/catalog responses use mirrored `product_images` first and fall back to cached `product_media` URLs when needed.
