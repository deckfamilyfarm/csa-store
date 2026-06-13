export function subscriptionStoreUrl() {
  return "https://fullfarmcsa.deckfamilyfarm.com/";
}

function isLocalHost() {
  if (typeof window === "undefined") return false;
  const host = String(window.location.host || "").toLowerCase();
  return host.includes("localhost") || host.includes("127.0.0.1");
}

function localPath(path) {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

export function getSubscribeHostUrl() {
  return isLocalHost() ? localPath("/subscribe") : "https://subscribe.deckfamilyfarm.com/";
}

export function getDropsitesHostUrl() {
  return isLocalHost() ? localPath("/dropsites") : "https://dropsites.deckfamilyfarm.com/";
}

export function buildSubscribeNavLinks() {
  return [
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
        { label: "Subscribe", href: getSubscribeHostUrl() },
        { label: "Become a Drop Site Host", href: getDropsitesHostUrl() }
      ]
    },
    { label: "Newsletter", href: "https://www.deckfamilyfarm.com/blog" },
    { label: "Events", href: "https://www.deckfamilyfarm.com/events" },
    {
      label: "Shop",
      children: [
        { label: "CSA Shopping", href: subscriptionStoreUrl() },
        { label: "Merchandise", href: "https://www.deckfamilyfarm.com/merchandise" }
      ]
    }
  ];
}
