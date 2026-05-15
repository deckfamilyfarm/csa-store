# Marketing Tracking Format

This is the current backend tracking contract for CSA Store marketing attribution.

## Public Endpoints

### `GET /api/marketing/utm-format`

Returns the supported tag format and examples in JSON.

### `GET /api/marketing/go/:slug`

Tracked redirect route.

Use this when you want CSA Store to:

- record the click/session
- stamp the destination with the final UTM values
- add CSA-specific attribution fields before sending the visitor to subscribe

Example:

```text
https://subscribe.deckfamilyfarm.com/api/marketing/go/spring-csa-eugene-fb-a
```

### `GET /api/marketing/track`
### `POST /api/marketing/track`

Lightweight tracking endpoint for external pages such as `farm-brand-tests`.

Use this when you want to log a visit or click event directly from another page.

Useful fields:

- `pageUrl`
- `referrerUrl`
- `eventType`
- `queryString`
- standard UTM fields
- CSA-specific fields

## Standard UTM Tags

CSA Store accepts and stores these standard tags:

- `utm_source`
- `utm_medium`
- `utm_campaign`
- `utm_content`
- `utm_term`

These flow through to:

- `subscribe_leads`
- `marketing_sessions`
- `marketing_click_events`
- `marketing_subscriber_events`

## CSA-Specific Tags

CSA Store also accepts these campaign-specific fields:

- `csa_track`
  - per-visitor or per-click tracking token
- `csa_link`
  - tracked link slug
- `csa_campaign`
  - campaign slug
- `csa_message_focus`
  - one of: `farm`, `csa`, `food`, `event`, `mixed`
- `csa_target_city`
  - target city for the campaign
- `csa_target_zip`
  - target zip for the campaign
- `csa_target_location`
  - human-readable target location label
- `csa_target_drop_site`
  - target drop-site id when known

These fields are stored on subscribe leads and marketing attribution rows.

## Direct Subscribe URL Format

You can send traffic directly to the subscribe page with tags in the URL:

```text
https://subscribe.deckfamilyfarm.com/?utm_source=facebook&utm_medium=paid-social&utm_campaign=spring_csa_eugene&utm_content=creative_a&csa_message_focus=csa&csa_target_city=Eugene&csa_target_location=Eugene
```

The subscribe form already sends its full query string to the backend, so these values are captured on submit.

## Redirect Link Format

When using a managed tracked link, CSA Store adds:

- the UTM fields stored on the tracked link
- `csa_track`
- `csa_link`
- `csa_campaign`
- any configured message/location metadata

Example managed link:

```text
https://subscribe.deckfamilyfarm.com/api/marketing/go/spring-csa-eugene-fb-a
```

## Example Tracking Call

Example browser GET:

```text
/api/marketing/track?pageUrl=https%3A%2F%2Fexample.com%2Flanding&eventType=page_view&utm_source=facebook&utm_medium=paid-social&utm_campaign=spring_csa_eugene&csa_message_focus=csa&csa_target_city=Eugene
```

Example POST payload:

```json
{
  "pageUrl": "https://example.com/landing",
  "referrerUrl": "https://facebook.com/",
  "eventType": "page_view",
  "utmSource": "facebook",
  "utmMedium": "paid-social",
  "utmCampaign": "spring_csa_eugene",
  "utmContent": "creative_a",
  "csaMessageFocus": "csa",
  "csaTargetCity": "Eugene",
  "csaTargetLocation": "Eugene"
}
```

## Current Matching Priority

When a subscription lead is submitted, CSA Store attempts attribution in this order:

1. `csa_track` session token
2. `csa_link` tracked-link slug
3. `csa_campaign` campaign slug
4. direct UTM capture only

This is the first backend slice. Wix import and stronger subscriber matching can build on top of this without changing the tag format.
