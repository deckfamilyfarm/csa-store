import React, { useEffect, useState } from "react";
import { adminGet, adminPost, adminPut } from "../adminApi.js";
import { changePassword } from "../api.js";

const EMPTY_NEW_USER = {
  username: "",
  email: "",
  name: "",
  active: true,
  adminRoles: ["local_pricelist_admin"]
};

function normalizeUserDraft(user) {
  return {
    id: user.id,
    username: user.username || "",
    email: user.email || "",
    name: user.name || "",
    active: user.active !== false,
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

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

export function AdminUsersSection({ token, currentAdmin }) {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [newUser, setNewUser] = useState(EMPTY_NEW_USER);
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState({
    currentPassword: "",
    password: "",
    confirm: ""
  });
  const [loading, setLoading] = useState(false);
  const [savingUserId, setSavingUserId] = useState(null);
  const [resettingUserId, setResettingUserId] = useState(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [creating, setCreating] = useState(false);
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
          ? `Admin user added, but password email was not sent: ${response.emailReason || "email is not configured."}`
          : "Admin user added and password setup email sent."
      );
      await loadUsers();
    } catch (error) {
      setMessage(error?.message || "Failed to add admin user.");
    } finally {
      setCreating(false);
    }
  }

  async function sendResetPassword(user) {
    setResettingUserId(user.id);
    setMessage("");
    try {
      const response = await adminPost(`admin-users/${user.id}/reset-password`, token, {});
      setMessage(
        response.emailSent === false
          ? `Password reset was created, but email was not sent: ${response.emailReason || "email is not configured."}`
          : `Password reset email sent to ${user.email}.`
      );
    } catch (error) {
      setMessage(error?.message || "Failed to send password reset email.");
    } finally {
      setResettingUserId(null);
    }
  }

  async function submitChangePassword(event) {
    event.preventDefault();
    setMessage("");
    if (passwordDraft.password !== passwordDraft.confirm) {
      setMessage("New password and confirmation do not match.");
      return;
    }

    setChangingPassword(true);
    try {
      await changePassword(token, passwordDraft.currentPassword, passwordDraft.password);
      setPasswordDraft({ currentPassword: "", password: "", confirm: "" });
      setShowChangePassword(false);
      setMessage("Your password was changed.");
    } catch (error) {
      setMessage(error?.message || "Failed to change password.");
    } finally {
      setChangingPassword(false);
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
        <button className="button alt" type="button" onClick={() => setShowChangePassword(true)}>
          Change My Password
        </button>
      </div>

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
                    <span className="small">Password reset email</span>
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

      {showChangePassword ? (
        <div className="modal-backdrop" onClick={() => setShowChangePassword(false)}>
          <div className="modal modal-small" onClick={(event) => event.stopPropagation()}>
            <button
              className="modal-close"
              type="button"
              onClick={() => setShowChangePassword(false)}
            >
              Close
            </button>
            <div className="modal-body single">
              <div>
                <div className="eyebrow">Credentials</div>
                <h2 className="h2">Change My Password</h2>
                <form className="admin-form" onSubmit={submitChangePassword}>
                  <label className="filter-field">
                    <span className="small">Current password</span>
                    <input
                      className="input"
                      type="password"
                      value={passwordDraft.currentPassword}
                      onChange={(event) =>
                        setPasswordDraft((prev) => ({
                          ...prev,
                          currentPassword: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label className="filter-field">
                    <span className="small">New password</span>
                    <input
                      className="input"
                      type="password"
                      value={passwordDraft.password}
                      onChange={(event) =>
                        setPasswordDraft((prev) => ({ ...prev, password: event.target.value }))
                      }
                    />
                  </label>
                  <label className="filter-field">
                    <span className="small">Confirm new password</span>
                    <input
                      className="input"
                      type="password"
                      value={passwordDraft.confirm}
                      onChange={(event) =>
                        setPasswordDraft((prev) => ({ ...prev, confirm: event.target.value }))
                      }
                    />
                  </label>
                  <button className="button" type="submit" disabled={changingPassword}>
                    {changingPassword ? "Changing..." : "Change Password"}
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
              <th>Credentials</th>
              <th>Active</th>
              <th>Roles</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const draft = drafts[user.id] || normalizeUserDraft(user);
              const isCurrentUser = Number(user.id) === currentAdminId;
              const canReceiveResetEmail = isEmailAddress(draft.email);
              const hasUnsavedCredentialChanges =
                draft.username !== (user.username || "") || draft.email !== (user.email || "");
              return (
                <tr key={`admin-user-${user.id}`}>
                  <td>
                    <div className="admin-user-fields">
                      <div className="admin-user-row-heading">
                        <strong>{draft.username || "No username set"}</strong>
                        {isCurrentUser ? <span className="admin-user-you-badge">You</span> : null}
                      </div>
                      <label className="admin-user-field-label">
                        <span>Username</span>
                        <input
                          className="input"
                          value={draft.username}
                          onChange={(event) =>
                            updateDraft(user.id, { username: event.target.value })
                          }
                        />
                      </label>
                      <label className="admin-user-field-label">
                        <span>Password reset email</span>
                        <input
                          className="input"
                          type="email"
                          value={draft.email}
                          onChange={(event) => updateDraft(user.id, { email: event.target.value })}
                        />
                      </label>
                      {!canReceiveResetEmail ? (
                        <div className="admin-user-warning">
                          Enter a real password reset email before sending reset links.
                        </div>
                      ) : hasUnsavedCredentialChanges ? (
                        <div className="admin-user-warning">
                          Save username/email changes before sending reset links.
                        </div>
                      ) : null}
                      <label className="admin-user-field-label">
                        <span>Name</span>
                        <input
                          className="input"
                          value={draft.name}
                          onChange={(event) => updateDraft(user.id, { name: event.target.value })}
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
                        disabled={
                          resettingUserId === user.id ||
                          !canReceiveResetEmail ||
                          hasUnsavedCredentialChanges
                        }
                        onClick={() => sendResetPassword(user)}
                      >
                        {resettingUserId === user.id
                          ? "Sending..."
                          : isCurrentUser
                            ? "Email Me Reset Link"
                            : "Send Password Reset Email"}
                      </button>
                      {isCurrentUser ? (
                        <button
                          className="button alt"
                          type="button"
                          onClick={() => setShowChangePassword(true)}
                        >
                          Change Password Here
                        </button>
                      ) : null}
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
