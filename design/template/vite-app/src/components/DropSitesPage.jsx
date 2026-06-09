import React, { useEffect, useMemo, useState } from "react";
import { fetchDropSitePerformance, submitDropSiteHostInterest } from "../api.js";
import { DeckPageHeader } from "./DeckPageHeader.jsx";

const MEDIA_KIT_URL =
  "https://docs.google.com/document/d/16iVw310-q0OGkJhWaXyO4Tp7WLEtU8Sf/edit";

const DEFAULT_FORM = {
  name: "",
  email: "",
  phone: "",
  memberStatus: "Current member",
  address: "",
  city: "",
  stateProvince: "OR",
  postalCode: "",
  availability: "",
  parking: "",
  stairs: "",
  secureLocation: "",
  toteStorage: "",
  neighborConcerns: "",
  notes: "",
  website: ""
};

function setMeta(name, content, attribute = "name") {
  if (typeof document === "undefined") return;
  let meta = document.querySelector(`meta[${attribute}="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute(attribute, name);
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", content);
}

function setCanonical(url) {
  if (typeof document === "undefined") return;
  let link = document.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement("link");
    link.setAttribute("rel", "canonical");
    document.head.appendChild(link);
  }
  link.setAttribute("href", url);
}

function formatMonth(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return value || "Current month";
  return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric"
  });
}

function formatAverage(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "0.00";
}

function getDropSitesUrl() {
  if (typeof window === "undefined") return "https://dropsites.deckfamilyfarm.com/";
  const host = String(window.location.host || "").toLowerCase();
  if (host.includes("localhost") || host.includes("127.0.0.1")) {
    return `${window.location.origin}/dropsites`;
  }
  return "https://dropsites.deckfamilyfarm.com/";
}

function DropSiteStatus({ row }) {
  return row?.transitionCreditEligible ? (
    <span className="dropsite-status good">Credit eligible</span>
  ) : (
    <span className="dropsite-status bad">Below credit threshold</span>
  );
}

export function DropSitesPage() {
  const [data, setData] = useState(null);
  const [month, setMonth] = useState("");
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState(DEFAULT_FORM);
  const [photos, setPhotos] = useState([]);
  const [status, setStatus] = useState({ submitting: false, message: "", error: "" });

  useEffect(() => {
    const title = "Drop Site Hosts | Deck Family Farm";
    const description =
      "Resources, host expectations, monthly performance summaries, and drop-site host applications for Full Farm pickup sites.";
    const url = getDropSitesUrl();
    document.title = title;
    setMeta("description", description);
    setMeta("robots", "index,follow,max-image-preview:large");
    setMeta("og:title", title, "property");
    setMeta("og:description", description, "property");
    setMeta("og:type", "website", "property");
    setMeta("og:url", url, "property");
    setCanonical(url);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchDropSitePerformance(month)
      .then((nextData) => {
        if (cancelled) return;
        setData(nextData);
        setLoadError("");
        if (!month && nextData?.performance?.selectedMonth) {
          setMonth(nextData.performance.selectedMonth);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error?.message || "Unable to load drop-site performance.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [month]);

  const navLinks = useMemo(
    () => [
      { label: "Overview", href: "#overview" },
      { label: "Host Credits", href: "#credits" },
      { label: "Resources", href: "#resources" },
      { label: "Metrics", href: "#metrics" },
      { label: "Apply", href: "#apply" }
    ],
    []
  );

  const performance = data?.performance || {};
  const rankedSites = performance.rankedSites || [];

  function updateField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus({ submitting: true, message: "", error: "" });
    try {
      const payload = new FormData();
      Object.entries(form).forEach(([key, value]) => {
        payload.append(key, value);
      });
      payload.append("sourceHost", window.location.host);
      payload.append("sourcePath", window.location.pathname);
      payload.append("queryString", window.location.search);
      photos.slice(0, 4).forEach((photo) => {
        payload.append("photos", photo);
      });
      await submitDropSiteHostInterest(payload);
      setStatus({
        submitting: false,
        message: "Thanks. Your drop-site host information has been sent to the farm team.",
        error: ""
      });
      setForm(DEFAULT_FORM);
      setPhotos([]);
    } catch (error) {
      setStatus({
        submitting: false,
        message: "",
        error: error?.message || "Unable to submit your drop-site host information."
      });
    }
  }

  return (
    <div className="subscribe-page dropsites-page">
      <DeckPageHeader navLinks={navLinks} />

      <section className="dropsites-hero" id="overview">
        <div className="container dropsites-hero-grid">
          <div className="dropsites-hero-copy">
            <div className="eyebrow">Full Farm Drop Sites</div>
            <h1 className="dropsites-title">Drop site hosts keep local food moving.</h1>
            <p className="dropsites-lede">
              Small farms need drop site hosts to help sell direct to consumer, spread the
              word, help people eat healthy local food, and grow regenerative agriculture.
              Hosts offer a simple pickup location for members and help with rare missed
              pickups.
            </p>
            <div className="dropsites-hero-actions">
              <a className="button" href="#apply">Become a host</a>
              <a className="button alt" href="#resources">Host resources</a>
            </div>
          </div>
          <figure className="dropsites-hero-media">
            <img src="/images/subscribe-map.avif" alt="Full Farm drop-site map" />
          </figure>
        </div>
      </section>

      <section className="section dropsites-requirements-section">
        <div className="container dropsites-info-grid">
          <article className="dropsite-info-panel">
            <div className="eyebrow">Responsibilities</div>
            <h2 className="h2">When a member misses pickup</h2>
            <ol className="dropsite-check-list">
              <li>Confirm the order is still at the site.</li>
              <li>Contact the member.</li>
              <li>Let the farm team know if product needs to be held or returned.</li>
            </ol>
          </article>
          <article className="dropsite-info-panel" id="credits">
            <div className="eyebrow">Benefits</div>
            <h2 className="h2">Host credits, referral credit, and free delivery</h2>
            <ul className="dropsite-check-list">
              <li>If neither the member nor farm can pick up product while it is fresh, it can go to the host.</li>
              <li>Hosts receive free delivery for their own orders.</li>
              <li>Qualifying sites receive a $50 monthly host credit.</li>
              <li>Hosts can receive a $25 credit for each new member signup credited to their referral link.</li>
            </ul>
          </article>
          <article className="dropsite-info-panel">
            <div className="eyebrow">Home Requirements</div>
            <h2 className="h2">Easy access matters</h2>
            <ul className="dropsite-check-list">
              <li>Reliable access for delivery and member pickup.</li>
              <li>Friendly neighbors and a practical pickup area.</li>
              <li>A safe place for orders during the pickup window.</li>
              <li>Current membership with an active subscription.</li>
            </ul>
          </article>
        </div>
      </section>

      <section className="section dropsites-tools-section" id="resources">
        <div className="container">
          <div className="subscribe-section-head">
            <div className="eyebrow">Tools</div>
            <h2 className="h2">Host Resources and Responsibilities</h2>
            <p className="lede dropsites-resources-lede">
              Use these materials to manage your site, handle pickup-day communication,
              and share Full Farm resources with your community.
            </p>
          </div>
          <div className="dropsites-resource-grid">
            <article className="dropsite-resource-card">
              <h3>Missed-pickup checklist</h3>
              <ol className="dropsite-check-list">
                <li>Confirm the order.</li>
                <li>Contact the member.</li>
                <li>Let the farm team know if product needs to be held or returned.</li>
              </ol>
            </article>
            <article className="dropsite-resource-card">
              <h3>Cooler and tote storage</h3>
              <p>
                Keep totes and coolers in a safe spot until the following delivery week,
                when the farm picks them up.
              </p>
            </article>
            <article className="dropsite-resource-card">
              <h3>Media Kit</h3>
              <p>
                Use the media kit to share Full Farm with neighbors and nearby friends.
              </p>
              <a className="button alt" href={MEDIA_KIT_URL} target="_blank" rel="noreferrer">
                Open media kit
              </a>
            </article>
          </div>
        </div>
      </section>

      <section className="section dropsites-metrics-section" id="metrics">
        <div className="container">
          <div className="subscribe-section-head">
            <div className="eyebrow">Performance</div>
            <h2 className="h2">Monthly public drop-site summary</h2>
            <p className="lede dropsites-metrics-lede">
              Host credit is the food credit hosts receive for hosting a drop site. A site
              qualifies by averaging 3 or more drops per week OR more than 5 pickups per month.
            </p>
          </div>
          <div className="dropsites-metrics-controls">
            <label className="filter-field">
              <span className="small">Month</span>
              <select
                className="select"
                value={month || performance.selectedMonth || ""}
                onChange={(event) => setMonth(event.target.value)}
              >
                {(performance.months || []).length ? null : (
                  <option value="">No order months yet</option>
                )}
                {(performance.months || []).map((value) => (
                  <option value={value} key={`dropsite-public-month-${value}`}>
                    {formatMonth(value)}
                  </option>
                ))}
              </select>
            </label>
            <div className="small">
              Credit threshold: 3 or more drops per week OR more than 5 pickups per month.
            </div>
          </div>
          {loadError ? <div className="small subscribe-error">{loadError}</div> : null}
          <div className="dropsite-metrics-table-shell">
            <table className="dropsite-metrics-table">
              <thead>
                <tr>
                  <th>Drop site</th>
                  <th>Area</th>
                  <th>Orders</th>
                  <th>Active weeks</th>
                  <th>Avg/week</th>
                  <th>Members picked up</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rankedSites.map((site) => (
                  <tr key={`public-dropsite-metric-${site.id}`}>
                    <td>{site.name}</td>
                    <td>{site.area || "Local pickup area"}</td>
                    <td>{Number(site.orderCount || 0)}</td>
                    <td>{Number(site.activeDropWeeks || site.scheduledDrops || 0)}</td>
                    <td>{formatAverage(site.averageOrdersPerActiveDropWeek || site.averageWeeklyOrders)}</td>
                    <td>{Number(site.legacyMonthlyUniqueCustomers || 0)}</td>
                    <td><DropSiteStatus row={site} /></td>
                  </tr>
                ))}
                {rankedSites.length ? null : (
                  <tr>
                    <td colSpan="7">No public drop-site performance data is available for this month yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section dropsites-apply-section" id="apply">
        <div className="container dropsites-apply-grid">
          <div className="dropsites-apply-copy">
            <h2 className="h2">Become a Drop Site Host</h2>
            <h3>Tell Us About Your Pickup Location</h3>
            <p className="lede">
              Drop sites help connect local families with food from local farms. Use this
              form to tell us about your location. Our farm team will review access,
              parking, storage options, and delivery logistics.
            </p>
            <h3>Why Become a Drop Site Host?</h3>
            <ul className="dropsite-check-list">
              <li>Help strengthen local agriculture and expand access to farm-fresh food.</li>
              <li>Build food security and support a more resilient local food system.</li>
              <li>Share healthy food with friends, neighbors, and your community.</li>
              <li>Receive free delivery and potential host rewards.</li>
            </ul>
            <p className="lede">
              Hosting a drop site is a simple way to support local farms, connect your
              community with good food, and help grow a stronger regional food network.
            </p>
          </div>
          <form className="dropsite-application-form card" onSubmit={handleSubmit}>
            <input
              className="dropsite-honeypot"
              tabIndex="-1"
              autoComplete="off"
              value={form.website}
              onChange={(event) => updateField("website", event.target.value)}
              name="website"
            />
            <div className="subscribe-form-grid">
              <label className="filter-field">
                <span className="small">Name</span>
                <input
                  className="input"
                  required
                  value={form.name}
                  onChange={(event) => updateField("name", event.target.value)}
                />
              </label>
              <label className="filter-field">
                <span className="small">Email</span>
                <input
                  className="input"
                  required
                  type="email"
                  value={form.email}
                  onChange={(event) => updateField("email", event.target.value)}
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
              <label className="filter-field">
                <span className="small">Membership</span>
                <select
                  className="select"
                  value={form.memberStatus}
                  onChange={(event) => updateField("memberStatus", event.target.value)}
                >
                  <option>Current member</option>
                  <option>Planning to become a member</option>
                  <option>Not currently a member</option>
                </select>
              </label>
            </div>
            <label className="filter-field">
              <span className="small">Proposed address</span>
              <input
                className="input"
                required
                value={form.address}
                onChange={(event) => updateField("address", event.target.value)}
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
                <span className="small">ZIP</span>
                <input
                  className="input"
                  value={form.postalCode}
                  onChange={(event) => updateField("postalCode", event.target.value)}
                />
              </label>
            </div>
            <div className="dropsite-form-section-title">Tell us about your site:</div>
            <div className="subscribe-form-grid">
              <label className="filter-field">
                <span className="small">Pickup-day availability</span>
                <textarea
                  className="textarea"
                  value={form.availability}
                  onChange={(event) => updateField("availability", event.target.value)}
                />
              </label>
              <label className="filter-field">
                <span className="small">Parking and street access</span>
                <textarea
                  className="textarea"
                  value={form.parking}
                  onChange={(event) => updateField("parking", event.target.value)}
                />
              </label>
              <label className="filter-field">
                <span className="small">Stairs or grade changes</span>
                <textarea
                  className="textarea"
                  value={form.stairs}
                  onChange={(event) => updateField("stairs", event.target.value)}
                />
              </label>
              <label className="filter-field">
                <span className="small">Secure location or gate?</span>
                <textarea
                  className="textarea"
                  value={form.secureLocation}
                  onChange={(event) => updateField("secureLocation", event.target.value)}
                />
              </label>
              <label className="filter-field">
                <span className="small">Tote/cooler storage</span>
                <textarea
                  className="textarea"
                  value={form.toteStorage}
                  onChange={(event) => updateField("toteStorage", event.target.value)}
                />
              </label>
              <label className="filter-field">
                <span className="small">Neighbor or HOA concerns</span>
                <textarea
                  className="textarea"
                  value={form.neighborConcerns}
                  onChange={(event) => updateField("neighborConcerns", event.target.value)}
                />
              </label>
            </div>
            <label className="filter-field">
              <span className="small">Additional notes</span>
              <textarea
                className="textarea"
                value={form.notes}
                onChange={(event) => updateField("notes", event.target.value)}
              />
            </label>
            <label className="filter-field">
              <span className="small">Photos of access, parking, or pickup area</span>
              <input
                className="input"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                multiple
                onChange={(event) => setPhotos(Array.from(event.target.files || []).slice(0, 4))}
              />
            </label>
            {photos.length ? (
              <div className="small">
                {photos.length} photo{photos.length === 1 ? "" : "s"} selected.
              </div>
            ) : null}
            {status.error ? <div className="small subscribe-error">{status.error}</div> : null}
            {status.message ? (
              <div className="small subscribe-success-message">{status.message}</div>
            ) : null}
            <button className="button" type="submit" disabled={status.submitting}>
              {status.submitting ? "Sending..." : "Send host information"}
            </button>
          </form>
        </div>
      </section>

      <footer className="subscribe-footer">
        <div className="container subscribe-footer-row">
          <div className="subscribe-footer-brand">
            <div className="subscribe-footer-brand-top">
              <img
                className="subscribe-footer-logo"
                src="/images/subscribe-footer-logo.avif"
                alt="Deck Family Farm icon logo"
              />
              <strong className="subscribe-footer-wordmark">Deck Family Farm</strong>
            </div>
            <div className="small">Drop-site resources for Full Farm hosts and neighbors.</div>
          </div>
          <div className="subscribe-footer-contact">
            <div>25362 High Pass Road</div>
            <div>Junction City, OR 97448</div>
            <div><a href="tel:15413210925">541-321-0925</a></div>
            <div><a href="mailto:fullfarmcsa@deckfamilyfarm.com">Email Full Farm</a></div>
          </div>
          <div className="subscribe-footer-links">
            <a className="subscribe-review-link" href="https://subscribe.deckfamilyfarm.com/">
              <span className="subscribe-review-link-star" aria-hidden="true">+</span>
              <span>Subscribe</span>
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
