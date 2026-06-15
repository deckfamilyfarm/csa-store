import jwt from "jsonwebtoken";
import { ensureAdminAccessSchema, getPool } from "../db.js";

function getTimesheetsApiUrl() {
  return String(process.env.TIMESHEETS_API_URL || "").trim().replace(/\/+$/, "");
}

export function isTimesheetsApiConfigured() {
  const baseUrl = getTimesheetsApiUrl();
  return Boolean(baseUrl && /^https?:\/\//i.test(baseUrl));
}

export function shouldUseTimesheetsAdminAuth() {
  const mode = String(process.env.CSA_ADMIN_AUTH_MODE || "").trim().toLowerCase();
  if (mode === "local") return false;
  if (mode === "timesheets") return true;
  return isTimesheetsApiConfigured();
}

function configuredTimesheetsApiUrl() {
  const baseUrl = getTimesheetsApiUrl();
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    const error = new Error("TIMESHEETS_API_URL must be configured for Timesheets admin login.");
    error.status = 503;
    throw error;
  }
  return baseUrl;
}

function readJsonResponse(response) {
  return response.json().catch(() => null);
}

function extractJwtClaims(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) {
    const error = new Error("Timesheets token format is invalid.");
    error.status = 401;
    throw error;
  }
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeTimesheetsRole(payload) {
  return normalizeString(payload?.data?.user_role ?? payload?.user_role ?? payload?.role ?? "team") || "team";
}

async function fetchTimesheetsRole(accessToken) {
  const response = await fetch(`${configuredTimesheetsApiUrl()}/auth/getUserRole`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: "{}"
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const error = new Error(
      payload?.message || payload?.error || "Failed to verify Timesheets user role."
    );
    error.status = response.status || 401;
    throw error;
  }
  return normalizeTimesheetsRole(payload);
}

function profileFromAccessToken(accessToken, fallbackUsername, role) {
  const claims = extractJwtClaims(accessToken);
  const username = normalizeString(claims.username ?? fallbackUsername);
  const employeeId = normalizeString(claims.employee_id);
  const timesheetsUserId = normalizeString(claims.id);

  if (!username || !employeeId) {
    const error = new Error("Timesheets token is missing username or employee_id.");
    error.status = 401;
    throw error;
  }

  return {
    accessToken,
    username,
    employeeId,
    timesheetsUserId,
    role
  };
}

export async function loginAgainstTimesheets(username, password) {
  const response = await fetch(`${configuredTimesheetsApiUrl()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || "Invalid username or password.");
    error.status = response.status || 401;
    throw error;
  }

  const accessToken = payload?.data?.token;
  if (!accessToken) {
    const error = new Error("Timesheets login did not return an access token.");
    error.status = 502;
    throw error;
  }

  const role = await fetchTimesheetsRole(accessToken);
  return profileFromAccessToken(accessToken, username, role);
}

export async function authenticateTimesheetsAccessToken(accessToken) {
  const role = await fetchTimesheetsRole(accessToken);
  return profileFromAccessToken(accessToken, "", role);
}

function mapLocalUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.passwordHash,
    role: row.role,
    name: row.name,
    active: row.active,
    timesheetsUserId: row.timesheetsUserId,
    timesheetsEmployeeId: row.timesheetsEmployeeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function localLinkConflict(user, profile, matchSource) {
  if (matchSource === "timesheetsUserId" || matchSource === "timesheetsEmployeeId") return false;
  if (
    user.timesheetsUserId &&
    profile.timesheetsUserId &&
    String(user.timesheetsUserId) !== String(profile.timesheetsUserId)
  ) {
    return true;
  }
  if (
    user.timesheetsEmployeeId &&
    profile.employeeId &&
    String(user.timesheetsEmployeeId) !== String(profile.employeeId)
  ) {
    return true;
  }
  return false;
}

async function findLocalUserForTimesheetsProfile(profile, submittedUsername = "") {
  await ensureAdminAccessSchema();

  const predicates = [];
  const params = [];
  if (profile.timesheetsUserId) {
    predicates.push("u.timesheets_user_id = ?");
    params.push(profile.timesheetsUserId);
  }
  if (profile.employeeId) {
    predicates.push("u.timesheets_employee_id = ?");
    params.push(profile.employeeId);
  }
  if (profile.username) {
    predicates.push("u.username = ?");
    params.push(profile.username);
  }
  if (submittedUsername && submittedUsername !== profile.username) {
    predicates.push("u.username = ?");
    params.push(submittedUsername);
  }

  if (!predicates.length) return null;

  const [rows] = await getPool().query(
    `
      SELECT
        u.id,
        u.username,
        u.email,
        u.password_hash AS passwordHash,
        u.role,
        u.name,
        COALESCE(u.active, 1) AS active,
        u.timesheets_user_id AS timesheetsUserId,
        u.timesheets_employee_id AS timesheetsEmployeeId,
        u.created_at AS createdAt,
        u.updated_at AS updatedAt
      FROM users u
      WHERE ${predicates.map((predicate) => `(${predicate})`).join(" OR ")}
    `,
    params
  );

  const ranked = rows
    .map((row) => {
      if (profile.timesheetsUserId && String(row.timesheetsUserId || "") === profile.timesheetsUserId) {
        return { row, rank: 0, source: "timesheetsUserId" };
      }
      if (profile.employeeId && String(row.timesheetsEmployeeId || "") === profile.employeeId) {
        return { row, rank: 1, source: "timesheetsEmployeeId" };
      }
      if (profile.username && String(row.username || "").toLowerCase() === profile.username.toLowerCase()) {
        return { row, rank: 2, source: "username" };
      }
      return { row, rank: 3, source: "submittedUsername" };
    })
    .sort((left, right) => left.rank - right.rank || Number(left.row.id) - Number(right.row.id));

  if (!ranked.length) return null;
  if (ranked[1] && ranked[0].rank === ranked[1].rank && Number(ranked[0].row.id) !== Number(ranked[1].row.id)) {
    const error = new Error("Multiple CSA users match this Timesheets account. Resolve the duplicate link before logging in.");
    error.status = 409;
    throw error;
  }

  const match = ranked[0];
  const user = mapLocalUserRow(match.row);
  if (localLinkConflict(user, profile, match.source)) {
    const error = new Error("This CSA user is linked to a different Timesheets account.");
    error.status = 403;
    throw error;
  }

  return { user, matchSource: match.source };
}

async function updateLocalTimesheetsLinkIfNeeded(user, profile) {
  const updates = [];
  const params = [];
  if (profile.timesheetsUserId && String(user.timesheetsUserId || "") !== profile.timesheetsUserId) {
    updates.push("timesheets_user_id = ?");
    params.push(profile.timesheetsUserId);
  }
  if (profile.employeeId && String(user.timesheetsEmployeeId || "") !== profile.employeeId) {
    updates.push("timesheets_employee_id = ?");
    params.push(profile.employeeId);
  }
  if (!updates.length) return;

  updates.push("updated_at = ?");
  params.push(new Date(), user.id);
  await getPool().query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params);
}

async function authenticateLocalAdminWithTimesheetsProfile(profile, submittedUsername = "") {
  const match = await findLocalUserForTimesheetsProfile(profile, submittedUsername);

  if (!match?.user) {
    const error = new Error(
      "Timesheets login is valid, but this Timesheets user is not linked to a CSA Store admin user."
    );
    error.status = 403;
    throw error;
  }

  if (Number(match.user.active) === 0) {
    const error = new Error("User is inactive");
    error.status = 403;
    throw error;
  }

  await updateLocalTimesheetsLinkIfNeeded(match.user, profile);
  return { user: { ...match.user, timesheetsUserId: profile.timesheetsUserId, timesheetsEmployeeId: profile.employeeId }, timesheets: profile };
}

export async function authenticateLocalAdminWithTimesheets(username, password) {
  const profile = await loginAgainstTimesheets(username, password);
  return authenticateLocalAdminWithTimesheetsProfile(profile, username);
}

export async function authenticateLocalAdminWithTimesheetsAccessToken(accessToken) {
  const profile = await authenticateTimesheetsAccessToken(accessToken);
  return authenticateLocalAdminWithTimesheetsProfile(profile, profile.username);
}

export function issueAdminToken(user, adminRoles = []) {
  return jwt.sign(
    { adminId: user.id, userId: user.id, role: user.role, adminRoles },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "30d" }
  );
}
