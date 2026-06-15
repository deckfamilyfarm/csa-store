import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { ensureAdminAccessSchema, getDb, getPool } from "../db.js";
import { users } from "../schema.js";
import { requireUser } from "../middleware/auth.js";
import { resetPasswordWithToken, sendPasswordResetForUser } from "../lib/passwordReset.js";
import {
  authenticateLocalAdminWithTimesheets,
  authenticateLocalAdminWithTimesheetsAccessToken,
  issueAdminToken,
  shouldUseTimesheetsAdminAuth
} from "../lib/timesheetsAuth.js";

const router = express.Router();

async function loadAdminRoleKeysForUser(userId) {
  if (!Number.isFinite(Number(userId))) return [];
  await ensureAdminAccessSchema();
  const [rows] = await getPool().query(
    `
      SELECT r.role_key AS roleKey
      FROM admin_user_roles ur
      JOIN admin_roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.role_key
    `,
    [Number(userId)]
  );
  return rows.map((row) => row.roleKey).filter(Boolean);
}

function launchOriginAllowed(req) {
  const allowedOrigins = String(process.env.TIMESHEETS_LAUNCH_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowedOrigins.length) return true;
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

function sanitizeAdminReturnTo(value) {
  const raw = String(value || "").trim();
  if (raw === "#/admin") return "/#/admin";
  if (raw.startsWith("#/admin?")) return `/${raw}`;
  if (raw === "/#/admin" || raw.startsWith("/#/admin?")) return raw;
  return "/#/admin";
}

function buildAdminLaunchRedirect(returnTo, token) {
  const safeReturnTo = sanitizeAdminReturnTo(returnTo);
  const [path, query = ""] = safeReturnTo.split("?");
  const params = new URLSearchParams(query);
  params.set("adminToken", token);
  return `${path}?${params.toString()}`;
}

function issueUserLoginToken(user, adminRoles = []) {
  return jwt.sign(
    { userId: user.id, role: user.role, adminRoles },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "30d" }
  );
}

function buildLoginResponse(user, adminRoles = []) {
  return {
    token: issueUserLoginToken(user, adminRoles),
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role,
      adminRoles
    }
  };
}

async function authenticateLocalUserWithPassword(username, password) {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.username, username));
  if (!rows.length) {
    const error = new Error("Invalid credentials");
    error.status = 401;
    throw error;
  }
  if (rows[0].active === 0) {
    const error = new Error("User is inactive");
    error.status = 403;
    throw error;
  }

  const valid = await bcrypt.compare(password, rows[0].passwordHash);
  if (!valid) {
    const error = new Error("Invalid credentials");
    error.status = 401;
    throw error;
  }

  return rows[0];
}

router.post("/login", async (req, res) => {
  try {
    const username = String(req.body?.username || req.body?.email || "").trim();
    const { password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "Missing credentials" });
    }

    await ensureAdminAccessSchema().catch((error) => {
      console.warn("Admin access schema bootstrap skipped for /auth/login:", error.message);
    });

    let user;
    try {
      user = await authenticateLocalUserWithPassword(username, password);
    } catch (localError) {
      if (localError.status !== 401 || !shouldUseTimesheetsAdminAuth()) {
        throw localError;
      }
      user = (await authenticateLocalAdminWithTimesheets(username, password)).user;
    }

    const adminRoles = await loadAdminRoleKeysForUser(Number(user.id)).catch(() => []);
    return res.json(buildLoginResponse(user, adminRoles));
  } catch (error) {
    if (error.status && error.status < 500) {
      return res.status(error.status).json({ error: error.message || "Invalid credentials" });
    }
    console.error("Auth login failed:", error.message);
    return res.status(500).json({ error: "Server login error" });
  }
});

router.post("/timesheets-launch", async (req, res) => {
  if (!launchOriginAllowed(req)) {
    return res.status(403).json({ error: "Timesheets launch origin is not allowed." });
  }

  const accessToken = String(req.body?.access_token || req.body?.accessToken || "").trim();
  if (!accessToken) {
    return res.redirect(303, "/#/admin");
  }

  try {
    await ensureAdminAccessSchema();
    const { user } = await authenticateLocalAdminWithTimesheetsAccessToken(accessToken);
    const adminRoles = await loadAdminRoleKeysForUser(Number(user.id));
    const hasLegacyAdminRole = user.role === "administrator" || user.role === "admin";
    if (!hasLegacyAdminRole && !adminRoles.length) {
      return res.redirect(303, "/#/admin");
    }

    const token = issueAdminToken(user, adminRoles);
    return res.redirect(303, buildAdminLaunchRedirect(req.body?.return_to, token));
  } catch (error) {
    console.warn("Timesheets launch failed:", error.message);
    return res.redirect(303, "/#/admin");
  }
});

router.post("/forgot-password", async (req, res) => {
  const username = String(req.body?.username || req.body?.email || "").trim();
  if (!username) {
    return res.status(400).json({ error: "Username is required." });
  }

  try {
    await ensureAdminAccessSchema();
    const [rows] = await getPool().query(
      `
        SELECT id, username, email, name, COALESCE(active, 1) AS active
        FROM users
        WHERE username = ?
        LIMIT 1
      `,
      [username]
    );
    const user = rows[0];
    if (user && Number(user.active) !== 0) {
      await sendPasswordResetForUser(user, { req, requestedByAdmin: false });
    }
  } catch (error) {
    console.warn("Password reset request failed:", error.message);
  }

  res.json({
    ok: true,
    message: "If that username matches an active user with a reset email, a password reset email has been sent."
  });
});

router.post("/reset-password", async (req, res) => {
  const token = req.body?.token;
  const password = req.body?.password || req.body?.newPassword;
  try {
    await resetPasswordWithToken(token, password);
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "Unable to reset password." });
  }
});

router.post("/change-password", requireUser, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.password || req.body?.newPassword || "");

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current password and new password are required." });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const db = getDb();
  await ensureAdminAccessSchema().catch((error) => {
    console.warn("Admin access schema bootstrap skipped for /auth/change-password:", error.message);
  });
  const rows = await db.select().from(users).where(eq(users.id, req.user.userId));
  if (!rows.length) {
    return res.status(404).json({ error: "User not found." });
  }
  if (rows[0].active === 0) {
    return res.status(403).json({ error: "User is inactive." });
  }

  const valid = await bcrypt.compare(currentPassword, rows[0].passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, req.user.userId));

  res.json({ ok: true });
});

router.get("/me", requireUser, async (req, res) => {
  const db = getDb();
  await ensureAdminAccessSchema().catch((error) => {
    console.warn("Admin access schema bootstrap skipped for /auth/me:", error.message);
  });
  const rows = await db.select().from(users).where(eq(users.id, req.user.userId));
  if (!rows.length) {
    return res.status(404).json({ error: "User not found" });
  }

  const adminRoles = await loadAdminRoleKeysForUser(Number(rows[0].id)).catch(() => []);

  res.json({
    user: {
      id: rows[0].id,
      username: rows[0].username,
      email: rows[0].email,
      name: rows[0].name,
      role: rows[0].role,
      adminRoles
    }
  });
});

export default router;
