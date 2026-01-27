# CSA Storefront Template

This repo holds the design and template work for the Full Farm CSA storefront, plus a small API that
serves the catalog from the `store` database.

Design source
- The core plan and requirements live in `design/design.md`.

Template location
- The Vite-based template is in `design/template/vite-app`.

API location
- The API lives in `apps/api` (Express + Drizzle + MySQL).

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
