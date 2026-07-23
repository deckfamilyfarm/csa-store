import React, { useEffect, useMemo, useState } from "react";
import { adminDownload, adminGet, adminPost } from "../adminApi.js";

function truncateText(value, maxLength = 72) {
  const text = String(value || "").trim();
  if (!text) return "—";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

const FARM_BRAND_DISPLAY_VARIANTS = [
  {
    label: "Eat Full Farm",
    patterns: ["eat full farm", "eat-full-farm", "eat_full_farm", "eatfullfarm"]
  },
  {
    label: "Full Farm Direct",
    patterns: ["full farm direct", "full-farm-direct", "full_farm_direct", "fullfarmdirect"]
  },
  {
    label: "Willamette Valley Pastures",
    patterns: [
      "willamette valley pastures",
      "willamette-valley-pastures",
      "willamette_valley_pastures",
      "willamettevalleypastures"
    ]
  }
];

function normalizeDisplayText(value) {
  return String(value || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function formatAnalyticsSourceLabel(value) {
  const label = String(value || "").trim();
  if (!label) return "—";
  return normalizeDisplayText(label) === "direct / unknown" ? "Direct" : label;
}

function getFarmBrandDisplayLabel(...values) {
  const normalizedValues = values
    .map((value) => normalizeDisplayText(value))
    .filter(Boolean);
  const compactValues = normalizedValues.map((value) => value.replace(/\s+/g, ""));

  for (const variant of FARM_BRAND_DISPLAY_VARIANTS) {
    const matched = variant.patterns.some((pattern) => {
      const normalizedPattern = normalizeDisplayText(pattern);
      const compactPattern = normalizedPattern.replace(/\s+/g, "");
      return normalizedValues.some((value) => value.includes(normalizedPattern)) ||
        compactValues.some((value) => compactPattern && value.includes(compactPattern));
    });
    if (matched) return variant.label;
  }

  return "";
}

function formatSlugTrackingLabel(stat = {}) {
  const farmBrandLabel = getFarmBrandDisplayLabel(
    stat.label,
    stat.slug,
    stat.utmContent,
    stat.sourceLabel
  );
  if (farmBrandLabel) return farmBrandLabel;

  const label = String(stat.label || "").trim();
  const slug = String(stat.slug || "").trim();
  const preferred = label && label !== slug ? `${label} - ${slug}` : label || slug;
  return formatAnalyticsSourceLabel(preferred);
}

function formatTopSourceSummary(entries = []) {
  const entry = entries[0] || null;
  if (!entry) return "—";
  return `${formatAnalyticsSourceLabel(entry.label || entry.host)} (${entry.count})`;
}

function formatSourceListTitle(entries = []) {
  const summary = entries
    .map((entry) => `${formatAnalyticsSourceLabel(entry.label || entry.host)} (${entry.count})`)
    .join(", ");
  return summary || "—";
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatDateInput(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function getPresetDateRange(preset) {
  if (preset === "all") return { dateFrom: "", dateTo: "" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (preset === "last7") {
    return { dateFrom: formatDateInput(addDays(today, -6)), dateTo: formatDateInput(today) };
  }
  if (preset === "last14") {
    return { dateFrom: formatDateInput(addDays(today, -13)), dateTo: formatDateInput(today) };
  }
  if (preset === "last21") {
    return { dateFrom: formatDateInput(addDays(today, -20)), dateTo: formatDateInput(today) };
  }
  if (preset === "last30") {
    return { dateFrom: formatDateInput(addDays(today, -29)), dateTo: formatDateInput(today) };
  }
  return { dateFrom: "", dateTo: "" };
}

function buildDateRangeQuery(range) {
  const params = new URLSearchParams();
  if (range?.dateFrom) params.set("dateFrom", range.dateFrom);
  if (range?.dateTo) params.set("dateTo", range.dateTo);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function formatDateRangeLabel(range, preset) {
  if (preset === "all" || (!range?.dateFrom && !range?.dateTo)) return "All dates";
  if (range.dateFrom && range.dateTo) return `${range.dateFrom} to ${range.dateTo}`;
  if (range.dateFrom) return `Since ${range.dateFrom}`;
  return `Through ${range.dateTo}`;
}

function formatName(firstName, lastName) {
  const value = [firstName, lastName].filter(Boolean).join(" ").trim();
  return value || "—";
}

function slugifyValue(value, fallback = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function createCampaignDraft() {
  return {
    slug: "",
    name: "",
    platform: "web",
    channel: "landing-page",
    messageFocus: "mixed",
    destinationType: "subscribe",
    destinationUrl: "https://subscribe.deckfamilyfarm.com/",
    notes: ""
  };
}

function createLinkDraft(campaignId = "") {
  return {
    campaignId: campaignId || "",
    slug: "",
    label: "",
    channel: "landing-page",
    destinationType: "subscribe",
    destinationUrl: "https://subscribe.deckfamilyfarm.com/",
    utmSource: "farm-brand-tests",
    utmMedium: "landing-page",
    utmCampaign: "",
    utmContent: "",
    messageFocus: "farm",
    usageInstructions: ""
  };
}

const DATE_RANGE_OPTIONS = [
  { value: "all", label: "All time" },
  { value: "last7", label: "Last week" },
  { value: "last14", label: "Last two weeks" },
  { value: "last21", label: "Last three weeks" },
  { value: "last30", label: "Last month" },
  { value: "custom", label: "Custom" }
];

function SummaryCard({ title, value, detail }) {
  return (
    <div className="response-card marketing-summary-card">
      <div className="title">{title}</div>
      <div className="marketing-summary-value">{value}</div>
      {detail ? <div className="small">{detail}</div> : null}
    </div>
  );
}

function formatPercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}

export function AdminMarketingSection({ token }) {
  const [loading, setLoading] = useState(true);
  const [savingCampaign, setSavingCampaign] = useState(false);
  const [savingLink, setSavingLink] = useState(false);
  const [creatingBrandSet, setCreatingBrandSet] = useState(false);
  const [downloadingReport, setDownloadingReport] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [activeTab, setActiveTab] = useState("activity");
  const [overview, setOverview] = useState(null);
  const [activity, setActivity] = useState({ clicks: [], conversions: [] });
  const [campaigns, setCampaigns] = useState([]);
  const [links, setLinks] = useState([]);
  const [campaignDraft, setCampaignDraft] = useState(createCampaignDraft());
  const [linkDraft, setLinkDraft] = useState(createLinkDraft());
  const [dateRangePreset, setDateRangePreset] = useState("last21");
  const [customDateFrom, setCustomDateFrom] = useState("");
  const [customDateTo, setCustomDateTo] = useState("");

  const selectedDateRange = useMemo(() => {
    if (dateRangePreset === "custom") {
      return { dateFrom: customDateFrom, dateTo: customDateTo };
    }
    return getPresetDateRange(dateRangePreset);
  }, [customDateFrom, customDateTo, dateRangePreset]);

  const marketingDateQuery = useMemo(
    () => buildDateRangeQuery(selectedDateRange),
    [selectedDateRange]
  );

  const dateRangeLabel = useMemo(
    () => formatDateRangeLabel(selectedDateRange, dateRangePreset),
    [dateRangePreset, selectedDateRange]
  );

  function handleCampaignNameChange(nextName) {
    setCampaignDraft((current) => {
      const nextSlug = slugifyValue(nextName);
      const shouldReplaceSlug =
        !String(current.slug || "").trim() ||
        String(current.slug || "").trim() === slugifyValue(current.name);
      return {
        ...current,
        name: nextName,
        slug: shouldReplaceSlug ? nextSlug : current.slug
      };
    });
  }

  function handleLinkLabelChange(nextLabel) {
    setLinkDraft((current) => {
      const nextSlug = slugifyValue(nextLabel);
      const shouldReplaceSlug =
        !String(current.slug || "").trim() ||
        String(current.slug || "").trim() === slugifyValue(current.label);
      const shouldReplaceContent =
        !String(current.utmContent || "").trim() ||
        String(current.utmContent || "").trim() === slugifyValue(current.slug);
      return {
        ...current,
        label: nextLabel,
        slug: shouldReplaceSlug ? nextSlug : current.slug,
        utmContent: shouldReplaceContent ? nextSlug : current.utmContent
      };
    });
  }

  function handleLinkSlugChange(nextSlug) {
    setLinkDraft((current) => {
      const normalizedSlug = slugifyValue(nextSlug);
      const shouldReplaceContent =
        !String(current.utmContent || "").trim() ||
        String(current.utmContent || "").trim() === slugifyValue(current.slug);
      return {
        ...current,
        slug: normalizedSlug,
        utmContent: shouldReplaceContent ? normalizedSlug : current.utmContent
      };
    });
  }

  const sortedCampaigns = useMemo(
    () =>
      campaigns
        .slice()
        .sort(
          (left, right) =>
            new Date(right.updatedAt || right.createdAt) -
            new Date(left.updatedAt || left.createdAt)
        ),
    [campaigns]
  );

  const sortedLinks = useMemo(
    () =>
      links
        .slice()
        .sort(
          (left, right) =>
            new Date(right.updatedAt || right.createdAt) -
            new Date(left.updatedAt || left.createdAt)
        ),
    [links]
  );

  async function loadMarketing() {
    setLoading(true);
    setError("");
    try {
      const [overviewResponse, activityResponse, campaignsResponse, linksResponse] =
        await Promise.all([
          adminGet(`marketing/overview${marketingDateQuery}`, token),
          adminGet(`marketing/activity${marketingDateQuery}`, token),
          adminGet("marketing/campaigns", token),
          adminGet("marketing/utm-links", token)
        ]);
      const nextCampaigns = campaignsResponse?.campaigns || [];
      setOverview(overviewResponse || null);
      setActivity({
        clicks: activityResponse?.clicks || [],
        conversions: activityResponse?.conversions || []
      });
      setCampaigns(nextCampaigns);
      setLinks(linksResponse?.links || []);
      setLinkDraft((current) => ({
        ...current,
        campaignId: current.campaignId || String(nextCampaigns[0]?.id || "")
      }));
    } catch (loadError) {
      setError(loadError?.message || "Failed to load marketing data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMarketing();
  }, [token, marketingDateQuery]);

  async function handleCreateCampaign(event) {
    event.preventDefault();
    setSavingCampaign(true);
    setError("");
    setMessage("");
    try {
      const response = await adminPost("marketing/campaigns", token, campaignDraft);
      const createdCampaign = response?.campaign || null;
      if (createdCampaign) {
        setCampaigns((current) => [
          createdCampaign,
          ...current.filter((entry) => entry.id !== createdCampaign.id)
        ]);
        setLinkDraft((current) => ({
          ...current,
          campaignId: String(createdCampaign.id),
          utmCampaign: current.utmCampaign || createdCampaign.slug || ""
        }));
      }
      setCampaignDraft(createCampaignDraft());
      setMessage("Campaign created.");
      await loadMarketing();
    } catch (saveError) {
      setError(saveError?.message || "Failed to create campaign.");
    } finally {
      setSavingCampaign(false);
    }
  }

  async function handleCreateLink(event) {
    event.preventDefault();
    setSavingLink(true);
    setError("");
    setMessage("");
    try {
      await adminPost("marketing/utm-links", token, {
        ...linkDraft,
        campaignId: linkDraft.campaignId ? Number(linkDraft.campaignId) : null
      });
      setLinkDraft(createLinkDraft(linkDraft.campaignId));
      setMessage("Tracked link created.");
      await loadMarketing();
    } catch (saveError) {
      setError(saveError?.message || "Failed to create tracked link.");
    } finally {
      setSavingLink(false);
    }
  }

  async function copyTrackedUrl(url) {
    try {
      await navigator.clipboard.writeText(String(url || ""));
      setMessage("Tracked URL copied.");
      setError("");
    } catch (_error) {
      setError("Unable to copy tracked URL.");
    }
  }

  async function handleDownloadReport() {
    setDownloadingReport(true);
    setError("");
    setMessage("");
    try {
      const { blob, filename } = await adminDownload(`marketing/report.pdf${marketingDateQuery}`, token);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename || "marketing-link-analytics.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage("Marketing analytics PDF downloaded.");
    } catch (downloadError) {
      setError(downloadError?.message || "Failed to download marketing analytics PDF.");
    } finally {
      setDownloadingReport(false);
    }
  }

  function populateLinkDraftFromLink(link) {
    if (!link) return;
    const duplicateSlug = slugifyValue(`${link.slug || link.label || "tracked-link"} copy`);
    setLinkDraft({
      campaignId: String(link.campaignId || ""),
      slug: duplicateSlug,
      label: `${link.label || "Tracked Link"} Copy`,
      channel: link.channel || "landing-page",
      destinationType: link.destinationType || "subscribe",
      destinationUrl: link.destinationUrl || "https://subscribe.deckfamilyfarm.com/",
      utmSource: link.utmSource || "farm-brand-tests",
      utmMedium: link.utmMedium || "landing-page",
      utmCampaign: link.utmCampaign || "",
      utmContent: duplicateSlug,
      messageFocus: link.messageFocus || "farm",
      usageInstructions: link.usageInstructions || ""
    });
    setActiveTab("campaigns");
    setMessage("Tracked link copied into the form. Adjust and save when ready.");
    setError("");
  }

  async function handleCreateBrandTestSet() {
    if (!linkDraft.campaignId) {
      setError("Select a campaign before creating a brand-test set.");
      return;
    }
    const campaign = campaigns.find((entry) => String(entry.id) === String(linkDraft.campaignId));
    if (!campaign) {
      setError("Selected campaign was not found.");
      return;
    }

    const definitions = [
      {
        label: "Farm Angle",
        slug: `${campaign.slug}-farm`,
        utmContent: `${campaign.slug}-farm`,
        messageFocus: "farm"
      },
      {
        label: "CSA Angle",
        slug: `${campaign.slug}-csa`,
        utmContent: `${campaign.slug}-csa`,
        messageFocus: "csa"
      },
      {
        label: "Food Angle",
        slug: `${campaign.slug}-food`,
        utmContent: `${campaign.slug}-food`,
        messageFocus: "food"
      }
    ];

    setCreatingBrandSet(true);
    setError("");
    setMessage("");
    try {
      for (const definition of definitions) {
        await adminPost("marketing/utm-links", token, {
          campaignId: Number(campaign.id),
          slug: definition.slug,
          label: `${campaign.name} - ${definition.label}`,
          channel: "landing-page",
          destinationType: "subscribe",
          destinationUrl: campaign.destinationUrl || "https://subscribe.deckfamilyfarm.com/",
          utmSource: "farm-brand-tests",
          utmMedium: "landing-page",
          utmCampaign: campaign.slug,
          utmContent: definition.utmContent,
          messageFocus: definition.messageFocus,
          usageInstructions: `CTA for ${definition.label.toLowerCase()} landing page.`
        });
      }
      setMessage("Brand-test tracked-link set created.");
      await loadMarketing();
    } catch (saveError) {
      setError(saveError?.message || "Failed to create brand-test set.");
    } finally {
      setCreatingBrandSet(false);
    }
  }

  return (
    <section className="admin-section">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h3 style={{ marginBottom: 0 }}>Marketing</h3>
        <button
          className="button alt"
          type="button"
          onClick={handleDownloadReport}
          disabled={downloadingReport}
        >
          {downloadingReport ? "Preparing PDF..." : "Download PDF"}
        </button>
      </div>
      <div className="small">
        Track which pages and slugs bring people in, where they came from, and whether they
        completed the subscribe form.
      </div>
      {message ? <div className="small">{message}</div> : null}
      {error ? <div className="small">{error}</div> : null}

      <div style={{ display: "flex", gap: 12, marginTop: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <button
          className={`button alt ${activeTab === "activity" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("activity")}
        >
          Activity
        </button>
        <button
          className={`button alt ${activeTab === "campaigns" ? "active" : ""}`}
          type="button"
          onClick={() => setActiveTab("campaigns")}
        >
          Campaigns
        </button>
      </div>

      {activeTab === "activity" ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 12,
            marginBottom: 20,
            flexWrap: "wrap"
          }}
        >
          <label className="field" style={{ margin: 0, minWidth: 180 }}>
            <span>Date Range</span>
            <select
              value={dateRangePreset}
              onChange={(event) => setDateRangePreset(event.target.value)}
            >
              {DATE_RANGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {dateRangePreset === "custom" ? (
            <>
              <label className="field" style={{ margin: 0, minWidth: 150 }}>
                <span>From</span>
                <input
                  type="date"
                  value={customDateFrom}
                  onChange={(event) => setCustomDateFrom(event.target.value)}
                />
              </label>
              <label className="field" style={{ margin: 0, minWidth: 150 }}>
                <span>To</span>
                <input
                  type="date"
                  value={customDateTo}
                  onChange={(event) => setCustomDateTo(event.target.value)}
                />
              </label>
            </>
          ) : null}
          <div className="small" style={{ paddingBottom: 10 }}>
            {dateRangeLabel}
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="small">Loading marketing data...</div>
      ) : activeTab === "activity" ? (
        <>
          {overview?.summary ? (
            <div className="response-list marketing-summary-list">
              <SummaryCard
                title="Tracked Links"
                value={overview.summary.trackedLinks || 0}
                detail="Configured slugs"
              />
              <SummaryCard
                title="Visits"
                value={overview.summary.visits || overview.summary.trackedVisits || overview.summary.sessions || 0}
                detail="One count per visit"
              />
              <SummaryCard
                title="Signups"
                value={overview.summary.signups || overview.summary.subscriberEvents || 0}
                detail="Form completions, tests excluded"
              />
              <SummaryCard
                title="Attributed Signups"
                value={overview.summary.attributedSubscriptionLeads || 0}
                detail="UTM, referrer, session, or link"
              />
            </div>
          ) : null}

          <div className="audit-section">
            <h4>Visit Analytics</h4>
            <h5>Slug Tracking</h5>
            {!overview?.linkStats?.length ? (
              <div className="small">No tracked-link analytics yet.</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Slug</th>
                    <th>Focus</th>
                    <th>Visits</th>
                    <th>Signups</th>
                    <th>Signup Rate</th>
                    <th>Top Source</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.linkStats.map((stat) => {
                    const topSourceEntries = stat.topSources || stat.topReferrers || [];
                    return (
                      <tr key={stat.linkId || stat.slug}>
                        <td title={formatSlugTrackingLabel(stat)}>
                          {truncateText(formatSlugTrackingLabel(stat), 48)}
                        </td>
                        <td>{stat.messageFocus || "—"}</td>
                        <td>{stat.visits || stat.arrivals || stat.clicks || 0}</td>
                        <td>{stat.signups || stat.subscribers || 0}</td>
                        <td>{formatPercent(stat.conversionRate)}</td>
                        <td title={formatSourceListTitle(topSourceEntries)}>
                          {formatTopSourceSummary(topSourceEntries)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <h5 style={{ marginTop: 24 }}>Source Tracking</h5>
            {!overview?.sourceStats?.length ? (
              <div className="small">No source analytics yet.</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Visits</th>
                    <th>Source</th>
                    <th>Signups</th>
                    <th>Signup Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.sourceStats.map((source) => {
                    const sourceLabel = formatAnalyticsSourceLabel(source.sourceLabel);
                    return (
                      <tr key={source.sourceLabel || "direct"}>
                        <td>{source.visits || source.arrivals || source.pageViews || 0}</td>
                        <td title={sourceLabel}>{truncateText(sourceLabel, 48)}</td>
                        <td>{source.signups || 0}</td>
                        <td>{formatPercent(source.conversionRate)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="audit-section">
            <h4>Recent Marketing Activity</h4>
            {!activity.clicks.length ? (
              <div className="small">No marketing activity yet.</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Slug</th>
                    <th>Source</th>
                    <th>Campaign</th>
                    <th>Content</th>
                    <th>Focus</th>
                    <th>Destination</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.clicks.map((click) => (
                    <tr key={click.id}>
                      <td title={formatDateTime(click.occurredAt)}>{truncateText(formatDateTime(click.occurredAt), 22)}</td>
                      <td>{click.eventType || "—"}</td>
                      <td title={click.linkSlug || "—"}>{truncateText(click.linkSlug, 38)}</td>
                      <td title={click.sourceDetail || click.referrerUrl || click.sourceHost || "—"}>
                        {truncateText(click.sourceHost, 28)}
                      </td>
                      <td title={click.campaignSlug || click.campaignName || "—"}>
                        {truncateText(click.campaignSlug || click.campaignName, 30)}
                      </td>
                      <td title={click.utmContent || "—"}>{truncateText(click.utmContent, 26)}</td>
                      <td>{click.messageFocus || "—"}</td>
                      <td title={click.destinationUrl || "—"}>
                        {truncateText(click.destinationUrl, 44)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="audit-section">
            <h4>Recent Subscribe Signups</h4>
            {!activity.conversions.length ? (
              <div className="small">No subscribe conversions yet.</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Slug</th>
                    <th>Source</th>
                    <th>City</th>
                    <th>Drop Site</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.conversions.map((conversion) => (
                    <tr key={conversion.id}>
                      <td title={formatDateTime(conversion.subscribedAt)}>
                        {truncateText(formatDateTime(conversion.subscribedAt), 22)}
                      </td>
                      <td title={formatName(conversion.firstName, conversion.lastName)}>
                        {truncateText(formatName(conversion.firstName, conversion.lastName), 28)}
                      </td>
                      <td title={conversion.email || "—"}>{truncateText(conversion.email, 30)}</td>
                      <td title={conversion.linkSlug || "—"}>{truncateText(conversion.linkSlug, 38)}</td>
                      <td title={conversion.sourceDetail || conversion.referrerUrl || conversion.sourceHost || "—"}>
                        {truncateText(conversion.sourceHost, 24)}
                      </td>
                      <td title={conversion.city || "—"}>{truncateText(conversion.city, 20)}</td>
                      <td title={conversion.selectedDropSite || "—"}>
                        {truncateText(conversion.selectedDropSite, 28)}
                      </td>
                      <td>{conversion.leadStatus || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="admin-grid" style={{ alignItems: "start" }}>
            <form className="response-card" onSubmit={handleCreateCampaign}>
              <div className="title">New Campaign</div>
              <input
                className="input"
                placeholder="Campaign slug"
                value={campaignDraft.slug}
                onChange={(event) =>
                  setCampaignDraft((current) => ({
                    ...current,
                    slug: slugifyValue(event.target.value)
                  }))
                }
              />
              <div className="small">Auto-generated from the campaign name. Edit only if you want a different public slug.</div>
              <input
                className="input"
                placeholder="Campaign name"
                value={campaignDraft.name}
                onChange={(event) => handleCampaignNameChange(event.target.value)}
              />
              <div className="admin-grid">
                <input
                  className="input"
                  placeholder="Platform"
                  value={campaignDraft.platform}
                  onChange={(event) =>
                    setCampaignDraft((current) => ({ ...current, platform: event.target.value }))
                  }
                />
                <input
                  className="input"
                  placeholder="Channel"
                  value={campaignDraft.channel}
                  onChange={(event) =>
                    setCampaignDraft((current) => ({ ...current, channel: event.target.value }))
                  }
                />
              </div>
              <select
                className="input"
                value={campaignDraft.messageFocus}
                onChange={(event) =>
                  setCampaignDraft((current) => ({ ...current, messageFocus: event.target.value }))
                }
              >
                <option value="mixed">Mixed</option>
                <option value="farm">Farm</option>
                <option value="csa">CSA</option>
                <option value="food">Food</option>
                <option value="event">Event</option>
              </select>
              <input
                className="input"
                placeholder="Destination URL"
                value={campaignDraft.destinationUrl}
                onChange={(event) =>
                  setCampaignDraft((current) => ({ ...current, destinationUrl: event.target.value }))
                }
              />
              <textarea
                className="textarea"
                rows={3}
                placeholder="Notes"
                value={campaignDraft.notes}
                onChange={(event) =>
                  setCampaignDraft((current) => ({ ...current, notes: event.target.value }))
                }
              />
              <button className="button alt" type="submit" disabled={savingCampaign}>
                {savingCampaign ? "Creating..." : "Create Campaign"}
              </button>
            </form>

            <form className="response-card" onSubmit={handleCreateLink}>
              <div className="title">New Tracked Link</div>
              <select
                className="input"
                value={linkDraft.campaignId}
                onChange={(event) =>
                  setLinkDraft((current) => ({
                    ...current,
                    campaignId: event.target.value,
                    utmCampaign:
                      campaigns.find(
                        (campaign) => String(campaign.id) === String(event.target.value)
                      )?.slug || current.utmCampaign
                  }))
                }
              >
                <option value="">Select campaign</option>
                {sortedCampaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </select>
              <input
                className="input"
                placeholder="Link slug"
                value={linkDraft.slug}
                onChange={(event) => handleLinkSlugChange(event.target.value)}
              />
              <div className="small">Slug is used in the tracked URL. It defaults from the link title.</div>
              <input
                className="input"
                placeholder="Link label"
                value={linkDraft.label}
                onChange={(event) => handleLinkLabelChange(event.target.value)}
              />
              <div className="admin-grid">
                <input
                  className="input"
                  placeholder="UTM source"
                  value={linkDraft.utmSource}
                  onChange={(event) =>
                    setLinkDraft((current) => ({ ...current, utmSource: event.target.value }))
                  }
                />
                <input
                  className="input"
                  placeholder="UTM medium"
                  value={linkDraft.utmMedium}
                  onChange={(event) =>
                    setLinkDraft((current) => ({ ...current, utmMedium: event.target.value }))
                  }
                />
              </div>
              <div className="admin-grid">
                <input
                  className="input"
                  placeholder="UTM campaign"
                  value={linkDraft.utmCampaign}
                  onChange={(event) =>
                    setLinkDraft((current) => ({ ...current, utmCampaign: event.target.value }))
                  }
                />
                <input
                  className="input"
                  placeholder="UTM content"
                  value={linkDraft.utmContent}
                  onChange={(event) =>
                    setLinkDraft((current) => ({ ...current, utmContent: event.target.value }))
                  }
                />
              </div>
              <div className="small">Typical pattern: `utm_campaign` matches the campaign slug and `utm_content` matches the page or variant slug.</div>
              <select
                className="input"
                value={linkDraft.messageFocus}
                onChange={(event) =>
                  setLinkDraft((current) => ({ ...current, messageFocus: event.target.value }))
                }
              >
                <option value="farm">Farm</option>
                <option value="csa">CSA</option>
                <option value="food">Food</option>
                <option value="event">Event</option>
                <option value="mixed">Mixed</option>
              </select>
              <input
                className="input"
                placeholder="Usage instructions"
                value={linkDraft.usageInstructions}
                onChange={(event) =>
                  setLinkDraft((current) => ({
                    ...current,
                    usageInstructions: event.target.value
                  }))
                }
              />
              <div className="small">You can leave instructions brief, for example: “CTA for full-farm-direct landing page.”</div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <button className="button alt" type="submit" disabled={savingLink}>
                  {savingLink ? "Creating..." : "Create Tracked Link"}
                </button>
                <button
                  className="button alt"
                  type="button"
                  onClick={handleCreateBrandTestSet}
                  disabled={creatingBrandSet || !linkDraft.campaignId}
                >
                  {creatingBrandSet ? "Creating Set..." : "Create Brand-Test Set"}
                </button>
              </div>
              <div className="small">Brand-test set creates three links at once: farm, csa, and food.</div>
            </form>
          </div>

          <div className="audit-section">
            <h4>Campaigns</h4>
            {!sortedCampaigns.length ? (
              <div className="small">No campaigns yet.</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Slug</th>
                    <th>Channel</th>
                    <th>Focus</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedCampaigns.map((campaign) => (
                    <tr key={campaign.id}>
                      <td title={campaign.name || "—"}>{truncateText(campaign.name, 36)}</td>
                      <td title={campaign.slug || "—"}>{truncateText(campaign.slug, 32)}</td>
                      <td>{campaign.channel || "—"}</td>
                      <td>{campaign.messageFocus || "—"}</td>
                      <td>{formatDateTime(campaign.updatedAt || campaign.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="audit-section">
            <h4>Tracked Links</h4>
            {!sortedLinks.length ? (
              <div className="small">No tracked links yet.</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Slug</th>
                    <th>UTM Content</th>
                    <th>Focus</th>
                    <th>Tracked URL</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedLinks.map((link) => (
                    <tr key={link.id}>
                      <td title={link.label || "—"}>{truncateText(link.label, 34)}</td>
                      <td title={link.slug || "—"}>{truncateText(link.slug, 34)}</td>
                      <td>{link.utmContent || "—"}</td>
                      <td>{link.messageFocus || "—"}</td>
                      <td>
                        {link.trackedUrl ? (
                          <a href={link.trackedUrl} target="_blank" rel="noreferrer">
                            {truncateText(link.trackedUrl, 52)}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            className="button alt"
                            type="button"
                            onClick={() => copyTrackedUrl(link.trackedUrl)}
                          >
                            Copy URL
                          </button>
                          <button
                            className="button alt"
                            type="button"
                            onClick={() => populateLinkDraftFromLink(link)}
                          >
                            Duplicate
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </section>
  );
}
