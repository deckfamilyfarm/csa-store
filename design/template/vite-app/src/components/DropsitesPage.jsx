import React, { useEffect, useMemo, useState } from "react";
import {
  fetchDropSitePerformance,
  fetchDropSiteShareLinks,
  submitDropSiteHostInterest
} from "../api.js";
import { getSiteContentValue } from "../siteContent.js";
import { DeckPageHeader } from "./DeckPageHeader.jsx";
import { buildSubscribeNavLinks } from "./subscribeNavigation.js";

const MEDIA_KIT_URL =
  "https://docs.google.com/document/d/16iVw310-q0OGkJhWaXyO4Tp7WLEtU8Sf/edit";
const HOST_CREDIT_INFO =
  "Host credit is the food credit hosts receive for hosting a drop site. A site qualifies by averaging 3 or more orders per active drop week OR more than 5 unique customers in the month. We count guest and member orders per drop site.";
const SHARE_TEXT =
  "What you eat matters.\n\nI help host a neighborhood pickup location for Full Farm, a community food network started by Deck Family Farm.\n\nFamilies can order organic produce, pasture-raised meats, eggs, dairy, and other locally produced foods from nearby farms and pick them up close to home.\n\nIt's a convenient way to eat well and support local agriculture at the same time.\n\nLet me know if you're interested or use the link to find out more!";
const SHARE_TEXT_X =
  "I help host a neighborhood pickup location for Full Farm, a community food network started by Deck Family Farm. Organic produce, pasture-raised meats, eggs, dairy, and more from nearby farms, picked up close to home.";
const SHARE_SUBSCRIBE_URL = "https://subscribe.deckfamilyfarm.com/";
const SHARE_LINK_SLUGS = {
  sms: "dropsite-host-sms",
  facebook: "dropsite-host-facebook",
  instagram: "dropsite-host-instagram",
  nextdoor: "dropsite-host-nextdoor",
  x: "dropsite-host-x",
  copy: "dropsite-host-copy"
};

const INITIAL_FORM = {
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

function ensureMetaTag(name, content, attr = "name") {
  if (typeof document === "undefined") return;
  let tag = document.querySelector(`meta[${attr}="${name}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute(attr, name);
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", content);
}

function ensureCanonicalLink(url) {
  if (typeof document === "undefined") return;
  let link = document.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement("link");
    link.setAttribute("rel", "canonical");
    document.head.appendChild(link);
  }
  link.setAttribute("href", url);
}

function formatMonthLabel(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return value || "Current month";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatAverage(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "0.00";
}

function shouldShowPublicDropSiteMetric(row) {
  const title = String(row?.title || row?.name || "").toLowerCase();
  return !(
    title.includes("farmers market") ||
    title.includes("lcfm") ||
    title.includes("snap")
  );
}

function getDropsitesCanonicalUrl() {
  if (typeof window === "undefined") return "https://dropsites.deckfamilyfarm.com/";
  const host = String(window.location.host || "").toLowerCase();
  if (host.includes("localhost") || host.includes("127.0.0.1")) {
    return `${window.location.origin}/dropsites`;
  }
  return "https://dropsites.deckfamilyfarm.com/";
}

function slugifyShareTag(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function buildTrackedSubscribeShareUrl(channel) {
  const url = new URL(SHARE_SUBSCRIBE_URL);
  const channelTag = slugifyShareTag(channel) || "share";
  url.searchParams.set("utm_source", "dropsite_host");
  url.searchParams.set("utm_campaign", "dropsite_share");
  url.searchParams.set("utm_content", channelTag);
  if (SHARE_LINK_SLUGS[channelTag]) {
    url.searchParams.set("csa_link", SHARE_LINK_SLUGS[channelTag]);
  }
  return url.toString();
}

function buildTrackedMarketingRedirectUrl(channel) {
  const channelTag = slugifyShareTag(channel) || "share";
  const slug = SHARE_LINK_SLUGS[channelTag];
  if (!slug) return buildTrackedSubscribeShareUrl(channelTag);
  return `https://subscribe.deckfamilyfarm.com/api/marketing/go/${encodeURIComponent(slug)}`;
}

function buildFacebookShareUrl(url) {
  const shareUrl = new URL("https://www.facebook.com/sharer/sharer.php");
  shareUrl.searchParams.set("u", url);
  shareUrl.searchParams.set("quote", SHARE_TEXT);
  return shareUrl.toString();
}

function normalizeFetchedShareUrl(channel, trackedUrl) {
  if (!trackedUrl) return buildTrackedMarketingRedirectUrl(channel);
  try {
    const url = new URL(trackedUrl);
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return buildTrackedMarketingRedirectUrl(channel);
    }
    return url.toString();
  } catch (_error) {
    return buildTrackedMarketingRedirectUrl(channel);
  }
}

function buildShareMessage(url) {
  return `${SHARE_TEXT}\n\n${url}`;
}

function ShareIcon({ type }) {
  if (type === "sms") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 5.5h14v9.5H8.2L5 18.2V5.5Z" />
      </svg>
    );
  }
  if (type === "facebook") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14.7 8.2h2.1V4.7c-.4-.1-1.6-.2-3-.2-3 0-5.1 1.8-5.1 5.2v2.9H5.4v3.9h3.3v9h4.1v-9h3.4l.5-3.9h-3.9V10c0-1.1.3-1.8 1.9-1.8Z" />
      </svg>
    );
  }
  if (type === "instagram") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="4" fill="none" />
        <circle cx="12" cy="12" r="3.2" fill="none" />
        <circle cx="16.2" cy="7.8" r="1" />
      </svg>
    );
  }
  if (type === "nextdoor") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 19V8.2l4.3 3.5V19h3.1v-6c0-1.4.8-2.2 2-2.2 1.1 0 1.8.8 1.8 2.2v6H19v-6.5c0-3-1.8-4.9-4.4-4.9-1.5 0-2.7.6-3.5 1.7L5 4.5V19Z" />
      </svg>
    );
  }
  if (type === "x") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 5h4.4l3.3 4.7L16.7 5H20l-5.7 6.6L20.5 20h-4.4l-3.8-5.4L7.7 20H4.4l6.2-7.2L5 5Zm3.1 1.8 9 11.5h1.3L9.5 6.8H8.1Z" />
      </svg>
    );
  }
  if (type === "link") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9.7 14.3a1.3 1.3 0 0 1 0-1.9l2.7-2.7a1.3 1.3 0 0 1 1.9 1.9l-2.7 2.7a1.3 1.3 0 0 1-1.9 0Z" />
        <path d="M8.4 17.6 6.7 19.3a4 4 0 0 1-5.6-5.6l3.1-3.1a4 4 0 0 1 5.6 0 1.3 1.3 0 0 1-1.8 1.9 1.3 1.3 0 0 0-1.9 0L3 15.6a1.4 1.4 0 0 0 2 2l1.7-1.7a1.3 1.3 0 0 1 1.7 1.7Z" />
        <path d="m15.6 6.4 1.7-1.7a4 4 0 0 1 5.6 5.6l-3.1 3.1a4 4 0 0 1-5.6 0 1.3 1.3 0 0 1 1.8-1.9 1.3 1.3 0 0 0 1.9 0l3.1-3.1a1.4 1.4 0 0 0-2-2l-1.7 1.7a1.3 1.3 0 0 1-1.7-1.7Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3.5h7.2L19 8.3v12.2H7v-17Zm6.4 1.8v4h4L13.4 5.3ZM9 13h8v-1.7H9V13Zm0 3.4h8v-1.7H9v1.7Z" />
    </svg>
  );
}

function MetricStatus({ row }) {
  if (row.transitionCreditEligible) {
    return <span className="dropsite-status good">Credit eligible</span>;
  }
  return <span className="dropsite-status bad">Below credit threshold</span>;
}

export function DropsitesPage({ siteContent = {} }) {
  const [metrics, setMetrics] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState("");
  const [metricsError, setMetricsError] = useState("");
  const [hostCreditInfoOpen, setHostCreditInfoOpen] = useState(false);
  const [form, setForm] = useState(INITIAL_FORM);
  const [photos, setPhotos] = useState([]);
  const [status, setStatus] = useState({ submitting: false, message: "", error: "" });
  const [trackedShareUrls, setTrackedShareUrls] = useState({});
  const [shareModal, setShareModal] = useState(null);
  const copy = (section, field, fallback) =>
    getSiteContentValue(siteContent, "dropsites", section, field, fallback);
  const heroTitle = copy("hero", "title", "Nourish your neighborhood.");
  const heroBody = copy(
    "hero",
    "body",
    "Drop site hosts make farm-fresh, locally grown food accessible to more people while supporting regenerative agriculture right in your backyard. By offering a simple pickup spot and helping spread the word, you become an essential link in building a healthier, more sustainable food system. The more local hosts we have, the more affordable and accessible that food becomes for everyone."
  );
  const hostCreditInfo = copy("metrics", "hostCreditInfo", HOST_CREDIT_INFO);

  useEffect(() => {
    const title = "Drop Site Hosts | Deck Family Farm";
    const description = heroBody;
    const canonicalUrl = getDropsitesCanonicalUrl();
    document.title = title;
    ensureMetaTag("description", description);
    ensureMetaTag("robots", "index,follow,max-image-preview:large");
    ensureMetaTag("og:title", title, "property");
    ensureMetaTag("og:description", description, "property");
    ensureMetaTag("og:type", "website", "property");
    ensureMetaTag("og:url", canonicalUrl, "property");
    ensureCanonicalLink(canonicalUrl);
  }, [heroBody]);

  useEffect(() => {
    let cancelled = false;
    fetchDropSitePerformance(selectedMonth)
      .then((data) => {
        if (cancelled) return;
        setMetrics(data);
        setMetricsError("");
        if (!selectedMonth && data?.performance?.selectedMonth) {
          setSelectedMonth(data.performance.selectedMonth);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setMetricsError(error?.message || "Unable to load drop-site performance.");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMonth]);

  useEffect(() => {
    let cancelled = false;
    fetchDropSiteShareLinks()
      .then((data) => {
        if (cancelled) return;
        const nextUrls = {};
        Object.keys(SHARE_LINK_SLUGS).forEach((key) => {
          const trackedUrl = data?.links?.[key]?.trackedUrl;
          nextUrls[key] = normalizeFetchedShareUrl(key, trackedUrl);
        });
        setTrackedShareUrls(nextUrls);
      })
      .catch(() => {
        if (!cancelled) setTrackedShareUrls({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle("modal-open", Boolean(shareModal));
    return () => {
      document.body.classList.remove("modal-open");
    };
  }, [shareModal]);

  const navLinks = useMemo(
    () => buildSubscribeNavLinks(),
    []
  );
  const shareLinks = useMemo(() => {
    const fallbackUrls = {
      sms: buildTrackedMarketingRedirectUrl("sms"),
      facebook: buildTrackedMarketingRedirectUrl("facebook"),
      instagram: buildTrackedMarketingRedirectUrl("instagram"),
      nextdoor: buildTrackedMarketingRedirectUrl("nextdoor"),
      x: buildTrackedMarketingRedirectUrl("x"),
      copy: buildTrackedMarketingRedirectUrl("copy")
    };
    const urls = {
      ...fallbackUrls,
      ...trackedShareUrls
    };
    return {
      urls,
      smsHref: `sms:?&body=${encodeURIComponent(buildShareMessage(urls.sms))}`,
      facebookHref: buildFacebookShareUrl(urls.facebook),
      xHref: `https://twitter.com/intent/tweet?text=${encodeURIComponent(
        SHARE_TEXT_X
      )}&url=${encodeURIComponent(urls.x)}`
    };
  }, [trackedShareUrls]);

  const performance = metrics?.performance || {};
  const metricRows = (performance.rankedSites || []).filter(shouldShowPublicDropSiteMetric);

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus({ submitting: true, message: "", error: "" });
    try {
      const formData = new FormData();
      Object.entries(form).forEach(([key, value]) => {
        formData.append(key, value);
      });
      formData.append("sourceHost", window.location.host);
      formData.append("sourcePath", window.location.pathname);
      formData.append("queryString", window.location.search);
      photos.slice(0, 4).forEach((file) => {
        formData.append("photos", file);
      });
      await submitDropSiteHostInterest(formData);
      setStatus({
        submitting: false,
        message: "Thanks. Your drop-site host information has been sent to the farm team.",
        error: ""
      });
      setForm(INITIAL_FORM);
      setPhotos([]);
    } catch (error) {
      setStatus({
        submitting: false,
        message: "",
        error: error?.message || "Unable to submit your drop-site host information."
      });
    }
  }

  async function copyShareMessage(channel) {
    const channelUrl = shareLinks.urls[channel] || shareLinks.urls.copy;
    const message = buildShareMessage(channelUrl);
    try {
      await navigator.clipboard.writeText(message);
      return { copied: true, message };
    } catch (_error) {
      return { copied: false, message };
    }
  }

  async function shareWithDeviceOrCopy(channel, openUrl = "", platformName = "", messageOverride = "") {
    const fallbackMessage =
      messageOverride ||
      `Share text copied to clipboard. ${platformName || "This site"} does not allow prefilled web post.`;
    const result = await copyShareMessage(channel);
    setShareModal({
      title: `Share on ${platformName || "this site"}`,
      body: result.copied
        ? `${fallbackMessage} When ${platformName || "the site"} opens, create a post or message and paste the copied text.`
        : `Your browser could not copy automatically. Copy this share text, then paste it into ${platformName || "the site"}.`,
      copied: result.copied,
      shareText: result.copied ? "" : result.message,
      primaryLabel: `Open ${platformName || "site"}`,
      primaryUrl: openUrl
    });
  }

  async function copyShareUrl() {
    try {
      await navigator.clipboard.writeText(shareLinks.urls.copy);
      setShareModal({
        title: "Link copied",
        body: "Share link copied to clipboard.",
        copied: true,
        shareText: "",
        primaryLabel: "",
        primaryUrl: ""
      });
    } catch (_error) {
      setShareModal({
        title: "Copy link",
        body: "Your browser could not copy automatically. Copy this link.",
        copied: false,
        shareText: shareLinks.urls.copy,
        primaryLabel: "",
        primaryUrl: ""
      });
    }
  }

  function closeShareModal() {
    setShareModal(null);
  }

  function openShareModalTarget() {
    const url = shareModal?.primaryUrl;
    if (url && typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
    closeShareModal();
  }

  return (
    <div className="subscribe-page dropsites-page">
      <DeckPageHeader navLinks={navLinks} />

      <section className="dropsites-hero" id="overview">
        <div className="container dropsites-hero-grid">
          <div className="dropsites-hero-copy">
            <div className="eyebrow">{copy("hero", "eyebrow", "Full Farm Drop Sites")}</div>
            <h1 className="dropsites-title">{heroTitle}</h1>
            <p className="dropsites-lede">
              {heroBody}
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
            <h2 className="h2">
              {copy("resources", "title", "Host Resources and Responsibilities")}
            </h2>
            <p className="lede dropsites-resources-lede">
              {copy(
                "resources",
                "body",
                "Use these materials to manage your site, handle pickup-day communication, and share Full Farm resources with your community."
              )}
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
              <p>Keep totes and coolers in a safe spot until the following delivery week, when the farm picks them up.</p>
            </article>
            <article className="dropsite-resource-card">
              <h3>Help us spread the word!</h3>
              <p>
                Use these buttons to share Full Farm with neighbors, friends, and nearby
                families who want easier access to real local farm food.
              </p>
              <div className="dropsite-share-actions" aria-label="Share Full Farm subscribe link">
                <a
                  className="dropsite-share-button dropsite-share-button-sms"
                  href={shareLinks.smsHref}
                  aria-label="Share by text message"
                  title="Text message"
                >
                  <ShareIcon type="sms" />
                </a>
                <button
                  className="dropsite-share-button dropsite-share-button-facebook"
                  type="button"
                  onClick={() =>
                    shareWithDeviceOrCopy(
                      "facebook",
                      shareLinks.facebookHref,
                      "Facebook",
                      "Share text copied to clipboard. Facebook may not include prefilled post text."
                    )
                  }
                  aria-label="Share on Facebook"
                  title="Facebook"
                >
                  <ShareIcon type="facebook" />
                </button>
                <button
                  className="dropsite-share-button dropsite-share-button-instagram"
                  type="button"
                  onClick={() =>
                    shareWithDeviceOrCopy(
                      "instagram",
                      "https://www.instagram.com/",
                      "Instagram",
                      "Share text copied to clipboard. Instagram requires a photo, so choose a photo of your Full Farm food or your drop-site location, then paste the copied text into the caption."
                    )
                  }
                  aria-label="Share with Instagram"
                  title="Instagram"
                >
                  <ShareIcon type="instagram" />
                </button>
                <button
                  className="dropsite-share-button dropsite-share-button-nextdoor"
                  type="button"
                  onClick={() => shareWithDeviceOrCopy("nextdoor", "https://nextdoor.com/", "Nextdoor")}
                  aria-label="Share with Nextdoor"
                  title="Nextdoor"
                >
                  <ShareIcon type="nextdoor" />
                </button>
                <a
                  className="dropsite-share-button dropsite-share-button-x"
                  href={shareLinks.xHref}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Share on X"
                  title="X"
                >
                  <ShareIcon type="x" />
                </a>
                <button
                  className="dropsite-share-button dropsite-share-button-link"
                  type="button"
                  onClick={copyShareUrl}
                  aria-label="Copy tracked share link"
                  title="Copy link"
                >
                  <ShareIcon type="link" />
                </button>
              </div>
              <div className="dropsite-host-toolkit-row">
                <a
                  className="button alt dropsite-host-toolkit-link"
                  href={MEDIA_KIT_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Host Referral Resources
                </a>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="section dropsites-metrics-section" id="metrics">
        <div className="container">
          <div className="subscribe-section-head">
            <div className="eyebrow">Performance</div>
            <div className="dropsites-metrics-title-row">
              <h2 className="h2">Monthly drop-site summary</h2>
              <span className={`dropsite-info-control ${hostCreditInfoOpen ? "open" : ""}`}>
                <button
                  className="dropsite-info-button"
                  type="button"
                  aria-label="Host credit methodology"
                  aria-expanded={hostCreditInfoOpen}
                  onClick={() => setHostCreditInfoOpen((open) => !open)}
                  onBlur={() => setHostCreditInfoOpen(false)}
                >
                  i
                </button>
                <span className="dropsite-info-bubble" role="tooltip">
                  {hostCreditInfo}
                </span>
              </span>
            </div>
          </div>
          <div className="dropsites-metrics-controls">
            <label className="filter-field">
              <span className="small">Month</span>
              <select
                className="select"
                value={selectedMonth || performance.selectedMonth || ""}
                onChange={(event) => setSelectedMonth(event.target.value)}
              >
                {!(performance.months || []).length ? <option value="">No order months yet</option> : null}
                {(performance.months || []).map((value) => (
                  <option key={`dropsite-public-month-${value}`} value={value}>
                    {formatMonthLabel(value)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {metricsError ? <div className="small subscribe-error">{metricsError}</div> : null}
          <div className="dropsite-metrics-table-shell">
            <table className="dropsite-metrics-table">
              <thead>
                <tr>
                  <th>Drop site</th>
                  <th>Area</th>
                  <th>Orders</th>
                  <th>Avg orders/week</th>
                  <th>Unique customers</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {metricRows.map((row) => (
                  <tr key={`public-dropsite-metric-${row.id}`}>
                    <td>{row.name}</td>
                    <td>{row.area || "Local pickup area"}</td>
                    <td>{Number(row.orderCount || 0)}</td>
                    <td>{formatAverage(row.averageOrdersPerActiveDropWeek)}</td>
                    <td>{Number(row.legacyMonthlyUniqueCustomers || 0)}</td>
                    <td><MetricStatus row={row} /></td>
                  </tr>
                ))}
                {!metricRows.length ? (
                  <tr>
                    <td colSpan="6">No public drop-site performance data is available for this month yet.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section dropsites-apply-section" id="apply">
        <div className="container dropsites-apply-grid">
          <div className="dropsites-apply-copy">
            <h2 className="h2">{copy("apply", "title", "Become a Drop Site Host")}</h2>
            <h3>{copy("apply", "introTitle", "Tell Us About Your Pickup Location")}</h3>
            <p className="lede">
              {copy(
                "apply",
                "introBody",
                "Drop sites help connect local families with food from local farms. Use this form to tell us about your location. Our farm team will review access, parking, storage options, and delivery logistics."
              )}
            </p>
            <h3>{copy("apply", "whyTitle", "Why Become a Drop Site Host?")}</h3>
            <ul className="dropsite-check-list">
              <li>Help strengthen local agriculture and expand access to farm-fresh food.</li>
              <li>Build food security and support a more resilient local food system.</li>
              <li>Share healthy food with friends, neighbors, and your community.</li>
              <li>Receive free delivery and potential host rewards.</li>
            </ul>
            <p className="lede">
              {copy(
                "apply",
                "closingBody",
                "Hosting a drop site is a simple way to support local farms, connect your community with good food, and help grow a stronger regional food network."
              )}
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
                <input className="input" required value={form.name} onChange={(event) => updateField("name", event.target.value)} />
              </label>
              <label className="filter-field">
                <span className="small">Email</span>
                <input className="input" required type="email" value={form.email} onChange={(event) => updateField("email", event.target.value)} />
              </label>
              <label className="filter-field">
                <span className="small">Phone</span>
                <input className="input" value={form.phone} onChange={(event) => updateField("phone", event.target.value)} />
              </label>
              <label className="filter-field">
                <span className="small">Membership</span>
                <select className="select" value={form.memberStatus} onChange={(event) => updateField("memberStatus", event.target.value)}>
                  <option>Current member</option>
                  <option>Planning to become a member</option>
                  <option>Not currently a member</option>
                </select>
              </label>
            </div>
            <label className="filter-field">
              <span className="small">Proposed address</span>
              <input className="input" required value={form.address} onChange={(event) => updateField("address", event.target.value)} />
            </label>
            <div className="subscribe-form-grid subscribe-form-grid-3">
              <label className="filter-field">
                <span className="small">City</span>
                <input className="input" value={form.city} onChange={(event) => updateField("city", event.target.value)} />
              </label>
              <label className="filter-field">
                <span className="small">State</span>
                <input className="input" value={form.stateProvince} onChange={(event) => updateField("stateProvince", event.target.value)} />
              </label>
              <label className="filter-field">
                <span className="small">ZIP</span>
                <input className="input" value={form.postalCode} onChange={(event) => updateField("postalCode", event.target.value)} />
              </label>
            </div>
            <div className="dropsite-form-section-title">Tell us about your site:</div>
            <div className="subscribe-form-grid">
              <label className="filter-field">
                <span className="small">Pickup-day availability</span>
                <textarea className="textarea" value={form.availability} onChange={(event) => updateField("availability", event.target.value)} />
              </label>
              <label className="filter-field">
                <span className="small">Parking and street access</span>
                <textarea className="textarea" value={form.parking} onChange={(event) => updateField("parking", event.target.value)} />
              </label>
              <label className="filter-field">
                <span className="small">Stairs or grade changes</span>
                <textarea className="textarea" value={form.stairs} onChange={(event) => updateField("stairs", event.target.value)} />
              </label>
              <label className="filter-field">
                <span className="small">Secure location or gate?</span>
                <textarea className="textarea" value={form.secureLocation} onChange={(event) => updateField("secureLocation", event.target.value)} />
              </label>
              <label className="filter-field">
                <span className="small">Tote/cooler storage</span>
                <textarea className="textarea" value={form.toteStorage} onChange={(event) => updateField("toteStorage", event.target.value)} />
              </label>
              <label className="filter-field">
                <span className="small">Neighbor or HOA concerns</span>
                <textarea className="textarea" value={form.neighborConcerns} onChange={(event) => updateField("neighborConcerns", event.target.value)} />
              </label>
            </div>
            <label className="filter-field">
              <span className="small">Additional notes</span>
              <textarea className="textarea" value={form.notes} onChange={(event) => updateField("notes", event.target.value)} />
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
            {photos.length ? <div className="small">{photos.length} photo{photos.length === 1 ? "" : "s"} selected.</div> : null}
            {status.error ? <div className="small subscribe-error">{status.error}</div> : null}
            {status.message ? <div className="small subscribe-success-message">{status.message}</div> : null}
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
              <img className="subscribe-footer-logo" src="/images/subscribe-footer-logo.avif" alt="Deck Family Farm icon logo" />
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
      {shareModal ? (
        <div className="modal-backdrop dropsite-share-modal-backdrop" onClick={closeShareModal}>
          <div
            className="modal modal-small dropsite-share-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dropsite-share-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button className="modal-close" type="button" onClick={closeShareModal} aria-label="Close share dialog">
              x
            </button>
            <div className="modal-body single">
              <div className="dropsite-share-modal-content">
                <div className="eyebrow">Share</div>
                <h3 id="dropsite-share-modal-title">{shareModal.title}</h3>
                <p>{shareModal.body}</p>
                {shareModal.shareText ? (
                  <textarea className="textarea dropsite-share-copy-field" readOnly value={shareModal.shareText} />
                ) : null}
                <div className="dropsite-share-modal-actions">
                  {shareModal.primaryUrl ? (
                    <button className="button" type="button" onClick={openShareModalTarget}>
                      {shareModal.primaryLabel || "Open"}
                    </button>
                  ) : null}
                  <button className="button alt" type="button" onClick={closeShareModal}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
