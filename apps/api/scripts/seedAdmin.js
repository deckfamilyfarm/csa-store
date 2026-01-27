import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import { getDb } from "../db.js";
import { users } from "../schema.js";
import { eq } from "drizzle-orm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export async function ensureSeedAdmin() {
  const username = process.env.ADMIN_USER || "admin";
  const password = process.env.ADMIN_PASS || "admin2004";

  const db = getDb();
  const existing = await db.select().from(users).where(eq(users.email, username));

  if (existing.length > 0) {
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await db.insert(users).values({
    email: username,
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
