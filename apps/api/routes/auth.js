import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { ensureAdminAccessSchema, getDb, getPool } from "../db.js";
import { users } from "../schema.js";
import { requireUser } from "../middleware/auth.js";
import { resetPasswordWithToken, sendPasswordResetForUser } from "../lib/passwordReset.js";

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

router.post("/login", async (req, res) => {
  const username = String(req.body?.username || req.body?.email || "").trim();
  const { password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }

  const db = getDb();
  await ensureAdminAccessSchema().catch((error) => {
    console.warn("Admin access schema bootstrap skipped for /auth/login:", error.message);
  });
  const rows = await db.select().from(users).where(eq(users.username, username));
  if (!rows.length) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  if (rows[0].active === 0) {
    return res.status(403).json({ error: "User is inactive" });
  }

  const valid = await bcrypt.compare(password, rows[0].passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const adminRoles = await loadAdminRoleKeysForUser(Number(rows[0].id)).catch(() => []);

  const token = jwt.sign({ userId: rows[0].id, role: rows[0].role, adminRoles }, process.env.JWT_SECRET || "dev-secret", {
    expiresIn: "30d"
  });

  res.json({
    token,
    user: {
      id: rows[0].id,
      username: rows[0].username,
      email: rows[0].email,
      role: rows[0].role,
      adminRoles
    }
  });
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
      role: rows[0].role,
      adminRoles
    }
  });
});

export default router;
