import React, { useEffect, useState } from "react";
import { adminGet, adminPost, adminPut } from "../adminApi.js";

const EMPTY_NEW_USER = {
  username: "",
  email: "",
  name: "",
  active: true,
  timesheetsUserId: "",
  timesheetsEmployeeId: "",
  adminRoles: ["local_pricelist_admin"]
};

function normalizeUserDraft(user) {
  return {
    id: user.id,
    username: user.username || "",
    email: user.email || "",
    name: user.name || "",
    active: user.active !== false,
    timesheetsUserId: user.timesheetsUserId || "",
    timesheetsEmployeeId: user.timesheetsEmployeeId || "",
    adminRoles: Array.isArray(user.adminRoles) ? user.adminRoles : []
  };
}

function toggleRole(roleKeys, roleKey) {
  const current = new Set(roleKeys || []);
  if (current.has(roleKey)) {
    current.delete(roleKey);
  } else {
    current.add(roleKey);
  }
  return [...current];
}

function allRoleKeys(roles) {
  return roles.map((role) => role.key).filter(Boolean);
}

function visibleRoleKeys(roleKeys, roles) {
  const current = roleKeys || [];
  return current.includes("admin") ? allRoleKeys(roles) : current;
}

function toggleAdminAwareRole(roleKeys, roleKey, roles) {
  const current = new Set(visibleRoleKeys(roleKeys, roles));
  if (roleKey === "admin") {
    if (current.has("admin")) {
      current.delete("admin");
      return [...current];
    }
    return allRoleKeys(roles);
  }

  if (current.has("admin")) {
    return [...current];
  }

  return toggleRole([...current], roleKey);
}

function formatResetExpiry(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function formatSyncSummary(summary = {}) {
  const parts = [
    `total ${summary.total || 0}`,
    `linked ${summary.linked || 0}`,
    `matches ${summary.match || 0}`,
    `ambiguous ${summary.ambiguous || 0}`,
    `missing ${summary.no_match || 0}`
  ];
  return parts.join(" | ");
}

function formatTimesheetsMatch(item) {
  const user = item?.proposed;
  if (!user) return "";
  return [user.username, user.name, user.employeeId].filter(Boolean).join(" | ");
}

export function AdminUsersSection({ token, currentAdmin }) {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [newUser, setNewUser] = useState(EMPTY_NEW_USER);
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingUserId, setSavingUserId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [syncingTimesheets, setSyncingTimesheets] = useState(false);
  const [syncPreview, setSyncPreview] = useState(null);
  const [message, setMessage] = useState("");

  async function loadUsers() {
    if (!token) return;
    setLoading(true);
    setMessage("");
    try {
      const response = await adminGet("admin-users", token);
      setUsers(response.users || []);
      setRoles(response.roles || []);
      setDrafts(
        (response.users || []).reduce((acc, user) => {
          acc[user.id] = normalizeUserDraft(user);
          return acc;
        }, {})
      );
    } catch (error) {
      setMessage(error?.message || "Failed to load admin users.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, [token]);

  function updateDraft(userId, patch) {
    setDrafts((prev) => ({
      ...prev,
      [userId]: {
        ...prev[userId],
        ...patch
      }
    }));
  }

  async function saveUser(userId) {
    const draft = drafts[userId];
    if (!draft) return;
    setSavingUserId(userId);
    setMessage("");
    try {
      await adminPut(`admin-users/${userId}`, token, {
        username: draft.username,
        email: draft.email,
        name: draft.name,
        active: draft.active,
        timesheetsUserId: draft.timesheetsUserId,
        timesheetsEmployeeId: draft.timesheetsEmployeeId,
        adminRoles: draft.adminRoles
      });
      setMessage("Admin user saved.");
      await loadUsers();
    } catch (error) {
      setMessage(error?.message || "Failed to save admin user.");
    } finally {
      setSavingUserId(null);
    }
  }

  async function createUser(event) {
    event.preventDefault();
    setCreating(true);
    setMessage("");
    try {
      const response = await adminPost("admin-users", token, newUser);
      setNewUser(EMPTY_NEW_USER);
      setShowCreateUser(false);
      setMessage(
        response.emailSent === false
          ? `Admin user added. ${response.emailReason || "Link a Timesheets login before they can sign in."}`
          : `Admin user added and password setup email sent. Expires ${formatResetExpiry(response.expiresAt)}.`
      );
      await loadUsers();
    } catch (error) {
      setMessage(error?.message || "Failed to add admin user.");
    } finally {
      setCreating(false);
    }
  }

  async function previewTimesheetsSync() {
    setSyncingTimesheets(true);
    setMessage("");
    try {
      const response = await adminGet("admin-users/timesheets-sync", token);
      setSyncPreview(response);
      setMessage(`Timesheets sync preview loaded: ${formatSyncSummary(response.summary)}.`);
    } catch (error) {
      setMessage(error?.message || "Failed to preview Timesheets sync.");
    } finally {
      setSyncingTimesheets(false);
    }
  }

  async function applyTimesheetsSync() {
    setSyncingTimesheets(true);
    setMessage("");
    try {
      const response = await adminPost("admin-users/timesheets-sync", token, { dryRun: false });
      setSyncPreview(response);
      setMessage(`Applied ${response.appliedCount || 0} Timesheets user links.`);
      await loadUsers();
    } catch (error) {
      setMessage(error?.message || "Failed to apply Timesheets sync.");
    } finally {
      setSyncingTimesheets(false);
    }
  }

  const currentAdminId = Number(currentAdmin?.id || 0);

  return (
    <section className="admin-section admin-users-section">
      <h3>Users</h3>
      {message ? <div className="small">{message}</div> : null}
      {loading ? <div className="small">Loading users...</div> : null}

      <div className="admin-user-toolbar">
        <button className="button" type="button" onClick={() => setShowCreateUser(true)}>
          Add User
        </button>
        <button className="button alt" type="button" onClick={previewTimesheetsSync} disabled={syncingTimesheets}>
          Preview Timesheets Sync
        </button>
        <button className="button alt" type="button" onClick={applyTimesheetsSync} disabled={syncingTimesheets}>
          Apply Exact Timesheets Matches
        </button>
      </div>

      {syncPreview ? (
        <div className="admin-table-shell">
          <table className="admin-table">
            <thead>
              <tr>
                <th>CSA User</th>
                <th>Status</th>
                <th>Method</th>
                <th>Timesheets Match</th>
              </tr>
            </thead>
            <tbody>
              {(syncPreview.items || []).map((item) => (
                <tr key={`timesheets-sync-${item.userId}`}>
                  <td>{item.username}</td>
                  <td>{item.status}</td>
                  <td>{item.matchMethod || ""}</td>
                  <td>{formatTimesheetsMatch(item)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {showCreateUser ? (
        <div className="modal-backdrop" onClick={() => setShowCreateUser(false)}>
          <div className="modal modal-small" onClick={(event) => event.stopPropagation()}>
            <button
              className="modal-close"
              type="button"
              onClick={() => setShowCreateUser(false)}
            >
              Close
            </button>
            <div className="modal-body single">
              <div>
                <div className="eyebrow">Users</div>
                <h2 className="h2">Add User</h2>
                <form className="admin-form" onSubmit={createUser}>
                  <label className="filter-field">
                    <span className="small">Username</span>
                    <input
                      className="input"
                      value={newUser.username}
                      onChange={(event) =>
                        setNewUser((prev) => ({ ...prev, username: event.target.value }))
                      }
                    />
                  </label>
                  <label className="filter-field">
                    <span className="small">Contact email</span>
                    <input
                      className="input"
                      type="email"
                      value={newUser.email}
                      onChange={(event) =>
                        setNewUser((prev) => ({ ...prev, email: event.target.value }))
                      }
                    />
                  </label>
                  <label className="filter-field">
                    <span className="small">Name</span>
                    <input
                      className="input"
                      value={newUser.name}
                      onChange={(event) =>
                        setNewUser((prev) => ({ ...prev, name: event.target.value }))
                      }
                    />
                  </label>
                  <label className="filter-field">
                    <span className="small">Timesheets user ID</span>
                    <input
                      className="input"
                      value={newUser.timesheetsUserId}
                      onChange={(event) =>
                        setNewUser((prev) => ({ ...prev, timesheetsUserId: event.target.value }))
                      }
                    />
                  </label>
                  <label className="filter-field">
                    <span className="small">Timesheets employee ID</span>
                    <input
                      className="input"
                      value={newUser.timesheetsEmployeeId}
                      onChange={(event) =>
                        setNewUser((prev) => ({ ...prev, timesheetsEmployeeId: event.target.value }))
                      }
                    />
                  </label>
                  <label className="filter-toggle admin-user-active-toggle">
                    <input
                      type="checkbox"
                      checked={newUser.active}
                      onChange={(event) =>
                        setNewUser((prev) => ({ ...prev, active: event.target.checked }))
                      }
                    />
                    <span>Active</span>
                  </label>
                  <div className="admin-role-grid admin-role-grid-modal">
                    {roles.map((role) => (
                      <label key={`new-role-${role.key}`} className="admin-role-option">
                        <input
                          type="checkbox"
                          checked={visibleRoleKeys(newUser.adminRoles, roles).includes(role.key)}
                          disabled={
                            role.key !== "admin" &&
                            visibleRoleKeys(newUser.adminRoles, roles).includes("admin")
                          }
                          onChange={() =>
                            setNewUser((prev) => ({
                              ...prev,
                              adminRoles: toggleAdminAwareRole(prev.adminRoles, role.key, roles)
                            }))
                          }
                        />
                        <span>{role.label}</span>
                      </label>
                    ))}
                  </div>
                  <button className="button" type="submit" disabled={creating}>
                    {creating ? "Adding..." : "Add User"}
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="admin-table-shell admin-users-table-shell">
        <table className="admin-table admin-users-table">
          <thead>
            <tr>
              <th>User & Timesheets</th>
              <th>Active</th>
              <th>Roles</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const draft = drafts[user.id] || normalizeUserDraft(user);
              const isCurrentUser = Number(user.id) === currentAdminId;
              return (
                <tr key={`admin-user-${user.id}`}>
                  <td>
                    <div className="admin-user-fields">
                      <div className="admin-user-row-heading">
                        <strong>{draft.username || "No username set"}</strong>
                        {isCurrentUser ? <span className="admin-user-you-badge">You</span> : null}
                      </div>
                      <label className="admin-user-field-label">
                        <span>CSA username</span>
                        <input
                          className="input"
                          value={draft.username}
                          onChange={(event) =>
                            updateDraft(user.id, { username: event.target.value })
                          }
                        />
                      </label>
                      <label className="admin-user-field-label">
                        <span>Contact email</span>
                        <input
                          className="input"
                          type="email"
                          value={draft.email}
                          onChange={(event) => updateDraft(user.id, { email: event.target.value })}
                        />
                      </label>
                      <label className="admin-user-field-label">
                        <span>Name</span>
                        <input
                          className="input"
                          value={draft.name}
                          onChange={(event) => updateDraft(user.id, { name: event.target.value })}
                        />
                      </label>
                      <label className="admin-user-field-label">
                        <span>Timesheets user ID</span>
                        <input
                          className="input"
                          value={draft.timesheetsUserId}
                          onChange={(event) =>
                            updateDraft(user.id, { timesheetsUserId: event.target.value })
                          }
                        />
                      </label>
                      <label className="admin-user-field-label">
                        <span>Timesheets employee ID</span>
                        <input
                          className="input"
                          value={draft.timesheetsEmployeeId}
                          onChange={(event) =>
                            updateDraft(user.id, { timesheetsEmployeeId: event.target.value })
                          }
                        />
                      </label>
                    </div>
                  </td>
                  <td>
                    <button
                      className={`toggle-switch ${draft.active ? "active" : ""}`}
                      type="button"
                      onClick={() => updateDraft(user.id, { active: !draft.active })}
                    />
                  </td>
                  <td>
                    <div className="admin-role-grid">
                      {roles.map((role) => (
                        <label key={`role-${user.id}-${role.key}`} className="admin-role-option">
                          <input
                            type="checkbox"
                            checked={visibleRoleKeys(draft.adminRoles, roles).includes(role.key)}
                            disabled={
                              role.key !== "admin" &&
                              visibleRoleKeys(draft.adminRoles, roles).includes("admin")
                            }
                            onChange={() =>
                              updateDraft(user.id, {
                                adminRoles: toggleAdminAwareRole(draft.adminRoles, role.key, roles)
                              })
                            }
                          />
                          <span>{role.label}</span>
                        </label>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div className="admin-user-actions">
                      <button
                        className="button alt"
                        type="button"
                        disabled={savingUserId === user.id}
                        onClick={() => saveUser(user.id)}
                      >
                        {savingUserId === user.id ? "Saving..." : "Save"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!users.length ? (
              <tr>
                <td className="small" colSpan="4">
                  No backend users found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
