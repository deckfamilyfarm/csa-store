import express from "express";
import { getDb } from "../db.js";
import { and, eq, inArray } from "drizzle-orm";
import {
  categories,
  dropSites,
  packages,
  productImages,
  products,
  productSales,
  productTags,
  recipes,
  reviews,
  tags,
  vendors
} from "../schema.js";
import { requireUser } from "../middleware/auth.js";

const router = express.Router();

router.get("/catalog", async (_req, res) => {
  try {
    const db = getDb();

    const categoryRows = await db.select().from(categories).orderBy(categories.name);
    const vendorRows = await db.select().from(vendors);

    const productRows = await db
      .select()
      .from(products)
      .where(and(eq(products.isDeleted, 0), eq(products.visible, 1)));

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

    const reviewRows = productIds.length
      ? await db
          .select()
          .from(reviews)
          .where(and(inArray(reviews.productId, productIds), eq(reviews.status, "approved")))
      : [];

    const featuredTag = await db.select().from(tags).where(eq(tags.name, "featured"));
    const saleTag = await db.select().from(tags).where(eq(tags.name, "sale"));
    const featuredIds = featuredTag.length
      ? await db
          .select()
          .from(productTags)
          .where(eq(productTags.tagId, featuredTag[0].id))
      : [];
    const saleIds = saleTag.length
      ? await db
          .select()
          .from(productTags)
          .where(eq(productTags.tagId, saleTag[0].id))
      : [];

    const featuredSet = new Set(featuredIds.map((row) => row.productId));
    const saleSet = new Set(saleIds.map((row) => row.productId));

    const imagesByProduct = imageRows.reduce((acc, row) => {
      if (!acc[row.productId]) acc[row.productId] = [];
      acc[row.productId].push(row.url);
      return acc;
    }, {});

    const normalizeUrl = (url) => (url ? url.split("?")[0] : url);
    const imageScore = (url) => {
      if (!url) return 99;
      if (/thumbnail/i.test(url)) return 50;
      if (/_1\\./i.test(url)) return 0;
      if (/_2\\./i.test(url)) return 1;
      return 2;
    };

    for (const productId of Object.keys(imagesByProduct)) {
      const unique = [];
      const seen = new Set();
      for (const url of imagesByProduct[productId]) {
        const normalized = normalizeUrl(url);
        if (!normalized || /thumbnail/i.test(normalized) || seen.has(normalized)) continue;
        seen.add(normalized);
        unique.push(url);
      }
      imagesByProduct[productId] = unique.sort((a, b) => imageScore(a) - imageScore(b));
    }

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

    const reviewsByProduct = reviewRows.reduce((acc, row) => {
      if (!acc[row.productId]) acc[row.productId] = [];
      acc[row.productId].push({
        id: row.id,
        rating: row.rating,
        title: row.title,
        body: row.body,
        createdAt: row.createdAt
      });
      return acc;
    }, {});

    const vendorMap = new Map(vendorRows.map((row) => [row.id, row.name]));
    const categoryMap = new Map(categoryRows.map((row) => [row.id, row.name]));

    const productPayload = productRows.map((row) => {
      const productPackages = packagesByProduct[row.id] || [];
      const visiblePackages = productPackages.filter((pkg) => pkg.visible === 1 || pkg.visible === null);
      const priceCandidates = visiblePackages
        .map((pkg) => Number(pkg.price))
        .filter((value) => Number.isFinite(value));
      const productReviews = reviewsByProduct[row.id] || [];
      const avgRating = productReviews.length
        ? productReviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) /
          productReviews.length
        : 0;
      const saleMeta = salesByProduct[row.id];

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        categoryId: row.categoryId,
        category: categoryMap.get(row.categoryId) || null,
        vendorId: row.vendorId,
        vendor: vendorMap.get(row.vendorId) || null,
        price: priceCandidates.length ? Math.min(...priceCandidates).toFixed(2) : null,
        packages: productPackages,
        images: imagesByProduct[row.id] || [],
        imageUrl: (imagesByProduct[row.id] || [row.thumbnailUrl]).find(Boolean) || null,
        featured: featuredSet.has(row.id),
        onSale: saleMeta ? saleMeta.onSale : saleSet.has(row.id),
        saleDiscount: saleMeta ? saleMeta.saleDiscount : null,
        rating: avgRating ? Math.round(avgRating * 10) / 10 : 0,
        reviews: productReviews
      };
    });

    const recipeRows = await db.select().from(recipes).where(eq(recipes.published, 1));
    const recipePayload = recipeRows.map((row) => ({
      id: row.id,
      title: row.title,
      note: row.note,
      imageUrl: row.imageUrl,
      ingredients: row.ingredientsJson ? JSON.parse(row.ingredientsJson) : [],
      steps: row.stepsJson ? JSON.parse(row.stepsJson) : []
    }));

    const dropSiteRows = await db.select().from(dropSites).where(eq(dropSites.active, 1));

    res.json({
      categories: categoryRows,
      vendors: vendorRows,
      dropSites: dropSiteRows,
      products: productPayload,
      recipes: recipePayload
    });
  } catch (err) {
    console.error("Catalog error:", err);
    res.status(500).json({
      error: "Catalog error",
      message: process.env.NODE_ENV === "development" ? err?.message : undefined
    });
  }
});

router.post("/reviews", requireUser, async (req, res) => {
  try {
    const payload = req.body || {};
    const productId = Number(payload.productId);
    const rating = Number(payload.rating);
    const title = typeof payload.title === "string" ? payload.title.trim() : null;
    const body = typeof payload.body === "string" ? payload.body.trim() : null;

    if (!Number.isFinite(productId) || !Number.isFinite(rating)) {
      return res.status(400).json({ error: "Missing product or rating" });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating must be between 1 and 5" });
    }

    const db = getDb();
    const existing = await db.select().from(products).where(eq(products.id, productId));
    if (!existing.length) {
      return res.status(404).json({ error: "Product not found" });
    }

    const existingReview = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.productId, productId), eq(reviews.userId, req.user.userId)));

    if (existingReview.length) {
      return res.status(409).json({
        error: "Review already exists for this product",
        reviewId: existingReview[0].id
      });
    }

    await db.insert(reviews).values({
      productId,
      userId: req.user.userId,
      rating,
      title,
      body,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date()
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Review submit error:", err);
    res.status(500).json({ error: "Unable to submit review" });
  }
});

router.get("/reviews/mine", requireUser, async (req, res) => {
  try {
    const db = getDb();
    const productId = req.query.productId ? Number(req.query.productId) : null;
    const base = productId
      ? and(eq(reviews.userId, req.user.userId), eq(reviews.productId, productId))
      : eq(reviews.userId, req.user.userId);
    const rows = await db.select().from(reviews).where(base);
    res.json({ reviews: rows });
  } catch (err) {
    console.error("Review fetch error:", err);
    res.status(500).json({ error: "Unable to load reviews" });
  }
});

router.put("/reviews/:id", requireUser, async (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const payload = req.body || {};

    const existing = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.id, id), eq(reviews.userId, req.user.userId)));

    if (!existing.length) {
      return res.status(404).json({ error: "Review not found" });
    }

    await db
      .update(reviews)
      .set({
        rating: payload.rating ?? undefined,
        title: payload.title ?? undefined,
        body: payload.body ?? undefined,
        status: "pending",
        updatedAt: new Date()
      })
      .where(eq(reviews.id, id));

    res.json({ ok: true });
  } catch (err) {
    console.error("Review update error:", err);
    res.status(500).json({ error: "Unable to update review" });
  }
});

router.delete("/reviews/:id", requireUser, async (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.id, id), eq(reviews.userId, req.user.userId)));
    if (!existing.length) {
      return res.status(404).json({ error: "Review not found" });
    }
    await db.delete(reviews).where(eq(reviews.id, id));
    res.json({ ok: true });
  } catch (err) {
    console.error("Review delete error:", err);
    res.status(500).json({ error: "Unable to delete review" });
  }
});

export default router;
