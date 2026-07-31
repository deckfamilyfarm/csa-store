import React, { useEffect, useMemo, useRef, useState } from "react";
import { fetchSubscribeAddressInsights, submitSubscribeLead, trackMarketingEvent } from "../api.js";
import { getSiteContentValue } from "../siteContent.js";
import { SUBSCRIBE_PARTNERS } from "../data/subscribePartners.js";
import {
  MEMBER_PORTAL_LINK_ENABLED,
  SUBSCRIBE_PORTAL_ONBOARDING_ENABLED
} from "../portalFeatureFlags.js";
import { DeckPageHeader } from "./DeckPageHeader.jsx";
import { SubscribeFooter } from "./SubscribeFooter.jsx";
import {
  buildSubscribeNavLinks,
  getDropsitesHostUrl,
  subscriptionStoreUrl
} from "./subscribeNavigation.js";

const DELIVERY_MAP_URL =
  "https://berkeleymapper.berkeley.edu/index.html?tabfile=https://raw.githubusercontent.com/jdeck88/ffcsa_scripts/refs/heads/main/localline/data/delivery_data.tsv&configfile=https://raw.githubusercontent.com/jdeck88/ffcsa_scripts/refs/heads/main/dropsite_maps/dropsites2.xml&pointDisplay=markers&hideLegendItems=true";
const DROP_SITE_SHOP_VIDEO_URL = "https://www.youtube.com/shorts/NF7O3E1-WeM";
const DROP_SITE_SHOP_VIDEO_EMBED_URL = "https://www.youtube.com/embed/NF7O3E1-WeM";
const LIABILITY_AGREEMENT_URL =
  "https://docs.google.com/document/d/1VFMc4euofQ1S1kjtd6jZI46uxo6YKft9cufT6Q3-nrc/edit?tab=t.0";
const META_PIXEL_ID = "645309732709210";
const META_PIXEL_SCRIPT_ID = "meta-pixel-code";
const META_PIXEL_NOSCRIPT_ID = "meta-pixel-noscript";

const SUBSCRIBE_PLANS = [
  {
    value: "guest",
    title: "Guest Checkout",
    price: "Guest Checkout",
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
    selectLabel: "Forager ($200/mo)",
    price: "$200/month",
    note: "",
    featured: true,
    bullets: [
      "Loads $200 balance each month to spend on your individualized choice of farm products",
      "$200 minimum purchase, unused funds roll over",
      "15% under guest pricing",
      "10% discount at Farmers Market Booths.",
      "Access to raw dairy",
      "One-time $50 joining fee"
    ]
  },
  {
    value: "grazer",
    title: "The Grazer",
    selectLabel: "Grazer ($300/mo)",
    price: "$300/month",
    note: "",
    featured: false,
    bullets: [
      "Loads $300 balance each month to spend on your individualized choice of farm products",
      "$300 minimum purchase, unused funds roll over",
      "15% under guest pricing",
      "10% discount at Farmers Market Booths.",
      "Access to raw dairy",
      "One-time $50 joining fee",
      "Free Deck Family Farm tote bag and t-shirt"
    ]
  },
  {
    value: "harvester",
    title: "The Harvester",
    selectLabel: "Harvester ($500/mo)",
    price: "$500/month",
    note: "Best for stocking up",
    featured: false,
    bullets: [
      "Loads $500 balance each month to spend on your individualized choice of farm products",
      "$500 minimum purchase, unused funds roll over",
      "15% under guest pricing",
      "10% discount at Farmers Market Booths.",
      "Access to raw dairy",
      "One-time $50 joining fee",
      "Free Deck Family Farm tote bag and t-shirt",
      "Half-price home delivery in Corvallis, Junction City, Eugene, and Springfield"
    ]
  }
];

const FARMERS_MARKET_REFERRAL_SOURCE = "Farmers Market";
const CURRENT_MEMBER_REFERRAL_SOURCE = "A current CSA member";
const FRIEND_OR_FAMILY_REFERRAL_SOURCE = "Friend or family";
const DROP_SITE_REFERRAL_SOURCE = "Drop site host or pickup site";
const COMMUNITY_EVENT_REFERRAL_SOURCE = "Community event";
const FARM_PARTNER_REFERRAL_SOURCE = "Farm partner or local business";
const OTHER_REFERRAL_SOURCE = "Other";

const REFERRAL_SOURCE_OPTIONS = [
  FARMERS_MARKET_REFERRAL_SOURCE,
  CURRENT_MEMBER_REFERRAL_SOURCE,
  FRIEND_OR_FAMILY_REFERRAL_SOURCE,
  "Google / search engine",
  "Instagram",
  "Facebook",
  "Email newsletter",
  "Deck Family Farm website",
  "Full Farm CSA website",
  "Local Line / online store",
  DROP_SITE_REFERRAL_SOURCE,
  COMMUNITY_EVENT_REFERRAL_SOURCE,
  FARM_PARTNER_REFERRAL_SOURCE,
  OTHER_REFERRAL_SOURCE
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
      "One of the great things about Full Farm is the flexibility. You are welcome to place orders weekly, bi-weekly, or monthly."
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
  },
  {
    question: "Where can I find pasture-raised eggs and meat in Portland?",
    answer:
      "Deck Family Farm and Full Farm offer pasture-raised eggs, meat, raw dairy, and other nutrient-dense local foods for Portland-area members through Saturday pickup locations including Beaverton, Cully, Hollywood Farmers Market, Irvington, PSU Farmers Market, St. Johns Farmers Market, and Woodstock."
  },
  {
    question: "Where can I find pasture-raised eggs and meat in Eugene or Springfield?",
    answer:
      "Full Farm serves Eugene, Springfield, and Junction City with Tuesday, Friday, and Saturday pickup options as well as home delivery in the Eugene, Springfield, and Junction City area. Members can shop Deck Family Farm staples and partner-farm foods in one place."
  },
  {
    question: "Where can I find pasture-raised eggs and meat in Salem?",
    answer:
      "Full Farm offers a Salem Saturday pickup option for shoppers looking for Deck Family Farm pasture-raised eggs, meat, raw dairy, and other local farm foods."
  },
  {
    question: "Where can I get farm food delivered to my house?",
    answer:
      "Full Farm offers home delivery for qualifying addresses, with Tuesday delivery in Eugene, Springfield, and Junction City and Saturday delivery in Corvallis. The subscribe form can check your address and show whether you are inside the current delivery area."
  },
  {
    question: "Where can I join Full Farm for nutrient-dense local food in Oregon?",
    answer:
      "You can join Full Farm from Deck Family Farm on this page. Membership gives you access to pasture-raised eggs, meat, raw dairy, vegetables, pantry goods, and other hyper-local foods through pickup sites and home delivery."
  }
];

const DISCOVERY_CARDS = [
  {
    title: "Portland-area pickup",
    copy:
      "Find Deck Family Farm pasture-raised eggs, meat, raw dairy, and local farm staples through Portland-area Saturday pickup locations including Beaverton, Cully, Hollywood Farmers Market, Irvington, PSU Farmers Market, St. Johns Farmers Market, and Woodstock."
  },
  {
    title: "Eugene, Springfield, and Junction City",
    copy:
      "Shop nutrient-dense local food from Deck Family Farm and partner farms with Tuesday, Friday, and Saturday pickup options plus home delivery in the Eugene, Springfield, and Junction City area."
  },
  {
    title: "Salem and Corvallis access",
    copy:
      "Join Full Farm for Salem and Corvallis access to pasture-raised eggs, meat, dairy, and weekly farm food pickup. Corvallis also has a Saturday home-delivery route."
  },
  {
    title: "Good diet options",
    copy:
      "Members use Full Farm for nutrient-dense staples like pasture-raised eggs, grass-fed and pasture-raised meats, raw dairy, vegetables, pantry items, and meal-building ingredients for whole-food diets."
  }
];

function ensureMetaTag(name, content, attribute = "name") {
  if (typeof document === "undefined") return;
  const selector = `meta[${attribute}="${name}"]`;
  let element = document.head.querySelector(selector);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, name);
    document.head.appendChild(element);
  }
  element.setAttribute("content", content);
}

function ensureCanonicalLink(href) {
  if (typeof document === "undefined") return;
  let element = document.head.querySelector('link[rel="canonical"]');
  if (!element) {
    element = document.createElement("link");
    element.setAttribute("rel", "canonical");
    document.head.appendChild(element);
  }
  element.setAttribute("href", href);
}

function applyJsonLd(id, payload) {
  if (typeof document === "undefined") return;
  let element = document.getElementById(id);
  if (!element) {
    element = document.createElement("script");
    element.type = "application/ld+json";
    element.id = id;
    document.head.appendChild(element);
  }
  element.textContent = JSON.stringify(payload);
}

function ensureMetaPixelBaseCode() {
  if (typeof document === "undefined") return;
  if (!document.getElementById(META_PIXEL_SCRIPT_ID)) {
    const script = document.createElement("script");
    script.id = META_PIXEL_SCRIPT_ID;
    script.textContent = `
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${META_PIXEL_ID}');
`;
    document.head.appendChild(script);
  }

  if (!document.getElementById(META_PIXEL_NOSCRIPT_ID)) {
    const noscript = document.createElement("noscript");
    noscript.id = META_PIXEL_NOSCRIPT_ID;
    noscript.innerHTML = `<img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${META_PIXEL_ID}&ev=PageView&noscript=1" />`;
    document.head.appendChild(noscript);
  }
}

function trackMetaPixelPageView() {
  if (typeof window === "undefined") return;
  ensureMetaPixelBaseCode();
  if (typeof window.fbq !== "function") return;
  const trackedPageViews =
    window.__csaMetaPixelTrackedPageViews ||
    (window.__csaMetaPixelTrackedPageViews = new Set());
  const pageViewKey = window.location.href;
  if (trackedPageViews.has(pageViewKey)) return;
  window.fbq("track", "PageView");
  trackedPageViews.add(pageViewKey);
}

function getMarketingQueryString() {
  if (typeof window === "undefined") return "";
  const parts = [];
  const search = String(window.location.search || "").replace(/^\?/, "");
  if (search) parts.push(search);
  const hash = String(window.location.hash || "");
  const hashQueryIndex = hash.indexOf("?");
  if (hashQueryIndex >= 0) {
    const hashQuery = hash.slice(hashQueryIndex + 1).split("#")[0];
    if (hashQuery) parts.push(hashQuery);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function getMarketingSourcePath() {
  if (typeof window === "undefined") return "";
  const hash = String(window.location.hash || "");
  const hashPath = hash ? hash.split("?")[0] : "";
  return `${window.location.pathname}${hashPath}`;
}

function storeUrlFallback() {
  return "https://fullfarmcsa.deckfamilyfarm.com/";
}

function buildInitialForm(dropSites = []) {
  return {
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    confirmPassword: "",
    phone: "",
    country: "United States",
    addressLine1: "",
    addressLine2: "",
    city: "",
    stateProvince: "Oregon",
    postalCode: "",
    referralSource: "",
    referralSourceDetail: "",
    selectedPlan: "forager",
    billingDayOfMonth: 1,
    selectedDropSite: "",
    hasCurrentSnapEbtCard: false,
    isFarmEmployee: false,
    notes: "",
    liabilityAgreementAccepted: false,
    liabilityAgreementSignerName: "",
    liabilityAgreementSignatureMode: "typed"
  };
}

function getReferralSourceDetailField(referralSource) {
  if (referralSource === FARMERS_MARKET_REFERRAL_SOURCE) {
    return {
      label: "Who can we thank?",
      placeholder: "Farmers market rep name"
    };
  }
  if (referralSource === CURRENT_MEMBER_REFERRAL_SOURCE) {
    return {
      label: "Who can we thank?",
      placeholder: "CSA member name"
    };
  }
  if (referralSource === FRIEND_OR_FAMILY_REFERRAL_SOURCE) {
    return {
      label: "Who can we thank?",
      placeholder: "Friend or family member name"
    };
  }
  if (referralSource === DROP_SITE_REFERRAL_SOURCE) {
    return {
      label: "Which dropsite host can we thank?",
      placeholder: "Host or pickup site name"
    };
  }
  if (referralSource === COMMUNITY_EVENT_REFERRAL_SOURCE) {
    return {
      label: "Which community event?",
      placeholder: "Event name"
    };
  }
  if (referralSource === FARM_PARTNER_REFERRAL_SOURCE) {
    return {
      label: "Who can we thank?",
      placeholder: "Farm, business, or person"
    };
  }
  if (referralSource === OTHER_REFERRAL_SOURCE) {
    return {
      label: "Other source",
      placeholder: "Name of the person, place, or source"
    };
  }
  return null;
}

function buildReferralSourceSummary(form) {
  const source = String(form.referralSource || "").trim();
  const detail = String(form.referralSourceDetail || "").trim();
  if (!source) return "";
  if (!detail) return source;
  if (source === FARMERS_MARKET_REFERRAL_SOURCE) {
    return `${source} - Rep: ${detail}`;
  }
  if (source === CURRENT_MEMBER_REFERRAL_SOURCE) {
    return `${source} - Member: ${detail}`;
  }
  if (source === FRIEND_OR_FAMILY_REFERRAL_SOURCE) {
    return `${source} - Friend/family: ${detail}`;
  }
  if (source === DROP_SITE_REFERRAL_SOURCE) {
    return `${source} - Host/site: ${detail}`;
  }
  if (source === COMMUNITY_EVENT_REFERRAL_SOURCE) {
    return `${source} - Event: ${detail}`;
  }
  if (source === FARM_PARTNER_REFERRAL_SOURCE) {
    return `${source} - Partner: ${detail}`;
  }
  if (source === OTHER_REFERRAL_SOURCE) {
    return `${source} - ${detail}`;
  }
  return `${source} - ${detail}`;
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

function formatDropSiteTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?$/);
  if (!match) return text;

  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return text;
  }

  const period = hour >= 12 ? "pm" : "am";
  const displayHour = hour % 12 || 12;
  return minute ? `${displayHour}:${String(minute).padStart(2, "0")}${period}` : `${displayHour}${period}`;
}

function formatDropSiteWindow(site) {
  const openTime = formatDropSiteTime(site?.openTime);
  const closeTime = formatDropSiteTime(site?.closeTime);
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

function getDropSiteDaySortValue(site) {
  const normalized = String(site?.dayOfWeek || "").trim().toLowerCase();
  const order = {
    mon: 1,
    monday: 1,
    tue: 2,
    tues: 2,
    tuesday: 2,
    wed: 3,
    wednesday: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6,
    sun: 7,
    sunday: 7
  };
  return order[normalized] || 99;
}

function sortDropSitesByDayThenName(left, right) {
  const dayDelta = getDropSiteDaySortValue(left) - getDropSiteDaySortValue(right);
  if (dayDelta !== 0) return dayDelta;
  return String(left.name || "").localeCompare(String(right.name || ""));
}

function DropSiteTable({ title, orderWindow, sites = [], showDay = false }) {
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
              {showDay ? <th>Day</th> : null}
              <th>Time of Day</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => (
              <tr key={site.id || site.name}>
                <td data-label="Name">{site.name}</td>
                {showDay ? (
                  <td data-label="Day">{formatDayOfWeekLabel(site.dayOfWeek) || "—"}</td>
                ) : null}
                <td data-label="Time of Day">{formatDropSiteWindow(site) || "—"}</td>
                <td data-label="Address">{formatDropSiteAddress(site) || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function buildLiabilityReleaseUrl(slug, portalBaseHref) {
  try {
    const baseOrigin =
      typeof window !== "undefined" ? window.location.origin : "https://fullfarmcsa.deckfamilyfarm.com";
    const url = new URL(portalBaseHref || baseOrigin, baseOrigin);
    url.pathname = `/liability/${slug}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (_error) {
    return `/liability/${slug}`;
  }
}

export function SubscribePage({
  dropSites = [],
  portalBaseUrl,
  isLoggedIn = false,
  onAuthAction = null,
  siteContent = {}
}) {
  const allFaqs = useMemo(() => FAQS, []);
  const portalBaseHref = useMemo(
    () => String(portalBaseUrl || subscriptionStoreUrl()).replace(/#.*$/, "").replace(/\/+$/, ""),
    [portalBaseUrl]
  );
  const visitorLiabilityReleaseUrl = useMemo(
    () => buildLiabilityReleaseUrl("visitor", portalBaseHref),
    [portalBaseHref]
  );
  const horseLiabilityReleaseUrl = useMemo(
    () => buildLiabilityReleaseUrl("horse", portalBaseHref),
    [portalBaseHref]
  );
  const firearmLiabilityReleaseUrl = useMemo(
    () => buildLiabilityReleaseUrl("firearm", portalBaseHref),
    [portalBaseHref]
  );
  const subscribeNavLinks = useMemo(
    () => buildSubscribeNavLinks(),
    []
  );
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
  const tuesdayCycleDropSites = useMemo(
    () =>
      pickupDropSites
        .filter((site) =>
          ["tue", "tues", "tuesday", "wed", "wednesday"].includes(
            String(site.dayOfWeek || "").toLowerCase()
          )
        )
        .sort(sortDropSitesByDayThenName),
    [pickupDropSites]
  );
  const fridaySaturdayCycleDropSites = useMemo(
    () =>
      pickupDropSites
        .filter((site) =>
          ["fri", "friday", "sat", "saturday"].includes(
            String(site.dayOfWeek || "").toLowerCase()
          )
        )
        .sort(sortDropSitesByDayThenName),
    [pickupDropSites]
  );
  const [form, setForm] = useState(() => buildInitialForm(siteOptions));
  const [status, setStatus] = useState({ submitting: false, success: false, error: "" });
  const [agreementModalOpen, setAgreementModalOpen] = useState(false);
  const [agreementSaved, setAgreementSaved] = useState(false);
  const [dropSiteVideoOpen, setDropSiteVideoOpen] = useState(false);
  const [addressInsights, setAddressInsights] = useState(null);
  const [addressCheckError, setAddressCheckError] = useState("");
  const [addressCheckSource, setAddressCheckSource] = useState("");
  const [checkingAddress, setCheckingAddress] = useState(false);
  const formStatusRef = useRef(null);
  const formCardRef = useRef(null);
  const marketingSessionTokenRef = useRef("");
  const copy = (section, field, fallback) =>
    getSiteContentValue(siteContent, "subscribe", section, field, fallback);

  useEffect(() => {
    const canonicalUrl = window.location.href.split("#")[0];
    const title = "Full Farm Subscribe Page";
    const description =
      "Join Full Farm from Deck Family Farm for pasture-raised eggs, meat, raw dairy, and nutrient-dense local food with pickup in Portland, Eugene, Salem, Corvallis, and home delivery in qualifying Oregon areas.";
    const faqEntities = allFaqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer
      }
    }));
    const organizationSchema = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Deck Family Farm",
      url: canonicalUrl,
      brand: {
        "@type": "Brand",
        name: "Full Farm"
      },
      areaServed: [
        "Portland, Oregon",
        "Eugene, Oregon",
        "Springfield, Oregon",
        "Junction City, Oregon",
        "Salem, Oregon",
        "Corvallis, Oregon",
        "Beaverton, Oregon",
        "Oregon City, Oregon"
      ],
      knowsAbout: [
        "pasture-raised eggs",
        "pasture-raised meat",
        "raw dairy",
        "grass-fed beef",
        "local farm food",
        "Full Farm membership",
        "home delivery",
        "pickup sites"
      ]
    };
    const serviceSchema = {
      "@context": "https://schema.org",
      "@type": "Service",
      serviceType: "Full Farm membership, farm food pickup, and home delivery",
      provider: {
        "@type": "Organization",
        name: "Deck Family Farm"
      },
      areaServed: [
        "Portland, Oregon",
        "Eugene, Oregon",
        "Springfield, Oregon",
        "Junction City, Oregon",
        "Salem, Oregon",
        "Corvallis, Oregon"
      ],
      description:
        "Full Farm helps Oregon households buy pasture-raised eggs, meat, raw dairy, and other nutrient-dense local foods through neighborhood pickup sites and home delivery in qualifying areas.",
      offers: SUBSCRIBE_PLANS.filter((plan) => plan.value !== "guest").map((plan) => ({
        "@type": "Offer",
        name: plan.title,
        priceCurrency: "USD",
        price: String(plan.price || "").replace(/[^0-9.]/g, "")
      }))
    };
    const faqSchema = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqEntities
    };

    document.title = title;
    ensureMetaTag("description", description);
    ensureMetaTag("robots", "index,follow,max-image-preview:large");
    ensureMetaTag("og:title", title, "property");
    ensureMetaTag("og:description", description, "property");
    ensureMetaTag("og:type", "website", "property");
    ensureMetaTag("og:url", canonicalUrl, "property");
    ensureCanonicalLink(canonicalUrl);
    applyJsonLd("subscribe-organization-schema", organizationSchema);
    applyJsonLd("subscribe-service-schema", serviceSchema);
    applyJsonLd("subscribe-faq-schema", faqSchema);
    trackMetaPixelPageView();

    const pageViewKey = window.location.href;
    window.__csaMarketingPageViewPromises = window.__csaMarketingPageViewPromises || new Map();
    if (!window.__csaMarketingPageViewPromises.has(pageViewKey)) {
      window.__csaMarketingPageViewPromises.set(
        pageViewKey,
        trackMarketingEvent({
          eventType: "page_view",
          pageUrl: window.location.href,
          destinationUrl: window.location.href,
          referrerUrl: document.referrer || "",
          sourceHost: window.location.host,
          sourcePath: getMarketingSourcePath(),
          queryString: getMarketingQueryString()
        }).catch(() => null)
      );
    }
    window.__csaMarketingPageViewPromises.get(pageViewKey)?.then((response) => {
      if (response?.sessionToken) {
        marketingSessionTokenRef.current = response.sessionToken;
      }
    });
  }, [allFaqs]);

  useEffect(() => {
    if (!dropSiteVideoOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setDropSiteVideoOpen(false);
      }
    };
    document.body.classList.add("modal-open");
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.classList.remove("modal-open");
    };
  }, [dropSiteVideoOpen]);

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
      setAddressCheckSource("");
    }
    if (
      key === "liabilityAgreementAccepted" ||
      key === "liabilityAgreementSignerName"
    ) {
      setAgreementSaved(false);
    }
    if (key === "referralSource") {
      setForm((prev) => ({
        ...prev,
        referralSource: value,
        referralSourceDetail:
          value === prev.referralSource && getReferralSourceDetailField(value)
            ? prev.referralSourceDetail
            : ""
      }));
      return;
    }
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setPreferredDropSite(siteName) {
    setForm((prev) => ({
      ...prev,
      selectedDropSite: siteName || ""
    }));
    setAddressInsights(null);
    setAddressCheckError("");
    setAddressCheckSource("");
  }

  async function handleCheckAddress(source = "form") {
    setCheckingAddress(true);
    setAddressCheckError("");
    setAddressCheckSource(source);
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

  const addressCheckDisabled =
    checkingAddress ||
    !(form.city.trim() || form.postalCode.trim()) ||
    !form.stateProvince.trim() ||
    (form.addressLine1.trim() && !(form.city.trim() && form.postalCode.trim()));

  function handleAddressCheckSubmit(event) {
    event.preventDefault();
    if (!addressCheckDisabled) {
      handleCheckAddress("hero");
    }
  }

  function renderAddressInsightsPanel(source = "form") {
    if (addressCheckSource && addressCheckSource !== source) return null;
    if (!addressInsights) return null;
    return (
      <div className="subscribe-address-insights card">
        <div className="small subscribe-address-insights-eyebrow">
          Address insights
        </div>
        <div className="subscribe-address-insights-grid">
          <div>
            <strong>Validated address</strong>
            <div>
              {addressInsights.lookupPrecision === "area" ? "Approximate area" : "Validated address"}
            </div>
            <div className="small">{addressInsights.geocodedDisplayName || "—"}</div>
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
              {addressInsights.homeDeliveryCheckRequiresStreetAddress
                ? "Add street address to confirm"
                : addressInsights.insideHomeDeliveryArea === true
                ? "Inside delivery area"
                : addressInsights.insideHomeDeliveryArea === false
                  ? "Outside delivery area"
                  : "Unavailable"}
            </div>
            {addressInsights.insideHomeDeliveryArea === true &&
            addressInsights.preferredHomeDeliverySite?.name ? (
              <div className="subscribe-nearest-pickup-item" style={{ marginTop: 8 }}>
                <div>
                  <div>
                    <strong>{addressInsights.preferredHomeDeliverySite.name}</strong>
                  </div>
                  {addressInsights.preferredHomeDeliverySite.dayOfWeek ? (
                    <div className="small">
                      {formatDayOfWeekLabel(
                        addressInsights.preferredHomeDeliverySite.dayOfWeek
                      )}
                    </div>
                  ) : null}
                  {addressInsights.preferredHomeDeliverySite.address ? (
                    <div className="small">
                      {addressInsights.preferredHomeDeliverySite.address}
                    </div>
                  ) : null}
                </div>
                <button
                  className="button alt"
                  type="button"
                  onClick={() =>
                    setPreferredDropSite(
                      addressInsights.preferredHomeDeliverySite.name
                    )
                  }
                >
                  Set as preferred option
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
    );
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
    setAgreementSaved(true);
    setStatus({ submitting: false, success: false, error: "" });
    setAgreementModalOpen(false);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus({ submitting: true, success: false, error: "" });
    try {
      if (SUBSCRIBE_PORTAL_ONBOARDING_ENABLED) {
        if (!form.password || form.password.length < 8) {
          throw new Error("Create a password with at least 8 characters.");
        }
        if (form.password !== form.confirmPassword) {
          throw new Error("Password confirmation does not match.");
        }
      }
      if (!form.liabilityAgreementAccepted) {
        throw new Error("You must agree to the product liability agreement.");
      }
      if (!form.liabilityAgreementSignerName.trim()) {
        throw new Error("Enter the signer name for the product liability agreement.");
      }
      if (!agreementSaved) {
        throw new Error("Please review and save the agreement before submitting.");
      }
      const plan = SUBSCRIBE_PLANS.find((entry) => entry.value === form.selectedPlan);
      const { billingDayOfMonth, ...leadForm } = form;
      const referralSourceSummary = buildReferralSourceSummary(form);
      const marketingQueryString = getMarketingQueryString();
      const marketingSearchParams = new URLSearchParams(marketingQueryString);
      const csaTrackToken =
        marketingSearchParams.get("csa_track") ||
        marketingSearchParams.get("csa_session") ||
        marketingSessionTokenRef.current ||
        "";
      const response = await submitSubscribeLead({
        ...leadForm,
        referralSource: referralSourceSummary,
        referralSourceSelection: form.referralSource,
        referralSourceDetail: form.referralSourceDetail,
        selectedPlanLabel: plan?.title || form.selectedPlan,
        ...(SUBSCRIBE_PORTAL_ONBOARDING_ENABLED
          ? { billingDayOfMonth: Number(billingDayOfMonth || 1) }
          : {}),
        liabilityAgreementSignatureMode: "typed",
        liabilityAgreementSignatureDataUrl: "",
        ...(csaTrackToken ? { csaTrackToken } : {}),
        sourceHost: window.location.host,
        sourcePath: getMarketingSourcePath(),
        referrerUrl: document.referrer || "",
        pageUrl: window.location.href,
        queryString: marketingQueryString
      });
      setAddressInsights(response?.addressInsights || addressInsights);
      if (SUBSCRIBE_PORTAL_ONBOARDING_ENABLED && response?.token) {
        window.localStorage.setItem("userToken", response.token);
        setStatus({ submitting: false, success: true, error: "" });
        window.setTimeout(() => {
          window.location.href = portalAccountUrl;
        }, 0);
        return;
      }
      setStatus({ submitting: false, success: true, error: "" });
      window.setTimeout(() => {
        formCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    } catch (error) {
      setStatus({
        submitting: false,
        success: false,
        error: error?.message || "Unable to submit your information right now."
      });
      window.setTimeout(() => {
        formCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    }
  }

  const referralSourceDetailField = getReferralSourceDetailField(form.referralSource);

  return (
    <div className="subscribe-page">
      <DeckPageHeader
        navLinks={subscribeNavLinks}
        authLabel={MEMBER_PORTAL_LINK_ENABLED ? (isLoggedIn ? "Log out" : "Log in") : ""}
        onAuthAction={MEMBER_PORTAL_LINK_ENABLED ? onAuthAction : null}
      />

      <main>
        <section className="subscribe-hero">
          <div className="container subscribe-hero-grid">
            <div className="subscribe-hero-copy">
              <div className="eyebrow">{copy("hero", "eyebrow", "Deck Family Farm")}</div>
              <h1 className="subscribe-title">{copy("hero", "title", "Welcome to Full Farm")}</h1>
              <p className="subscribe-lede subscribe-welcome-line">
                {copy("hero", "welcomeLine", "We are happy you're here.")}
              </p>
              <div className="subscribe-member-shop-cta">
                <a className="button subscribe-member-shop-button" href={subscriptionStoreUrl()}>
                  Browse the store
                </a>
              </div>
              <form className="subscribe-address-check-card" onSubmit={handleAddressCheckSubmit}>
                <div>
                  <div className="eyebrow">DELIVERY AND PICKUP OPTIONS</div>
                </div>
                <div className="subscribe-address-check-grid">
                  <label className="filter-field">
                    <span className="small">City</span>
                    <input
                      className="input"
                      value={form.city}
                      onChange={(event) => updateField("city", event.target.value)}
                      autoComplete="address-level2"
                    />
                  </label>
                  <label className="filter-field">
                    <span className="small">ZIP</span>
                    <input
                      className="input"
                      value={form.postalCode}
                      onChange={(event) => updateField("postalCode", event.target.value)}
                      autoComplete="postal-code"
                    />
                  </label>
                  <label className="filter-field">
                    <span className="small">Street address for delivery</span>
                    <input
                      className="input"
                      value={form.addressLine1}
                      onChange={(event) => updateField("addressLine1", event.target.value)}
                      autoComplete="street-address"
                    />
                  </label>
                </div>
                <div className="button-row">
                  <button className="button" type="submit" disabled={addressCheckDisabled}>
                    {checkingAddress ? "Checking area..." : "Check my area"}
                  </button>
                </div>
                {addressCheckSource === "hero" && addressCheckError ? (
                  <div className="small subscribe-error">{addressCheckError}</div>
                ) : null}
                {renderAddressInsightsPanel("hero")}
              </form>
              <figure className="subscribe-hero-image-card">
                <img
                  src="/images/subscribe-products.jpg"
                  alt="Full Farm products arranged together"
                />
              </figure>
              <p className="subscribe-lede">
                {copy(
                  "hero",
                  "body",
                  "Full Farm provides essential staples from Deck Family Farm and other hyper-local farms with shared growing standards. Members can shop online for pickup at local farmers markets, drop sites, and home delivery. Membership involves a scheduled monthly payment: 100% of your monthly payment is store credit, with no hidden fees. Any unused balance rolls over for future shopping!"
                )}
              </p>
              <p className="subscribe-lede">
                {copy(
                  "hero",
                  "feeBody",
                  "We charge a one-time membership fee of $50 which includes Herdshare Agreement and access to raw dairy products."
                )}
              </p>
              <p className="subscribe-lede">
                Read our <a href="#faqs">FAQs</a> at the bottom of this page to learn more.
              </p>
              <figure className="subscribe-hero-image-card subscribe-hero-image-card-secondary">
                <img
                  src="/images/subscribe-dairy-top.jpg"
                  alt="Deck Family Farm dairy products"
                />
              </figure>
              <div className="subscribe-hero-notes">
                <div className="subscribe-note-card">
                  <strong>$50 one-time membership fee</strong>
                  <span>Includes Herdshare Agreement and access to raw dairy products.</span>
                </div>
                <div className="subscribe-note-card">
                  <strong>After submitting this form</strong>
                  <span>
                    {SUBSCRIBE_PORTAL_ONBOARDING_ENABLED
                      ? "Your account will be created and you will continue into the member portal to enter your payment method."
                      : "We will record your subscription request and follow up manually with next steps."}
                  </span>
                </div>
              </div>
            </div>

            <div ref={formCardRef} className="subscribe-form-card card">
              {!status.success ? (
                <>
                  <div className="eyebrow">Get started</div>
                  <h2 className="h2">Personal information</h2>
                  <p className="small">
                    {copy(
                      "form",
                      "introBody",
                      "First, give us your name, email, phone number, address, and preferred plan."
                    )}
                  </p>
                </>
              ) : null}

              {status.success ? (
                <div className="subscribe-success">
                  <h2 className="h2">
                    {SUBSCRIBE_PORTAL_ONBOARDING_ENABLED ? "Account Created" : "Request Received"}
                  </h2>
                  {SUBSCRIBE_PORTAL_ONBOARDING_ENABLED ? (
                    <p>
                      We recorded your subscription request and created your member account. Continue
                      to the member portal to add a payment method and activate recurring billing.
                    </p>
                  ) : (
                    <p>
                      We recorded your subscription request. We will review it and follow up with
                      next steps for setting up your membership manually.
                    </p>
                  )}
                  <div className="button-row">
                    <button
                      className="button alt"
                      type="button"
                      onClick={() => {
                        setForm(buildInitialForm(siteOptions));
                        setAgreementSaved(false);
                        setAddressInsights(null);
                        setAddressCheckError("");
                        setAddressCheckSource("");
                        setStatus({ submitting: false, success: false, error: "" });
                      }}
                    >
                      Close
                    </button>
                    {SUBSCRIBE_PORTAL_ONBOARDING_ENABLED ? (
                      <a className="button" href={portalAccountUrl}>
                        Continue to Member Portal
                      </a>
                    ) : null}
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
                    {SUBSCRIBE_PORTAL_ONBOARDING_ENABLED ? (
                      <>
                        <label className="filter-field">
                          <span className="small">Create password*</span>
                          <input
                            className="input"
                            type="password"
                            value={form.password}
                            onChange={(event) => updateField("password", event.target.value)}
                            minLength={8}
                            required
                          />
                        </label>
                        <label className="filter-field">
                          <span className="small">Confirm password*</span>
                          <input
                            className="input"
                            type="password"
                            value={form.confirmPassword}
                            onChange={(event) => updateField("confirmPassword", event.target.value)}
                            minLength={8}
                            required
                          />
                        </label>
                      </>
                    ) : null}
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
                      onClick={() => handleCheckAddress("form")}
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
                  {addressCheckSource === "form" && addressCheckError ? (
                    <div className="small subscribe-error">{addressCheckError}</div>
                  ) : null}
                  {renderAddressInsightsPanel("form")}

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
                            {plan.selectLabel || plan.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    {SUBSCRIBE_PORTAL_ONBOARDING_ENABLED ? (
                      <label className="filter-field">
                        <span className="small">Billing day of month</span>
                        <input
                          className="input"
                          type="number"
                          min="1"
                          max="28"
                          value={form.billingDayOfMonth}
                          onChange={(event) => updateField("billingDayOfMonth", event.target.value)}
                        />
                      </label>
                    ) : null}
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

                  <div className="subscribe-option-checklist">
                    <label className="subscribe-option-check">
                      <input
                        type="checkbox"
                        checked={Boolean(form.hasCurrentSnapEbtCard)}
                        onChange={(event) =>
                          updateField("hasCurrentSnapEbtCard", event.target.checked)
                        }
                      />
                      <span>
                        I have a current SNAP/EBT card from USDA.gov and would like to use it for
                        this subscription. DO NOT CLICK THIS BOX IF YOU DO NOT HAVE A CURRENT EBT
                        CARD.
                      </span>
                    </label>
                    <label className="subscribe-option-check">
                      <input
                        type="checkbox"
                        checked={Boolean(form.isFarmEmployee)}
                        onChange={(event) => updateField("isFarmEmployee", event.target.checked)}
                      />
                      <span>I am an employee of Deck Family Farm, Full Farm CSA, or Creamy Cow LLC.</span>
                    </label>
                  </div>

                  <div className="subscribe-form-grid">
                    <label className="filter-field">
                      <span className="small">How did you hear about us?</span>
                      <select
                        className="select"
                        value={form.referralSource}
                        onChange={(event) => updateField("referralSource", event.target.value)}
                      >
                        <option value="">Select one</option>
                        {REFERRAL_SOURCE_OPTIONS.map((source) => (
                          <option key={source} value={source}>
                            {source}
                          </option>
                        ))}
                      </select>
                    </label>
                    {referralSourceDetailField ? (
                      <label className="filter-field">
                        <span className="small">{referralSourceDetailField.label}</span>
                        <input
                          className="input"
                          value={form.referralSourceDetail}
                          onChange={(event) =>
                            updateField("referralSourceDetail", event.target.value)
                          }
                          placeholder={referralSourceDetailField.placeholder}
                        />
                      </label>
                    ) : null}
                  </div>

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
                        ? `Agreement saved for ${form.liabilityAgreementSignerName} using typed name signature.`
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
                  </div>
                </form>
              )}
            </div>
          </div>
        </section>

        <section className="section subscribe-proof">
          <div className="container">
            <div className="subscribe-section-head subscribe-section-head-centered">
              <div className="eyebrow">Testimonials</div>
              <h2 className="h2">What people are saying</h2>
            </div>
            <div className="subscribe-proof-title">What people are saying</div>
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
                  {plan.note ? <div className="small subscribe-plan-note">{plan.note}</div> : null}
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
              <button
                className="button subscribe-drop-site-video-button"
                type="button"
                onClick={() => setDropSiteVideoOpen(true)}
              >
                Video on how to shop like a local!
              </button>
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
                title="Tuesday / Wednesday Dropsites"
                orderWindow="order window Thursday through Sunday"
                sites={tuesdayCycleDropSites}
                showDay
              />
              <DropSiteTable
                title="Friday / Saturday Dropsites"
                orderWindow="order window Monday through Wednesday"
                sites={fridaySaturdayCycleDropSites}
                showDay
              />
            </div>
            <div className="subscribe-drop-site-host-callout">
              <div>
                <h3>Want to become a drop site?</h3>
                <p className="lede">
                  The drop-site host page explains host responsibilities, monthly host credit
                  criteria, pickup resources, performance summaries, and the form to tell us about
                  your proposed pickup location.
                </p>
              </div>
              <a
                className="button alt"
                href={getDropsitesHostUrl()}
                target="_blank"
                rel="noreferrer"
              >
                Visit drop-site host page
              </a>
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
                  cream, and cheeses have been a staple of Full Farm since we began delivering Full
                  Farm products in 2017. The herdshare agreement means that each member owns a portion of
                  a cow, and in turn, Creamy Cow, LLC performs a milking service (see agistment
                  agreement).
                </p>
                <p className="lede">
                  Our $50 Full Farm membership fee includes financial support for the dairy herd, which
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

        <section className="section subscribe-discovery-section">
          <div className="container">
            <div className="subscribe-section-head subscribe-section-head-centered">
              <div className="eyebrow">Find local food</div>
              <h2 className="h2">
                Where to find pasture-raised eggs, meat, pickup, and home delivery
              </h2>
            </div>
            <p className="lede subscribe-discovery-lede">
              Deck Family Farm and Full Farm help households in Portland, Eugene, Salem,
              Corvallis, Springfield, and nearby areas find nutrient-dense local food with pickup
              sites, farmers market access, and home delivery for qualifying addresses.
            </p>
            <div className="subscribe-discovery-grid">
              {DISCOVERY_CARDS.map((card) => (
                <article key={card.title} className="card subscribe-discovery-card">
                  <h3>{card.title}</h3>
                  <p>{card.copy}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section subscribe-partners-section" id="vendors">
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
              {SUBSCRIBE_PARTNERS.map((partner) => (
                <article key={partner.name} className="card subscribe-partner-card">
                  <figure className="subscribe-partner-image-frame">
                    <img src={partner.imageUrl} alt={partner.alt} loading="lazy" />
                  </figure>
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
              {allFaqs.map((faq) => (
                <details key={faq.question} className="card subscribe-faq-item">
                  <summary>{faq.question}</summary>
                  <p>{faq.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      {dropSiteVideoOpen ? (
        <div className="modal-backdrop" onClick={() => setDropSiteVideoOpen(false)}>
          <div
            className="modal modal-small subscribe-video-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="subscribe-drop-site-video-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              type="button"
              onClick={() => setDropSiteVideoOpen(false)}
              aria-label="Close video"
            >
              Close
            </button>
            <div className="modal-body single">
              <div className="subscribe-video-modal-content">
                <h3 id="subscribe-drop-site-video-title">How to shop at a drop site</h3>
                <div className="subscribe-video-frame">
                  <iframe
                    src={DROP_SITE_SHOP_VIDEO_EMBED_URL}
                    title="How to shop at a drop site"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                  />
                </div>
                <div className="button-row">
                  <a
                    className="button alt"
                    href={DROP_SITE_SHOP_VIDEO_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open on YouTube
                  </a>
                  <button
                    className="button"
                    type="button"
                    onClick={() => setDropSiteVideoOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

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
              <div className="small">
                Your typed full name above will be used as your electronic signature on the saved PDF.
              </div>
              <div className="button-row">
                <button className="button" type="button" onClick={handleSaveAgreement}>
                  Save Agreement
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <SubscribeFooter
        visitorLiabilityReleaseUrl={visitorLiabilityReleaseUrl}
        horseLiabilityReleaseUrl={horseLiabilityReleaseUrl}
        firearmLiabilityReleaseUrl={firearmLiabilityReleaseUrl}
      />
    </div>
  );
}
