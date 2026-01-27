import express from "express";
import { getDb } from "../db.js";
import { and, eq, inArray } from "drizzle-orm";
import { categories, packages, productImages, products, productTags, recipes, tags, vendors } from "../schema.js";

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

    const vendorMap = new Map(vendorRows.map((row) => [row.id, row.name]));
    const categoryMap = new Map(categoryRows.map((row) => [row.id, row.name]));

    const productPayload = productRows.map((row) => {
      const productPackages = packagesByProduct[row.id] || [];
      const visiblePackages = productPackages.filter((pkg) => pkg.visible === 1 || pkg.visible === null);
      const priceCandidates = visiblePackages
        .map((pkg) => Number(pkg.price))
        .filter((value) => Number.isFinite(value));

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
        onSale: saleSet.has(row.id),
        rating: 0,
        reviews: []
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

    res.json({
      categories: categoryRows,
      vendors: vendorRows,
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

export default router;
