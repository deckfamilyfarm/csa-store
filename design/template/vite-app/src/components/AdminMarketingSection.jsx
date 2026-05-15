import React, { useEffect, useMemo, useState } from "react";
import { adminGet, adminPost } from "../adminApi.js";

function truncateText(value, maxLength = 72) {
  const text = String(value || "").trim();
  if (!text) return "—";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
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

export function AdminMarketingSection({ token }) {
  const [loading, setLoading] = useState(true);
  const [savingCampaign, setSavingCampaign] = useState(false);
  const [savingLink, setSavingLink] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [overview, setOverview] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [links, setLinks] = useState([]);
  const [campaignDraft, setCampaignDraft] = useState(createCampaignDraft());
  const [linkDraft, setLinkDraft] = useState(createLinkDraft());

  const sortedCampaigns = useMemo(
    () =>
      campaigns
        .slice()
        .sort((left, right) => new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt)),
    [campaigns]
  );

  const sortedLinks = useMemo(
    () =>
      links
        .slice()
        .sort((left, right) => new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt)),
    [links]
  );

  async function loadMarketing() {
    setLoading(true);
    setError("");
    try {
      const [overviewResponse, campaignsResponse, linksResponse] = await Promise.all([
        adminGet("marketing/overview", token),
        adminGet("marketing/campaigns", token),
        adminGet("marketing/utm-links", token)
      ]);
      const nextCampaigns = campaignsResponse?.campaigns || [];
      setOverview(overviewResponse || null);
      setCampaigns(nextCampaigns);
      setLinks(linksResponse?.links || []);
      setLinkDraft((current) => ({
        ...current,
        campaignId:
          current.campaignId ||
          String(nextCampaigns[0]?.id || "")
      }));
    } catch (loadError) {
      setError(loadError?.message || "Failed to load marketing data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMarketing();
  }, [token]);

  async function handleCreateCampaign(event) {
    event.preventDefault();
    setSavingCampaign(true);
    setError("");
    setMessage("");
    try {
      const response = await adminPost("marketing/campaigns", token, campaignDraft);
      const createdCampaign = response?.campaign || null;
      if (createdCampaign) {
        setCampaigns((current) => [createdCampaign, ...current.filter((entry) => entry.id !== createdCampaign.id)]);
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

  return (
    <section className="admin-section">
      <h3>Marketing</h3>
      <div className="small">
        Manage campaigns and tracked subscribe links for attribution-driven landing pages and ads.
      </div>
      {message ? <div className="small">{message}</div> : null}
      {error ? <div className="small">{error}</div> : null}

      {overview?.summary ? (
        <div className="response-list">
          <div className="response-card">
            <div className="title">Campaigns</div>
            <div className="small">{overview.summary.campaigns || 0}</div>
          </div>
          <div className="response-card">
            <div className="title">Tracked Links</div>
            <div className="small">{overview.summary.trackedLinks || 0}</div>
          </div>
          <div className="response-card">
            <div className="title">Clicks</div>
            <div className="small">{overview.summary.clickEvents || 0}</div>
          </div>
          <div className="response-card">
            <div className="title">Subscriber Events</div>
            <div className="small">{overview.summary.subscriberEvents || 0}</div>
          </div>
        </div>
      ) : null}

      <div className="admin-grid" style={{ alignItems: "start" }}>
        <form className="response-card" onSubmit={handleCreateCampaign}>
          <div className="title">New Campaign</div>
          <input
            className="input"
            placeholder="Campaign slug"
            value={campaignDraft.slug}
            onChange={(event) => setCampaignDraft((current) => ({ ...current, slug: event.target.value }))}
          />
          <input
            className="input"
            placeholder="Campaign name"
            value={campaignDraft.name}
            onChange={(event) => setCampaignDraft((current) => ({ ...current, name: event.target.value }))}
          />
          <div className="admin-grid">
            <input
              className="input"
              placeholder="Platform"
              value={campaignDraft.platform}
              onChange={(event) => setCampaignDraft((current) => ({ ...current, platform: event.target.value }))}
            />
            <input
              className="input"
              placeholder="Channel"
              value={campaignDraft.channel}
              onChange={(event) => setCampaignDraft((current) => ({ ...current, channel: event.target.value }))}
            />
          </div>
          <select
            className="input"
            value={campaignDraft.messageFocus}
            onChange={(event) => setCampaignDraft((current) => ({ ...current, messageFocus: event.target.value }))}
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
            onChange={(event) => setCampaignDraft((current) => ({ ...current, destinationUrl: event.target.value }))}
          />
          <textarea
            className="textarea"
            rows={3}
            placeholder="Notes"
            value={campaignDraft.notes}
            onChange={(event) => setCampaignDraft((current) => ({ ...current, notes: event.target.value }))}
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
                  campaigns.find((campaign) => String(campaign.id) === String(event.target.value))?.slug || current.utmCampaign
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
            onChange={(event) => setLinkDraft((current) => ({ ...current, slug: event.target.value }))}
          />
          <input
            className="input"
            placeholder="Link label"
            value={linkDraft.label}
            onChange={(event) => setLinkDraft((current) => ({ ...current, label: event.target.value }))}
          />
          <div className="admin-grid">
            <input
              className="input"
              placeholder="UTM source"
              value={linkDraft.utmSource}
              onChange={(event) => setLinkDraft((current) => ({ ...current, utmSource: event.target.value }))}
            />
            <input
              className="input"
              placeholder="UTM medium"
              value={linkDraft.utmMedium}
              onChange={(event) => setLinkDraft((current) => ({ ...current, utmMedium: event.target.value }))}
            />
          </div>
          <div className="admin-grid">
            <input
              className="input"
              placeholder="UTM campaign"
              value={linkDraft.utmCampaign}
              onChange={(event) => setLinkDraft((current) => ({ ...current, utmCampaign: event.target.value }))}
            />
            <input
              className="input"
              placeholder="UTM content"
              value={linkDraft.utmContent}
              onChange={(event) => setLinkDraft((current) => ({ ...current, utmContent: event.target.value }))}
            />
          </div>
          <select
            className="input"
            value={linkDraft.messageFocus}
            onChange={(event) => setLinkDraft((current) => ({ ...current, messageFocus: event.target.value }))}
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
            onChange={(event) => setLinkDraft((current) => ({ ...current, usageInstructions: event.target.value }))}
          />
          <button className="button alt" type="submit" disabled={savingLink}>
            {savingLink ? "Creating..." : "Create Tracked Link"}
          </button>
        </form>
      </div>

      {loading ? (
        <div className="small">Loading marketing data...</div>
      ) : (
        <>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="audit-section">
            <h4>Link Analytics</h4>
            {!overview?.linkStats?.length ? (
              <div className="small">No tracked-link analytics yet.</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Slug</th>
                    <th>Focus</th>
                    <th>Clicks</th>
                    <th>Signups</th>
                    <th>Conv %</th>
                    <th>Top Source</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.linkStats.map((stat) => (
                    <tr key={stat.linkId || stat.slug}>
                      <td title={stat.slug || "—"}>{truncateText(stat.slug, 36)}</td>
                      <td>{stat.messageFocus || "—"}</td>
                      <td>{stat.clicks || 0}</td>
                      <td>{stat.subscribers || 0}</td>
                      <td>{Number(stat.conversionRate || 0).toFixed(1)}%</td>
                      <td title={stat.topReferrers?.map((entry) => `${entry.host} (${entry.count})`).join(", ") || "—"}>
                        {stat.topReferrers?.length
                          ? `${stat.topReferrers[0].host} (${stat.topReferrers[0].count})`
                          : "—"}
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
