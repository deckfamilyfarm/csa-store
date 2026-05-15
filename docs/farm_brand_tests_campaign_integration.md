# Farm Brand Tests Campaign Integration

Treat `../farm-brand-tests` as a single marketing campaign with multiple page or CTA variants.

## Campaign Model

Use one campaign for the current test wave:

- campaign slug: `farm-brand-tests-2026-05`
- campaign name: `Farm Brand Tests May 2026`

Use one tracked link per variant:

- `farm-brand-tests-farm-a`
- `farm-brand-tests-csa-b`
- `farm-brand-tests-food-c`

Recommended tag pattern:

- `utm_source=farm-brand-tests`
- `utm_medium=landing-page`
- `utm_campaign=farm-brand-tests-2026-05`
- `utm_content=<variant>`
- `csa_message_focus=<farm|csa|food>`
- optional `csa_target_city=<city>`
- optional `csa_target_location=<label>`

## Admin API: Create Campaign

Create the campaign in CSA Store:

```http
POST /api/admin/marketing/campaigns
Content-Type: application/json
```

```json
{
  "slug": "farm-brand-tests-2026-05",
  "name": "Farm Brand Tests May 2026",
  "status": "active",
  "platform": "web",
  "channel": "landing-page",
  "messageFocus": "mixed",
  "destinationType": "subscribe",
  "destinationUrl": "https://subscribe.deckfamilyfarm.com/",
  "notes": "Campaign for farm-brand-tests landing page and brand/message experiments."
}
```

## Admin API: Create Tracked Links

Create one tracked link per variant:

```http
POST /api/admin/marketing/utm-links
Content-Type: application/json
```

```json
{
  "campaignId": 1,
  "slug": "farm-brand-tests-farm-a",
  "label": "Farm Brand Test - Farm Angle A",
  "channel": "landing-page",
  "destinationType": "subscribe",
  "destinationUrl": "https://subscribe.deckfamilyfarm.com/",
  "utmSource": "farm-brand-tests",
  "utmMedium": "landing-page",
  "utmCampaign": "farm-brand-tests-2026-05",
  "utmContent": "farm-a",
  "messageFocus": "farm",
  "usageInstructions": "Use on the Farm A variant CTA button."
}
```

Example additional variants:

- `farm-brand-tests-csa-b`
  - `utmContent = csa-b`
  - `messageFocus = csa`
- `farm-brand-tests-food-c`
  - `utmContent = food-c`
  - `messageFocus = food`

## Client Integration Pattern

`farm-brand-tests` should do two things:

1. track the page view
2. route the CTA through the CSA Store tracked link

## Page-View Tracking Example

Call this once per page load.

```js
async function trackMarketingPageView({
  apiBase,
  variant,
  messageFocus,
  targetCity = "",
  targetLocation = ""
}) {
  const payload = {
    pageUrl: window.location.href,
    referrerUrl: document.referrer || "",
    eventType: "page_view",
    utm_source: "farm-brand-tests",
    utm_medium: "landing-page",
    utm_campaign: "farm-brand-tests-2026-05",
    utm_content: variant,
    csa_message_focus: messageFocus,
    csa_target_city: targetCity,
    csa_target_location: targetLocation
  };

  const response = await fetch(`${apiBase}/api/marketing/track`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("Failed to record marketing page view");
  }

  return response.json();
}
```

This returns a `sessionToken`.

## CTA Link Pattern

Use the returned `sessionToken` when building the CTA URL so the click and the subscribe submit stay tied to the same tracked session.

```js
function buildTrackedSubscribeUrl({
  apiBase,
  linkSlug,
  sessionToken
}) {
  const url = new URL(`${apiBase}/api/marketing/go/${linkSlug}`);
  if (sessionToken) {
    url.searchParams.set("csa_track", sessionToken);
  }
  return url.toString();
}
```

Example:

```js
const tracking = await trackMarketingPageView({
  apiBase: "https://subscribe.deckfamilyfarm.com",
  variant: "farm-a",
  messageFocus: "farm",
  targetCity: "Eugene",
  targetLocation: "Eugene"
});

const ctaUrl = buildTrackedSubscribeUrl({
  apiBase: "https://subscribe.deckfamilyfarm.com",
  linkSlug: "farm-brand-tests-farm-a",
  sessionToken: tracking.sessionToken
});
```

Then use `ctaUrl` for the main button:

```html
<a href="https://subscribe.deckfamilyfarm.com/api/marketing/go/farm-brand-tests-farm-a?csa_track=...">
  Join Full Farm CSA
</a>
```

## Recommended Variant Mapping

Suggested first pass:

- Farm page
  - `utm_content=farm-a`
  - `csa_message_focus=farm`
  - tracked link slug: `farm-brand-tests-farm-a`
- CSA value page
  - `utm_content=csa-b`
  - `csa_message_focus=csa`
  - tracked link slug: `farm-brand-tests-csa-b`
- Food / meal page
  - `utm_content=food-c`
  - `csa_message_focus=food`
  - tracked link slug: `farm-brand-tests-food-c`

## What CSA Store Will Capture

When this is wired correctly, CSA Store will record:

- page views in `marketing_click_events`
- sessions in `marketing_sessions`
- tracked link clicks in `marketing_click_events`
- subscribe submissions in `subscribe_leads`
- attributed subscription events in `marketing_subscriber_events`

## Why This Structure

This makes `farm-brand-tests` a real campaign source instead of just a set of untracked pages.

It gives you:

- variant-level attribution
- message-focus attribution
- cleaner comparison across page types
- a direct path from test page to subscribe submit
