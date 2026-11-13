# Square category crosswalk

Square POS categories are separate from the local/Local Line categories. Store
Square IDs and display names; do not rename the local categories to match POS.
The November 13 crosswalk preserves the user-reviewed Square catalog.

Resolution order:

1. Explicit local product assignment.
2. Saved assignments for its approved Square item links, if they agree.
3. An explicitly reviewed default for its local category ID.
4. Require a choice in the product's Square setup.

The five initial category defaults are local pork → Pasture Raised Pork,
beef → Grassfed Beef, poultry → Roasters, lamb → Spring Lamb, and eggs → Eggs.
Broad categories such as sausages, bones/organs, canned goods and grains do not
get inferred defaults. Their current products retain exact product assignments.
Square-only items are saved by Square item ID without guessing a local match.
The deleted whole-turkey item is not imported or recreated.

`square_category_registry` stores names, IDs and the last explicitly refreshed
category body. `square_category_crosswalk` stores `product`, `category`, and
`square-item` assignments, reporting-category IDs, provenance and editor/time.
Both are scoped to a hash of Square's environment, endpoint and access token;
location and currency changes do not affect them. A credential/account change
requires a reviewed import under the new connection. Never copy mappings across
accounts by name alone.

## Installation and initial import

From the repository root:

```sh
npm --prefix apps/api run migrate:square-categories -- --check
npm --prefix apps/api run migrate:square-categories -- --apply
node --env-file=.env apps/api/scripts/importSquareCategoryCrosswalk.js
# Inspect .local-pricing/square-category-crosswalk/plan.json.
node --env-file=.env apps/api/scripts/importSquareCategoryCrosswalk.js --apply
```

The migration creates only these two tables, with no financial DDL. Runtime
reads never migrate them. Import writes only the local database, compares the
live Square catalog and local links against the preview, and refuses to replace
an existing crosswalk. The plan and receipt remain in `.local-pricing`.

## Editing and publication

Pricing → product details → Square links and creation exposes the saved category,
its source, and the category selector. Saving requires Square Pull plus the
existing pricing-page access. It is a local-only write with a stale-edit check.
"Use saved item mapping or local category default" removes the product override.
"Refresh category names" reads Square categories, updates the registry, and marks
deleted IDs unavailable without rewriting any product assignments. Replacement
categories with the same name get different IDs and require explicit selection.

New Create in Square previews require a valid category. The preview freezes the
mapping, category names/IDs and reporting category; approval rechecks them against
live Square and current local mapping. The request sets the category and verifies
it on readback. Missing/deleted/renamed categories hold creation for review.
Uncertain requests and old in-flight requests keep their original body and key,
including old requests without a category. Category assignment is not retrofitted
onto those requests.

Existing price/photo sync preserves Square's current categories. Saving a new
local mapping does not move an existing remote item or publish a category rename;
those remain separate explicitly reviewed catalog operations. Local Line,
stock, online visibility and item location availability are unchanged.

## Validation

```sh
node --test apps/api/lib/squareCategoryCrosswalk.test.js apps/api/lib/squareProductCreation.test.js
python3 scripts/test-stabilization.py --docker
npm --prefix design/template/vite-app run build
```

The Square creation integration suite verifies default/override resolution,
stale edits, unavailable categories, category-name refresh, permissions, frozen
category recovery and legacy in-flight requests on a disposable mocked database.
