import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getDb } from "../db.js";
import { and, eq, inArray } from "drizzle-orm";
import {
  categories,
  dropSites,
  packages,
  productImages,
  products,
  productSales,
  recipes,
  reviews,
  tags,
  users,
  vendors
} from "../schema.js";
import { requireAdmin } from "../middleware/auth.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const spacesClient = new S3Client({
  region: process.env.DO_SPACES_REGION || "sfo3",
  endpoint: process.env.DO_SPACES_ENDPOINT,
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET
  }
});

function buildPublicUrl(key) {
  const base = process.env.DO_SPACES_PUBLIC_BASE_URL;
  if (base) return `${base.replace(/\/$/, "")}/${key}`;
  return `${process.env.DO_SPACES_ENDPOINT}/${process.env.DO_SPACES_BUCKET}/${key}`;
}

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }

  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.email, username));
  if (!rows.length) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const valid = await bcrypt.compare(password, rows[0].passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (rows[0].role !== "administrator" && rows[0].role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }

  const token = jwt.sign(
    { adminId: rows[0].id, userId: rows[0].id, role: rows[0].role },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "30d" }
  );

  res.json({ token });
});

router.get("/products", requireAdmin, async (_req, res) => {
  const db = getDb();
  const productRows = await db.select().from(products);
  const productIds = productRows.map((row) => row.id);

  const imageRows = productIds.length
    ? await db.select().from(productImages).where(inArray(productImages.productId, productIds))
    : [];

  const packageRows = productIds.length
    ? await db.select().from(packages).where(inArray(packages.productId, productIds))
    : [];

  const saleRows = productIds.length
    ? await db.select().from(productSales).where(inArray(productSales.productId, productIds))
    : [];

  const imagesByProduct = imageRows.reduce((acc, row) => {
    if (!acc[row.productId]) acc[row.productId] = [];
    acc[row.productId].push(row.url);
    return acc;
  }, {});

  const packagesByProduct = packageRows.reduce((acc, row) => {
    if (!acc[row.productId]) acc[row.productId] = [];
    acc[row.productId].push(row);
    return acc;
  }, {});

  const salesByProduct = saleRows.reduce((acc, row) => {
    acc[row.productId] = {
      onSale: Boolean(row.onSale),
      saleDiscount: row.saleDiscount !== null ? Number(row.saleDiscount) : null
    };
    return acc;
  }, {});

  res.json({
    products: productRows.map((row) => ({
      ...row,
      images: imagesByProduct[row.id] || [],
      packages: packagesByProduct[row.id] || [],
      onSale: salesByProduct[row.id]?.onSale ?? false,
      saleDiscount: salesByProduct[row.id]?.saleDiscount ?? null
    }))
  });
});

router.get("/categories", requireAdmin, async (_req, res) => {
  const db = getDb();
  const rows = await db.select().from(categories);
  res.json({ categories: rows });
});

router.get("/vendors", requireAdmin, async (_req, res) => {
  const db = getDb();
  const rows = await db.select().from(vendors);
  res.json({ vendors: rows });
});

router.get("/drop-sites", requireAdmin, async (_req, res) => {
  const db = getDb();
  const rows = await db.select().from(dropSites);
  res.json({ dropSites: rows });
});

router.get("/reviews", requireAdmin, async (_req, res) => {
  const db = getDb();
  const rows = await db.select().from(reviews);
  const userIds = [...new Set(rows.map((row) => row.userId).filter(Boolean))];
  const userRows = userIds.length
    ? await db.select().from(users).where(inArray(users.id, userIds))
    : [];
  const userMap = new Map(userRows.map((row) => [row.id, row.email]));

  res.json({
    reviews: rows.map((row) => ({
      ...row,
      userEmail: row.userId ? userMap.get(row.userId) || null : null
    }))
  });
});

router.get("/recipes", requireAdmin, async (_req, res) => {
  const db = getDb();
  const rows = await db.select().from(recipes);
  res.json({ recipes: rows });
});

router.post("/categories", requireAdmin, async (req, res) => {
  const db = getDb();
  const payload = req.body || {};
  await db.insert(categories).values({ name: payload.name });
  res.json({ ok: true });
});

router.post("/vendors", requireAdmin, async (req, res) => {
  const db = getDb();
  const payload = req.body || {};
  await db.insert(vendors).values({ name: payload.name });
  res.json({ ok: true });
});

router.post("/drop-sites", requireAdmin, async (req, res) => {
  const db = getDb();
  const payload = req.body || {};
  await db.insert(dropSites).values({
    name: payload.name,
    address: payload.address,
    dayOfWeek: payload.dayOfWeek,
    openTime: payload.openTime,
    closeTime: payload.closeTime,
    active: payload.active ?? 1,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  res.json({ ok: true });
});

router.put("/drop-sites/:id", requireAdmin, async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const payload = req.body || {};
  await db
    .update(dropSites)
    .set({
      name: payload.name ?? undefined,
      address: payload.address ?? undefined,
      dayOfWeek: payload.dayOfWeek ?? undefined,
      openTime: payload.openTime ?? undefined,
      closeTime: payload.closeTime ?? undefined,
      active: payload.active ?? undefined,
      updatedAt: new Date()
    })
    .where(eq(dropSites.id, id));
  res.json({ ok: true });
});

router.put("/reviews/:id", requireAdmin, async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const payload = req.body || {};
  await db
    .update(reviews)
    .set({
      rating: payload.rating ?? undefined,
      title: payload.title ?? undefined,
      body: payload.body ?? undefined,
      status: payload.status ?? undefined,
      updatedAt: new Date()
    })
    .where(eq(reviews.id, id));
  res.json({ ok: true });
});

router.put("/products/:id", requireAdmin, async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const updates = req.body || {};

  await db
    .update(products)
    .set({
      name: updates.name ?? undefined,
      description: updates.description ?? undefined,
      visible: updates.visible ?? undefined,
      trackInventory: updates.trackInventory ?? undefined,
      inventory: updates.inventory ?? undefined,
      categoryId: updates.categoryId ?? undefined,
      vendorId: updates.vendorId ?? undefined,
      thumbnailUrl: updates.thumbnailUrl ?? undefined
    })
    .where(eq(products.id, id));

  res.json({ ok: true });
});

router.post("/products/bulk-update", requireAdmin, async (req, res) => {
  const db = getDb();
  const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
  const results = [];

  for (const update of updates) {
    const productId = Number(update.productId);
    const changes = update.changes || {};
    if (!Number.isFinite(productId)) {
      results.push({ productId, databaseUpdate: false, localLineUpdate: null, localLinePriceUpdate: null });
      continue;
    }

    try {
      await db
        .update(products)
        .set({
          visible: changes.visible ?? undefined,
          trackInventory: changes.trackInventory ?? undefined,
          inventory: changes.inventory ?? undefined,
          updatedAt: new Date()
        })
        .where(eq(products.id, productId));

      const salePayload = {
        productId,
        onSale: changes.onSale ?? 0,
        saleDiscount: typeof changes.saleDiscount === "number" ? changes.saleDiscount : null,
        updatedAt: new Date()
      };

      const existingSale = await db
        .select()
        .from(productSales)
        .where(eq(productSales.productId, productId));

      if (existingSale.length) {
        await db
          .update(productSales)
          .set(salePayload)
          .where(eq(productSales.productId, productId));
      } else {
        await db.insert(productSales).values(salePayload);
      }

      results.push({
        productId,
        databaseUpdate: true,
        localLineUpdate: null,
        localLinePriceUpdate: null
      });
    } catch (err) {
      console.error("Bulk update error:", err);
      results.push({
        productId,
        databaseUpdate: false,
        localLineUpdate: null,
        localLinePriceUpdate: null
      });
    }
  }

  res.json({ results });
});

router.put("/packages/:id", requireAdmin, async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const updates = req.body || {};

  await db
    .update(packages)
    .set({
      price: updates.price ?? undefined,
      inventory: updates.inventory ?? undefined,
      visible: updates.visible ?? undefined,
      trackInventory: updates.trackInventory ?? undefined
    })
    .where(eq(packages.id, id));

  res.json({ ok: true });
});

router.post("/products/:id/images", requireAdmin, upload.single("image"), async (req, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  if (!req.file) {
    return res.status(400).json({ error: "Missing image file" });
  }

  if (!process.env.DO_SPACES_BUCKET || !process.env.DO_SPACES_ENDPOINT) {
    return res.status(500).json({ error: "Spaces not configured" });
  }

  const ext = req.file.originalname.split(".").pop() || "jpg";
  const key = `products/${productId}/${Date.now()}.${ext}`;

  await spacesClient.send(
    new PutObjectCommand({
      Bucket: process.env.DO_SPACES_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ACL: "public-read",
      ContentType: req.file.mimetype,
      CacheControl: "public, max-age=31536000, immutable"
    })
  );

  const url = buildPublicUrl(key);
  const urlHash = url.length ? String(url).slice(-64) : String(Date.now());

  await db.insert(productImages).values({
    productId,
    url,
    urlHash
  });

  res.json({ ok: true, url });
});

router.post("/recipes", requireAdmin, async (req, res) => {
  const db = getDb();
  const payload = req.body || {};
  await db.insert(recipes).values({
    title: payload.title,
    note: payload.note,
    imageUrl: payload.imageUrl,
    ingredientsJson: JSON.stringify(payload.ingredients || []),
    stepsJson: JSON.stringify(payload.steps || []),
    published: payload.published ?? 1,
    createdAt: new Date(),
    updatedAt: new Date()
  });

  res.json({ ok: true });
});

router.put("/recipes/:id", requireAdmin, async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const payload = req.body || {};
  await db
    .update(recipes)
    .set({
      title: payload.title ?? undefined,
      note: payload.note ?? undefined,
      imageUrl: payload.imageUrl ?? undefined,
      ingredientsJson: payload.ingredients ? JSON.stringify(payload.ingredients) : undefined,
      stepsJson: payload.steps ? JSON.stringify(payload.steps) : undefined,
      published: payload.published ?? undefined,
      updatedAt: new Date()
    })
    .where(eq(recipes.id, id));

  res.json({ ok: true });
});

export default router;
