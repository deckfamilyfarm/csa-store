# API Notes

This API serves the CSA storefront catalog and admin endpoints.

Setup
1) Copy `.env.example` to `.env` and fill in DB creds.
2) `npm install`
3) `npm run dev`

Optional: seed admin
- Set `AUTO_SEED_ADMIN=true` in `.env`, then start the server.
- Or run `SEED_ADMIN=true npm run seed:admin`.

Endpoints
- GET /api/health
- GET /api/catalog
- POST /api/admin/login
- GET /api/admin/products
- PUT /api/admin/products/:id
- PUT /api/admin/packages/:id
- POST /api/admin/recipes
- PUT /api/admin/recipes/:id
