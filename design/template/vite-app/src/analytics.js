const GA_MEASUREMENT_ID = "G-V9TZSHTFP7";
const GA_SCRIPT_ID = "google-analytics-gtag";
const GA_CROSS_DOMAIN_LINKER = {
  accept_incoming: true,
  domains: ["deckfamilyfarm.com", "www.deckfamilyfarm.com", "subscribe.deckfamilyfarm.com"]
};

let googleAnalyticsConfigured = false;

function getGtag() {
  if (typeof window === "undefined") return null;
  window.dataLayer = window.dataLayer || [];
  if (typeof window.gtag !== "function") {
    window.gtag = function gtag() {
      window.dataLayer.push(arguments);
    };
  }
  return window.gtag;
}

function ensureGoogleAnalyticsBaseCode() {
  if (typeof document === "undefined") return false;
  const gtag = getGtag();
  if (!gtag) return false;

  if (!document.getElementById(GA_SCRIPT_ID)) {
    const script = document.createElement("script");
    script.id = GA_SCRIPT_ID;
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(
      GA_MEASUREMENT_ID
    )}`;
    document.head.appendChild(script);
  }

  if (!googleAnalyticsConfigured) {
    gtag("js", new Date());
    gtag("set", "linker", GA_CROSS_DOMAIN_LINKER);
    gtag("config", GA_MEASUREMENT_ID, {
      send_page_view: false,
      linker: GA_CROSS_DOMAIN_LINKER
    });
    googleAnalyticsConfigured = true;
  }

  return true;
}

function getCurrentPagePath() {
  if (typeof window === "undefined") return "";
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function trackGoogleAnalyticsPageView({ title } = {}) {
  if (typeof window === "undefined" || !ensureGoogleAnalyticsBaseCode()) return;

  const trackedPageViews =
    window.__csaGoogleAnalyticsTrackedPageViews ||
    (window.__csaGoogleAnalyticsTrackedPageViews = new Set());
  const pageLocation = window.location.href;
  if (trackedPageViews.has(pageLocation)) return;

  window.gtag("event", "page_view", {
    page_title: title || document.title,
    page_location: pageLocation,
    page_path: getCurrentPagePath()
  });
  trackedPageViews.add(pageLocation);
}
