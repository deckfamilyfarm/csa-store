import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import { ensureAdminAccessSchema, getDb, getPool } from "../db.js";
import { users } from "../schema.js";
import { eq } from "drizzle-orm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export async function ensureSeedAdmin() {
  const username = process.env.ADMIN_USER || "admin";
  const email = process.env.ADMIN_EMAIL || (username.includes("@") ? username : null);
  const password = process.env.ADMIN_PASS || "admin2004";

  const db = getDb();
  await ensureAdminAccessSchema();
  const existing = await db.select().from(users).where(eq(users.username, username));

  if (existing.length > 0) {
    return;
  }

  const [adminRows] = await getPool().query(
    `
      SELECT u.id
      FROM users u
      LEFT JOIN admin_user_roles ur ON ur.user_id = u.id
      LEFT JOIN admin_roles r ON r.id = ur.role_id
      WHERE COALESCE(u.active, 1) = 1
        AND (u.role IN ('admin', 'administrator') OR r.role_key = 'admin')
      LIMIT 1
    `
  );
  if (adminRows.length > 0) {
    console.log(`Admin seed skipped: an active admin already exists. Manage ADMIN_USER=${username} in the Users screen.`);
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await db.insert(users).values({
    username,
    email,
    passwordHash: hash,
    role: "administrator",
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith("seedAdmin.js");

if (isDirectRun) {
  ensureSeedAdmin()
    .then(() => {
      console.log("Admin seeded");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Admin seed failed:", err.message);
      process.exit(1);
    });
}
