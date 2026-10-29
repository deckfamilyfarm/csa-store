# Enterprise pricing workbench

The new Store → Pricing and Store → Review & Publish screens use local pricing revisions. Saving activates the store price immediately, including in production, and records purchase/wholesale history. Saving never writes to Square or Local Line. Channel synchronization requires separate approval, fresh checks, explicit publication and verification. Existing products continue using legacy pricing until migrated individually.

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

1. Save a product price in Pricing; it takes effect in our store immediately. Enter validated purchase costs and documentation references; historical legacy multipliers do not establish intercompany costs.
2. An authorized publisher reviews the frozen output. The October 29 cutover explicitly allows the same person to edit and approve; the separation setting remains configurable.
3. Check destinations. The existing Product Sync audit refreshes remote products, variation units, prices, locations, vendor identity, and mappings without writing.
4. Publish the approved actions. The release checks frozen local and remote baselines again. A blocker in either destination holds coordinated publication for that product. Unrelated products can proceed.
5. Confirm destination receipts. A partially published product stays partial until all required destinations verify. Publication failures do not undo saved store prices. A new edit invalidates prior approval; unresolved publications or approved sales hold conflicting edits.

Square eligibility is explicit and distinct from an approved variation mapping. Disabling eligibility does not remove a Square listing. Products without Square eligibility produce no Square price action. Wholesale prices stay local. Deposits, Membership, and unresolved basket-specific overrides stay in the legacy workflow pending reconciliation.

The Migration comparison menu item uses cached remote data and does not publish or change prices. Treat missing costs, conflicting basket prices, and uncertain mappings as review items.

## Sales

The Pricing editor can propose a sale for an active product. Approval freezes packages, regular prices, remote mappings, dates, channels, and percentage. Square uses managed `DISCOUNT`, `PRODUCT_SET`, and `PRICING_RULE` catalog objects as described in [Square's automatic discount guide](https://developer.squareup.com/docs/catalog-api/cookbook/auto-apply-discounts); normal variation prices remain intact. New Square rules use the [supported validity fields](https://developer.squareup.com/reference/square/objects/CatalogPricingRule), omitting the end bounds for ongoing sales. Previously frozen requests and receipts are preserved. Local Line gets a fixed sale amount in all four baskets with the regular amount as the crossed-out price. The scheduled release runner activates and restores approved Local Line sales and records partial failures for retry. New sale proposals default to **Until I turn it off**, stored as `endAt: null`; choosing a date still supports automatic expiration. **Review & Publish → Sales → Turn off sale** removes only the managed Square pricing rule and restores Local Line regular prices. Failed restoration keeps the cancellation intent for retry; it cannot reactivate the sale. Bundle prices recalculate locally after a sale ends and still require a separate bundle publication.

Before the Square discount is created, both selected destinations must pass remote price, mapping, vendor, and unit checks. Existing automatic Square rules at a selected location block the sale until stacking is reviewed. The exact Square request and idempotency key are saved before publication and reused after an uncertain response. A lost Local Line response is checked against the remote basket prices before retry.

Production Square discount publication is blocked until a farmers-market POS pilot is verified and `SQUARE_PROMOTION_POS_VERIFIED=true` is deliberately configured. Square Sandbox cannot confirm the physical POS behavior. Approved sale proposals may be tested locally with mocked APIs without setting that production gate. The existing scheduled runner runs hourly; schedule its invocation more frequently if minute-level activation is required.

## Tests

```sh
node --test apps/api/lib/enterprisePricingEngine.test.js apps/api/lib/enterprisePricingPublication.test.js apps/api/lib/enterprisePromotionsCore.test.js
node --test apps/api/lib/productSyncCore.test.js apps/api/lib/productSyncAdapters.test.js
node --test scripts/local-pricing/guard.test.mjs
```

The opt-in enterprise and Product Sync integration tests use a disposable MySQL socket under `/tmp/csa-product-sync-*` and mock every external request. Run those suites separately because Product Sync uses a process-wide database lock.

## Bundles

Pricing → Bundles stores native Local Line boxes separately from ordinary products. FF bundle selling price is the sum of component package selling prices less the saved discount (initially 5%). Vendor Buy Price is independent. Editing a component price recalculates dependent bundles.

The Sync section checks live component prices, box mappings, vendor and four basket entries, then saves a frozen review. Approve & publish requires publishing permission and Local Line Push. All component basket prices must already match our saved prices. Retries use the same review and verify a lost response before sending again; an uncertain publication blocks replacement reviews. Name, description, visibility, Buy Price, component quantities and basket prices are displayed/reviewed. Inventory-mode/stock changes, unknown images, swaps and missing baskets are held rather than guessed.

Live box publication requires an explicitly approved first-box pilot (`LL_BUNDLE_PUBLICATION_ENABLED=true` and `LL_BUNDLE_PILOT_BOX_IDS=<approved remote box IDs>`). Both are required; an empty list or wildcard permits nothing. Read-only recovery of an already successful request still works when the pilot is disabled. Local tests mock every channel request; they do not establish live Local Line behavior. Square promotions separately require the real POS pilot. See [the migration guide](pricing-migration.md) for the rehearsed rollout and rollback.

Bundle components may use a managed Local Line promotion only while it is active, confirmed on Local Line, and matches the local regular price. All four remote baskets must match its sale price, sale flag and crossed-out regular price. Unmanaged legacy sales, partially published promotions, and expired promotions with stale channel prices block publication. Reviews freeze the promotion identity as well as component amounts. A sale starting or ending recalculates local bundle prices; it does **not** automatically publish the bundle. Recheck and publish affected bundles after verifying component changes.
