import React, { useMemo, useState } from "react";
import { submitSubscribeLead } from "../api.js";

const DELIVERY_MAP_URL =
  "https://berkeleymapper.berkeley.edu/index.html?tabfile=https://raw.githubusercontent.com/jdeck88/ffcsa_scripts/refs/heads/main/localline/data/delivery_data.tsv&configfile=https://raw.githubusercontent.com/jdeck88/ffcsa_scripts/refs/heads/main/dropsite_maps/dropsites2.xml&pointDisplay=markers&hideLegendItems=true";

const SUBSCRIBE_NAV_LINKS = [
  {
    label: "Our Farm",
    children: [
      { label: "About", href: "https://www.deckfamilyfarm.com/the-farm" },
      { label: "Our Farmily", href: "https://www.deckfamilyfarm.com/the-farmily" },
      { label: "Education", href: "https://www.deckfamilyfarm.com/intern-program" },
      { label: "Farm Dogs", href: "https://www.deckfamilyfarm.com/dogs" }
    ]
  },
  {
    label: "Full Farm CSA",
    children: [
      { label: "Subscribe", href: "https://www.deckfamilyfarm.com/subscribe" },
      { label: "Plans", href: "https://www.deckfamilyfarm.com/subscribe#plans" },
      { label: "Locations", href: "https://www.deckfamilyfarm.com/subscribe#locations" }
    ]
  },
  {
    label: "Newsletter",
    href: "https://www.deckfamilyfarm.com/newsletter"
  },
  {
    label: "Events",
    href: "https://www.deckfamilyfarm.com/events"
  },
  {
    label: "Shop",
    children: [
      { label: "CSA Shopping", href: "https://fullfarmcsa.deckfamilyfarm.com/" },
      { label: "Merchandise", href: "https://www.deckfamilyfarm.com/merchandise" }
    ]
  }
];

const SUBSCRIBE_PLANS = [
  {
    value: "guest",
    title: "Guest",
    price: "Check out",
    note: "No minimum purchase",
    bullets: [
      "Pay in cart with credit card each time you shop",
      "No access to Herdshare",
      "Prices are 15% higher than membership",
      "No joining fee"
    ]
  },
  {
    value: "forager",
    title: "The Forager",
    price: "$200/month",
    note: "Minimum purchase",
    featured: false,
    bullets: [
      "Loads $200 balance each month to spend on your individualized choice of farm products",
      "$200 minimum purchase, unused funds roll over",
      "15% discount on all products",
      "5% discount at Deck Family Farm farmers market booth",
      "Access to raw dairy",
      "One-time $50 joining fee"
    ]
  },
  {
    value: "grazer",
    title: "The Grazer",
    price: "$300/month",
    note: "Most popular",
    featured: true,
    bullets: [
      "Loads $300 balance each month to spend on your individualized choice of farm products",
      "$300 minimum purchase, unused funds roll over",
      "15% discount on all products",
      "5% discount at Deck Family Farm farmers market booth",
      "Access to raw dairy",
      "One-time $50 joining fee",
      "Free Deck Family Farm tote bag and t-shirt"
    ]
  },
  {
    value: "harvester",
    title: "The Harvester",
    price: "$500/month",
    note: "Best for stocking up",
    featured: false,
    bullets: [
      "Loads $500 balance each month to spend on your individualized choice of farm products",
      "$500 minimum purchase, unused funds roll over",
      "15% discount on all products",
      "5% discount at Deck Family Farm farmers market booth",
      "Access to raw dairy",
      "One-time $50 joining fee",
      "Free Deck Family Farm tote bag and t-shirt",
      "Half-price home delivery in Corvallis, Junction City, Eugene, and Springfield"
    ]
  }
];

const TESTIMONIALS = [
  {
    author: "K. Green",
    quote:
      "Thank you and your farmers for everything. We love being members and will always support local, responsible farms."
  },
  {
    author: "N. Mac",
    quote:
      "Thank you all for your continued excellence and high quality amazing food. We greatly appreciate your hard work and dedication."
  },
  {
    author: "K. Kohler",
    quote:
      "I love the subscription model, especially when you can shop for protein. It's like free money to splurge on great food."
  }
];

const FAQS = [
  {
    question: "Do I need to be home for home delivery?",
    answer:
      "No. You will receive an automated text from our delivery driver with an estimated delivery time, and we recommend bringing perishables inside promptly."
  },
  {
    question: "How often do I have to order?",
    answer:
      "One of the great things about FFCSA is the flexibility. You are welcome to place orders weekly, bi-weekly, or monthly."
  },
  {
    question: "What happens if I don’t use all of my funds in one month?",
    answer: "Unused funds roll over into the next month."
  },
  {
    question: "Is there a time commitment to being a member?",
    answer: "We kindly ask all members to agree to a minimum six-month commitment."
  },
  {
    question: "Can I get a refund if I cancel?",
    answer:
      "Unfortunately, no refunds are available upon cancellation. You are welcome to continue ordering until any remaining balance is used."
  },
  {
    question: "What if I miss the order window?",
    answer:
      "We know life gets busy, but unfortunately we cannot accommodate late or missed orders."
  }
];

const PARTNERS = [
  {
    name: "Deck Family Farm",
    description: "Pasture-raised meats, eggs, and regenerative agriculture from Junction City."
  },
  {
    name: "Creamy Cow, LLC",
    description: "Raw dairy, butter, sour cream, and cheeses connected to the herdshare program."
  },
  {
    name: "Grazier's Garden",
    description: "Hyper-local produce grown with shared standards around natural cycles and stewardship."
  },
  {
    name: "Hyland Artisanal Meats",
    description: "Carefully crafted meats that fit the same local, values-driven food system."
  },
  {
    name: "Little Wings",
    description: "Sustainable local produce supporting the pasture-raised and organic storefront mix."
  },
  {
    name: "Lonesome Whistle",
    description: "Organic grains and legumes grown regionally for staple pantry items."
  },
  {
    name: "River Ranch Oregon Olive Oil",
    description: "Premium Oregon olive oil produced with the same regional sourcing ethos."
  },
  {
    name: "Creole Me Up",
    description: "Creole-inspired sauces and seasonings that add ready-to-cook flavor options."
  },
  {
    name: "Reality Kitchen Bakery",
    description: "Locally made baked goods and pantry pairings for full-week meal planning."
  },
  {
    name: "Small Is Beautiful Farm",
    description:
      "A small-scale diversified farm using organic and biodynamic practices with on-site fertility."
  },
  {
    name: "Red Tail Organics",
    description: "Regional produce and pantry diversity that complements the farm's staple offerings."
  },
  {
    name: "Camas Country Mill / Camas Swale Farm",
    description: "Regional grains and milling that round out the broader Full Farm CSA pantry."
  }
];

function storeUrlFallback() {
  return "https://store.deckfamilyfarm.com";
}

function buildInitialForm(dropSites = []) {
  return {
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    country: "United States",
    addressLine1: "",
    addressLine2: "",
    city: "",
    stateProvince: "Oregon",
    postalCode: "",
    referralSource: "",
    selectedPlan: "grazer",
    selectedDropSite: dropSites[0] || "",
    notes: ""
  };
}

function isVisibleSubscribeDropSite(site) {
  const name = String(site?.name || "").toLowerCase();
  if (!name) return false;
  if (
    name.includes("membership purchase") ||
    name.includes("herdshare purchase") ||
    name.includes("snap fulfillment membership")
  ) {
    return false;
  }
  return true;
}

function formatDropSiteWindow(site) {
  const openTime = String(site?.openTime || "").trim();
  const closeTime = String(site?.closeTime || "").trim();
  if (!openTime && !closeTime) return "";
  return [openTime, closeTime].filter(Boolean).join(" - ");
}

function formatDropSiteAddress(site) {
  return String(site?.address || "").trim();
}

export function SubscribePage({ dropSites = [], storeUrl }) {
  const siteOptions = useMemo(
    () =>
      dropSites
        .filter((site) => isVisibleSubscribeDropSite(site))
        .map((site) => site.name)
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right)),
    [dropSites]
  );
  const visibleDropSites = useMemo(
    () => dropSites.filter((site) => isVisibleSubscribeDropSite(site)),
    [dropSites]
  );
  const homeDeliverySites = useMemo(
    () =>
      visibleDropSites
        .filter(
          (site) =>
            String(site.fulfillmentType || "").toLowerCase() === "delivery" ||
            String(site.type || "").toLowerCase() === "postalcodes" ||
            String(site.name || "").toLowerCase().includes("home delivery")
        )
        .sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""))),
    [visibleDropSites]
  );
  const pickupDropSites = useMemo(
    () =>
      visibleDropSites.filter(
        (site) =>
          !(
            String(site.fulfillmentType || "").toLowerCase() === "delivery" ||
            String(site.type || "").toLowerCase() === "postalcodes" ||
            String(site.name || "").toLowerCase().includes("home delivery")
          )
      ),
    [visibleDropSites]
  );
  const tuesdayDropSites = useMemo(
    () =>
      pickupDropSites
        .filter((site) => String(site.dayOfWeek || "").toLowerCase() === "tue")
        .sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""))),
    [pickupDropSites]
  );
  const saturdayDropSites = useMemo(
    () =>
      pickupDropSites
        .filter((site) => String(site.dayOfWeek || "").toLowerCase() === "sat")
        .sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""))),
    [pickupDropSites]
  );
  const fridayDropSites = useMemo(
    () =>
      pickupDropSites
        .filter((site) => String(site.dayOfWeek || "").toLowerCase() === "fri")
        .sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""))),
    [pickupDropSites]
  );
  const [form, setForm] = useState(() => buildInitialForm(siteOptions));
  const [status, setStatus] = useState({ submitting: false, success: false, error: "" });

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus({ submitting: true, success: false, error: "" });
    try {
      const plan = SUBSCRIBE_PLANS.find((entry) => entry.value === form.selectedPlan);
      await submitSubscribeLead({
        ...form,
        selectedPlanLabel: plan?.title || form.selectedPlan,
        sourceHost: window.location.host,
        sourcePath: window.location.pathname,
        queryString: window.location.search
      });
      setStatus({ submitting: false, success: true, error: "" });
    } catch (error) {
      setStatus({
        submitting: false,
        success: false,
        error: error?.message || "Unable to submit your information right now."
      });
    }
  }

  return (
    <div className="subscribe-page">
      <header className="subscribe-header">
        <div className="container subscribe-header-row">
          <a className="subscribe-wordmark" href="https://www.deckfamilyfarm.com">
            <img
              className="subscribe-wordmark-logo"
              src="/images/subscribe-logo.avif"
              alt="Deck Family Farm logo"
            />
          </a>
          <nav className="subscribe-nav">
            {SUBSCRIBE_NAV_LINKS.map((link) =>
              Array.isArray(link.children) ? (
                <div key={link.label} className="subscribe-nav-group">
                  <span className="subscribe-nav-group-title">{link.label}</span>
                  <div className="subscribe-nav-group-links">
                    {link.children.map((child) => (
                      <a key={child.href} href={child.href === storeUrlFallback() ? storeUrl : child.href}>
                        {child.label}
                      </a>
                    ))}
                  </div>
                </div>
              ) : (
                <a key={link.href} className="subscribe-nav-single" href={link.href}>
                  {link.label}
                </a>
              )
            )}
          </nav>
        </div>
      </header>

      <main>
        <section className="subscribe-hero">
          <div className="container subscribe-hero-grid">
            <div className="subscribe-hero-copy">
              <div className="eyebrow">Deck Family Farm</div>
              <h1 className="subscribe-title">Welcome to Full Farm CSA</h1>
              <div className="subscribe-hero-subtitle">
                Nourishing our community with pasture-raised foods and local farm partners
              </div>
              <p className="subscribe-lede">
                The Full Farm CSA program provides essential staples from Deck Family Farm and other
                hyper-local farms with shared growing standards. Members shop online for pickup at
                local markets, drop sites, and home delivery.
              </p>
              <p className="subscribe-lede">
                Membership includes a scheduled monthly payment: 100% of that payment becomes store
                credit, unused balances roll forward, and members gain access to raw dairy through
                the herdshare agreement.
              </p>
              <div className="subscribe-hero-notes">
                <div className="subscribe-note-card">
                  <strong>$50 one-time membership fee</strong>
                  <span>Includes herdshare agreement and access to raw dairy products.</span>
                </div>
                <div className="subscribe-note-card">
                  <strong>After submitting</strong>
                  <span>We will capture your information locally and you can continue into the store.</span>
                </div>
              </div>
            </div>

            <div className="subscribe-form-card card">
              <div className="eyebrow">Get started</div>
              <h2 className="h2">Personal information</h2>
              <p className="small">
                First, give us your name, email, phone number, address, and preferred plan.
              </p>

              {status.success ? (
                <div className="subscribe-success">
                  <h3>Thanks for your interest.</h3>
                  <p>
                    We recorded your subscription request. You can now continue to the store or wait
                    for follow-up from the farm.
                  </p>
                  <div className="button-row">
                    <a className="button" href={storeUrl}>
                      Continue to store
                    </a>
                    <button
                      className="button alt"
                      type="button"
                      onClick={() => {
                        setForm(buildInitialForm(siteOptions));
                        setStatus({ submitting: false, success: false, error: "" });
                      }}
                    >
                      Submit another
                    </button>
                  </div>
                </div>
              ) : (
                <form className="subscribe-form" onSubmit={handleSubmit}>
                  <div className="subscribe-form-grid">
                    <label className="filter-field">
                      <span className="small">First name*</span>
                      <input
                        className="input"
                        value={form.firstName}
                        onChange={(event) => updateField("firstName", event.target.value)}
                        required
                      />
                    </label>
                    <label className="filter-field">
                      <span className="small">Last name*</span>
                      <input
                        className="input"
                        value={form.lastName}
                        onChange={(event) => updateField("lastName", event.target.value)}
                        required
                      />
                    </label>
                    <label className="filter-field">
                      <span className="small">Email*</span>
                      <input
                        className="input"
                        type="email"
                        value={form.email}
                        onChange={(event) => updateField("email", event.target.value)}
                        required
                      />
                    </label>
                    <label className="filter-field">
                      <span className="small">Phone</span>
                      <input
                        className="input"
                        value={form.phone}
                        onChange={(event) => updateField("phone", event.target.value)}
                      />
                    </label>
                  </div>

                  <label className="filter-field">
                    <span className="small">Address</span>
                    <input
                      className="input"
                      value={form.addressLine1}
                      onChange={(event) => updateField("addressLine1", event.target.value)}
                    />
                  </label>
                  <label className="filter-field">
                    <span className="small">Address line 2</span>
                    <input
                      className="input"
                      value={form.addressLine2}
                      onChange={(event) => updateField("addressLine2", event.target.value)}
                    />
                  </label>

                  <div className="subscribe-form-grid subscribe-form-grid-3">
                    <label className="filter-field">
                      <span className="small">City</span>
                      <input
                        className="input"
                        value={form.city}
                        onChange={(event) => updateField("city", event.target.value)}
                      />
                    </label>
                    <label className="filter-field">
                      <span className="small">State</span>
                      <input
                        className="input"
                        value={form.stateProvince}
                        onChange={(event) => updateField("stateProvince", event.target.value)}
                      />
                    </label>
                    <label className="filter-field">
                      <span className="small">Zip / Postal code</span>
                      <input
                        className="input"
                        value={form.postalCode}
                        onChange={(event) => updateField("postalCode", event.target.value)}
                      />
                    </label>
                  </div>

                  <div className="subscribe-form-grid">
                    <label className="filter-field">
                      <span className="small">Plan</span>
                      <select
                        className="select"
                        value={form.selectedPlan}
                        onChange={(event) => updateField("selectedPlan", event.target.value)}
                      >
                        {SUBSCRIBE_PLANS.map((plan) => (
                          <option key={plan.value} value={plan.value}>
                            {plan.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="filter-field">
                      <span className="small">Preferred pickup / delivery site</span>
                      <select
                        className="select"
                        value={form.selectedDropSite}
                        onChange={(event) => updateField("selectedDropSite", event.target.value)}
                      >
                        <option value="">Not sure yet</option>
                        {siteOptions.map((siteName) => (
                          <option key={siteName} value={siteName}>
                            {siteName}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label className="filter-field">
                    <span className="small">Where did you hear about Full Farm CSA?</span>
                    <input
                      className="input"
                      value={form.referralSource}
                      onChange={(event) => updateField("referralSource", event.target.value)}
                    />
                  </label>

                  <label className="filter-field">
                    <span className="small">Anything else we should know?</span>
                    <textarea
                      className="textarea"
                      value={form.notes}
                      onChange={(event) => updateField("notes", event.target.value)}
                    />
                  </label>

                  {status.error ? <div className="small subscribe-error">{status.error}</div> : null}

                  <div className="button-row">
                    <button className="button" type="submit" disabled={status.submitting}>
                      {status.submitting ? "Submitting..." : "Submit subscription request"}
                    </button>
                    <a className="button alt" href="#plans">
                      Review plans
                    </a>
                  </div>
                </form>
              )}
            </div>
          </div>
        </section>

        <section className="section subscribe-proof">
          <div className="container">
            <div className="subscribe-section-head subscribe-section-head-centered">
              <div className="eyebrow">What people say</div>
              <h2 className="h2">Member feedback</h2>
            </div>
            <div className="subscribe-proof-grid">
              {TESTIMONIALS.map((testimonial) => (
                <article key={testimonial.author} className="card subscribe-quote-card">
                  <p>{testimonial.quote}</p>
                  <strong>{testimonial.author}</strong>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="plans">
          <div className="container">
            <div className="subscribe-section-head">
              <div className="eyebrow">Subscription plans</div>
              <h2 className="h2">Choose the plan that fits your table</h2>
            </div>
            <div className="subscribe-plan-grid">
              {SUBSCRIBE_PLANS.map((plan) => (
                <article
                  key={plan.value}
                  className={`card subscribe-plan-card${plan.featured ? " featured" : ""}`}
                >
                  <div className="subscribe-plan-topline">
                    <span className="subscribe-plan-title">{plan.title}</span>
                    {plan.featured ? <span className="subscribe-plan-badge">Most popular</span> : null}
                  </div>
                  <div className="subscribe-plan-price">{plan.price}</div>
                  <div className="small subscribe-plan-note">{plan.note}</div>
                  <ul className="subscribe-plan-list">
                    {plan.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section subscribe-location-section" id="locations">
          <div className="container subscribe-location-grid">
            <div>
              <div className="subscribe-section-head">
                <div className="eyebrow">Locations</div>
                <h2 className="h2">Pickup sites, home delivery, and order days</h2>
              </div>
              <div className="subscribe-location-copy">
                <h3>Home Delivery</h3>
                <p className="lede">
                  There is a $20 fee for home delivery with free delivery for orders over $125. See
                  map for delivery area. Eugene, Springfield, and Junction City deliveries happen on
                  Tuesdays and Corvallis deliveries happen on Saturdays.
                </p>
                {homeDeliverySites.length ? (
                  <div className="subscribe-delivery-list">
                    {homeDeliverySites.map((site) => (
                      <div key={site.id || site.name} className="card subscribe-delivery-card">
                        <strong>{site.name}</strong>
                        <span>{String(site.dayOfWeek || "").toUpperCase()}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <h3>Drop Sites (Free)</h3>
                <p className="lede">
                  Drop site locations and days are listed below. All dropsite deliveries are free.
                  You can choose your preferred dropsite location when placing your order.
                </p>
              </div>
              <div className="button-row">
                <a className="button" href={DELIVERY_MAP_URL} target="_blank" rel="noreferrer">
                  See delivery map
                </a>
                <a className="button alt" href={storeUrl}>
                  Visit the store
                </a>
              </div>
            </div>
            <div className="subscribe-drop-site-groups">
              {tuesdayDropSites.length ? (
                <section className="card subscribe-drop-site-group">
                  <h3>Tuesday Dropsites</h3>
                  <p>Order window Thursday through Sunday</p>
                  <div className="subscribe-drop-site-list">
                    {tuesdayDropSites.map((site) => (
                      <article key={site.id || site.name} className="subscribe-drop-site-item">
                        <strong>{site.name}</strong>
                        {formatDropSiteWindow(site) ? <span>{formatDropSiteWindow(site)}</span> : null}
                        {formatDropSiteAddress(site) ? <small>{formatDropSiteAddress(site)}</small> : null}
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
              {saturdayDropSites.length ? (
                <section className="card subscribe-drop-site-group">
                  <h3>Saturday Dropsites</h3>
                  <p>Order window Monday through Wednesday</p>
                  <div className="subscribe-drop-site-list">
                    {saturdayDropSites.map((site) => (
                      <article key={site.id || site.name} className="subscribe-drop-site-item">
                        <strong>{site.name}</strong>
                        {formatDropSiteWindow(site) ? <span>{formatDropSiteWindow(site)}</span> : null}
                        {formatDropSiteAddress(site) ? <small>{formatDropSiteAddress(site)}</small> : null}
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
              {fridayDropSites.length ? (
                <section className="card subscribe-drop-site-group">
                  <h3>Friday Dropsites</h3>
                  <p>Order window Tuesday through Thursday</p>
                  <div className="subscribe-drop-site-list">
                    {fridayDropSites.map((site) => (
                      <article key={site.id || site.name} className="subscribe-drop-site-item">
                        <strong>{site.name}</strong>
                        {formatDropSiteWindow(site) ? <span>{formatDropSiteWindow(site)}</span> : null}
                        {formatDropSiteAddress(site) ? <small>{formatDropSiteAddress(site)}</small> : null}
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        </section>

        <section className="section subscribe-partners-section">
          <div className="container">
            <div className="subscribe-section-head">
              <div className="eyebrow">Meet our partners</div>
              <h2 className="h2">Hyper-local farms and food makers</h2>
            </div>
            <p className="lede">
              All products are grown, raised, or crafted within roughly 100 miles of the farm in
              Junction City, with shared standards around regenerative practices, natural cycles,
              and careful stewardship.
            </p>
            <div className="subscribe-partner-grid">
              {PARTNERS.map((partner) => (
                <article key={partner.name} className="card subscribe-partner-card">
                  <div className="subscribe-partner-crest" aria-hidden="true">
                    {partner.name.slice(0, 1)}
                  </div>
                  <div className="subscribe-partner-card-name">{partner.name}</div>
                  <p>{partner.description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section subscribe-faq-section" id="faqs">
          <div className="container">
            <div className="subscribe-section-head">
              <div className="eyebrow">Frequently asked questions</div>
              <h2 className="h2">How membership works</h2>
            </div>
            <div className="subscribe-faq-list">
              {FAQS.map((faq) => (
                <details key={faq.question} className="card subscribe-faq-item">
                  <summary>{faq.question}</summary>
                  <p>{faq.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="subscribe-footer">
        <div className="container subscribe-footer-row">
          <div>
            <strong>Deck Family Farm</strong>
            <div className="small">Full Farm CSA is the CSA arm of Deck Family Farm.</div>
          </div>
          <div className="button-row">
            <a className="button alt" href="https://www.deckfamilyfarm.com">
              Main site
            </a>
            <a className="button" href={storeUrl}>
              Store
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
