# API Notes

This API serves the CSA storefront catalog and admin endpoints.

Setup
1) Copy `.env.example` to `.env` and fill in DB creds.
2) `npm install`
3) `npm run dev`

Optional: seed admin
- Set `AUTO_SEED_ADMIN=true` in `.env`, then start the server.
- Or run `SEED_ADMIN=true npm run seed:admin`.

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

Endpoints
- GET /api/health
- GET /api/catalog
- POST /api/admin/login
- POST /api/auth/forgot-password
- POST /api/auth/reset-password
- POST /api/auth/change-password
- GET /api/admin/products
- PUT /api/admin/products/:id
- PUT /api/admin/packages/:id
- GET /api/admin/admin-users
- POST /api/admin/admin-users
- PUT /api/admin/admin-users/:id
- POST /api/admin/admin-users/:id/reset-password
- POST /api/admin/recipes
- PUT /api/admin/recipes/:id

Password reset email
- The admin Users screen separates unique login `username` from non-unique password reset `email`.
- The reset email can be shared by multiple users. Forgot-password asks for username and sends the reset email to that user's stored reset email.
- The admin Users screen does not collect passwords for newly added users. It creates the local user, assigns roles, and sends a password setup link.
- Signed-in users can change their own password with `/api/auth/change-password`; the admin `Users` screen exposes this as `Change My Password`.
- Configure SMTP with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and optional `SMTP_SECURE`, use Gmail-style `EMAIL_USER`/`EMAIL_PASS`, or use the local `MAIL_USER`/`MAIL_ACCESS` pair.
- Configure `PUBLIC_APP_BASE_URL` or `FRONTEND_BASE_URL` when reset links should point to the storefront host instead of the API request host.
