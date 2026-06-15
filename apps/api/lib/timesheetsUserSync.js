import fs from "fs";
import mysql from "mysql2/promise";
import { ensureAdminAccessSchema, getPool } from "../db.js";

function normalize(value) {
  return String(value || "").trim();
}

function normalizeComparable(value) {
  return normalize(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactComparable(value) {
  return normalizeComparable(value).replace(/\s+/g, "");
}

function splitName(value) {
  const raw = normalize(value);
  if (!raw) return { firstName: "", lastName: "" };
  if (raw.includes(",")) {
    const [lastName = "", firstName = ""] = raw.split(",").map((part) => normalize(part));
    return { firstName, lastName };
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] || "", lastName: "" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1]
  };
}

function displayNameForLocalUser(user) {
  return normalize(user.name) || normalize(user.username);
}

function summarizeTimesheetsUser(row) {
  return {
    timesheetsUserId: normalize(row.timesheetsUserId),
    username: normalize(row.username),
    employeeId: normalize(row.employeeId),
    name: normalize(row.name),
    email: normalize(row.email),
    active: row.active === null || row.active === undefined ? null : Number(row.active) !== 0,
    userRole: normalize(row.userRole)
  };
}

function getTimesheetsDatabaseUrl() {
  return normalize(process.env.TIMESHEETS_DATABASE_URL || process.env.TIMESHEETS_DB_URL);
}

function readSslConfig() {
  const caPath = normalize(process.env.TIMESHEETS_DB_CA_PATH || process.env.DB_CA_PATH);
  if (caPath) {
    try {
      return { ca: fs.readFileSync(caPath, "utf8"), rejectUnauthorized: true };
    } catch (error) {
      throw new Error(`Unable to read Timesheets DB CA file at ${caPath}: ${error.message}`);
    }
  }

  const sslFlag = normalize(process.env.TIMESHEETS_DB_SSL || process.env.DB_SSL).toLowerCase();
  if (["1", "true", "yes", "require"].includes(sslFlag)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function buildTimesheetsConnectionConfig() {
  const databaseUrl = getTimesheetsDatabaseUrl();
  if (databaseUrl) {
    const url = new URL(databaseUrl);
    return {
      host: url.hostname,
      port: Number(url.port || process.env.TIMESHEETS_DB_PORT || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, "") || "timesheets",
      ssl: readSslConfig(),
      waitForConnections: true,
      connectionLimit: Number(process.env.TIMESHEETS_DB_CONNECTION_LIMIT || 4),
      queueLimit: 0
    };
  }

  const host = normalize(process.env.TIMESHEETS_DB_HOST);
  const user = normalize(process.env.TIMESHEETS_DB_USER);
  const password = process.env.TIMESHEETS_DB_PASSWORD;
  if (!host || !user || password === undefined) {
    const error = new Error("TIMESHEETS_DATABASE_URL or TIMESHEETS_DB_HOST/USER/PASSWORD must be configured for user sync.");
    error.status = 503;
    throw error;
  }

  return {
    host,
    port: Number(process.env.TIMESHEETS_DB_PORT || 3306),
    user,
    password,
    database: normalize(process.env.TIMESHEETS_DB_DATABASE) || "timesheets",
    ssl: readSslConfig(),
    waitForConnections: true,
    connectionLimit: Number(process.env.TIMESHEETS_DB_CONNECTION_LIMIT || 4),
    queueLimit: 0
  };
}

async function createTimesheetsPool() {
  return mysql.createPool(buildTimesheetsConnectionConfig());
}

async function listTimesheetsLoginUsers(pool) {
  const [rows] = await pool.query(
    `
      SELECT
        u.id AS timesheetsUserId,
        u.username,
        u.employee_id AS employeeId,
        u.user_role AS userRole,
        e.name,
        e.email,
        e.is_active AS active
      FROM users u
      LEFT JOIN employees e ON e.id = u.employee_id
      ORDER BY e.name ASC, u.username ASC
    `
  );
  return rows.map(summarizeTimesheetsUser);
}

async function listLocalUsers({ includeAll = false } = {}) {
  await ensureAdminAccessSchema();
  const [rows] = await getPool().query(
    `
      SELECT
        u.id,
        u.username,
        u.email,
        u.name,
        u.role,
        COALESCE(u.active, 1) AS active,
        u.timesheets_user_id AS timesheetsUserId,
        u.timesheets_employee_id AS timesheetsEmployeeId,
        GROUP_CONCAT(r.role_key ORDER BY r.role_key SEPARATOR ',') AS adminRoleKeys
      FROM users u
      LEFT JOIN admin_user_roles ur ON ur.user_id = u.id
      LEFT JOIN admin_roles r ON r.id = ur.role_id
      WHERE ${
        includeAll
          ? "1 = 1"
          : "EXISTS (SELECT 1 FROM admin_user_roles scoped_ur WHERE scoped_ur.user_id = u.id)"
      }
      GROUP BY u.id
      ORDER BY u.username ASC
    `
  );
  return rows.map((row) => ({
    id: Number(row.id),
    username: normalize(row.username),
    email: normalize(row.email),
    name: normalize(row.name),
    role: normalize(row.role),
    active: Number(row.active) !== 0,
    timesheetsUserId: normalize(row.timesheetsUserId),
    timesheetsEmployeeId: normalize(row.timesheetsEmployeeId),
    adminRoles: normalize(row.adminRoleKeys)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  }));
}

function uniqueByIdentity(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.timesheetsUserId || candidate.employeeId || candidate.username;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickUnique(candidates, predicate) {
  const matches = uniqueByIdentity(candidates.filter(predicate));
  return matches.length === 1 ? matches[0] : null;
}

function findProposedMatch(localUser, timesheetsUsers) {
  const linked = timesheetsUsers.find(
    (candidate) =>
      (localUser.timesheetsUserId && candidate.timesheetsUserId === localUser.timesheetsUserId) ||
      (localUser.timesheetsEmployeeId && candidate.employeeId === localUser.timesheetsEmployeeId)
  );
  if (linked) {
    return {
      status: "linked",
      matchMethod: localUser.timesheetsUserId ? "timesheets_user_id" : "timesheets_employee_id",
      proposed: linked,
      candidates: [linked],
      canApply: false
    };
  }

  const byUsername = pickUnique(
    timesheetsUsers,
    (candidate) => candidate.username.toLowerCase() === localUser.username.toLowerCase()
  );
  if (byUsername) {
    return {
      status: "match",
      matchMethod: "username",
      proposed: byUsername,
      candidates: [byUsername],
      canApply: true
    };
  }

  const localDisplayName = displayNameForLocalUser(localUser);
  const localParts = splitName(localDisplayName);
  const localLastName = compactComparable(localParts.lastName);
  if (!localLastName) {
    return {
      status: "missing_local_last_name",
      matchMethod: "",
      proposed: null,
      candidates: [],
      canApply: false
    };
  }

  const lastNameCandidates = uniqueByIdentity(
    timesheetsUsers.filter((candidate) => compactComparable(splitName(candidate.name).lastName) === localLastName)
  );

  if (!lastNameCandidates.length) {
    return {
      status: "no_match",
      matchMethod: "last_name",
      proposed: null,
      candidates: [],
      canApply: false
    };
  }

  const localEmail = localUser.email.toLowerCase();
  const byEmail = localEmail
    ? pickUnique(lastNameCandidates, (candidate) => candidate.email.toLowerCase() === localEmail)
    : null;
  if (byEmail) {
    return {
      status: "match",
      matchMethod: "email_last_name",
      proposed: byEmail,
      candidates: [byEmail],
      canApply: true
    };
  }

  const localFullName = compactComparable(localDisplayName);
  const byFullName = localFullName
    ? pickUnique(lastNameCandidates, (candidate) => compactComparable(candidate.name) === localFullName)
    : null;
  if (byFullName) {
    return {
      status: "match",
      matchMethod: "full_name",
      proposed: byFullName,
      candidates: [byFullName],
      canApply: true
    };
  }

  if (lastNameCandidates.length === 1) {
    return {
      status: "match",
      matchMethod: "last_name",
      proposed: lastNameCandidates[0],
      candidates: lastNameCandidates,
      canApply: true
    };
  }

  return {
    status: "ambiguous",
    matchMethod: "last_name",
    proposed: null,
    candidates: lastNameCandidates,
    canApply: false
  };
}

function summarizePreview(items) {
  return items.reduce(
    (summary, item) => {
      summary.total += 1;
      summary[item.status] = (summary[item.status] || 0) + 1;
      if (item.canApply) summary.applicable += 1;
      return summary;
    },
    { total: 0, applicable: 0 }
  );
}

export async function previewTimesheetsUserSync({ includeAll = false } = {}) {
  const timesheetsPool = await createTimesheetsPool();
  try {
    const [localUsers, timesheetsUsers] = await Promise.all([
      listLocalUsers({ includeAll }),
      listTimesheetsLoginUsers(timesheetsPool)
    ]);

    const items = localUsers.map((localUser) => {
      const match = findProposedMatch(localUser, timesheetsUsers);
      return {
        userId: localUser.id,
        username: localUser.username,
        name: localUser.name,
        email: localUser.email,
        active: localUser.active,
        adminRoles: localUser.adminRoles,
        current: {
          timesheetsUserId: localUser.timesheetsUserId,
          timesheetsEmployeeId: localUser.timesheetsEmployeeId
        },
        ...match,
        candidates: (match.candidates || []).map(summarizeTimesheetsUser),
        proposed: match.proposed ? summarizeTimesheetsUser(match.proposed) : null
      };
    });

    return {
      ok: true,
      includeAll: Boolean(includeAll),
      timesheetsUserCount: timesheetsUsers.length,
      summary: summarizePreview(items),
      items
    };
  } finally {
    await timesheetsPool.end();
  }
}

export async function applyTimesheetsUserSync({ includeAll = false, userIds = [] } = {}) {
  const allowedUserIds = new Set((Array.isArray(userIds) ? userIds : []).map((value) => Number(value)).filter(Number.isFinite));
  const preview = await previewTimesheetsUserSync({ includeAll });
  const applicable = preview.items.filter(
    (item) => item.canApply && (!allowedUserIds.size || allowedUserIds.has(Number(item.userId)))
  );

  const applied = [];
  for (const item of applicable) {
    await getPool().query(
      `
        UPDATE users
        SET timesheets_user_id = ?,
            timesheets_employee_id = ?,
            updated_at = ?
        WHERE id = ?
      `,
      [
        item.proposed?.timesheetsUserId || null,
        item.proposed?.employeeId || null,
        new Date(),
        item.userId
      ]
    );
    applied.push({
      userId: item.userId,
      username: item.username,
      matchMethod: item.matchMethod,
      timesheetsUserId: item.proposed?.timesheetsUserId || "",
      timesheetsEmployeeId: item.proposed?.employeeId || "",
      timesheetsUsername: item.proposed?.username || "",
      timesheetsName: item.proposed?.name || ""
    });
  }

  return {
    ...preview,
    applied,
    appliedCount: applied.length
  };
}
