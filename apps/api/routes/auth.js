import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { users } from "../schema.js";
import { requireUser } from "../middleware/auth.js";

const router = express.Router();

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }

  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.email, email));
  if (!rows.length) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const valid = await bcrypt.compare(password, rows[0].passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ userId: rows[0].id, role: rows[0].role }, process.env.JWT_SECRET || "dev-secret", {
    expiresIn: "30d"
  });

  res.json({
    token,
    user: {
      id: rows[0].id,
      email: rows[0].email,
      role: rows[0].role
    }
  });
});

router.get("/me", requireUser, async (req, res) => {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, req.user.userId));
  if (!rows.length) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json({
    user: {
      id: rows[0].id,
      email: rows[0].email,
      role: rows[0].role
    }
  });
});

export default router;
