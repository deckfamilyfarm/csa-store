import React, { useEffect, useMemo, useRef, useState } from "react";
import { fetchSubscribeAddressInsights, submitSubscribeLead } from "../api.js";

const DELIVERY_MAP_URL =
  "https://berkeleymapper.berkeley.edu/index.html?tabfile=https://raw.githubusercontent.com/jdeck88/ffcsa_scripts/refs/heads/main/localline/data/delivery_data.tsv&configfile=https://raw.githubusercontent.com/jdeck88/ffcsa_scripts/refs/heads/main/dropsite_maps/dropsites2.xml&pointDisplay=markers&hideLegendItems=true";
const LIABILITY_AGREEMENT_URL =
  "https://docs.google.com/document/d/1VFMc4euofQ1S1kjtd6jZI46uxo6YKft9cufT6Q3-nrc/edit?tab=t.0";

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
    title: "Forager ($200/mo)",
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
    title: "Grazer ($300/mo)",
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
    title: "Harvester ($500/mo)",
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
  return "https://fullfarmcsa.deckfamilyfarm.com/";
}

function subscriptionStoreUrl() {
  return "https://fullfarmcsa.deckfamilyfarm.com/";
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
    selectedPlan: "forager",
    selectedDropSite: dropSites[0] || "",
    notes: "",
    liabilityAgreementAccepted: false,
    liabilityAgreementSignerName: "",
    liabilityAgreementSignatureMode: "draw"
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

function formatDayOfWeekLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "mon") return "Monday";
  if (normalized === "tue") return "Tuesday";
  if (normalized === "wed") return "Wednesday";
  if (normalized === "thu") return "Thursday";
  if (normalized === "fri") return "Friday";
  if (normalized === "sat") return "Saturday";
  if (normalized === "sun") return "Sunday";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function DropSiteTable({ title, orderWindow, sites = [] }) {
  if (!sites.length) return null;
  return (
    <section className="card subscribe-drop-site-table-card">
      <h3>
        {title} <span>({orderWindow})</span>
      </h3>
      <div className="subscribe-drop-site-table-shell">
        <table className="subscribe-drop-site-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Time of Day</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => (
              <tr key={site.id || site.name}>
                <td>{site.name}</td>
                <td>{formatDropSiteWindow(site) || "—"}</td>
                <td>{formatDropSiteAddress(site) || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
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
  const preferredHomeDeliverySite = homeDeliverySites[0] || null;
  const [form, setForm] = useState(() => buildInitialForm(siteOptions));
  const [status, setStatus] = useState({ submitting: false, success: false, error: "" });
  const [agreementModalOpen, setAgreementModalOpen] = useState(false);
  const [agreementSaved, setAgreementSaved] = useState(false);
  const [signaturePresent, setSignaturePresent] = useState(false);
  const [addressInsights, setAddressInsights] = useState(null);
  const [addressCheckError, setAddressCheckError] = useState("");
  const [checkingAddress, setCheckingAddress] = useState(false);
  const signatureCanvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef(null);
  const formStatusRef = useRef(null);

  useEffect(() => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#1e2d3b";
    context.lineWidth = 2.2;
  }, [agreementModalOpen]);

  function updateField(key, value) {
    if (
      key === "addressLine1" ||
      key === "addressLine2" ||
      key === "city" ||
      key === "stateProvince" ||
      key === "postalCode" ||
      key === "country"
    ) {
      setAddressInsights(null);
      setAddressCheckError("");
    }
    if (
      key === "liabilityAgreementAccepted" ||
      key === "liabilityAgreementSignerName" ||
      key === "liabilityAgreementSignatureMode"
    ) {
      setAgreementSaved(false);
      if (key === "liabilityAgreementSignatureMode" && value === "typed") {
        clearSignature();
      }
    }
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setPreferredDropSite(siteName) {
    setForm((prev) => ({
      ...prev,
      selectedDropSite: siteName || ""
    }));
  }

  async function handleCheckAddress() {
    setCheckingAddress(true);
    setAddressCheckError("");
    try {
      const response = await fetchSubscribeAddressInsights({
        addressLine1: form.addressLine1,
        addressLine2: form.addressLine2,
        city: form.city,
        stateProvince: form.stateProvince,
        postalCode: form.postalCode,
        country: form.country
      });
      setAddressInsights(response?.insights || null);
    } catch (error) {
      setAddressInsights(null);
      setAddressCheckError(error?.message || "Unable to validate address right now.");
    } finally {
      setCheckingAddress(false);
    }
  }

  function canvasPointFromEvent(event) {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const clientX = "touches" in event ? event.touches?.[0]?.clientX : event.clientX;
    const clientY = "touches" in event ? event.touches?.[0]?.clientY : event.clientY;
    if (typeof clientX !== "number" || typeof clientY !== "number") return null;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  function startSignature(event) {
    const canvas = signatureCanvasRef.current;
    const point = canvasPointFromEvent(event);
    if (!canvas || !point) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    drawingRef.current = true;
    lastPointRef.current = point;
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.lineTo(point.x + 0.01, point.y + 0.01);
    context.stroke();
    setSignaturePresent(true);
  }

  function drawSignature(event) {
    if (!drawingRef.current) return;
    const canvas = signatureCanvasRef.current;
    const point = canvasPointFromEvent(event);
    if (!canvas || !point) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const previous = lastPointRef.current || point;
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    lastPointRef.current = point;
    setSignaturePresent(true);
  }

  function endSignature() {
    drawingRef.current = false;
    lastPointRef.current = null;
  }

  function clearSignature() {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    setSignaturePresent(false);
    setAgreementSaved(false);
  }

  function handleSaveAgreement() {
    if (!form.liabilityAgreementAccepted) {
      setStatus({
        submitting: false,
        success: false,
        error: "You must agree to the product liability agreement."
      });
      return;
    }
    if (!form.liabilityAgreementSignerName.trim()) {
      setStatus({
        submitting: false,
        success: false,
        error: "Enter the signer name for the product liability agreement."
      });
      return;
    }
    if (form.liabilityAgreementSignatureMode === "draw" && !signaturePresent) {
      setStatus({
        submitting: false,
        success: false,
        error: "Please provide a drawn signature for the product liability agreement."
      });
      return;
    }
    setAgreementSaved(true);
    setStatus({ submitting: false, success: false, error: "" });
    setAgreementModalOpen(false);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus({ submitting: true, success: false, error: "" });
    try {
      const canvas = signatureCanvasRef.current;
      if (!form.liabilityAgreementAccepted) {
        throw new Error("You must agree to the product liability agreement.");
      }
      if (!form.liabilityAgreementSignerName.trim()) {
        throw new Error("Enter the signer name for the product liability agreement.");
      }
      if (!agreementSaved) {
        throw new Error("Please review and save the agreement before submitting.");
      }
      if (form.liabilityAgreementSignatureMode === "draw" && (!canvas || !signaturePresent)) {
        throw new Error("Please sign the product liability agreement before submitting.");
      }
      const plan = SUBSCRIBE_PLANS.find((entry) => entry.value === form.selectedPlan);
      const response = await submitSubscribeLead({
        ...form,
        selectedPlanLabel: plan?.title || form.selectedPlan,
        liabilityAgreementSignatureDataUrl:
          form.liabilityAgreementSignatureMode === "draw" && canvas
            ? canvas.toDataURL("image/png")
            : "",
        sourceHost: window.location.host,
        sourcePath: window.location.pathname,
        queryString: window.location.search
      });
      setAddressInsights(response?.addressInsights || addressInsights);
      setStatus({ submitting: false, success: true, error: "" });
      window.setTimeout(() => {
        formStatusRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 0);
    } catch (error) {
      setStatus({
        submitting: false,
        success: false,
        error: error?.message || "Unable to submit your information right now."
      });
      window.setTimeout(() => {
        formStatusRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 0);
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
                    <a className="button" href={subscriptionStoreUrl()}>
                      Continue to store
                    </a>
                    <button
                      className="button alt"
                      type="button"
                      onClick={() => {
                        setForm(buildInitialForm(siteOptions));
                        clearSignature();
                        setAgreementSaved(false);
                        setAddressInsights(null);
                        setAddressCheckError("");
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
                      <span className="small">Phone*</span>
                      <input
                        className="input"
                        value={form.phone}
                        onChange={(event) => updateField("phone", event.target.value)}
                        required
                      />
                    </label>
                  </div>

                  <label className="filter-field">
                    <span className="small">Address*</span>
                    <input
                      className="input"
                      value={form.addressLine1}
                      onChange={(event) => updateField("addressLine1", event.target.value)}
                      required
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
                      <span className="small">City*</span>
                      <input
                        className="input"
                        value={form.city}
                        onChange={(event) => updateField("city", event.target.value)}
                        required
                      />
                    </label>
                    <label className="filter-field">
                      <span className="small">State*</span>
                      <input
                        className="input"
                        value={form.stateProvince}
                        onChange={(event) => updateField("stateProvince", event.target.value)}
                        required
                      />
                    </label>
                    <label className="filter-field">
                      <span className="small">Zip / Postal code*</span>
                      <input
                        className="input"
                        value={form.postalCode}
                        onChange={(event) => updateField("postalCode", event.target.value)}
                        required
                      />
                    </label>
                  </div>
                  <div className="button-row">
                    <button
                      className="button alt"
                      type="button"
                      onClick={handleCheckAddress}
                      disabled={
                        checkingAddress ||
                        !form.addressLine1.trim() ||
                        !form.city.trim() ||
                        !form.stateProvince.trim() ||
                        !form.postalCode.trim()
                      }
                    >
                      {checkingAddress ? "Checking address..." : "Check delivery area and nearest site"}
                    </button>
                  </div>
                  {addressCheckError ? (
                    <div className="small subscribe-error">{addressCheckError}</div>
                  ) : null}
                  {addressInsights ? (
                    <div className="subscribe-address-insights card">
                      <div className="small subscribe-address-insights-eyebrow">
                        Address insights
                      </div>
                      <div className="subscribe-address-insights-grid">
                        <div>
                          <strong>Validated address</strong>
                          <div>{addressInsights.geocodedDisplayName || "—"}</div>
                        </div>
                        <div>
                          <strong>Closest pickup site</strong>
                          <div>
                            {addressInsights.closestDropSite || "Unknown"}
                            {Number.isFinite(Number(addressInsights.closestDropSiteDistanceMiles))
                              ? ` (${Number(addressInsights.closestDropSiteDistanceMiles).toFixed(2)} miles)`
                              : ""}
                          </div>
                          {addressInsights.closestDropSiteAddress ? (
                            <div className="small">{addressInsights.closestDropSiteAddress}</div>
                          ) : null}
                        </div>
                        <div>
                          <strong>Home delivery area</strong>
                          <div>
                            {addressInsights.insideHomeDeliveryArea === true
                              ? "Inside delivery area"
                              : addressInsights.insideHomeDeliveryArea === false
                                ? "Outside delivery area"
                              : "Unavailable"}
                          </div>
                          {addressInsights.insideHomeDeliveryArea === true && preferredHomeDeliverySite ? (
                            <div className="button-row" style={{ marginTop: 8 }}>
                              <button
                                className="button alt"
                                type="button"
                                onClick={() => setPreferredDropSite(preferredHomeDeliverySite.name)}
                              >
                                Set home delivery as preferred option
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                      {Array.isArray(addressInsights.nearestPickupSites) &&
                      addressInsights.nearestPickupSites.length ? (
                        <div className="subscribe-nearest-pickup-list">
                          <strong>Three closest pickup sites</strong>
                          <div className="subscribe-nearest-pickup-items">
                            {addressInsights.nearestPickupSites.map((site) => (
                              <div
                                key={`${site.name}-${site.address || ""}`}
                                className="subscribe-nearest-pickup-item"
                              >
                                <div>
                                  <div>
                                    <strong>{site.name || "Unknown site"}</strong>
                                    {Number.isFinite(Number(site.distanceMiles))
                                      ? ` (${Number(site.distanceMiles).toFixed(2)} miles)`
                                      : ""}
                                  </div>
                                  {site.dayOfWeek ? (
                                    <div className="small">
                                      {formatDayOfWeekLabel(site.dayOfWeek)}
                                    </div>
                                  ) : null}
                                  {site.address ? <div className="small">{site.address}</div> : null}
                                </div>
                                {site.name ? (
                                  <button
                                    className="button alt"
                                    type="button"
                                    onClick={() => setPreferredDropSite(site.name)}
                                  >
                                    Set as preferred site
                                  </button>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

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

                  <div className="subscribe-agreement-card">
                    <div className="small subscribe-agreement-eyebrow">Required before submitting</div>
                    <h3>Product liability agreement</h3>
                    <p>
                      Review the agreement, then open the signer to sign at the bottom of the
                      document flow. Your signed PDF copy will be stored with your subscription
                      request.
                    </p>
                    <div className="button-row">
                      <button
                        className="button alt"
                        type="button"
                        onClick={() => setAgreementModalOpen(true)}
                      >
                        {agreementSaved ? "Review Saved Agreement" : "Review and Sign Agreement"}
                      </button>
                    </div>
                    <div className="small">
                      {agreementSaved && form.liabilityAgreementSignerName && form.liabilityAgreementAccepted
                        ? `Agreement saved for ${form.liabilityAgreementSignerName} using ${
                            form.liabilityAgreementSignatureMode === "typed" ? "typed name" : "drawn signature"
                          }.`
                        : "Agreement not saved yet."}
                    </div>
                  </div>

                  <div ref={formStatusRef}>
                    {status.error ? <div className="small subscribe-error">{status.error}</div> : null}
                  </div>

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
          <div className="container">
            <div className="subscribe-section-head">
              <div className="eyebrow">Locations</div>
              <h2 className="h2">Pickup sites, home delivery, and order days</h2>
            </div>
            <div className="subscribe-location-copy">
              <h3>Home Delivery</h3>
              <p className="lede">
                There is a $20 fee for home delivery with free delivery for orders over $125. See
                map for delivery area. Eugene/Springfield/ and Junction City deliveries happen on
                Tuesdays and Corvallis deliveries happen on Saturdays.
              </p>
              <h3>Drop Sites (Free)</h3>
              <p className="lede">
                Drop site locations and days are listed below. All dropsite deliveries are free. You
                can choose your preferred dropsite location when placing your order.
              </p>
            </div>
            <a
              className="subscribe-map-link"
              href={DELIVERY_MAP_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Open delivery map in a new window"
            >
              <img
                className="subscribe-map-image"
                src="/images/subscribe-map.avif"
                alt="Deck Family Farm delivery area map"
              />
            </a>
            <div className="subscribe-map-caption">
              Click the Map to See Our Pickup Locations/Dates and Delivery Radius
            </div>
            <div className="subscribe-drop-site-groups">
              <DropSiteTable
                title="Tuesday Dropsites"
                orderWindow="order window Thursday through Sunday"
                sites={tuesdayDropSites}
              />
              <DropSiteTable
                title="Friday Dropsites"
                orderWindow="order window Monday through Wednesday"
                sites={fridayDropSites}
              />
              <DropSiteTable
                title="Saturday Dropsites"
                orderWindow="order window Monday through Wednesday"
                sites={saturdayDropSites}
              />
            </div>
          </div>
        </section>

        <section className="section subscribe-herdshare-section" id="herdshare">
          <div className="container">
            <div className="subscribe-section-head">
              <div className="eyebrow">Raw Dairy</div>
              <h2 className="h2">About our Herdshare</h2>
            </div>
            <div className="subscribe-herdshare-grid">
              <div className="subscribe-herdshare-copy">
                <div className="subscribe-herdshare-logo-wrap">
                  <img
                    className="subscribe-herdshare-logo"
                    src="/images/subscribe-cclogo.avif"
                    alt="Creamy Cow herdshare logo"
                  />
                </div>
                <p className="lede">
                  We have been milking dairy cows since 2006 and our raw cow milk, butter, sour
                  cream, and cheeses have been a staple of our CSA since we began delivering CSA
                  products in 2017. The herdshare agreement means that each member owns a portion of
                  a cow, and in turn, Creamy Cow, LLC performs a milking service (see agistment
                  agreement).
                </p>
                <p className="lede">
                  Our $50 CSA membership fee includes financial support for the dairy herd, which
                  allows members to purchase milk produced by the herd. Value added dairy products
                  and bottling are charged a service fee.
                </p>
                <p className="lede">
                  Members elect to consume raw milk products under their own understanding and
                  advisement and are self-educated in all of the risks and benefits of consuming raw
                  milk products. Creamy Cow, LLC regularly tests milk (records available upon
                  request) and maintains a sanitary facility with modern milking equipment to cool
                  the product.
                </p>
                <p className="lede">
                  We are happy to answer any questions customers may have about raw milk and our
                  procedures and facilities and encourage everyone to do research about consuming raw
                  milk and make their own decision about whether it it right for you &amp; your
                  family. Visit{" "}
                  <a href="https://www.westonaprice.org" target="_blank" rel="noreferrer">
                    www.westonaprice.org
                  </a>{" "}
                  for more information.
                </p>
              </div>
              <div className="subscribe-herdshare-media">
                <figure className="card subscribe-herdshare-figure">
                  <img
                    src="/images/subscribe-dairy.avif"
                    alt="Pasture-raised dairy cows grazing on lush green fields at Deck Family Farm, showcasing regenerative and certified organic farming practices in Oregon."
                  />
                </figure>
                <figure className="card subscribe-herdshare-figure">
                  <img
                    src="/images/subscribe-dairy-2.avif"
                    alt="Deck Family Farm team with dairy cows, representing the herdshare program and the hands-on care the crew provides to grass-fed, pasture-raised animals in Junction City, Oregon."
                  />
                </figure>
              </div>
            </div>
          </div>
        </section>

        <section className="section subscribe-partners-section">
          <div className="container">
            <div className="subscribe-section-head">
              <div className="eyebrow">Meet Our Partners</div>
              <h2 className="h2">Meet Our Partners</h2>
            </div>
            <p className="lede">
              All products are grown, raised or crafted within 100 miles of our farm in Junction
              City with all farmers relying on natural cycles, regenerative practices or certified
              organic. Over 70% of the products offered on the storefront is from our own farm!
            </p>
            <p className="lede">
              From produce and meat to pasta and cookies, there are plenty of options to make
              delicious meals all week long.
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

      {agreementModalOpen ? (
        <div className="modal-backdrop" onClick={() => setAgreementModalOpen(false)}>
          <div className="modal response-modal" onClick={(event) => event.stopPropagation()}>
            <div className="button-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>Product Liability Agreement</strong>
                <div className="small">Review, acknowledge, and sign below.</div>
              </div>
              <button className="button alt" type="button" onClick={() => setAgreementModalOpen(false)}>
                Close
              </button>
            </div>
            <div className="subscribe-agreement-card" style={{ marginTop: 16 }}>
              <p>
                <a href={LIABILITY_AGREEMENT_URL} target="_blank" rel="noreferrer">
                  Open the Deck Family Farm product liability agreement
                </a>
              </p>
              <label className="filter-field">
                <span className="small">Signer full name*</span>
                <input
                  className="input"
                  value={form.liabilityAgreementSignerName}
                  onChange={(event) =>
                    updateField("liabilityAgreementSignerName", event.target.value)
                  }
                  placeholder="Type your full legal name"
                />
              </label>
              <label className="subscribe-agreement-check">
                <input
                  type="checkbox"
                  checked={Boolean(form.liabilityAgreementAccepted)}
                  onChange={(event) =>
                    updateField("liabilityAgreementAccepted", event.target.checked)
                  }
                />
                <span>
                  I have reviewed the product liability agreement and agree to sign it electronically.
                </span>
              </label>
              <div className="button-row">
                <button
                  className={`button alt${form.liabilityAgreementSignatureMode === "draw" ? " selected" : ""}`}
                  type="button"
                  onClick={() => updateField("liabilityAgreementSignatureMode", "draw")}
                >
                  Draw signature
                </button>
                <button
                  className={`button alt${form.liabilityAgreementSignatureMode === "typed" ? " selected" : ""}`}
                  type="button"
                  onClick={() => updateField("liabilityAgreementSignatureMode", "typed")}
                >
                  Type my name instead
                </button>
              </div>
              <div className="small">Sign here*</div>
              {form.liabilityAgreementSignatureMode === "draw" ? (
                <>
                  <canvas
                    ref={signatureCanvasRef}
                    className="subscribe-signature-pad"
                    width={560}
                    height={180}
                    onMouseDown={startSignature}
                    onMouseMove={drawSignature}
                    onMouseUp={endSignature}
                    onMouseLeave={endSignature}
                    onTouchStart={startSignature}
                    onTouchMove={drawSignature}
                    onTouchEnd={endSignature}
                  />
                  <div className="button-row">
                    <button className="button alt" type="button" onClick={clearSignature}>
                      Clear signature
                    </button>
                    <button className="button" type="button" onClick={handleSaveAgreement}>
                      Save Agreement
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="small">
                    Your typed full name above will be used as your electronic signature on the saved PDF.
                  </div>
                  <div className="button-row">
                    <button className="button" type="button" onClick={handleSaveAgreement}>
                      Save Agreement
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

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
            <a className="button" href={subscriptionStoreUrl()}>
              Store
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
