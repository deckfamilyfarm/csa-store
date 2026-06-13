import React, { useEffect, useMemo, useState } from "react";
import { adminGet, adminPut } from "../adminApi.js";

const PAGE_LABELS = {
  home: "Home",
  subscribe: "Subscribe",
  dropsites: "Drop Sites"
};

const SECTION_LABELS = {
  hero: "Hero",
  shop: "Shop",
  boxes: "Boxes",
  sides: "Sides",
  pickup: "Pickup",
  resources: "Resources",
  metrics: "Metrics",
  apply: "Application",
  form: "Form"
};

function formatKey(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function pageLabel(page) {
  return PAGE_LABELS[page] || formatKey(page);
}

function sectionLabel(section) {
  return SECTION_LABELS[section] || formatKey(section);
}

function sortBlocks(left, right) {
  const leftOrder = Number(left.sortOrder || 0);
  const rightOrder = Number(right.sortOrder || 0);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  if (left.section !== right.section) return String(left.section).localeCompare(String(right.section));
  return String(left.field).localeCompare(String(right.field));
}

export function AdminContentSection({ token, onSiteContentRefresh }) {
  const [blocks, setBlocks] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [activePage, setActivePage] = useState("home");
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadContent() {
    setLoading(true);
    setError("");
    try {
      const response = await adminGet("site-content", token);
      const nextBlocks = (response?.content || []).slice().sort(sortBlocks);
      setBlocks(nextBlocks);
      setDrafts(
        Object.fromEntries(nextBlocks.map((block) => [String(block.id), block.value || ""]))
      );
    } catch (loadError) {
      setError(loadError?.message || "Failed to load site content.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadContent();
  }, [token]);

  const pageKeys = useMemo(() => {
    const seen = new Set();
    return blocks
      .map((block) => block.page)
      .filter((page) => {
        if (!page || seen.has(page)) return false;
        seen.add(page);
        return true;
      });
  }, [blocks]);

  useEffect(() => {
    if (!pageKeys.length) return;
    setActivePage((current) => (pageKeys.includes(current) ? current : pageKeys[0]));
  }, [pageKeys]);

  const activeBlocks = useMemo(
    () => blocks.filter((block) => block.page === activePage).sort(sortBlocks),
    [blocks, activePage]
  );

  function updateDraft(blockId, value) {
    setDrafts((current) => ({ ...current, [String(blockId)]: value }));
    setMessage("");
    setError("");
  }

  function resetDraft(block) {
    setDrafts((current) => ({ ...current, [String(block.id)]: block.value || "" }));
    setMessage("");
    setError("");
  }

  async function saveBlock(block) {
    const blockId = String(block.id);
    setSavingId(block.id);
    setMessage("");
    setError("");
    try {
      const response = await adminPut(`site-content/${block.id}`, token, {
        value: drafts[blockId] ?? ""
      });
      const updatedBlock = response?.contentBlock;
      if (updatedBlock) {
        setBlocks((current) =>
          current
            .map((entry) => (entry.id === updatedBlock.id ? updatedBlock : entry))
            .sort(sortBlocks)
        );
        setDrafts((current) => ({ ...current, [String(updatedBlock.id)]: updatedBlock.value || "" }));
        setMessage(`Saved ${pageLabel(updatedBlock.page)} ${sectionLabel(updatedBlock.section)}.`);
      } else {
        await loadContent();
        setMessage("Saved content.");
      }
      await onSiteContentRefresh?.();
    } catch (saveError) {
      setError(saveError?.message || "Failed to save content.");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section className="admin-section admin-content-editor-section">
      <div className="admin-header">
        <div>
          <h3>Site Content</h3>
          <div className="small">
            Edit public page copy for the home, subscribe, and drop-site pages. Changes publish
            immediately after saving.
          </div>
        </div>
        <button className="button alt" type="button" onClick={loadContent} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error ? <div className="small subscribe-error">{error}</div> : null}
      {message ? <div className="small subscribe-success-message">{message}</div> : null}

      {loading ? (
        <div className="small">Loading site content...</div>
      ) : (
        <>
          <div className="admin-content-editor-tabs" role="tablist" aria-label="Content pages">
            {pageKeys.map((page) => (
              <button
                key={page}
                className={`admin-nav-item ${activePage === page ? "active" : ""}`}
                type="button"
                role="tab"
                aria-selected={activePage === page ? "true" : "false"}
                onClick={() => setActivePage(page)}
              >
                {pageLabel(page)}
              </button>
            ))}
          </div>

          <div className="admin-content-editor-list">
            {activeBlocks.map((block) => {
              const blockId = String(block.id);
              const draftValue = drafts[blockId] ?? "";
              const cleanValue = block.value || "";
              const isDirty = draftValue !== cleanValue;
              const isTextInput = block.inputType === "text";

              return (
                <article className="card admin-content-block" key={block.id}>
                  <div className="admin-content-block-head">
                    <div>
                      <div className="eyebrow">{sectionLabel(block.section)}</div>
                      <h4>{block.label || formatKey(block.field)}</h4>
                    </div>
                    <code className="admin-content-block-key">
                      {block.page}.{block.section}.{block.field}
                    </code>
                  </div>

                  <label className="filter-field">
                    <span className="small">Copy</span>
                    {isTextInput ? (
                      <input
                        className="input admin-content-editor-input"
                        value={draftValue}
                        onChange={(event) => updateDraft(block.id, event.target.value)}
                      />
                    ) : (
                      <textarea
                        className="textarea admin-content-editor-textarea"
                        value={draftValue}
                        onChange={(event) => updateDraft(block.id, event.target.value)}
                      />
                    )}
                  </label>

                  <div className="admin-content-editor-actions">
                    <button
                      className="button"
                      type="button"
                      disabled={!isDirty || savingId === block.id}
                      onClick={() => saveBlock(block)}
                    >
                      {savingId === block.id ? "Saving..." : "Save"}
                    </button>
                    <button
                      className="button alt"
                      type="button"
                      disabled={!isDirty || savingId === block.id}
                      onClick={() => resetDraft(block)}
                    >
                      Reset
                    </button>
                  </div>
                </article>
              );
            })}
            {!activeBlocks.length ? (
              <div className="small">No editable content blocks are configured for this page.</div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
