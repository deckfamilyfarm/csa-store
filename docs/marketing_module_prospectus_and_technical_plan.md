# CSA Store Marketing Module Prospectus and Technical Plan

## Part 1. Marketing Prospectus

### Purpose

CSA Store should include a focused Marketing module that helps Deck Family Farm grow subscribers, direct campaigns more intelligently, and improve how clearly the farm is represented to both people and AI retrieval systems.

This module has two connected purposes:

- improve subscriber acquisition through better campaign tracking, channel direction, and location targeting
- improve AI discoverability so Deck Family Farm and its CSA offering are easier for search engines, AI assistants, and local recommendation systems to retrieve and recommend

This is not a generic social media scheduler. It is an operational marketing command center for subscriber growth, location strategy, and semantic visibility.

### The Business Need

The farm is already creating content and promoting through Google, Facebook, Instagram, YouTube, events, and community channels. Subscriber conversion happens on Wix, while business intelligence lives across CSA Store, Local Line harvests, and drop-site tools. What is missing is a single place that answers:

- Which campaigns are producing subscriber interest?
- Which locations and drop-site markets are responding?
- Which channel should carry a particular message?
- How should Deck Family Farm frame a message when the goal is farm storytelling versus CSA conversion?
- What should the farm promote next?
- How understandable is the farm website to modern search and AI retrieval systems?
- Which local food searches, products, or geographies are poorly represented online?

The marketing problem is no longer just posting and paying for ads. It is also being clearly represented in the systems customers now use to find answers and local food options.

### Strategic Content Model

The module should support a single Deck Family Farm content stream with a clear internal distinction between:

- `Deck Family Farm` as the main public brand
- `Full Farm CSA` as the CSA arm of Deck Family Farm

This means the content strategy stays unified under Deck Family Farm while still helping the operator shape the message correctly for the goal at hand:

- farm education, regenerative practices, and long-form storytelling
- customer value, food enjoyment, local access, and CSA conversion

The system should help clarify when a message should emphasize the broader Deck Family Farm identity and when it should emphasize Full Farm CSA as the subscription/customer-facing expression of that same brand.

### What The Module Should Do

The first version should help the farm:

1. create campaigns tied to subscriber growth goals
2. generate tracked links automatically without making the operator think about UTM tags
3. provide short posting instructions by channel, especially for Instagram, Facebook, YouTube, and Google
4. connect campaign traffic to Wix subscriber conversions where possible
5. report performance by campaign, location, message focus, and channel
6. evaluate AI discoverability of the farm website and identify visibility gaps
7. suggest what to promote next, where, and through which channel

### How Campaign Tracking Works

An operator creates or selects a campaign, answers a few guided questions, and the system generates:

- a tracked campaign link
- the correct destination, usually the Wix subscribe page
- channel-specific usage instructions
- campaign metadata stored locally for later reporting

Examples of the guidance the operator should receive:

- use this directly in Facebook
- use this as the Google landing URL
- use this as the Instagram Story link
- set this as the temporary bio link for the main Deck Family Farm account
- place this in the YouTube description and pinned comment

Subscriber conversion currently happens on Wix at:

- `https://www.deckfamilyfarm.com/subscribe`

CSA Store should not replace Wix in the first phase. It should record campaign clicks before users leave for Wix, preserve campaign identity where possible, and import or receive subscriber conversion data back from Wix for attribution.

This is also the largest early dependency and risk. If Wix supports campaign-token passthrough or hidden-field preservation, subscriber attribution can be much stronger and more deterministic. If it does not, the system will initially rely more heavily on email and time-window matching, which is useful but noisier. This risk should be treated as a business constraint, not just an implementation detail.

### AI Discoverability and Semantic Visibility

Subscriber acquisition is only one side of the marketing picture. The farm also needs to know whether its website is easy for modern search and AI retrieval systems to understand.

This module should therefore include an AI Discoverability layer that measures:

- how clearly the website represents products, regions, and service areas
- which high-intent food searches are strongly or weakly covered
- whether pages are helping or hurting retrieval confidence
- whether structured data, FAQs, and geographic/service-area signals are strong enough

The goal is not traditional SEO scoring alone. The goal is to improve how likely AI systems are to retrieve and recommend the farm for high-intent local food searches.

### Why This Matters

Once the system tracks campaign clicks, subscriber growth, spend, drop-site performance, harvested order patterns, and semantic website coverage, it can help the farm make much better decisions:

- which locations deserve more promotion
- which drop sites may need targeted support
- which messages belong on Google versus Facebook versus Instagram
- whether a topic should emphasize Deck Family Farm broadly or Full Farm CSA specifically
- which current food or seasonal trends are worth posting on
- which site pages need stronger wording, FAQs, or structured data to improve discoverability

### Outcome

The result is a practical marketing command center inside CSA Store:

- campaign planning
- automated tracked-link generation
- Wix subscriber attribution
- location-aware reporting
- discoverability scoring
- semantic coverage analysis
- clearer channel direction
- future recommendations grounded in farm data

This keeps the system aligned with the farm’s actual operating goals: grow subscribers, strengthen service areas, improve local visibility, and promote the right message through the right channel.

## Part 2. Technical Implementation Appendix

### Product Scope

This module should live inside the existing CSA Store admin under:

- `/#/admin/marketing`

It should use:

- the existing MySQL store database
- the existing admin role/permission system
- the existing reporting and local-cache style already used for Local Line, orders, subscribers, and dashboards

### Recommended Admin Sections

Inside `Marketing`:

1. `Dashboard`
2. `Campaigns`
3. `Content`
4. `Link Generator`
5. `Subscriber Attribution`
6. `Ad Spend`
7. `AI Discoverability`
   - `Overview`
   - `Search Intent Coverage`
   - `Semantic Visibility`
   - `Geographic Coverage`
   - `Structured Data Audit`
   - `AI Recommendations`
   - `Site Crawl History`
   - `Retrieval Confidence Reports`
8. `Recommendations`
9. `Settings / Wix Import`

### Suggested Roles

Add to the current admin role system:

- `marketing_admin`
- `campaign_manager`
- `content_editor`
- `ad_spend_approver`
- `analytics_viewer`

### Core Marketing Data Model

Use `marketing_*` tables in the store database.

Core campaign and attribution tables:

- `marketing_campaigns`
- `marketing_content_posts`
- `marketing_utm_links`
- `marketing_sessions`
- `marketing_click_events`
- `marketing_subscriber_events`
- `marketing_ad_spend`
- `marketing_recommendations`

Useful fields:

- `message_focus` (`farm`, `csa`, `food`, `event`, `mixed`)
- `target_city`
- `target_zip`
- `target_location_label`
- `target_drop_site_id`
- `destination_type`
- `external_subscriber_id`
- `match_method`

### Tracked Link Flow

Recommended flow:

1. Operator creates a campaign link in CSA Store.
2. CSA Store stores campaign, channel, and location metadata.
3. Generated link points to a CSA Store redirect route such as:
   - `/go/spring-csa-salem-fb-a`
4. CSA Store records:
   - session id
   - campaign id
   - content id
   - UTM values
   - target location
   - target drop site
   - message focus
5. User is redirected to:
   - `https://www.deckfamilyfarm.com/subscribe`
6. Wix subscriber data is later imported or received by webhook/automation.
7. CSA Store attempts attribution using:
   - tracking token
   - email
   - signup time window
   - location fields

Channel-specific usage guidance should be generated at link-creation time and stored with the link or campaign record so operators see the same recommended usage when they return to it later.

### Wix Integration Requirements

Best-case import fields from Wix:

- email
- name
- subscriber/contact id
- signup timestamp
- address
- city
- zip
- chosen drop site if present
- any carried-through campaign token or hidden field

Preferred matching priority:

1. exact campaign token match
2. email + time window
3. aggregate campaign/location reporting when exact match is unavailable

Known implementation risk:

- if Wix does not preserve campaign tokens or hidden fields, exact subscriber attribution becomes limited and the system must fall back to weaker matching
- this does not block campaign tracking, but it reduces confidence in person-level conversion assignment

### Channel Logic

The system should store and present usage instructions by channel:

- Instagram organic:
  - usually bio-link or Story guidance
- Instagram paid:
  - direct tracked CTA link
- Facebook:
  - direct tracked link
- Google Ads:
  - direct landing URL
- YouTube:
  - direct tracked link in description and optionally pinned comment

This guidance should be generated automatically from campaign inputs.

### Recommendation Layer

Phase 2 should use existing CSA Store data plus OpenAI-assisted reasoning to suggest campaigns.

Inputs:

- drop-site performance
- order/location patterns from harvested Local Line order data
- subscriber growth by geography
- campaign click/conversion history
- spend history
- seasonal and food trend context
- inventory or product opportunity signals where appropriate

Outputs:

- location-focused campaign suggestions
- underperforming drop-site promotion opportunities
- content theme suggestions
- message emphasis recommendation (`Deck Family Farm`, `Full Farm CSA`, or blended)
- channel recommendation (`Google`, `Facebook`, `Instagram`, `YouTube`)
- rationale and confidence

### AI Discoverability Data Model

Add:

- `marketing_site_snapshots`
- `marketing_semantic_scores`
- `marketing_search_intents`
- `marketing_ai_recommendations`
- `marketing_schema_audits`

Suggested fields:

`marketing_site_snapshots`
- `url`
- `page_type`
- `extracted_text`
- `extracted_headings`
- `last_scanned`
- `html_hash`
- `content_word_count`

`marketing_semantic_scores`
- `semantic_score`
- `geographic_score`
- `product_score`
- `faq_score`
- `schema_score`
- `freshness_score`
- `ai_visibility_score`
- `retrieval_confidence_score`

### AI Visibility Score

Generate an overall AI Visibility Score from `1–100`.

Suggested weighting:

- Geographic clarity: `20%`
- Product clarity: `20%`
- Search-intent coverage: `20%`
- FAQ/question coverage: `15%`
- Structured schema presence: `15%`
- Freshness and update frequency: `10%`

Interpretation:

- `90–100`: strong semantic authority and local retrievability
- `70–89`: good discoverability with identifiable gaps
- `50–69`: moderate discoverability with major missing intent coverage
- `below 50`: weak AI/search clarity and inconsistent retrieval signals

### Search Intent Coverage

Track whether the site directly supports high-intent local food queries such as:

- pasture-raised eggs Portland
- grass-fed beef Salem
- local meat CSA Eugene
- regenerative farm food Corvallis

The goal is to identify semantic gaps and opportunities.

### Structured Data Audit

Detect and score:

- LocalBusiness schema
- Product schema
- FAQ schema
- Organization schema
- Breadcrumb schema

Identify:

- missing schema
- malformed schema
- inconsistent entity naming
- missing geographic or service-area information

### FAQ and Answer-Engine Optimization

Score whether pages contain direct question-and-answer formats likely to perform well in AI retrieval systems.

Examples:

- Where can I buy pasture-raised eggs near Portland?
- How does a meat CSA work?
- Does Deck Family Farm deliver to Salem?

Recommend missing FAQ opportunities.

### OpenAI’s Role

OpenAI should be used for:

- campaign suggestions
- content and topic suggestions
- channel recommendations
- caption, CTA, and ad-copy drafting
- semantic clarity evaluation
- retrieval-confidence estimation
- missing-intent analysis
- suggested FAQ generation
- page improvement recommendations
- AI visibility summaries

Prompt design philosophy:

- deterministic inputs first, AI interpretation second
- prompts should receive structured business facts, scores, gaps, and constraints rather than raw unbounded site dumps
- outputs should be short, explainable, and reviewable by a farm operator
- recommendations should always include the facts or scoring signals that led to the suggestion
- prompts should favor transparent reasoning over creative novelty when generating operational recommendations

OpenAI should not initially be used for:

- autonomous page editing
- autonomous publishing
- automatic ad spend changes
- pricing or inventory changes
- replacing deterministic reporting SQL
- silent SEO manipulation

### Build Sequence

#### Phase 1

- roles
- schema
- admin shell
- campaigns
- content
- guided link generator

#### Phase 2

- redirect tracking
- session tracking
- Wix import
- subscriber attribution reports
- spend tracking

#### Phase 2A

- internal crawler
- page extraction
- deterministic semantic scoring
- AI visibility dashboard
- structured-schema audit
- search-intent coverage maps

#### Phase 3

- recommendation engine for campaigns
- location campaign suggestions
- drop-site opportunity suggestions
- trend-aware content suggestions
- channel and message-focus guidance

#### Phase 3A

- OpenAI recommendation engine for discoverability
- historical AI visibility tracking
- retrieval-confidence comparisons
- location-specific discoverability analysis
- semantic trend monitoring
- automated admin alerts for weak coverage areas

### Architectural Discipline

This subsystem should follow the same design discipline as the rest of CSA Store:

- deterministic scoring first
- local reporting tables
- explicit admin review
- AI used for recommendations and interpretation
- no silent automated publishing
- transparent scoring rationale

This module belongs in CSA Store because the app already contains:

- admin auth and roles
- drop-site data
- local subscriber snapshots
- harvested order data
- reporting and dashboard patterns

The technical implementation should remain narrow, explicit, and auditable.
