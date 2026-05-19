import jwt from "jsonwebtoken";

export function issueUserToken({ userId, role = "member", adminRoles = [] }) {
  return jwt.sign(
    { userId, role, adminRoles },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "30d" }
  );
}
