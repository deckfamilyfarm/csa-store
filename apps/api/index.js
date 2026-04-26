import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import { ensureLocalLineSyncSchema, initDb } from "./db.js";
import catalogRoutes from "./routes/catalog.js";
import adminRoutes from "./routes/admin.js";
import { ensureSeedAdmin } from "./scripts/seedAdmin.js";
import { ensureSeedUser } from "./scripts/seedUser.js";
import authRoutes from "./routes/auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const app = express();
const serveFrontend = process.env.STORE_SERVE_FRONTEND === "true";
const port = Number(process.env.PORT || (serveFrontend ? 5176 : 5177));

app.set("etag", false);
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

initDb();
ensureLocalLineSyncSchema().catch((err) => {
  console.error("Local Line schema bootstrap failed:", err.message);
});

if (process.env.AUTO_SEED_ADMIN === "true") {
  ensureSeedAdmin().catch((err) => {
    console.error("Admin seed failed:", err.message);
  });
}

if (process.env.AUTO_SEED_USER === "true") {
  ensureSeedUser().catch((err) => {
    console.error("User seed failed:", err.message);
  });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", catalogRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);

if (serveFrontend) {
  const distDir = path.resolve(__dirname, "../../design/template/vite-app/dist");

  app.use(express.static(distDir, { index: "index.html" }));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api") || (req.method !== "GET" && req.method !== "HEAD")) {
      next();
      return;
    }

    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(port, () => {
  console.log(`API listening on :${port}`);
  if (serveFrontend) {
    console.log("Serving built frontend from design/template/vite-app/dist");
  }
});
