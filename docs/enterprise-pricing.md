# Enterprise pricing workbench

The new Store → Pricing and Store → Review & Publish screens use local pricing revisions. A draft never changes the storefront, Square, or Local Line. An approved revision becomes the active local price only after every required remote destination has been checked and verified. Existing products continue using legacy pricing until migrated individually.

## Local development

Use the isolated environment in [local-pricing-refactor.md](local-pricing-refactor.md):

```sh
npm run db:local:up
npm run db:local:init
npm run dev
```

These commands use synthetic MySQL records, clear inherited Square and Local Line credentials, and block outbound API traffic. The root `.env` is not loaded. Do not use `dev:connected` for this refactor loop.

## Data model

- `enterprise_pricing_enterprises` identifies the purchasing or selling enterprise. `vendors` still identifies the supplier.
- `enterprise_pricing_settings_versions` freezes markup defaults, the Local Line discount, Square rounding, and eligibility defaults.
- `enterprise_pricing_revisions` stores each product's complete reviewed input and calculated output. `enterprise_pricing_product_state` identifies its latest proposal and last fully verified active revision.
- `enterprise_purchase_cost_history` stores buy-from prices by purchasing enterprise, effective date, revision, and documentation reference. `enterprise_wholesale_price_history` stores independent resale prices by selling enterprise.
- `enterprise_pricing_publications` records each destination's audit, release, result, and verification status.
- `enterprise_promotions` and `enterprise_promotion_events` store frozen sale proposals, Square request keys and receipts, channel status, and audit events.

The pricing engine uses integer amounts: purchase costs have four decimal places, markups use basis points, and customer prices use cents. A 12 oz sausage sold `each` has package quantity 1; its 12 oz label is descriptive. A chuck roast sold `lb` in Square uses its approved average package weight for Local Line. The average comes from an explicit override, the min/max midpoint, cached weight, or a single bound, in that order. All four Local Line baskets receive one calculated package price.

## Review and publication

1. Save a product proposal in Pricing. Enter validated purchase costs and documentation references; historical legacy multipliers do not establish intercompany costs.
2. A different publisher reviews the frozen output. Production requires separate editor and approver by default.
3. Check destinations. The existing Product Sync audit refreshes remote products, variation units, prices, locations, vendor identity, and mappings without writing.
4. Publish the approved actions. The release checks frozen local and remote baselines again. A blocker in either destination holds coordinated publication for that product. Unrelated products can proceed.
5. Confirm destination receipts. A partially published product stays partial until all required destinations verify. Only then does its active local pricing revision change.

Square eligibility is explicit and distinct from an approved variation mapping. Disabling eligibility does not remove a Square listing. Products without Square eligibility produce no Square price action. Wholesale prices stay local. Deposits, Membership, and unresolved basket-specific overrides stay in the legacy workflow pending reconciliation.

The Migration comparison button uses cached remote data and does not publish or change prices. Treat missing costs, conflicting basket prices, and uncertain mappings as review items.

## Sales

The Pricing editor can propose a sale for an active product. Approval freezes packages, regular prices, remote mappings, dates, channels, and percentage. Square uses managed `DISCOUNT`, `PRODUCT_SET`, `TIME_PERIOD`, and `PRICING_RULE` catalog objects as described in [Square's automatic discount guide](https://developer.squareup.com/docs/catalog-api/cookbook/auto-apply-discounts); normal variation prices remain intact. Local Line gets a fixed sale amount in all four baskets with the regular amount as the crossed-out price. The scheduled release runner activates and restores approved Local Line sales and records partial failures for retry. Cancellation removes only the managed Square pricing rule and restores Local Line regular prices.

Before the Square discount is created, both selected destinations must pass remote price, mapping, vendor, and unit checks. Existing automatic Square rules at a selected location block the sale until stacking is reviewed. The exact Square request and idempotency key are saved before publication and reused after an uncertain response. A lost Local Line response is checked against the remote basket prices before retry.

Production Square discount publication is blocked until a farmers-market POS pilot is verified and `SQUARE_PROMOTION_POS_VERIFIED=true` is deliberately configured. Square Sandbox cannot confirm the physical POS behavior. Approved sale proposals may be tested locally with mocked APIs without setting that production gate. The existing scheduled runner runs hourly; schedule its invocation more frequently if minute-level activation is required.

## Tests

```sh
node --test apps/api/lib/enterprisePricingEngine.test.js apps/api/lib/enterprisePricingPublication.test.js apps/api/lib/enterprisePromotionsCore.test.js
node --test apps/api/lib/productSyncCore.test.js apps/api/lib/productSyncAdapters.test.js
node --test scripts/local-pricing/guard.test.mjs
```

The opt-in enterprise and Product Sync integration tests use a disposable MySQL socket under `/tmp/csa-product-sync-*` and mock every external request. Run those suites separately because Product Sync uses a process-wide database lock.
