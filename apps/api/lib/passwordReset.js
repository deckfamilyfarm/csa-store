import crypto from "crypto";
import bcrypt from "bcryptjs";
import { ensureAdminAccessSchema, getPool } from "../db.js";
import { sendPasswordResetEmail } from "./email.js";

const RESET_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function getAppBaseUrl(req) {
  const configured =
    process.env.PUBLIC_APP_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.STORE_PUBLIC_BASE_URL ||
    process.env.APP_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");

  const forwardedProto = String(req?.get?.("x-forwarded-proto") || "").split(",")[0].trim();
  const protocol = forwardedProto || req?.protocol || "http";
  const host = req?.get?.("host") || `localhost:${process.env.PORT || 5177}`;
  return `${protocol}://${host}`;
}

function buildResetUrl(req, token) {
  return `${getAppBaseUrl(req)}/#/reset-password?token=${encodeURIComponent(token)}`;
}

export async function sendPasswordResetForUser(user, options = {}) {
  if (!user?.id || !user?.email) {
    throw new Error("A valid user is required for password reset.");
  }

  await ensureAdminAccessSchema();
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const now = new Date();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  const pool = getPool();

  await pool.query(
    `
      UPDATE password_reset_tokens
      SET used_at = ?
      WHERE user_id = ?
        AND used_at IS NULL
    `,
    [now, Number(user.id)]
  );

  await pool.query(
    `
      INSERT INTO password_reset_tokens
        (user_id, token_hash, requested_by_user_id, requested_by_admin, used_at, expires_at, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?)
    `,
    [
      Number(user.id),
      tokenHash,
      options.requestedByUserId ? Number(options.requestedByUserId) : null,
      options.requestedByAdmin ? 1 : 0,
      expiresAt,
      now
    ]
  );

  const resetUrl = buildResetUrl(options.req, token);
  let emailResult;
  try {
    emailResult = await sendPasswordResetEmail({
      to: user.email,
      name: user.name || user.username || user.email,
      username: user.username || "",
      resetUrl
    });
  } catch (error) {
    console.warn(`Password reset email failed for ${user.email}:`, error.message);
    emailResult = { sent: false, reason: error.message || "Email failed." };
  }

  return {
    emailSent: Boolean(emailResult?.sent),
    emailReason: emailResult?.reason || "",
    expiresAt
  };
}

export async function resetPasswordWithToken(token, password) {
  const plainToken = String(token || "").trim();
  const newPassword = String(password || "");
  if (!plainToken || !newPassword) {
    const error = new Error("Token and password are required.");
    error.status = 400;
    throw error;
  }
  if (newPassword.length < 8) {
    const error = new Error("Password must be at least 8 characters.");
    error.status = 400;
    throw error;
  }

  await ensureAdminAccessSchema();
  const pool = getPool();
  const [rows] = await pool.query(
    `
      SELECT id, user_id AS userId, expires_at AS expiresAt, used_at AS usedAt
      FROM password_reset_tokens
      WHERE token_hash = ?
      LIMIT 1
    `,
    [hashToken(plainToken)]
  );

  const row = rows[0];
  if (!row || row.usedAt || new Date(row.expiresAt).getTime() <= Date.now()) {
    const error = new Error("This password reset link is invalid or expired.");
    error.status = 400;
    throw error;
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const now = new Date();
  await pool.query("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [
    passwordHash,
    now,
    Number(row.userId)
  ]);
  await pool.query("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?", [
    now,
    Number(row.id)
  ]);

  return { ok: true };
}
