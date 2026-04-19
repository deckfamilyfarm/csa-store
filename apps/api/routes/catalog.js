import express from "express";
import { ensureLocalLineSyncSchema, getDb, isMissingTableError } from "../db.js";
import { and, eq, inArray } from "drizzle-orm";
import {
  categories,
  localLinePriceListEntries,
  localLinePackageMeta,
  dropSites,
  packages,
  productMedia,
  productImages,
  productPricingProfiles,
  products,
  productSales,
  productTags,
  recipes,
  reviews,
  tags,
  vendors
} from "../schema.js";
import { requireUser } from "../middleware/auth.js";
import { computeProductPricingSnapshot } from "../lib/productPricing.js";

const router = express.Router();

function parsePriceListId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getStorefrontLocalLinePriceListIds() {
  return [
    parsePriceListId(process.env.LL_PRICE_LIST_GUEST_ID),
    parsePriceListId(process.env.LL_PRICE_LIST_CSA_MEMBERS_ID),
    parsePriceListId(process.env.LL_PRICE_LIST_HERDSHARE_ID),
    parsePriceListId(process.env.LL_PRICE_LIST_SNAP_ID)
  ].filter((value, index, values) => Number.isFinite(value) && values.indexOf(value) === index);
}

function getExcludedStoreCategoryNames() {
  const configured = String(process.env.STORE_CATALOG_EXCLUDED_CATEGORY_NAMES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!configured.length) {
    configured.push("Membership");
  }
  return new Set(configured.map((value) => value.toLowerCase()));
}

function isVisiblePriceListEntry(row) {
  return row.visible === null || typeof row.visible === "undefined" ? true : Boolean(row.visible);
}

function chooseLowerPrice(current, candidate) {
  if (!Number.isFinite(candidate)) return current;
  if (!Number.isFinite(current)) return candidate;
  return candidate < current ? candidate : current;
}

function toTimestamp(value) {
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function computeDerivedSaleDiscount(finalPrice, strikethroughDisplayValue) {
  const finalValue = Number(finalPrice);
  const strikeValue = Number(strikethroughDisplayValue);
  if (!Number.isFinite(finalValue) || !Number.isFinite(strikeValue) || strikeValue <= finalValue || strikeValue <= 0) {
    return null;
  }
  return Number(((strikeValue - finalValue) / strikeValue).toFixed(4));
}

function isRealLocalLineSale(row) {
  const derivedDiscount = computeDerivedSaleDiscount(
    row.finalPriceCache,
    row.strikethroughDisplayValue
  );
  return Boolean(row.onSaleToggle) || (Number.isFinite(derivedDiscount) && derivedDiscount > 0);
}

router.get("/catalog", async (_req, res) => {
  try {
    const db = getDb();
    await ensureLocalLineSyncSchema().catch((error) => {
      console.warn("Local Line schema bootstrap skipped for /catalog:", error.message);
    });

    const rawCategoryRows = await db.select().from(categories).orderBy(categories.name);
    const vendorRows = await db.select().from(vendors);
    const excludedCategoryNames = getExcludedStoreCategoryNames();
    const excludedCategoryIds = new Set(
      rawCategoryRows
        .filter((row) => excludedCategoryNames.has(String(row.name || "").trim().toLowerCase()))
        .map((row) => row.id)
    );
    const categoryRows = rawCategoryRows.filter((row) => !excludedCategoryIds.has(row.id));

    const rawProductRows = await db
      .select()
      .from(products)
      .where(and(eq(products.isDeleted, 0), eq(products.visible, 1)));
    const productRows = rawProductRows.filter((row) => !excludedCategoryIds.has(row.categoryId));

    const productIds = productRows.map((row) => row.id);

    const imageRows = productIds.length
      ? await db.select().from(productImages).where(inArray(productImages.productId, productIds))
      : [];
    let mediaRows = [];
    if (productIds.length) {
      try {
        mediaRows = await db.select().from(productMedia).where(inArray(productMedia.productId, productIds));
      } catch (error) {
        if (!isMissingTableError(error, "product_media")) throw error;
      }
    }

    const packageRows = productIds.length
      ? await db.select().from(packages).where(inArray(packages.productId, productIds))
      : [];
    const pricingProfileRows = productIds.length
      ? await db
          .select()
          .from(productPricingProfiles)
          .where(inArray(productPricingProfiles.productId, productIds))
      : [];
    let packageMetaRows = [];
    if (productIds.length) {
      try {
        packageMetaRows = await db
          .select()
          .from(localLinePackageMeta)
          .where(inArray(localLinePackageMeta.productId, productIds));
      } catch (error) {
        if (!isMissingTableError(error, "local_line_package_meta")) throw error;
      }
    }

    const storefrontLocalLinePriceListIds = getStorefrontLocalLinePriceListIds();
    let localLinePriceListEntryRows = [];
    if (productIds.length && storefrontLocalLinePriceListIds.length) {
      try {
        localLinePriceListEntryRows = await db
          .select()
          .from(localLinePriceListEntries)
          .where(
            and(
              inArray(localLinePriceListEntries.productId, productIds),
              inArray(
                localLinePriceListEntries.localLinePriceListId,
                storefrontLocalLinePriceListIds
              )
            )
          );
      } catch (error) {
        if (!isMissingTableError(error, "local_line_price_list_entries")) throw error;
      }
    }

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
    const isThumbnailUrl = (url) => /(?:^|\/)[^/]+\.thumbnail\.(jpg|jpeg|png|webp)$/i.test(url || "");
    const baseKeyForUrl = (url) => {
      try {
        const normalized = normalizeUrl(url);
        if (!normalized) return url;
        const parsed = new URL(normalized);
        const file = parsed.pathname.split("/").pop() || normalized;
        return file
          .replace(/\.thumbnail\.(jpg|jpeg|png|webp)$/i, "")
          .replace(/\.(jpg|jpeg|png|webp)$/i, "");
      } catch (err) {
        const file = (normalizeUrl(url) || "").split("/").pop() || url;
        return file
          .replace(/\.thumbnail\.(jpg|jpeg|png|webp)$/i, "")
          .replace(/\.(jpg|jpeg|png|webp)$/i, "");
      }
    };

    const imageObjectsByProduct = {};
    for (const productId of Object.keys(imagesByProduct)) {
      const groups = new Map();
      const urls = imagesByProduct[productId];
      urls.forEach((url) => {
        const key = baseKeyForUrl(url);
        if (!groups.has(key)) {
          groups.set(key, { url: null, thumbnailUrl: null });
        }
        const entry = groups.get(key);
        if (isThumbnailUrl(url)) {
          entry.thumbnailUrl = entry.thumbnailUrl || url;
        } else {
          entry.url = entry.url || url;
        }
      });

      imageObjectsByProduct[productId] = [...groups.values()]
        .map((entry) => ({
          url: entry.url || entry.thumbnailUrl,
          thumbnailUrl: entry.thumbnailUrl || entry.url
        }))
        .filter((entry) => entry.url);
    }

    const mediaObjectsByProduct = mediaRows
      .slice()
      .sort((left, right) => {
        const primaryDelta = Number(right.isPrimary || 0) - Number(left.isPrimary || 0);
        if (primaryDelta !== 0) return primaryDelta;
        return Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
      })
      .reduce((acc, row) => {
        if (!acc[row.productId]) acc[row.productId] = [];
        const url = row.publicUrl || row.remoteUrl || row.sourceUrl;
        if (!url) return acc;
        acc[row.productId].push({
          url,
          thumbnailUrl: row.thumbnailUrl || url
        });
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
        saleDiscount: row.saleDiscount !== null ? Number(row.saleDiscount) : null,
        updatedAt: row.updatedAt || null
      };
      return acc;
    }, {});

    const guestPriceListId = parsePriceListId(process.env.LL_PRICE_LIST_GUEST_ID);
    const memberPriceListIds = [
      parsePriceListId(process.env.LL_PRICE_LIST_CSA_MEMBERS_ID),
      parsePriceListId(process.env.LL_PRICE_LIST_HERDSHARE_ID),
      parsePriceListId(process.env.LL_PRICE_LIST_SNAP_ID)
    ].filter((value, index, values) => Number.isFinite(value) && values.indexOf(value) === index);

    const localLineSalesByProduct = localLinePriceListEntryRows.reduce((acc, row) => {
      if (
        Number.isFinite(guestPriceListId) &&
        Number(row.localLinePriceListId) !== Number(guestPriceListId)
      ) {
        return acc;
      }

      const productId = row.productId;
      if (!acc[productId]) {
        acc[productId] = {
          hasEntries: false,
          onSale: false,
          saleDiscount: null,
          lastSyncedAt: null
        };
      }

      const visible =
        row.visible === null || typeof row.visible === "undefined" ? true : Boolean(row.visible);
      if (!visible) {
        return acc;
      }

      const entry = acc[productId];
      entry.hasEntries = true;
      if (
        !entry.lastSyncedAt ||
        toTimestamp(row.lastSyncedAt || row.updatedAt) > toTimestamp(entry.lastSyncedAt)
      ) {
        entry.lastSyncedAt = row.lastSyncedAt || row.updatedAt || null;
      }

      const derivedDiscount = computeDerivedSaleDiscount(
        row.finalPriceCache,
        row.strikethroughDisplayValue
      );
      const isOnSale = isRealLocalLineSale(row);

      if (isOnSale) {
        entry.onSale = true;
      }
      if (
        Number.isFinite(derivedDiscount) &&
        (entry.saleDiscount === null || derivedDiscount > entry.saleDiscount)
      ) {
        entry.saleDiscount = derivedDiscount;
      }

      return acc;
    }, {});

    const localLinePriceCacheByProduct = localLinePriceListEntryRows.reduce((acc, row) => {
      if (!isVisiblePriceListEntry(row)) {
        return acc;
      }
      const finalPrice =
        row.finalPriceCache !== null && typeof row.finalPriceCache !== "undefined"
          ? Number(row.finalPriceCache)
          : null;
      if (!Number.isFinite(finalPrice)) {
        return acc;
      }

      if (!acc[row.productId]) {
        acc[row.productId] = {
          byPriceListId: {}
        };
      }
      const current = acc[row.productId].byPriceListId[row.localLinePriceListId];
      acc[row.productId].byPriceListId[row.localLinePriceListId] = chooseLowerPrice(current, finalPrice);
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
    const vendorRowMap = new Map(vendorRows.map((row) => [row.id, row]));
    const vendorMarkupMap = new Map(
      vendorRows.map((row) => [
        row.id,
        {
          guestMarkup: row.guestMarkup !== null && row.guestMarkup !== undefined ? Number(row.guestMarkup) : 0.55,
          memberMarkup: row.memberMarkup !== null && row.memberMarkup !== undefined ? Number(row.memberMarkup) : 0.4
        }
      ])
    );
    const categoryMap = new Map(categoryRows.map((row) => [row.id, row.name]));
    const pricingProfileByProductId = new Map(
      pricingProfileRows.map((row) => [Number(row.productId), row])
    );
    const packageMetaByPackageId = new Map(
      packageMetaRows.map((row) => [Number(row.packageId), row])
    );

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
      const localLineSaleMeta = localLineSalesByProduct[row.id];
      const localSaleMeta = salesByProduct[row.id];
      const shouldUseLocalSaleOverride =
        Boolean(localSaleMeta) &&
        (!localLineSaleMeta?.hasEntries ||
          toTimestamp(localSaleMeta.updatedAt) > toTimestamp(localLineSaleMeta.lastSyncedAt));
      const saleMeta = shouldUseLocalSaleOverride
        ? localSaleMeta
        : (localLineSaleMeta?.hasEntries ? localLineSaleMeta : localSaleMeta);
      const pricingSnapshot = computeProductPricingSnapshot({
        product: row,
        packages: productPackages,
        packageMetaByPackageId,
        vendor: vendorRowMap.get(row.vendorId) || null,
        profile: pricingProfileByProductId.get(row.id) || null
      });
      const hasResolvedPricingProfile =
        (Boolean(pricingProfileByProductId.get(row.id)) ||
          Boolean(pricingSnapshot.profile.usesNoMarkupPricing)) &&
        Number.isFinite(Number(pricingSnapshot.profile.sourceUnitPrice));
      const basePrice = hasResolvedPricingProfile
        ? pricingSnapshot.basePrice
        : (priceCandidates.length ? Math.min(...priceCandidates) : null);
      const markups = vendorMarkupMap.get(row.vendorId) || { guestMarkup: 0.55, memberMarkup: 0.4 };
      const localLinePricing = localLinePriceCacheByProduct[row.id]?.byPriceListId || {};
      const guestPriceFromLocalLine =
        Number.isFinite(guestPriceListId) && Number.isFinite(localLinePricing[guestPriceListId])
          ? Number(localLinePricing[guestPriceListId].toFixed(2))
          : null;
      const memberPriceFromLocalLine = memberPriceListIds
        .map((id) => localLinePricing[id])
        .find((value) => Number.isFinite(value));
      const guestPrice = hasResolvedPricingProfile
        ? pricingSnapshot.guestPrice
        : (
            guestPriceFromLocalLine ??
            (basePrice !== null ? Number((basePrice * (1 + markups.guestMarkup)).toFixed(2)) : null)
          );
      const memberPrice = hasResolvedPricingProfile
        ? pricingSnapshot.memberPrice
        : (
            (Number.isFinite(memberPriceFromLocalLine)
              ? Number(memberPriceFromLocalLine.toFixed(2))
              : null) ??
            (basePrice !== null ? Number((basePrice * (1 + markups.memberMarkup)).toFixed(2)) : null)
          );
      const effectiveSaleMeta = hasResolvedPricingProfile
        ? {
            onSale: Boolean(pricingSnapshot.profile.onSale),
            saleDiscount: pricingSnapshot.profile.saleDiscount
          }
        : saleMeta;

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        categoryId: row.categoryId,
        category: categoryMap.get(row.categoryId) || null,
        vendorId: row.vendorId,
        vendor: vendorMap.get(row.vendorId) || null,
        basePrice: basePrice !== null ? Number(basePrice.toFixed(2)) : null,
        guestPrice,
        memberPrice,
        vendorGuestMarkup: markups.guestMarkup,
        vendorMemberMarkup: markups.memberMarkup,
        packages: productPackages,
        images:
          imageObjectsByProduct[row.id] ||
          mediaObjectsByProduct[row.id] ||
          (imagesByProduct[row.id] || []).map((url) => ({ url, thumbnailUrl: url })),
        imageUrl:
          (imageObjectsByProduct[row.id] || [])
            .map((item) => item.url)
            .find(Boolean) ||
          (mediaObjectsByProduct[row.id] || [])
            .map((item) => item.url)
            .find(Boolean) ||
          row.thumbnailUrl ||
          null,
        thumbnailUrl:
          (imageObjectsByProduct[row.id] || [])
            .map((item) => item.thumbnailUrl)
            .find(Boolean) ||
          (mediaObjectsByProduct[row.id] || [])
            .map((item) => item.thumbnailUrl)
            .find(Boolean) ||
          row.thumbnailUrl ||
          null,
        featured: featuredSet.has(row.id),
        onSale: effectiveSaleMeta ? Boolean(effectiveSaleMeta.onSale) : saleSet.has(row.id),
        saleDiscount: effectiveSaleMeta ? effectiveSaleMeta.saleDiscount : null,
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
