import jwt from "jsonwebtoken";

export function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    const isAdminRole = payload && (payload.role === "administrator" || payload.role === "admin");
    if (!payload || (!payload.adminId && !isAdminRole)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    req.admin = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
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
