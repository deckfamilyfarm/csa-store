import React, { useEffect, useRef } from "react";

const MANUAL_TOPICS = [
  { key: "overview", label: "Overview" },
  { key: "pricing", label: "Pricing Model" },
  { key: "formula", label: "Deck / Hyland / Creamy Cow" },
  { key: "sync", label: "Sync With Local Line" },
  { key: "workflow", label: "Daily Workflow" }
];

export function AdminManualSection({ focusTopic = "overview" }) {
  const sectionRefs = useRef({});

  function setSectionRef(topic) {
    return (node) => {
      sectionRefs.current[topic] = node;
    };
  }

  function scrollToTopic(topic) {
    const node = sectionRefs.current[topic];
    if (!node || typeof node.scrollIntoView !== "function") return;
    node.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  useEffect(() => {
    if (typeof window === "undefined" || !focusTopic) return undefined;
    const timer = window.setTimeout(() => {
      scrollToTopic(focusTopic);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusTopic]);

  return (
    <section className="admin-section admin-manual-section">
      <div className="admin-manual-hero">
        <div>
          <h3>Admin Manual</h3>
          <p>
            This page explains how the admin panel works in plain language. Use it as the reference
            for pricing, product setup, Local Line syncing, and the normal daily workflow.
          </p>
        </div>
        <div className="admin-manual-topic-links">
          {MANUAL_TOPICS.map((topic) => (
            <button
              key={topic.key}
              className="button alt"
              type="button"
              onClick={() => scrollToTopic(topic.key)}
            >
              {topic.label}
            </button>
          ))}
        </div>
      </div>

      <div className="admin-manual-summary-grid">
        <article className="card pad admin-manual-summary-card">
          <strong>Local system first</strong>
          <p>
            The admin panel is the local working system. Admins review and save pricing here before
            pushing approved changes to Local Line.
          </p>
        </article>
        <article className="card pad admin-manual-summary-card">
          <strong>Formula vendors stay local</strong>
          <p>
            Deck Family Farm, Hyland Processing, and Creamy Cow products use local source-pricing
            fields as the source of truth.
          </p>
        </article>
        <article className="card pad admin-manual-summary-card">
          <strong>Sync is deliberate</strong>
          <p>
            Pulling from Local Line and pushing to Local Line are separate actions. Remote changes
            are not treated as automatic authority for local pricing.
          </p>
        </article>
      </div>

      <article className="admin-manual-card" ref={setSectionRef("overview")}>
        <h4>What This Application Does</h4>
        <p>
          This application sits between the local CSA Store database and the Local Line store. It
          gives admins one place to manage products, local pricing rules, source-cost formulas,
          inventory-related settings, and Local Line sync decisions.
        </p>
        <p>
          The pricelist screen is the main pricing workspace. It shows the local rule values,
          previews calculated prices, tracks what still needs to be pushed to Local Line, and opens
          the full product editor when admins need to change descriptions, packages, images, or
          Local Line cache data.
        </p>
      </article>

      <article className="admin-manual-card" ref={setSectionRef("pricing")}>
        <h4>How Pricing Works</h4>
        <p>
          Every product has a local pricing profile. The app starts with a CSA Package Price and
          then applies price-list adjustments for each customer price list: Guest Basket, CSA
          Members, Herd Share Members, and SNAP.
        </p>
        <ul className="admin-manual-list">
          <li>For standard products, the CSA Package Price comes from the local package price.</li>
          <li>
            For formula-priced vendors, the CSA Package Price is calculated from the local Vendor
            Retail Price, the unit type, package quantity or weight, and the FFCSA Factor.
          </li>
          <li>
            The default markup for the price lists is now controlled from the <strong>Vendors</strong>
            section. Each vendor can have a single default Pricelist Markup %, and that markup is
            used across the customer price lists for that vendor&apos;s products.
          </li>
          <li>
            After the CSA Package Price is known, the app applies the vendor markup to calculate
            the customer-facing Adjusted Price.
          </li>
          <li>
            If a sale is active, the regular price is the current CSA Package Price plus markup,
            and the sale discount is then applied to that regular price to get the final sell
            price.
          </li>
        </ul>
        <p className="admin-manual-note">
          The Google pricing sheet now shows two different sale concepts on purpose.
          <strong> squareSalePrice</strong> is for the Square / farmers-market pricelist and is
          just the vendor retail price with the sale discount applied. By contrast,
          <strong> ffcsaMemberSalesPrice</strong> follows the FFCSA online-store formula using the
          FFCSA Factor, package quantity or weight, and the member markup.
        </p>
        <p className="admin-manual-note">
          The app also keeps a single CSA Package Price for remote sync. When you push to Local
          Line, that computed package price becomes the starting point for the remote FFCSA store
          pricing, and the price-list adjusted prices are built from there.
        </p>
      </article>

      <article className="admin-manual-card" ref={setSectionRef("formula")}>
        <h4>Deck Family Farm, Hyland, And Creamy Cow Pricing</h4>
        <p>
          Products from Deck Family Farm, Hyland Processing, and Creamy Cow use local formula
          pricing. These products should be maintained from the local source fields in the admin
          panel instead of treating Local Line prices as the authority.
        </p>
        <ul className="admin-manual-list">
          <li>
            <strong>Vendor defaults live in the Vendors tab.</strong> Set the vendor&apos;s default
            Pricelist Markup % there, and for Deck Family Farm, Hyland, and Creamy Cow also set the
            vendor&apos;s FFCSA Factor there.
          </li>
          <li>
            <strong>Vendor's Retail Price</strong> is the local retail price used for calculation.
          </li>
          <li>
            <strong>Vendor's Unit Type</strong> tells the app whether the retail price is per item or per
            pound.
          </li>
          <li>
            <strong>Avg Weight Override</strong> is used when the product is priced by weight and
            you want the app to use a specific average weight.
          </li>
          <li>
            <strong>FFCSA Factor</strong> is the portion of the vendor retail price that becomes the
            CSA base package price before markup.
          </li>
          <li>
            <strong>Vendor markup</strong> then creates the final customer-facing price from that
            CSA base package price.
          </li>
        </ul>
        <div className="admin-manual-callout">
          <strong>Deck / Hyland / Creamy pricing box</strong>
          <p>
            The product template&apos;s package <strong>Price</strong> field is the
            <strong> CSA Package Price</strong> for these vendors, and it is automatically
            calculated. Admins do not type a separate member sell price for them.
          </p>
          <ol className="admin-manual-list admin-manual-numbered">
            <li>
              Start with the local vendor unit price entered in
              <strong> Vendor's Retail Price</strong>.
            </li>
            <li>
              If the item is weight-based, the app uses <strong>Avg Weight Override</strong> when
              present. Otherwise it uses the average of <strong>Min Weight</strong> and <strong>Max
              Weight</strong>. If neither is set, it falls back to the package&apos;s stored average
              weight.
            </li>
            <li>
              The app multiplies that unit price by the package weight or quantity to get the
              package retail amount.
            </li>
            <li>
              The app then applies the <strong>FFCSA Factor</strong> to get the
              <strong> CSA Package Price</strong>.
            </li>
            <li>
              From that package price, the app applies the vendor&apos;s default
              <strong> Pricelist Markup %</strong> to get each price list&apos;s
              <strong> Adjusted Price</strong>.
            </li>
            <li>
              If a sale is active for a vendor that uses an FFCSA Factor, the app shares the sale
              cost with the vendor internally by lowering the CSA Package Price first, then applies
              the full sale discount to the regular marked-up price to get the customer-facing sale
              price.
            </li>
          </ol>
        </div>
        <p>
          If a package is priced by weight, the app uses the average weight to calculate its CSA
          Package Price. If a package is priced by count, the app uses the package quantity instead.
        </p>
        <p>
          In Local Line, the strikethrough price represents the regular non-sale sell price for the
          current CSA Package Price, and the live sale price reflects the reduced effective markup
          needed to reach the true final sale price.
        </p>
        <p>
          Products with <strong>deposit</strong> in the product name are special no-markup items.
          Even if they are Deck Family Farm products, their markups are forced to zero so the sell
          price stays equal to the calculated CSA Package Price.
        </p>
      </article>

      <article className="admin-manual-card" ref={setSectionRef("sync")}>
        <h4>How Syncing With Local Line Works</h4>
        <p>
          The local system and Local Line are connected, but they do not behave like two identical
          copies of the same database. This app intentionally keeps the pricing workflow under local
          admin review.
        </p>
        <ul className="admin-manual-list">
          <li>
            <strong>Pull From Local Line</strong> refreshes the local cache and can repair missing
            local products, packages, and supported local catalog fields.
          </li>
          <li>
            <strong>Review Local Line</strong> shows warnings, mismatches, and supported repair
            actions before local writes are approved.
          </li>
          <li>
            <strong>Apply Local Changes</strong> stores local pricing and product changes in this
            application only.
          </li>
          <li>
            <strong>Push To Local Line</strong> sends approved local product and pricing changes to
            the remote Local Line store.
          </li>
        </ul>
        <p>
          For Deck Family Farm, Hyland, and Creamy Cow products, local formula inputs remain the
          source of truth. Remote Local Line prices can be reviewed, but they should not silently
          overwrite the local source-pricing values.
        </p>
        <p className="admin-manual-note">
          When the app builds Local Line price-list entries, it preserves the existing Local Line
          adjustment style when available. If Local Line has no usable adjustment style yet, the app
          defaults to a percent-based adjustment.
        </p>
      </article>

      <article className="admin-manual-card" ref={setSectionRef("workflow")}>
        <h4>Recommended Daily Workflow</h4>
        <ol className="admin-manual-list admin-manual-numbered">
          <li>Open the pricelist and filter to the vendor or category you want to work on.</li>
          <li>
            Use <strong>Add Product</strong> for a new local item, or <strong>Duplicate</strong> to
            copy an existing item and adjust it.
          </li>
          <li>
            For Deck Family Farm, Hyland, and Creamy Cow items, fill in the Vendor's Retail Price
            fields and make sure the vendor&apos;s FFCSA Factor and Pricelist Markup % are correct in
            the <strong>Vendors</strong> section before saving so the CSA Package Price and adjusted prices can
            calculate correctly.
          </li>
          <li>Review the calculated prices and any sale settings.</li>
          <li>Save local changes first.</li>
          <li>Push to Local Line only after the local values look correct.</li>
          <li>
            If there is a question about remote data, run a review or pull from Local Line instead
            of manually guessing what changed.
          </li>
        </ol>
      </article>
    </section>
  );
}
