import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getDb } from "../db.js";
import { and, eq, inArray } from "drizzle-orm";
import {
  admins,
  categories,
  dropSites,
  packages,
  productImages,
  products,
  recipes,
  reviews,
  tags,
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
  const rows = await db.select().from(admins).where(eq(admins.username, username));
  if (!rows.length) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const valid = await bcrypt.compare(password, rows[0].passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ adminId: rows[0].id }, process.env.JWT_SECRET || "dev-secret", {
    expiresIn: "30d"
  });

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

  res.json({
    products: productRows.map((row) => ({
      ...row,
      images: imagesByProduct[row.id] || [],
      packages: packagesByProduct[row.id] || []
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
  res.json({ reviews: rows });
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
      categoryId: updates.categoryId ?? undefined,
      vendorId: updates.vendorId ?? undefined,
      thumbnailUrl: updates.thumbnailUrl ?? undefined
    })
    .where(eq(products.id, id));

  res.json({ ok: true });
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
