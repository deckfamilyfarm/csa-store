# API Notes

This API serves the CSA storefront catalog and admin endpoints.

Setup
1) Copy `.env.example` to `.env` and fill in DB creds.
2) `npm install`
3) `npm run dev`

Optional: seed admin
- Set `AUTO_SEED_ADMIN=true` in `.env`, then start the server.
- Or run `SEED_ADMIN=true npm run seed:admin`.
- The default seed admin is `deck.john` / `John Deck`; override with `ADMIN_USER`,
  `ADMIN_NAME`, and `ADMIN_EMAIL`.

Schema notes
- Local Line sync support tables are defined in `schema.js`.
- The SQL bootstrap/migration file for those tables is `sql/localline_sync.sql`.
- That migration adds local tables for:
  `price_lists`,
  `package_price_list_memberships`,
  `product_price_list_memberships`,
  `product_media`,
  `local_line_product_meta`,
  `local_line_package_meta`,
  `local_line_sync_runs`,
  `local_line_sync_issues`.
- Subscriber snapshots are cached locally in `local_line_subscription_snapshot_rows` and `local_line_subscription_snapshot_runs`.
- `New Subscribers`, `Exiting Subscribers`, and the non-SNAP portion of `Total Subscribers`
  are counted from the subscription export's `Created` and `Cancelled Date` fields for each
  dashboard week. This avoids treating a late live export as a true point-in-time snapshot
  for an earlier week.
- `Average Order Amount` uses the orders export `Order Total` value, not the order detail API
  `total`, because the API total can be reduced to zero by store credits. By default it uses
  the legacy KPI price lists `2966,2718,3124`; override with `DASHBOARD_ORDER_PRICE_LIST_IDS`.
- `SNAP subscribers` on the dashboard are counted from current Local Line SNAP price-list
  membership (`LL_PRICE_LIST_SNAP_ID`, or `DASHBOARD_SNAP_PRICE_LIST_ID` when set). They
  are added into `Total Subscribers`, but they are not used for `New Subscribers` or
  `Exiting Subscribers`.

Endpoints
- GET /api/health
- GET /api/catalog
- POST /api/admin/login
- POST /api/auth/timesheets-launch
- POST /api/auth/forgot-password
- POST /api/auth/reset-password
- POST /api/auth/change-password
- GET /api/admin/products
- PUT /api/admin/products/:id
- PUT /api/admin/packages/:id
- GET /api/admin/admin-users
- GET /api/admin/admin-users/timesheets-sync
- POST /api/admin/admin-users/timesheets-sync
- POST /api/admin/admin-users
- PUT /api/admin/admin-users/:id
- POST /api/admin/admin-users/:id/reset-password
- POST /api/admin/recipes
- PUT /api/admin/recipes/:id

Timesheets admin login
- When `TIMESHEETS_API_URL` is set, `/api/admin/login` validates the submitted username/password
  against Timesheets, then issues a CSA Store JWT only if the linked local user has CSA admin roles.
- CSA permissions stay local in `admin_roles` and `admin_user_roles`; Timesheets roles are not used
  as CSA permissions.
- Set `CSA_ADMIN_AUTH_MODE=local` to force the legacy local admin password login for development or
  emergency recovery. Set `CSA_ADMIN_AUTH_MODE=timesheets` to require Timesheets even if the API URL
  is missing, which will fail closed until configured.
- `/api/auth/timesheets-launch` accepts the standard Timesheets top-level POST with `access_token`
  and optional `return_to`, validates it with `${TIMESHEETS_API_URL}/auth/getUserRole`, then redirects
  into `/#/admin` with an app-issued CSA token in the URL fragment.
- Restrict launch origins with `TIMESHEETS_LAUNCH_ALLOWED_ORIGINS`, for example
  `https://timesheets.deckfamilyfarm.com,http://localhost:3000`.
- Use `TIMESHEETS_DATABASE_URL` for user sync previews/apply, or set
  `TIMESHEETS_DB_HOST`, `TIMESHEETS_DB_USER`, `TIMESHEETS_DB_PASSWORD`, and optional
  `TIMESHEETS_DB_DATABASE`.
- From `apps/api`, run `npm run sync:timesheets-users` to preview backend-user matches, and
  `npm run sync:timesheets-users -- --write` to apply unique matches.

Password reset email
- Storefront/member login still uses the local CSA password flow and reset emails.
- The admin Users screen separates unique CSA `username` from non-unique contact `email`.
- The reset email can be shared by multiple users. Forgot-password asks for username and sends the reset email to that user's stored reset email.
- In Timesheets admin-auth mode, backend admin passwords are managed in Timesheets and the admin
  Users screen does not send CSA password setup/reset emails.
- Signed-in local storefront/member users can change their own password with `/api/auth/change-password`.
- Configure SMTP with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and optional `SMTP_SECURE`, use Gmail-style `EMAIL_USER`/`EMAIL_PASS`, or use the local `MAIL_USER`/`MAIL_ACCESS` pair.
- Configure `PUBLIC_APP_BASE_URL` or `FRONTEND_BASE_URL` when reset links should point to the storefront host instead of the API request host.
