import jwt from "jsonwebtoken";
import { ensureAdminAccessSchema, getPool } from "../db.js";
import { hasAdminPermission } from "../lib/adminRoles.js";

async function loadAdminRoleKeys(userId) {
  if (!userId) return [];
  await ensureAdminAccessSchema().catch(() => {});
  const [rows] = await getPool().query(
    `
      SELECT r.role_key AS roleKey
      FROM admin_user_roles ur
      JOIN admin_roles r ON r.id = ur.role_id
      JOIN users u ON u.id = ur.user_id
      WHERE ur.user_id = ?
        AND COALESCE(u.active, 1) = 1
    `,
    [userId]
  );
  return rows.map((row) => row.roleKey).filter(Boolean);
}

async function isActiveUser(userId) {
  if (!userId) return false;
  await ensureAdminAccessSchema().catch(() => {});
  const [rows] = await getPool().query(
    "SELECT COALESCE(active, 1) AS active FROM users WHERE id = ? LIMIT 1",
    [userId]
  );
  return rows.length > 0 && Number(rows[0].active) !== 0;
}

export async function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    const userId = payload?.userId || payload?.adminId;
    if (!(await isActiveUser(userId))) {
      return res.status(403).json({ error: "User is inactive" });
    }
    const legacyAdminRole = payload && (payload.role === "administrator" || payload.role === "admin");
    const roleKeys = await loadAdminRoleKeys(userId);
    const isAdminRole = legacyAdminRole || roleKeys.length > 0;
    if (!payload || !isAdminRole) {
      return res.status(403).json({ error: "Admin access required" });
    }
    req.admin = { ...payload, adminRoles: roleKeys };
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function requireAdminPermission(requiredRoles) {
  return async (req, res, next) => {
    const runAfterAdmin = () => {
      if (!hasAdminPermission(req.admin?.adminRoles || [], requiredRoles)) {
        return res.status(403).json({ error: "Insufficient admin permissions" });
      }
      return next();
    };

    if (req.admin) return runAfterAdmin();
    return requireAdmin(req, res, (error) => {
      if (error) return next(error);
      return runAfterAdmin();
    });
  };
}

export function requireUser(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    if (!payload || !payload.userId) {
      return res.status(403).json({ error: "User access required" });
    }
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}
