import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import { initDb } from "./db.js";
import catalogRoutes from "./routes/catalog.js";
import adminRoutes from "./routes/admin.js";
import { ensureSeedAdmin } from "./scripts/seedAdmin.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const app = express();
const port = Number(process.env.PORT || 5177);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

initDb();

if (process.env.AUTO_SEED_ADMIN === "true") {
  ensureSeedAdmin().catch((err) => {
    console.error("Admin seed failed:", err.message);
  });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", catalogRoutes);
app.use("/api/admin", adminRoutes);

app.listen(port, () => {
  console.log(`API listening on :${port}`);
});
