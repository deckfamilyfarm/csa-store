import express from "express";
import crypto from "crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  ensureLocalLineSyncSchema,
  ensureSubscriberCaptureSchema,
  getDb,
  isMissingTableError
} from "../db.js";
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
  subscribeLeads,
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

function cleanString(value, maxLength = 255) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return trimmed.slice(0, maxLength);
}

function cleanOptionalString(value, maxLength = 255) {
  const trimmed = cleanString(value, maxLength);
  return trimmed || null;
}

function cleanOptionalText(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

const LIABILITY_AGREEMENT_URL =
  "https://docs.google.com/document/d/1VFMc4euofQ1S1kjtd6jZI46uxo6YKft9cufT6Q3-nrc/edit?tab=t.0";
const LIABILITY_AGREEMENT_TITLE = "Full Farm CSA LLC Product Liability Agreement";
const LIABILITY_AGREEMENT_PARAGRAPHS = [
  "Mailing address: P.O. Box 565, Junction City, OR 97128",
  "Farm Location: 25362 High Pass Rd, Junction City, OR 97448",
  "541-321-0925 • fullfarmcsa@deckfamilyfarm.com",
  "Thank you for becoming a member of the Full Farm CSA! We are excited to have you be part of our “farmily” and share in the adventure of producing wholesome, nutrient dense foods. Our commitment to you is to produce our farm products in the cleanest and safest way possible; however, it is important to acknowledge that there are inherent risks in consuming food direct from the farm, and we expect that you are educated in the decision to eat as we do. Your food options will include raw milk, farm-processed meat animals, eggs, vegetables, fruit, grains, and other incidentals. Oregon State law prohibits selling these products to consumers, so it needs to be made explicitly clear that our Full Farm CSA, herein called “FFCSA” is a membership group that shares ownership with the farm in the meat, milk and other products that the FFCSA produces.",
  "Ownership agreement:",
  "I/we agree to become full members in the FFCSA and take ownership, along with other FFCSA members, Deck Family Farm, Sweet Leaf Organics, Organic Corner Market, Little Wings Farm, Lonesome Whistle Farm, Camas Country Mill, Beetanical Apiary, and any additional member farms, in the dairy herd, any meat animals (hogs, cattle, poultry, sheep), laying hens, and produce, grains, legumes, nuts, honey and fruit crops. My membership fees listed on the financial agreement compensate the farmers for pasturing, feeding, milking, and any required health care for my animals, as well as the cost of producing the non-animal crops. Full Farm CSA LLC retains full decision-making power over animals and crops.",
  "I/we agree and understand that raw milk, farm processed meat, and the products that come to me direct from the garden are raw agricultural products and I/we accept all of the health benefits and concerns associated with it, and I/we do not hold Full Farm CSA LLC nor its members or member farms responsible for any food borne illnesses associated with raw milk, meat or raw produce, nuts, honey or fruit consumption.",
  "I/we have been informed and understand that I/we are choosing to receive as part of my farm membership raw cow milk and other raw agricultural products. I/we will not hold Full Farm CSA LLC, other FFCSA members, or member farms responsible or liable for any injury, in any way, after purchasing this membership and receiving the products including but not limited to raw milk, meat, eggs; and I/we am solely responsible for my health and safety while on the farm premises for any activity, including but not limited to: CSA pick-up, U-pick harvests, and farm events.",
  "I/we agree that I/we will not pursue any legal actions, suits, claims for relief, demands, damages, and any other obligations, known and unknown, suspected and unsuspected, in law or equity, direct or indirect, and whether now or in the future, for any injury or death arising from use of these products what-so-ever.",
  "I/we agree that my FFCSA Membership is not transferable and that I/we will not sell nor share my membership to/with anyone else. I/we agree to give written notice immediately upon decision to cancel membership. I/we agree that I am not entitled to a refund of unused membership shares, but may choose to donate unused funds to our Feed-a-Friend program.",
  "I/we understand as a FFCSA Member that it is my responsibility to ensure that any product I/we purchase is cared for properly to guarantee its freshness and quality. Therefore, I/we agree to bring clean containers and a cooler with ice to pick-up for safe transport of my goods to my home refrigerator and pantry. I/we also agree to conscientiously follow all health and safety guidelines while at pick-up and on the farm.",
  "I/we agree to pick up my share from my drop site or farm each week and if I/we intend to come to the farm for Friday pick up I/we will give 24 hours advance notice if I/we want to attend the farm dinner.",
  "I/we understand that Full Farm CSA LLC is committed to supplying a wide variety of abundant fresh farm products, however I/we understand that farming is unpredictable. In joining Full Farm CSA LLC, I/we understand that there will be variations in the quantity and the quality of food that I/we receive, including substitutions, depending on weather and other factors.",
  "By purchasing products through the Full Farm CSA, I/we have read and understand the Full Farm CSA LLC Product Liability Agreement and agree to their contents on behalf of my member household. This document supersedes any prior document on the same subject."
];

let spacesClient = null;

function getSpacesClient() {
  if (!spacesClient) {
    spacesClient = new S3Client({
      region: process.env.DO_SPACES_REGION || "sfo3",
      endpoint: process.env.DO_SPACES_ENDPOINT,
      credentials: {
        accessKeyId: process.env.DO_SPACES_KEY,
        secretAccessKey: process.env.DO_SPACES_SECRET
      }
    });
  }
  return spacesClient;
}

function hasSpacesUploadConfig() {
  return Boolean(
    process.env.DO_SPACES_BUCKET &&
      process.env.DO_SPACES_ENDPOINT &&
      process.env.DO_SPACES_KEY &&
      process.env.DO_SPACES_SECRET
  );
}

function buildPublicUrl(key) {
  const base = process.env.DO_SPACES_PUBLIC_BASE_URL;
  if (base) return `${base.replace(/\/$/, "")}/${key}`;
  return `${process.env.DO_SPACES_ENDPOINT}/${process.env.DO_SPACES_BUCKET}/${key}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseSignatureDataUrl(value) {
  const input = String(value || "").trim();
  const match = input.match(/^data:(image\/png);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (!buffer.length) return null;
    return {
      mimeType: match[1].toLowerCase(),
      buffer,
      dataUrl: input
    };
  } catch (_error) {
    return null;
  }
}

function wrapPdfText(text, maxChars = 86) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function buildSignedAgreementPdf({
  signerName,
  email,
  submittedAt,
  sourceHost,
  sourcePath,
  signatureBuffer,
  signatureMode
}) {
  const pdfDoc = await PDFDocument.create();
  let page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const signatureImage = signatureBuffer ? await pdfDoc.embedPng(signatureBuffer) : null;
  const signedLabel = submittedAt.toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short"
  });
  const pageSize = [612, 792];
  const marginX = 48;
  const bodyWidth = 516;
  const pageBottom = 56;

  function newPage() {
    page = pdfDoc.addPage(pageSize);
    return 740;
  }

  let y = 740;
  page.drawText(LIABILITY_AGREEMENT_TITLE, {
    x: marginX,
    y,
    size: 20,
    font: boldFont,
    color: rgb(0.12, 0.18, 0.23)
  });
  y -= 30;
  page.drawText(`Agreement source: ${LIABILITY_AGREEMENT_URL}`, {
    x: marginX,
    y,
    size: 10,
    font,
    color: rgb(0.35, 0.3, 0.26)
  });
  y -= 30;

  const metaLines = [
    `Signer: ${signerName}`,
    `Email: ${email}`,
    `Signed at: ${signedLabel}`,
    `Source: ${sourceHost || ""}${sourcePath || ""}`,
    "Statement: I have reviewed the Deck Family Farm product liability agreement and submit this signature as my agreement."
  ];

  for (const metaLine of metaLines) {
    for (const line of wrapPdfText(metaLine, 88)) {
      if (y <= pageBottom) y = newPage();
      page.drawText(line, {
        x: marginX,
        y,
        size: 11,
        font,
        color: rgb(0.12, 0.11, 0.09)
      });
      y -= 18;
    }
    y -= 6;
  }

  y -= 12;
  page.drawText("Agreement Text", {
    x: marginX,
    y,
    size: 14,
    font: boldFont,
    color: rgb(0.12, 0.18, 0.23)
  });
  y -= 24;

  for (const paragraph of LIABILITY_AGREEMENT_PARAGRAPHS) {
    const isHeading = paragraph.endsWith(":");
    const lines = wrapPdfText(paragraph, 92);
    for (const line of lines) {
      if (y <= pageBottom) y = newPage();
      page.drawText(line, {
        x: marginX,
        y,
        size: isHeading ? 12 : 10.5,
        font: isHeading ? boldFont : font,
        color: rgb(0.12, 0.11, 0.09),
        maxWidth: bodyWidth,
        lineHeight: 14
      });
      y -= isHeading ? 16 : 14;
    }
    y -= isHeading ? 6 : 10;
  }

  y = newPage();
  page.drawText("Signature", {
    x: marginX,
    y,
    size: 14,
    font: boldFont,
    color: rgb(0.12, 0.18, 0.23)
  });
  y -= 160;
  if (signatureImage) {
    const dims = signatureImage.scale(0.5);
    page.drawImage(signatureImage, {
      x: marginX,
      y,
      width: Math.min(dims.width, 320),
      height: Math.min(dims.height, 120)
    });
  } else {
    page.drawText(`Electronically signed by typing name: ${signerName}`, {
      x: marginX,
      y: y + 50,
      size: 16,
      font: boldFont,
      color: rgb(0.12, 0.11, 0.09)
    });
    page.drawText(`Signature mode: ${signatureMode === "typed" ? "Typed name" : "Electronic"}`, {
      x: marginX,
      y: y + 28,
      size: 10,
      font,
      color: rgb(0.35, 0.3, 0.26)
    });
  }
  page.drawLine({
    start: { x: marginX, y: y - 8 },
    end: { x: 380, y: y - 8 },
    thickness: 1,
    color: rgb(0.12, 0.11, 0.09)
  });
  page.drawText(signerName, {
    x: marginX,
    y: y - 24,
    size: 10,
    font,
    color: rgb(0.12, 0.11, 0.09)
  });

  return Buffer.from(await pdfDoc.save());
}

async function uploadSignedAgreementRecord({
  signerName,
  email,
  submittedAt,
  sourceHost,
  sourcePath,
  signatureBuffer,
  signatureMode
}) {
  if (!hasSpacesUploadConfig()) {
    throw new Error(
      "Signed agreement storage is not configured. Set DO_SPACES_BUCKET, DO_SPACES_ENDPOINT, DO_SPACES_KEY, and DO_SPACES_SECRET."
    );
  }
  const stamp = submittedAt.toISOString().replace(/[:.]/g, "-");
  const slug = crypto.randomBytes(6).toString("hex");
  const key = `subscribe-agreements/${submittedAt.getUTCFullYear()}/${String(
    submittedAt.getUTCMonth() + 1
  ).padStart(2, "0")}/${stamp}-${slug}.pdf`;
  const pdf = await buildSignedAgreementPdf({
    signerName,
    email,
    submittedAt,
    sourceHost,
    sourcePath,
    signatureBuffer,
    signatureMode
  });
  await getSpacesClient().send(
    new PutObjectCommand({
      Bucket: process.env.DO_SPACES_BUCKET,
      Key: key,
      Body: pdf,
      ContentType: "application/pdf",
      ACL: "public-read"
    })
  );
  return buildPublicUrl(key);
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

router.get("/drop-sites", async (_req, res) => {
  try {
    const db = getDb();
    try {
      await ensureLocalLineSyncSchema();
    } catch (error) {
      console.warn("Local Line schema bootstrap skipped for /drop-sites:", error.message);
    }
    const dropSiteRows = await db.select().from(dropSites).where(eq(dropSites.active, 1));
    res.json({ dropSites: dropSiteRows });
  } catch (error) {
    console.error("Drop sites error:", error);
    res.status(500).json({ error: "Failed to load drop sites" });
  }
});

router.post("/subscribe", async (req, res) => {
  try {
    const db = getDb();
    await ensureSubscriberCaptureSchema().catch((error) => {
      console.warn("Subscriber capture schema bootstrap skipped for /subscribe:", error.message);
    });

    const payload = req.body || {};
    const firstName = cleanString(payload.firstName);
    const lastName = cleanString(payload.lastName);
    const email = cleanString(payload.email);
    const signerName = cleanString(
      payload.liabilityAgreementSignerName || `${firstName} ${lastName}`.trim()
    );
    const agreementAccepted = Boolean(payload.liabilityAgreementAccepted);
    const signatureMode =
      String(payload.liabilityAgreementSignatureMode || "draw").trim().toLowerCase() === "typed"
        ? "typed"
        : "draw";
    const signature = parseSignatureDataUrl(payload.liabilityAgreementSignatureDataUrl);

    if (!firstName || !lastName || !email) {
      res.status(400).json({ error: "First name, last name, and email are required." });
      return;
    }

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: "Enter a valid email address." });
      return;
    }

    if (!agreementAccepted) {
      res.status(400).json({ error: "You must agree to the product liability agreement." });
      return;
    }

    if (!signerName) {
      res.status(400).json({ error: "Enter the signer name for the liability agreement." });
      return;
    }

    if (signatureMode === "draw" && !signature) {
      res.status(400).json({ error: "Please provide a drawn signature for the liability agreement." });
      return;
    }

    const now = new Date();
    const searchParams = new URLSearchParams(String(payload.queryString || ""));
    const sourceHostHeader = cleanOptionalString(
      req.get("x-forwarded-host") || req.get("host") || payload.sourceHost,
      255
    );
    const sourcePath = cleanOptionalString(payload.sourcePath, 255);
    const liabilityAgreementRecordUrl = await uploadSignedAgreementRecord({
      signerName,
      email,
      submittedAt: now,
      sourceHost: sourceHostHeader,
      sourcePath,
      signatureBuffer: signature?.buffer || null,
      signatureMode
    });

    await db.insert(subscribeLeads).values({
      status: "in_progress",
      firstName,
      lastName,
      email,
      phone: cleanOptionalString(payload.phone, 64),
      country: cleanOptionalString(payload.country, 128),
      addressLine1: cleanOptionalString(payload.addressLine1, 255),
      addressLine2: cleanOptionalString(payload.addressLine2, 255),
      city: cleanOptionalString(payload.city, 255),
      stateProvince: cleanOptionalString(payload.stateProvince, 255),
      postalCode: cleanOptionalString(payload.postalCode, 32),
      referralSource: cleanOptionalText(payload.referralSource),
      selectedPlan: cleanOptionalString(payload.selectedPlan, 64),
      selectedPlanLabel: cleanOptionalString(payload.selectedPlanLabel, 255),
      selectedDropSite: cleanOptionalString(payload.selectedDropSite, 255),
      notes: cleanOptionalText(payload.notes),
      liabilityAgreementAccepted: 1,
      liabilityAgreementSignerName: cleanOptionalString(signerName, 255),
      liabilityAgreementDocumentUrl: LIABILITY_AGREEMENT_URL,
      liabilityAgreementRecordUrl: liabilityAgreementRecordUrl,
      liabilityAgreementSignedAt: now,
      sourceHost: sourceHostHeader,
      sourcePath,
      utmSource: cleanOptionalString(payload.utmSource || searchParams.get("utm_source"), 255),
      utmMedium: cleanOptionalString(payload.utmMedium || searchParams.get("utm_medium"), 255),
      utmCampaign: cleanOptionalString(
        payload.utmCampaign || searchParams.get("utm_campaign"),
        255
      ),
      utmContent: cleanOptionalString(payload.utmContent || searchParams.get("utm_content"), 255),
      utmTerm: cleanOptionalString(payload.utmTerm || searchParams.get("utm_term"), 255),
      rawJson: JSON.stringify(payload),
      submittedAt: now,
      createdAt: now,
      updatedAt: now
    });

    res.json({ ok: true, liabilityAgreementRecordUrl });
  } catch (error) {
    console.error("Subscribe lead capture error:", error);
    res.status(500).json({ error: "Unable to submit subscribe request." });
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
