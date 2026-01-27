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

export async function ensureSeedUser() {
  const email = process.env.USER_SEED_EMAIL || "member@example.com";
  const password = process.env.USER_SEED_PASS || "member1234";
  const role = process.env.USER_SEED_ROLE || "member";

  const db = getDb();
  const existing = await db.select().from(users).where(eq(users.email, email));
  if (existing.length > 0) {
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await db.insert(users).values({
    email,
    passwordHash: hash,
    role,
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

if (process.env.SEED_USER === "true") {
  ensureSeedUser().then(() => {
    console.log("User seeded");
    process.exit(0);
  });
}
