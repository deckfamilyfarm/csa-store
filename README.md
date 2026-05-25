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

How To Edit The Site Directly
- This site is not edited through Wix or a visual CMS. It is edited directly in this repo using normal files.
- The current subscribe page is a React page. If you want to change wording, images, layout, or styling, you edit the files below and rebuild the frontend.

Files to edit
- Main subscribe page content and layout:
  - `design/template/vite-app/src/components/SubscribePage.jsx`
- Subscribe page styling:
  - `design/template/vite-app/src/styles.css`
- Partner/vendor content for `Meet Our Partners`:
  - `design/template/vite-app/src/data/subscribePartners.js`
- Local subscribe-page images:
  - `design/template/vite-app/public/images/`
- Local partner/vendor images:
  - `design/template/vite-app/public/images/partners/`
- Public API endpoints used by the subscribe page:
  - `apps/api/routes/catalog.js`

What to edit where
- Header/menu links:
  - update `SUBSCRIBE_NAV_LINKS` in `SubscribePage.jsx`
- Plan cards and plan dropdown labels:
  - update `SUBSCRIBE_PLANS` in `SubscribePage.jsx`
- Hero text, herdshare text, FAQ text, section headings, and other written copy:
  - update the JSX text in `SubscribePage.jsx`
- Partner descriptions and partner images:
  - update `subscribePartners.js`
  - update image files in `public/images/partners/` if needed
- Static page images such as the logo, map, dairy photos, and other local assets:
  - replace or add files in `public/images/`
  - then update the matching `src="/images/..."` reference in `SubscribePage.jsx`
- Colors, spacing, typography, card layout, and responsive behavior:
  - update `styles.css`

Local testing
- Start the app:
  - `npm run dev`
- Open the subscribe page locally:
  - `http://localhost:5176/?experience=subscribe`
- Production subscribe host:
  - `https://subscribe.deckfamilyfarm.com/`

Temporary portal toggles
- By default, the subscribe page is in lightweight lead-capture mode: it gathers contact, address, plan, pickup/delivery, notes, and the signed agreement, then logs the lead without public portal onboarding.
- Subscription request emails go to the submitted email address, include a `What you submitted` detail section, use `SUBSCRIBE_LEAD_FROM` if set, and always Bcc `fullfarmcsa@deckfamilyfarm.com` plus any `SUBSCRIBE_LEAD_NOTIFY_TO_BCC`, `SUBSCRIBE_LEAD_NOTIFY_TO`, or `SUBSCRIBE_NOTIFY_TO` values.
- To restore the public member portal link and full subscribe-to-portal onboarding, set all three flags to `true`:
  - `VITE_MEMBER_PORTAL_LINK_ENABLED=true`
  - `VITE_SUBSCRIBE_PORTAL_ONBOARDING_ENABLED=true`
  - `SUBSCRIBE_PORTAL_ONBOARDING_ENABLED=true`

Typical editing workflow
1. Open the file that controls the content you want to change.
2. Make the content or style update.
3. Run:
   - `npm --prefix design/template/vite-app run build`
4. If the build succeeds, restart or redeploy the app so the new frontend bundle is served.

Practical examples
- Change the welcome text:
  - edit `SubscribePage.jsx`
- Change a vendor description:
  - edit `subscribePartners.js`
- Replace a vendor image:
  - replace the file in `public/images/partners/`
- Change colors or spacing:
  - edit `styles.css`

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
- `start.sh` builds the frontend and runs one PM2 process named `store` on port 5176.
- `restart.sh` rebuilds and recreates that PM2 process.

Store pricelist sync
- Preview the store master pricelist export with `npm run export:master-pricelist:preview`.
- Run the store master pricelist export with `npm run export:master-pricelist`.
- The export wrapper loads this repo's `.env` by default and uses this app's configured store database. It does not call into a sibling Killdeer checkout.
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
- Use `--include-inactive` if you want to include inactive local pricelist rows in the live comparison.
- Add `--write` when running `apps/api/scripts/auditLocalLineSync.js` directly.
- The apply path writes actionable csa-store fixes only: create missing local products, create missing local packages, and update local product/package fields. Pricelist drift, dead Local Line mappings, and price-list override warnings are still reported but not written.
- Formula-pricing vendors are local-authoritative: vendor names containing `deck family farm`, `hyland`, or `creamy cow` compute pricing from local source price, weight/quantity, multiplier, and markups. Do not back-capture Local Line price changes for those vendors as formula inputs without a separate explicit approval/schema path.
- Deposit products are no-markup exceptions: product names containing `deposit` are classified as `Deposit / no markup` in the admin pricelist and use `0%` guest/member/herd-share/SNAP markup, even when the vendor is Deck Family Farm.
- Membership category products are membership levels, not pricelist or inventory rows. The admin pricelist and inventory sections exclude the `Membership` category; manage those product/package records from the admin `Membership` section.
- The Local Line push logic now preserves the live adjustment type when price-list entries already exist, so dollar (`adjustment_type=1`), percentage (`adjustment_type=2`), and set-price (`adjustment_type=3`) rows can be updated without being coerced into percentage adjustments.
- The audit still surfaces fixed-adjustment rows explicitly so you can review where Local Line pricing behavior differs from the current pricelist assumptions.
- Populate the new Local Line cache tables in csa-store with `npm run sync:localline-cache`.
- The audit/full-sync scripts use this repo's `.env` by default and must not depend on a sibling Killdeer checkout or its `node_modules`.
- Preview the cache sync first with `npm run sync:localline-cache -- --limit=25`.
- Write the cache tables with `npm run sync:localline-cache -- --write`.
- Run the combined catalog + Local Line data/image sync with `npm run sync:localline-full`.
- Cached Local Line product media is stored in csa-store `product_media`.
- When cache sync runs in write mode and Spaces is configured, Local Line product images are also mirrored into local storage and written into `product_images`.
- Admin/catalog responses use mirrored `product_images` first and fall back to cached `product_media` URLs when needed.
