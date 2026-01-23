# CSA Storefront Template

This repo holds the design and template work for the Full Farm CSA storefront. The current output is a
front-end template only; it is not wired to a live backend yet.

Design source
- The core plan and requirements live in `design/design.md`.

Template location
- The Vite-based template is in `design/template/vite-app`.

Run locally (dev)
1) `cd design/template/vite-app`
2) `npm install`
3) `npm run dev`

The dev server defaults to port 5176.

Run online (preview/prod)
1) `cd design/template/vite-app`
2) `npm install`
3) `npm run build`
4) `npm run preview -- --host 0.0.0.0 --port 5176`

PM2 helpers
- `start.sh` runs a preview server under PM2 on port 5176.
- `restart.sh` restarts that PM2 process.
