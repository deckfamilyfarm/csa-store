# Deck Family Farm + Full Farm CSA – Platform Plan (Medusa + React)

**Goal:** Replace/augment LocalLine with a custom CSA commerce + subscription-credit platform that supports: member subscriptions (monthly credits), herdshare fee + credit-back, credit adjustments (jar returns, missing product), member dashboards & preferences, admin inventory/pricing, customer-type filtering (guest / member / SNAP), delivery zone polygons, Stripe subscriptions + card-on-file, and a staged migration with a pilot cohort.

---

## 1) Product framing

### Primary user roles

* **Guest**: browse and purchase eligible products only.
* **Member**: pays monthly subscription → receives store credits; can optionally draw on card-on-file beyond credits.
* **SNAP Member**: like member, but product eligibility is constrained to SNAP-eligible catalog, with optional card payment for non-SNAP items.
* **CSA Manager / Admin**: manages products, pricing, inventory, fulfillment reports, credits, member feedback.

### Key concepts (confirmed rules)

* **Subscription credits**: member contributes **$200 / $300 / $500 per month**; credits are added to a wallet.
* **Credit rollover**: **credits roll over forever** (no expiration).
* **Leaving the CSA**: member may **donate remaining credits** to a **Feed-a-Friend** program wallet/account used to subsidize low-income accounts.
* **Herdshare pair** (per active member/month):

  * Charge **$5/month** labeled “Herdshare fee”.
  * Add **$5/month** back as “Member dividend credit” (net $0 impact to member’s wallet balance, but tracked as two ledger entries for audit/legal clarity).
* **Jar deposits**: **per-jar refundable deposits** tracked via the ledger (deposit charged at sale; returned as credit when jar is returned).
* **Credit adjustments**: admin can apply credits with a **credit type** (Jar Return, Missing Product, Goodwill, Manual Correction), with notes and optional attachments.
* **Order settlement**:

  * Primary: spend wallet credits.
  * If wallet insufficient AND member is active: **prompt at checkout** to charge remainder to card.
  * Member setting: **auto-charge remainder** (if enabled, charge card automatically when credits run short).
* **SNAP tender splitting**:

  * SNAP wallet funds (or SNAP-designated credits) can apply **only** to SNAP-eligible products.
  * Allow optional **card payment** for non-SNAP items in the same cart (tender split at checkout).

---

## 2) Recommended architecture (high-level)

### Backend

* **Medusa** (as core commerce engine): products, carts, orders, fulfillment, customers.
* **Custom modules/services** layered on Medusa:

  1. **Wallet & Ledger module** (credits + debits, types, audit, monthly posting).
  2. **Subscription module** (plan enrollment, proration rules, active status).
  3. **Eligibility module** (guest/member/SNAP filtering + per-product rules).
  4. **Vendor module** (vendor ownership, vendor pricing, vendor reports per order cycle).
  5. **Catalog module** (categories, tags, sale flags, images, visibility).
  6. **Inventory module** (stock-tracked vs always-available, reservations).
  7. **Delivery scheduling module** (drop-sites, delivery days, configurable order windows).
  8. **Delivery zones module** (polygon-based delivery area, eligibility checks).
  9. **Member preferences + feedback module** (pickup preferences, delivery instructions, feedback inbox).
  10. **LocalLine Bridge module** (pilot-stage sync + combined fulfillment reports).

### Frontend

* **React + Vite**

  * **Storefront**: guest + member shopping experience.
  * **Member portal**: wallet, subscription, order history, preferences, feedback.
  * **Admin portal**: vendors, product/inventory/pricing, credits ledger, order cycles, fulfillment.

### Infrastructure & deployment

* Node.js services deployed with **PM2** behind Nginx.
* **Timezone:** all business rules use **America/Los_Angeles (Pacific Time)**.
* Background jobs (cron/worker) for:

  * monthly credit posting
  * order-cycle open/close automation
  * vendor report generation + email
  * nightly LocalLine sync (pilot)
  * fulfillment report generation

## 3) Data model (conceptual schema) (conceptual schema)

> This is **conceptual** (not tied to a specific DB yet). It’s the shape your future DB schema should support.

### Accounts & roles

* **User**: id, email, password_hash (or SSO), role (admin/manager/member), created_at
* **Customer** (Medusa customer): id, name, email, phone
* **MemberProfile**: customer_id, status (active/paused/canceled), customer_type (guest/member/snap), snap_id_optional, notes

### Subscription & billing

* **SubscriptionPlan**: id, name, monthly_amount (200/300/500), posting_day (e.g., 1st), rules
* **Subscription**: id, customer_id, plan_id, status, start_date, end_date, stripe_subscription_id
* **PaymentProfile**: customer_id, stripe_customer_id, default_payment_method_id, allow_overage_charges (bool), auto_charge_remainder (bool)

### Wallet & ledger

* **Wallet**: id, customer_id, currency, balance_cached (optional), updated_at

* **LedgerEntry**:

  * id, wallet_id, created_at
  * amount (positive = credit, negative = debit)
  * type (enum):

    * SUBSCRIPTION_CREDIT
    * ORDER_DEBIT
    * HERDSHARE_FEE
    * HERDSHARE_DIVIDEND
    * JAR_DEPOSIT_CHARGE
    * JAR_DEPOSIT_RETURN
    * MISSING_PRODUCT
    * GOODWILL
    * MANUAL_ADJUSTMENT
    * DONATION_TO_FEED_A_FRIEND
  * reference_type (order/subscription/adjustment/jar_event/donation)
  * reference_id
  * memo, created_by_user_id

* **Feed-a-FriendProgram**: id, name, wallet_id (program wallet)

* **DonationRequest**: id, customer_id, program_id, amount, created_at, status

### Products, eligibility, pricing

* **Vendor**: id, name, contact_name, email_list, report_format, active
* **Product** (Medusa product) + **extensions**:

  * vendor_id (FK)
  * is_member_only (bool)
  * is_snap_eligible (bool)
  * guest_visible (bool)
  * is_on_sale (bool)
  * category tags (milk/meat/eggs/grains/veg/fruit)
  * jar_deposit_amount (money, optional)
  * visibility_status (enum): VISIBLE | HIDDEN | DRAFT
  * inventory_mode (enum): TRACK_STOCK | ALWAYS_AVAILABLE
  * stock_on_hand (int, nullable)
* **ProductMedia**:

  * id, product_id, url, alt_text, sort_order
  * is_primary (bool)
  * (rule: exactly one primary image when images exist; otherwise use a default placeholder image)
* **VendorPricing**:

  * id, product_id, vendor_id, vendor_unit_cost, effective_start, effective_end
* **SalesPricing**:

  * id, product_id, customer_type (guest/member/snap), sale_price, compare_at_price_optional, effective_start, effective_end
* **PriceList / Sale**: start/end dates, percent/amount, applies_to rules

Filtering requirements (storefront + admin):

* filter products by **vendor**, **category**, **on-sale**, **inventory status**, and **visibility**.

### Orders & fulfillment

* **Order** (Medusa): totals, line items

* **OrderLineItem** (Medusa) + extension:

  * vendor_id (denormalized for reporting)
  * vendor_unit_cost_snapshot
  * sale_price_snapshot

* **OrderPaymentSettlement**:

  * order_id
  * wallet_applied_amount
  * snap_wallet_applied_amount (optional)
  * stripe_charged_amount
  * stripe_payment_intent_id
  * tender_split_summary (json)

* **OrderCycle** (new, Pacific time):

  * id, name (e.g., “Tue Delivery – Week of …”)
  * opens_at_pt, closes_at_pt
  * fulfillment_day_pt, fulfillment_window_label
  * drop_site_ids (many-to-many)
  * status (scheduled/open/closed/fulfilled)

* **VendorCycleReport**:

  * id, vendor_id, order_cycle_id, generated_at
  * summary_json (quantities by product/variant)
  * emailed_to, email_status, attachments

* **FulfillmentBatch**: week/date, drop-site, status, generated_reports

### Drop-sites & delivery polygons

* **PickupLocation (DropSite)**: id, name, address, geo_point, pickup_days/times

* **DropSiteScheduleRule** (configurable, Pacific time):

  * id, drop_site_id
  * delivery_day (enum Mon..Sun)
  * window_opens (day_of_week + time)
  * window_closes (day_of_week + time)
  * fulfillment_window_label (e.g., “Saturday 9–1”)
  * example rules you described:

    * Saturday delivery: ordering open **Mon → Wed**
    * Tuesday delivery: ordering open **Fri → Sun**
  * (rule: engine derives concrete opens_at/ closes_at datetimes for each week)

* **DeliveryZone**: id, name, polygon_geojson, active

* **DeliveryEligibilityCheck**: customer_id, address_id, within_zone (bool), zone_id

### Member preferences & feedback

* **MemberPreference**: customer_id, default_pickup_location_id, delivery_instructions_text, packing_notes
* **MemberFeedback**: id, customer_id, created_at, category (quality/packing/site/billing/other), message, status (new/open/closed), assigned_to

### Reviews & recipes (new)

* **ProductReview**: id, product_id, customer_id, rating (1–5), title, body, created_at, status (pending/approved/rejected)
* **Recipe**: id, title, slug, body_markdown, created_at, status (draft/published)
* **RecipeProductLink**: recipe_id, product_id, notes (e.g., cut/variant), sort_order

---

## 4) API surface (what Codex can scaffold)

### Member-facing

* `GET /me` → profile, customer_type, subscription status
* `GET /me/wallet` → current balance + recent ledger entries
* `GET /me/orders` → order history
* `PUT /me/preferences` → pickup + delivery instructions
* `PUT /me/billing/settings` → auto-charge remainder toggle + payment method management
* `POST /me/feedback` → create feedback item
* `POST /me/donate` → donate remaining credits to Feed-a-Friend (when leaving, or anytime)

### Cart/checkout

* `POST /cart` / `POST /cart/items`
* `POST /checkout` → computes:

  * eligible products for this customer type
  * **SNAP eligibility per line item**
  * wallet spend + remainder
  * **tender split** (snap wallet → snap items; regular wallet → any; card → remainder/non-snap)
  * creates Stripe payment intent if needed

### Admin/manager

* `POST /admin/ledger/credit` → apply credit with type + memo
* `POST /admin/ledger/jar-return` → post jar deposit return(s)
* `POST /admin/products/:id/eligibility` → toggle member-only/snap flags
* `POST /admin/inventory/adjust`
* `GET /admin/fulfillment/batch/:week` → generate packlists + exports
* `GET /admin/feedback` → inbox, filters, assignment
* `POST /admin/reviews/:id/moderate` → approve/reject reviews
* `POST /admin/recipes` / `PUT /admin/recipes/:id` → manage recipes

### Jobs

* `POST /jobs/monthly-posting/run` (or scheduled)
* `POST /jobs/localline-sync/run` (pilot)

## 5) Feature-by-feature build plan (atomic slices)

### Phase 0 — Wireframes + prototype scaffolding (1–2 weeks)

**Deliverables:** clickable UI + fake data, routes, component library.

* Set up monorepo (or separate repos) with:

  * `apps/storefront` (React/Vite)
  * `apps/admin` (React/Vite)
  * `apps/api` (Medusa + custom modules)
* Add a **feature flag** system (env + server-driven) so you can enable modules per pilot group.
* Build “prototype mode” with:

  * mocked API responses (JSON fixtures)
  * Storybook (optional) for UI components

### Phase 1 — Commerce foundation

* Medusa configured for products, categories, carts, orders
* Auth (member login) + basic profile
* Admin product CRUD

### Phase 2 — Wallet + ledger (core)

* Implement Wallet + LedgerEntry tables/services
* Implement order debit posting from checkout
* Implement admin credit adjustments with type/memo
* Member portal: show balance + ledger history

### Phase 3 — Subscriptions + Stripe

* Stripe customer creation + payment method attach (card-on-file)
* Stripe subscription for $200/$300/$500 plans
* Monthly job: when Stripe invoice paid → post **SUBSCRIPTION_CREDIT** to wallet
* Checkout behavior:

  * default: **prompt** to charge remainder when wallet is short
  * setting: **auto-charge remainder** when enabled
* Herdshare logic (monthly):

  * post **HERDSHARE_FEE** as a charge line (Stripe line item OR internal ledger)
  * post **HERDSHARE_DIVIDEND** credit back
* Leaving / donation:

  * member can donate remaining wallet balance to **Feed-a-Friend** program (ledger transfer)

### Phase 4 — Customer type eligibility (guest/member/SNAP)

* Product flags + filtering rules
* Enforce at:

  * product listing
  * cart add
  * checkout
* SNAP tender splitting:

  * apply SNAP funds only to SNAP-eligible items
  * allow card for non-SNAP items (same cart)
    (guest/member/SNAP)
* Product flags + filtering rules
* Enforce at:

  * product listing
  * cart add
  * checkout

### Phase 5 — Member preferences + drop-sites + polygons

* Store pickup locations + UI selection
* Store delivery address + run point-in-polygon check
* Show eligibility result during signup and on profile

### Phase 6 — Fulfillment + reporting

* Generate pack lists by drop-site and date
* Exports compatible with your existing ops:

  * PDF packlists
  * CSV for labels, etc.

### Phase 6.5 — Recurring orders (auto-submit at cycle open)

**Decision (locked): Auto-submit recurring orders when the order cycle opens (Pacific time).**

* Members create a **recurring template**:

  * frequency (e.g., every Saturday cycle)
  * items + quantities (e.g., veggie box, jar of milk)
  * per-item out-of-stock policy (default: **skip item**)
* At cycle open:

  * system materializes templates into real orders for that cycle and **submits automatically**
  * applies eligibility rules (guest/member/SNAP)
  * applies wallet spend + remainder handling
* Payment rule for auto-submit:

  * require **auto-charge remainder enabled** OR define fallback behavior (default recommendation: if funds insufficient and auto-charge disabled → **skip placing** the recurring order and notify member)
* Notifications:

  * “Recurring order placed” summary
  * exceptions list if items skipped/reduced

### Phase 7 — Feedback loop

* Member feedback form
* Admin inbox: status, assignment, export

### Phase 8 — Reviews + recipes

* Product reviews:

  * members can review eligible products
  * admin moderation queue (approve/reject)
  * show rating summaries on product pages

* Recipes:

  * recipe library (publishable pages)
  * link recipes to products (e.g., “Lamb Roast” → “Lamb shoulder/leg”)
  * embed on product detail pages and searchable recipe index

* Member feedback form

* Admin inbox: status, assignment, export

---

## 6) Transition plan from LocalLine (pilot-first)

### A) Choose a pilot scope

* 10–30 members across 1–2 drop-sites.
* Limit to a subset of catalog first (e.g., eggs + meat + dairy), then expand.

### B) “Bridge period” strategy (recommended)

Run both systems in parallel while you validate member experience.

**Bridge components:**

1. **Member identity mapping**

   * Map LocalLine customer → new customer_id
   * Keep a crosswalk table (localline_customer_id, new_customer_id)
2. **Combined reporting layer (must-have)**

   * Adapt your existing Node-based LocalLine reporting scripts into a **Reporting Aggregator**:

     * Pull orders + line items from **LocalLine** for a cycle
     * Pull orders + line items from **New System** for the same cycle
     * Normalize into a shared “order item” shape
     * Produce *single* combined outputs:

       * vendor cycle emails (summaries by vendor)
       * drop-site packlists/labels
       * dairy/frozen splits (if you already do that)
3. **Catalog alignment during bridge**

   * Keep one “source of truth” per attribute during pilot:

     * Option 1: LocalLine is truth for products/prices → nightly sync to Medusa read-only
     * Option 2: New system is truth → push minimal updates into LocalLine (only if needed)
   * Use a **product crosswalk** table (localline_product_id, new_product_id) so combined reports can merge correctly.

### C) Migration milestones

1. **Pilot signups + wallet posting tested**
2. **Pilot ordering + combined fulfillment stable**
3. **Expand catalog + drop-sites**
4. **Cutover**: stop LocalLine subscriptions; keep a read-only export of historical orders

## 7) QA & audit requirements (important for credits + herdshare) & audit requirements (important for credits + herdshare)

* **Ledger is append-only**: never edit a ledger entry; create reversal entries.
* **Every wallet change has a reason**: type + reference + memo + actor.
* **Monthly reconciliation**:

  * Stripe paid invoices ↔ subscription credits posted
  * order totals ↔ wallet debits + Stripe charges
* **Permissions**:

  * only managers/admin can apply credits
  * only admins can change pricing rules

---

## 8) What Codex should build first (starter backlog)

### Repo scaffolding

* Monorepo with:

  * `apps/api`
  * `apps/storefront`
  * `apps/admin`
  * `packages/shared` (types, utils)
  * `apps/reporting` (new): combined LocalLine + New System reporting aggregator

### Minimal vertical slice (MVP)

1. Auth + member profile
2. Product browse with:

   * images (primary + gallery) + default placeholder
   * filtering (vendor, category, on-sale)
3. Vendor model + product vendor assignment
4. Inventory modes:

   * TRACK_STOCK vs ALWAYS_AVAILABLE
   * visibility toggle independent from stock
5. Wallet + ledger basics
6. Checkout that spends wallet credits (no Stripe overage yet)
7. Admin tool to apply a credit with type
8. Member dashboard: wallet + order history
9. Order cycles + drop-site schedule rules (configurable PT windows)
10. Reporting aggregator: pull/normalize and output combined vendor summary for a cycle

Once this is stable, add Stripe subscriptions + monthly posting + vendor report emailing.

## 9) Open decisions (kept small)

* Database: pick later; ensure the schema supports strong consistency + transactional ledger writes.
* Exact herdshare billing mechanics:

  * Should the $5 herdshare fee be a Stripe line item or internal ledger charge? (Either works; choose based on legal/accounting preference.)
* SNAP funding source:

  * Will SNAP be represented as a **separate wallet** (recommended) or a wallet balance partition?

## 10) Questions to answer before coding too deep

1. **Refund flow**: if an order is refunded, do you return credits, return to card, or both?
2. **Jar deposits**: deposit amount(s) per jar type—single amount or per product/container?
3. **Feed-a-Friend rules**: can members donate anytime or only on exit? Can admins allocate subsidies from program wallet?
4. **Reviews**: members-only reviews or allow guest reviews? (Recommendation: members-only + moderation.)
5. **Recipes**: who can publish (admins only) and do you want rich content (images/video) or markdown-only to start?
6. **Order cycles**: do you ever run *multiple* simultaneous cycles (e.g., Tue + Sat open at same time), and can a member place separate orders per cycle?
7. **Vendor costing**: is vendor cost always per unit, or sometimes % / weight-based / variable?
8. **Inventory**: do you need reservations (hold stock when in cart) or is decrement-on-checkout sufficient?

---

## 11) Next steps

* Edit this doc into your preferred terminology.
* Turn the MVP slice into a `TODO.md` backlog.
* Start wireframing pages:

  * Storefront home
  * Product list
  * Cart/checkout
  * Member dashboard (wallet + history)
  * Preferences
  * Admin credits panel
