import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import { ensureAdminAccessSchema, getDb } from "../db.js";
import { users } from "../schema.js";
import { eq } from "drizzle-orm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export async function ensureSeedUser() {
  const username = process.env.USER_SEED_USERNAME || process.env.USER_SEED_EMAIL || "member";
  const email = process.env.USER_SEED_EMAIL || "member@example.com";
  const password = process.env.USER_SEED_PASS || "member1234";
  const role = process.env.USER_SEED_ROLE || "member";

  const db = getDb();
  await ensureAdminAccessSchema();
  const existing = await db.select().from(users).where(eq(users.username, username));
  if (existing.length > 0) {
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await db.insert(users).values({
    username,
    email,
    passwordHash: hash,
    role,
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith("seedUser.js");

if (isDirectRun) {
  ensureSeedUser()
    .then(() => {
      console.log("User seeded");
      process.exit(0);
    })
    .catch((err) => {
      console.error("User seed failed:", err.message);
      process.exit(1);
    });
}
