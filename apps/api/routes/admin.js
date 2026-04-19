import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import multer from "multer";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  ensureAdminAccessSchema,
  ensureLocalLineSyncSchema,
  getDb,
  getPool,
  isMissingTableError
} from "../db.js";
import { and, eq, inArray } from "drizzle-orm";
import {
  categories,
  dropSites,
  localLinePackageMeta,
  localLinePriceListEntries,
  localLineProductMeta,
  localLineSyncIssues,
  packagePriceListMemberships,
  packages,
  productMedia,
  productImages,
  productPricingProfiles,
  products,
  productSales,
  recipes,
  reviews,
  tags,
  users,
  vendors
} from "../schema.js";
import { requireAdmin, requireAdminPermission } from "../middleware/auth.js";
import { isLocalLineEnabled, updateLocalLineForProduct } from "../localLine.js";
import {
  getLatestLocalLineFullSyncJob,
  getLocalLineFullSyncJob,
  startLocalLineFullSyncJob
} from "../lib/localLineFullSyncJobs.js";
import {
  computeProductPricingSnapshot,
  isNoMarkupProduct,
  isSourcePricingVendor
} from "../lib/productPricing.js";
import { runLocalLineAudit } from "../scripts/auditLocalLineSync.js";
import {
  exportMasterPricelist,
  isGooglePricelistVendorName
} from "../scripts/exportMasterPricelist.js";
import {
  ADMIN_ROLE_DEFINITIONS,
  normalizeAdminRoleKeys
} from "../lib/adminRoles.js";
import { sendPasswordResetForUser } from "../lib/passwordReset.js";

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

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toTimestamp(value) {
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function toDbDecimal(value) {
  const numeric = toNumber(value);
  return numeric === null ? null : numeric;
}

function normalizeCategoryName(value) {
  return String(value || "").trim().toLowerCase();
}

function isMembershipCategoryName(value) {
  return normalizeCategoryName(value) === "membership";
}

function toActiveFlag(value) {
  return value === false || value === 0 || value === "0" ? 0 : 1;
}

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

async function loadAdminRoleKeysForUser(userId) {
  if (!Number.isFinite(Number(userId))) return [];
  await ensureAdminAccessSchema();
  const [rows] = await getPool().query(
    `
      SELECT r.role_key AS roleKey
      FROM admin_user_roles ur
      JOIN admin_roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.role_key
    `,
    [Number(userId)]
  );
  return rows.map((row) => row.roleKey).filter(Boolean);
}

async function replaceAdminRolesForUser(userId, roleKeys) {
  const normalized = normalizeAdminRoleKeys(roleKeys);
  const pool = getPool();
  await ensureAdminAccessSchema();
  await pool.query("DELETE FROM admin_user_roles WHERE user_id = ?", [userId]);
  if (!normalized.length) return normalized;
  await pool.query(
    `
      INSERT INTO admin_user_roles (user_id, role_id, created_at)
      SELECT ?, id, ?
      FROM admin_roles
      WHERE role_key IN (?)
    `,
    [userId, new Date(), normalized]
  );
  return normalized;
}

async function countOtherActiveFullAdmins(userId) {
  await ensureAdminAccessSchema();
  const [rows] = await getPool().query(
    `
      SELECT COUNT(*) AS count
      FROM users u
      JOIN admin_user_roles ur ON ur.user_id = u.id
      JOIN admin_roles r ON r.id = ur.role_id
      WHERE r.role_key = 'admin'
        AND COALESCE(u.active, 1) = 1
        AND u.id <> ?
    `,
    [Number(userId) || 0]
  );
  return Number(rows[0]?.count || 0);
}

async function assertAdminRoleChangeSafe(userId, active, roleKeys) {
  const normalized = normalizeAdminRoleKeys(roleKeys);
  if (active && normalized.includes("admin")) return;
  const otherAdmins = await countOtherActiveFullAdmins(userId);
  if (otherAdmins <= 0) {
    const error = new Error("At least one active full admin user is required.");
    error.status = 400;
    throw error;
  }
}

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }

  const db = getDb();
  await ensureAdminAccessSchema().catch((error) => {
    console.warn("Admin access schema bootstrap skipped for /admin/login:", error.message);
  });
  const rows = await db.select().from(users).where(eq(users.username, username));
  if (!rows.length) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  if (rows[0].active === 0) {
    return res.status(403).json({ error: "User is inactive" });
  }

  const valid = await bcrypt.compare(password, rows[0].passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const adminRoles = await loadAdminRoleKeysForUser(Number(rows[0].id));
  const hasLegacyAdminRole = rows[0].role === "administrator" || rows[0].role === "admin";
  if (!hasLegacyAdminRole && !adminRoles.length) {
    return res.status(403).json({ error: "Admin access required" });
  }

  const token = jwt.sign(
    { adminId: rows[0].id, userId: rows[0].id, role: rows[0].role, adminRoles },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "30d" }
  );

  res.json({
    token,
    user: {
      id: rows[0].id,
      username: rows[0].username,
      email: rows[0].email,
      name: rows[0].name || "",
      role: rows[0].role,
      adminRoles
    }
  });
});

router.get("/me", requireAdmin, async (req, res) => {
  const db = getDb();
  await ensureAdminAccessSchema();
  const userId = Number(req.admin?.userId || req.admin?.adminId);
  const rows = await db.select().from(users).where(eq(users.id, userId));
  if (!rows.length) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json({
    user: {
      id: rows[0].id,
      username: rows[0].username,
      email: rows[0].email,
      name: rows[0].name || "",
      role: rows[0].role,
      active: rows[0].active !== 0,
      adminRoles: await loadAdminRoleKeysForUser(Number(rows[0].id))
    }
  });
});

router.get("/admin-users", requireAdminPermission("user_admin"), async (_req, res) => {
  await ensureAdminAccessSchema();
  const [userRows] = await getPool().query(
    `
      SELECT
        u.id,
        u.username,
        u.email,
        u.name,
        u.role,
        COALESCE(u.active, 1) AS active,
        u.timesheets_user_id AS timesheetsUserId,
        u.timesheets_employee_id AS timesheetsEmployeeId,
        u.created_at AS createdAt,
        u.updated_at AS updatedAt,
        GROUP_CONCAT(r.role_key ORDER BY r.role_key SEPARATOR ',') AS adminRoleKeys
      FROM users u
      JOIN admin_user_roles ur ON ur.user_id = u.id
      JOIN admin_roles r ON r.id = ur.role_id
      GROUP BY u.id
      ORDER BY u.username
    `
  );

  res.json({
    roles: ADMIN_ROLE_DEFINITIONS,
    users: userRows.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      name: row.name || "",
      role: row.role,
      active: Boolean(row.active),
      timesheetsUserId: row.timesheetsUserId || "",
      timesheetsEmployeeId: row.timesheetsEmployeeId || "",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      adminRoles: String(row.adminRoleKeys || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    }))
  });
});

router.post("/admin-users", requireAdminPermission("user_admin"), async (req, res) => {
  const db = getDb();
  await ensureAdminAccessSchema();
  const payload = req.body || {};
  const username = String(payload.username || "").trim();
  const email = String(payload.email || "").trim().toLowerCase() || null;
  const adminRoles = normalizeAdminRoleKeys(payload.adminRoles);

  if (!username || !adminRoles.length) {
    return res.status(400).json({ error: "Username and at least one role are required." });
  }
  if (email && !isEmailAddress(email)) {
    return res.status(400).json({ error: "Password reset email must be a valid email address." });
  }

  const existing = await db.select().from(users).where(eq(users.username, username));
  if (existing.length) {
    return res.status(409).json({ error: "A user with this username already exists." });
  }

  const now = new Date();
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  const active = toActiveFlag(payload.active);
  const name = String(payload.name || "").trim() || null;
  const result = await db.insert(users).values({
    username,
    email,
    passwordHash,
    name,
    role: adminRoles.includes("admin") ? "admin" : "member",
    active,
    timesheetsUserId: payload.timesheetsUserId || null,
    timesheetsEmployeeId: payload.timesheetsEmployeeId || null,
    createdAt: now,
    updatedAt: now
  });

  const userId = Number(result[0]?.insertId);
  await replaceAdminRolesForUser(userId, adminRoles);

  let resetResult = { emailSent: false, emailReason: "User is inactive." };
  if (active && !isEmailAddress(email)) {
    resetResult = { emailSent: false, emailReason: "Password reset email is not set." };
  } else if (active) {
    resetResult = await sendPasswordResetForUser(
      { id: userId, username, email, name },
      {
        req,
        requestedByUserId: Number(req.admin?.userId || req.admin?.adminId) || null,
        requestedByAdmin: true
      }
    );
  }

  res.json({ ok: true, userId, ...resetResult });
});

router.post(
  "/admin-users/:id/reset-password",
  requireAdminPermission("user_admin"),
  async (req, res) => {
    await ensureAdminAccessSchema();
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: "Invalid user id." });
    }

    const [rows] = await getPool().query(
      `
        SELECT id, username, email, name, COALESCE(active, 1) AS active
        FROM users
        WHERE id = ?
        LIMIT 1
      `,
      [userId]
    );
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }
    if (!isEmailAddress(user.email)) {
      return res.status(400).json({
        error: "This user does not have a deliverable password reset email. Save a real reset email first."
      });
    }
    if (Number(user.active) === 0) {
      return res.status(400).json({ error: "Inactive users cannot receive password reset email." });
    }

    const resetResult = await sendPasswordResetForUser(user, {
      req,
      requestedByUserId: Number(req.admin?.userId || req.admin?.adminId) || null,
      requestedByAdmin: true
    });

    res.json({ ok: true, ...resetResult });
  }
);

router.put("/admin-users/:id", requireAdminPermission("user_admin"), async (req, res) => {
  const db = getDb();
  await ensureAdminAccessSchema();
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ error: "Invalid user id." });
  }

  const payload = req.body || {};
  const active = toActiveFlag(payload.active);
  const adminRoles = normalizeAdminRoleKeys(payload.adminRoles);
  if (!adminRoles.length) {
    return res.status(400).json({ error: "At least one role is required." });
  }

  try {
    await assertAdminRoleChangeSafe(userId, Boolean(active), adminRoles);
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }

  const updatePayload = {
    username: payload.username ? String(payload.username).trim() : undefined,
    email:
      payload.email === undefined
        ? undefined
        : String(payload.email || "").trim().toLowerCase() || null,
    name: payload.name === undefined ? undefined : String(payload.name || "").trim() || null,
    role: adminRoles.includes("admin") ? "admin" : "member",
    active,
    timesheetsUserId:
      payload.timesheetsUserId === undefined ? undefined : payload.timesheetsUserId || null,
    timesheetsEmployeeId:
      payload.timesheetsEmployeeId === undefined ? undefined : payload.timesheetsEmployeeId || null,
    updatedAt: new Date()
  };

  if (!updatePayload.username) {
    return res.status(400).json({ error: "Username is required." });
  }
  if (updatePayload.email && !isEmailAddress(updatePayload.email)) {
    return res.status(400).json({ error: "Password reset email must be a valid email address." });
  }

  const duplicateUsername = await db
    .select()
    .from(users)
    .where(eq(users.username, updatePayload.username));
  if (duplicateUsername.some((row) => Number(row.id) !== userId)) {
    return res.status(409).json({ error: "A user with this username already exists." });
  }

  if (payload.password) {
    updatePayload.passwordHash = await bcrypt.hash(String(payload.password), 10);
  }

  await db.update(users).set(updatePayload).where(eq(users.id, userId));
  await replaceAdminRolesForUser(userId, adminRoles);
  res.json({ ok: true });
});

router.get("/products", requireAdmin, async (_req, res) => {
  const db = getDb();
  const productRows = await db.select().from(products);
  const productIds = productRows.map((row) => row.id);

  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/products:", error.message);
  });

  const imageRows = productIds.length
    ? await db.select().from(productImages).where(inArray(productImages.productId, productIds))
    : [];
  let mediaRows = [];
  let productMetaRows = [];
  let syncIssueRows = [];
  if (productIds.length) {
    try {
      mediaRows = await db.select().from(productMedia).where(inArray(productMedia.productId, productIds));
    } catch (error) {
      if (!isMissingTableError(error, "product_media")) throw error;
    }
    try {
      productMetaRows = await db
        .select()
        .from(localLineProductMeta)
        .where(inArray(localLineProductMeta.productId, productIds));
    } catch (error) {
      if (!isMissingTableError(error, "local_line_product_meta")) throw error;
    }
    try {
      syncIssueRows = await db
        .select()
        .from(localLineSyncIssues)
        .where(inArray(localLineSyncIssues.productId, productIds));
    } catch (error) {
      if (!isMissingTableError(error, "local_line_sync_issues")) throw error;
    }
  }

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
  const productMetaByProduct = productMetaRows.reduce((acc, row) => {
    acc[row.productId] = row;
    return acc;
  }, {});
  const syncIssueCountsByProduct = syncIssueRows.reduce((acc, row) => {
    acc[row.productId] = (acc[row.productId] || 0) + 1;
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
      images:
        imageObjectsByProduct[row.id] ||
        mediaObjectsByProduct[row.id] ||
        (imagesByProduct[row.id] || []).map((url) => ({ url, thumbnailUrl: url })),
      localLineMeta: productMetaByProduct[row.id] || null,
      localLineSyncIssueCount: syncIssueCountsByProduct[row.id] || 0,
      packages: packagesByProduct[row.id] || [],
      onSale: salesByProduct[row.id]?.onSale ?? false,
      saleDiscount: salesByProduct[row.id]?.saleDiscount ?? null
    }))
  });
});

router.get("/localline/products/:id", requireAdmin, async (req, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  if (!Number.isFinite(productId)) {
    return res.status(400).json({ error: "Invalid product id" });
  }

  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/localline/products/:id:", error.message);
  });

  try {
    const [productMetaRows, packageMetaRows, priceListEntryRows, syncIssueRows, mediaRows] =
      await Promise.all([
        db.select().from(localLineProductMeta).where(eq(localLineProductMeta.productId, productId)),
        db
          .select()
          .from(localLinePackageMeta)
          .where(eq(localLinePackageMeta.productId, productId)),
        db
          .select()
          .from(localLinePriceListEntries)
          .where(eq(localLinePriceListEntries.productId, productId)),
        db
          .select()
          .from(localLineSyncIssues)
          .where(eq(localLineSyncIssues.productId, productId)),
        db.select().from(productMedia).where(eq(productMedia.productId, productId))
      ]);

    res.json({
      productId,
      productMeta: productMetaRows[0] || null,
      packageMeta: packageMetaRows,
      priceListEntries: priceListEntryRows
        .slice()
        .sort((left, right) => {
          const priceListDelta = Number(left.priceListId || 0) - Number(right.priceListId || 0);
          if (priceListDelta !== 0) return priceListDelta;
          return Number(left.packageId || 0) - Number(right.packageId || 0);
        }),
      syncIssues: syncIssueRows
        .slice()
        .sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0)),
      media: mediaRows
        .slice()
        .sort((left, right) => {
          const primaryDelta = Number(right.isPrimary || 0) - Number(left.isPrimary || 0);
          if (primaryDelta !== 0) return primaryDelta;
          return Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
        })
    });
  } catch (error) {
    if (
      isMissingTableError(error, "local_line_product_meta") ||
      isMissingTableError(error, "local_line_package_meta") ||
      isMissingTableError(error, "local_line_price_list_entries") ||
      isMissingTableError(error, "local_line_sync_issues") ||
      isMissingTableError(error, "product_media")
    ) {
      return res.json({
        productId,
        productMeta: null,
        packageMeta: [],
        priceListEntries: [],
        syncIssues: [],
        media: []
      });
    }
    throw error;
  }
});

router.put("/localline/products/:id/price-list-entries", requireAdminPermission("pricing_admin"), async (req, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];

  if (!Number.isFinite(productId)) {
    return res.status(400).json({ error: "Invalid product id" });
  }

  if (!entries.length) {
    return res.json({ ok: true, updated: 0 });
  }

  const updatedAt = new Date();
  let updated = 0;

  for (const entry of entries) {
    const entryId = Number(entry.id);
    if (!Number.isFinite(entryId)) continue;

    const payload = {
      visible:
        typeof entry.visible === "boolean" || entry.visible === null
          ? (entry.visible === null ? null : (entry.visible ? 1 : 0))
          : undefined,
      onSale:
        typeof entry.onSale === "boolean" || entry.onSale === null
          ? (entry.onSale === null ? null : (entry.onSale ? 1 : 0))
          : undefined,
      onSaleToggle:
        typeof entry.onSaleToggle === "boolean" || entry.onSaleToggle === null
          ? (entry.onSaleToggle === null ? null : (entry.onSaleToggle ? 1 : 0))
          : undefined,
      finalPriceCache:
        entry.finalPriceCache === null || typeof entry.finalPriceCache === "undefined"
          ? undefined
          : entry.finalPriceCache,
      strikethroughDisplayValue:
        entry.strikethroughDisplayValue === null ||
        typeof entry.strikethroughDisplayValue === "undefined"
          ? undefined
          : entry.strikethroughDisplayValue,
      maxUnitsPerOrder:
        entry.maxUnitsPerOrder === null || typeof entry.maxUnitsPerOrder === "undefined"
          ? undefined
          : entry.maxUnitsPerOrder,
      updatedAt,
      lastSyncedAt: updatedAt
    };

    Object.keys(payload).forEach((key) => {
      if (typeof payload[key] === "undefined") {
        delete payload[key];
      }
    });

    if (!Object.keys(payload).length) continue;

    await db
      .update(localLinePriceListEntries)
      .set(payload)
      .where(and(eq(localLinePriceListEntries.id, entryId), eq(localLinePriceListEntries.productId, productId)));

    const packageId = Number(entry.packageId);
    const priceListId = Number(entry.priceListId);
    if (Number.isFinite(packageId) && Number.isFinite(priceListId)) {
      await db
        .update(packagePriceListMemberships)
        .set({
          onSale: payload.onSale ?? undefined,
          onSaleToggle: payload.onSaleToggle ?? undefined,
          finalPriceCache: payload.finalPriceCache ?? undefined,
          strikethroughDisplayValue: payload.strikethroughDisplayValue ?? undefined,
          maxUnitsPerOrder: payload.maxUnitsPerOrder ?? undefined,
          updatedAt,
          lastSyncedAt: updatedAt
        })
        .where(
          and(
            eq(packagePriceListMemberships.packageId, packageId),
            eq(packagePriceListMemberships.priceListId, priceListId)
          )
        );
    }

    updated += 1;
  }

  return res.json({ ok: true, updated });
});

router.get("/pricelist", requireAdmin, async (_req, res) => {
  const db = getDb();
  await ensureLocalLineSyncSchema().catch((error) => {
    console.warn("Local Line schema bootstrap skipped for /admin/pricelist:", error.message);
  });

  const [productRows, categoryRows, vendorRows, packageRows, profileRows, saleRows] =
    await Promise.all([
      db.select().from(products),
      db.select().from(categories),
      db.select().from(vendors),
      db.select().from(packages),
      db.select().from(productPricingProfiles),
      db.select().from(productSales)
    ]);

  let packageMetaRows = [];
  try {
    packageMetaRows = await db.select().from(localLinePackageMeta);
  } catch (error) {
    if (!isMissingTableError(error, "local_line_package_meta")) throw error;
  }

  const categoryMap = new Map(categoryRows.map((row) => [row.id, row.name]));
  const vendorMap = new Map(vendorRows.map((row) => [row.id, row]));
  const packagesByProductId = packageRows.reduce((acc, row) => {
    const list = acc.get(row.productId) || [];
    list.push(row);
    acc.set(row.productId, list);
    return acc;
  }, new Map());
  const packageMetaByPackageId = new Map(
    packageMetaRows.map((row) => [Number(row.packageId), row])
  );
  const profileByProductId = new Map(
    profileRows.map((row) => [Number(row.productId), row])
  );
  const saleByProductId = new Map(
    saleRows.map((row) => [Number(row.productId), row])
  );

  const rows = productRows
    .slice()
    .filter((product) => !isMembershipCategoryName(categoryMap.get(product.categoryId)))
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")))
    .map((product) => {
      const pricingProfile = profileByProductId.get(Number(product.id)) || null;
      const saleRow = saleByProductId.get(Number(product.id)) || null;
      const vendor = vendorMap.get(product.vendorId) || null;
      const snapshot = computeProductPricingSnapshot({
        product,
        packages: packagesByProductId.get(Number(product.id)) || [],
        packageMetaByPackageId,
        vendor,
        profile: pricingProfile
          ? pricingProfile
          : {
              productId: product.id,
              onSale: saleRow?.onSale ?? 0,
              saleDiscount: saleRow?.saleDiscount ?? 0
            }
      });
      const usesSourcePricing = isSourcePricingVendor(vendor);
      const hasPendingRemoteApply = pricingProfile
        ? ["pending", "failed"].includes(String(pricingProfile.remoteSyncStatus || "")) ||
          toTimestamp(pricingProfile.updatedAt) > toTimestamp(pricingProfile.remoteSyncedAt)
        : false;

      return {
        productId: product.id,
        name: product.name,
        categoryId: product.categoryId,
        categoryName: categoryMap.get(product.categoryId) || "Uncategorized",
        vendorId: product.vendorId,
        vendorName: vendor?.name || "N/A",
        usesSourcePricing,
        usesNoMarkupPricing: snapshot.profile.usesNoMarkupPricing,
        pricingRule: snapshot.profile.pricingRule,
        pricingRuleLabel: snapshot.profile.usesNoMarkupPricing ? "Deposit / no markup" : "Standard",
        packageCount: snapshot.packageRows.length,
        packages: snapshot.packageRows,
        packageSummary: snapshot.packageRows
          .map((row) => {
            const details = [];
            if (snapshot.profile.unitOfMeasure === "lbs" && row.averageWeight !== null) {
              details.push(`${row.averageWeight} lb avg`);
            }
            if (row.quantity > 1) details.push(`${row.quantity} ea`);
            return `${row.name || `Package ${row.id}`}${details.length ? ` (${details.join(" · ")})` : ""}`;
          })
          .join(", "),
        unitOfMeasure: usesSourcePricing ? snapshot.profile.unitOfMeasure : null,
        sourceUnitPrice: usesSourcePricing ? snapshot.profile.sourceUnitPrice : null,
        minWeight: usesSourcePricing ? snapshot.profile.minWeight : null,
        maxWeight: usesSourcePricing ? snapshot.profile.maxWeight : null,
        avgWeightOverride: usesSourcePricing ? snapshot.profile.avgWeightOverride : null,
        sourceMultiplier: usesSourcePricing ? snapshot.profile.sourceMultiplier : null,
        guestMarkup: snapshot.profile.guestMarkup,
        memberMarkup: snapshot.profile.memberMarkup,
        herdShareMarkup: snapshot.profile.herdShareMarkup,
        snapMarkup: snapshot.profile.snapMarkup,
        onSale: Boolean(snapshot.profile.onSale),
        saleDiscount: snapshot.profile.saleDiscount,
        basePrice: snapshot.basePrice,
        guestPrice: snapshot.guestPrice,
        memberPrice: snapshot.memberPrice,
        herdSharePrice: snapshot.herdSharePrice,
        snapPrice: snapshot.snapPrice,
        remoteSyncStatus: pricingProfile?.remoteSyncStatus || "not-applied",
        remoteSyncMessage: pricingProfile?.remoteSyncMessage || "",
        remoteSyncedAt: pricingProfile?.remoteSyncedAt || null,
        updatedAt: pricingProfile?.updatedAt || null,
        hasPendingRemoteApply
      };
    });

  res.json({ rows });
});

router.post("/pricelist/bulk-save", requireAdminPermission("pricing_admin"), async (req, res) => {
  const db = getDb();
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const now = new Date();
  const savedProductIds = [];

  for (const row of rows) {
    const productId = Number(row?.productId);
    if (!Number.isFinite(productId)) {
      continue;
    }

    const productRows = await db.select().from(products).where(eq(products.id, productId));
    const forceNoMarkup = isNoMarkupProduct(productRows[0] || { id: productId });

    const payload = {
      unitOfMeasure: String(row.unitOfMeasure || "each").toLowerCase() === "lbs" ? "lbs" : "each",
      sourceUnitPrice: toDbDecimal(row.sourceUnitPrice),
      minWeight: toDbDecimal(row.minWeight),
      maxWeight: toDbDecimal(row.maxWeight),
      avgWeightOverride: toDbDecimal(row.avgWeightOverride),
      sourceMultiplier: toDbDecimal(row.sourceMultiplier),
      guestMarkup: forceNoMarkup ? 0 : toDbDecimal(row.guestMarkup),
      memberMarkup: forceNoMarkup ? 0 : toDbDecimal(row.memberMarkup),
      herdShareMarkup: forceNoMarkup ? 0 : toDbDecimal(row.herdShareMarkup),
      snapMarkup: forceNoMarkup ? 0 : toDbDecimal(row.snapMarkup),
      onSale: row.onSale ? 1 : 0,
      saleDiscount: toDbDecimal(row.saleDiscount),
      remoteSyncStatus: "pending",
      remoteSyncMessage: "Local pricing updated. Apply to remote store pending.",
      updatedAt: now
    };

    const existing = await db
      .select()
      .from(productPricingProfiles)
      .where(eq(productPricingProfiles.productId, productId));

    if (existing.length) {
      await db
        .update(productPricingProfiles)
        .set(payload)
        .where(eq(productPricingProfiles.productId, productId));
    } else {
      await db.insert(productPricingProfiles).values({
        productId,
        ...payload,
        createdAt: now
      });
    }

    savedProductIds.push(productId);
  }

  res.json({ ok: true, saved: savedProductIds.length, productIds: savedProductIds });
});

router.post("/pricelist/apply-remote", requireAdminPermission("localline_push"), async (req, res) => {
  const db = getDb();
  const productIds = [...new Set(
    (Array.isArray(req.body?.productIds) ? req.body.productIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
  )];

  const results = [];
  for (const productId of productIds) {
    const now = new Date();
    try {
      const productRows = await db.select().from(products).where(eq(products.id, productId));

      if (!productRows.length) {
        results.push({ productId, ok: false, message: "Product not found." });
        continue;
      }

      const product = productRows[0];
      const [packageRows, vendorRows, profileRows, saleRows] = await Promise.all([
        db.select().from(packages).where(eq(packages.productId, productId)),
        product.vendorId
          ? db.select().from(vendors).where(eq(vendors.id, product.vendorId))
          : Promise.resolve([]),
        db
          .select()
          .from(productPricingProfiles)
          .where(eq(productPricingProfiles.productId, productId)),
        db.select().from(productSales).where(eq(productSales.productId, productId))
      ]);

      let packageMetaRows = [];
      try {
        packageMetaRows = await db
          .select()
          .from(localLinePackageMeta)
          .where(eq(localLinePackageMeta.productId, productId));
      } catch (error) {
        if (!isMissingTableError(error, "local_line_package_meta")) throw error;
      }

      const snapshot = computeProductPricingSnapshot({
        product,
        packages: packageRows,
        packageMetaByPackageId: new Map(
          packageMetaRows.map((row) => [Number(row.packageId), row])
        ),
        vendor: vendorRows[0] || null,
        profile: profileRows[0] || {
          productId,
          onSale: saleRows[0]?.onSale ?? 0,
          saleDiscount: saleRows[0]?.saleDiscount ?? 0
        }
      });

      if (!Number.isFinite(Number(snapshot.profile.sourceUnitPrice))) {
        results.push({
          productId,
          ok: false,
          message: "Source unit price is required before remote apply."
        });
        continue;
      }

      const pricedPackages = snapshot.packageRows.filter((row) => Number.isFinite(Number(row.basePrice)));
      if (!pricedPackages.length) {
        results.push({
          productId,
          ok: false,
          message: "No package prices could be derived for this product."
        });
        continue;
      }

      for (const packageRow of pricedPackages) {
        await db
          .update(packages)
          .set({ price: packageRow.basePrice })
          .where(eq(packages.id, packageRow.id));
      }

      const salePayload = {
        productId,
        onSale: snapshot.profile.onSale ? 1 : 0,
        saleDiscount: snapshot.profile.saleDiscount,
        updatedAt: now
      };
      if (saleRows.length) {
        await db
          .update(productSales)
          .set(salePayload)
          .where(eq(productSales.productId, productId));
      } else {
        await db.insert(productSales).values(salePayload);
      }

      const profilePayload = {
        unitOfMeasure: snapshot.profile.unitOfMeasure,
        sourceUnitPrice: snapshot.profile.sourceUnitPrice,
        minWeight: snapshot.profile.minWeight,
        maxWeight: snapshot.profile.maxWeight,
        avgWeightOverride: snapshot.profile.avgWeightOverride,
        sourceMultiplier: snapshot.profile.sourceMultiplier,
        guestMarkup: snapshot.profile.guestMarkup,
        memberMarkup: snapshot.profile.memberMarkup,
        herdShareMarkup: snapshot.profile.herdShareMarkup,
        snapMarkup: snapshot.profile.snapMarkup,
        onSale: snapshot.profile.onSale ? 1 : 0,
        saleDiscount: snapshot.profile.saleDiscount,
        remoteSyncStatus: "applied",
        remoteSyncMessage: "Applied to store pricing and remote sync completed.",
        remoteSyncedAt: now,
        updatedAt: profileRows[0]?.updatedAt || now
      };
      if (profileRows.length) {
        await db
          .update(productPricingProfiles)
          .set(profilePayload)
          .where(eq(productPricingProfiles.productId, productId));
      } else {
        await db.insert(productPricingProfiles).values({
          productId,
          ...profilePayload,
          createdAt: now
        });
      }

      const remoteResult = await updateLocalLineForProduct(db, productId, {
        onSale: snapshot.profile.onSale ? 1 : 0,
        saleDiscount: snapshot.profile.saleDiscount,
        forcePriceSync: true
      });
      const remoteFailed = isLocalLineEnabled() && remoteResult.priceOk === false;
      if (remoteFailed) {
        await db
          .update(productPricingProfiles)
          .set({
            remoteSyncStatus: "failed",
            remoteSyncMessage: "Local store updated, but Local Line price sync failed.",
            updatedAt: now
          })
          .where(eq(productPricingProfiles.productId, productId));
      }

      results.push({
        productId,
        ok: !remoteFailed,
        packageUpdates: pricedPackages.length,
        remotePriceUpdate: remoteResult.priceOk,
        message: remoteFailed
          ? "Local store updated, but Local Line price sync failed."
          : "Pricing applied."
      });
    } catch (error) {
      await db
        .update(productPricingProfiles)
        .set({
          remoteSyncStatus: "failed",
          remoteSyncMessage: error?.message || "Remote apply failed.",
          updatedAt: new Date()
        })
        .where(eq(productPricingProfiles.productId, productId));
      results.push({
        productId,
        ok: false,
        message: error?.message || "Remote apply failed."
      });
    }
  }

  res.json({ results });
});

router.post("/pricelist/export-google", requireAdminPermission("pricing_admin"), async (_req, res) => {
  try {
    const summary = await exportMasterPricelist({
      nodeEnv: process.env.NODE_ENV || "production",
      vendorNameMatcher: isGooglePricelistVendorName
    });

    res.json({
      ok: true,
      rowCount: summary.rowCount,
      spreadsheetSummary: summary.spreadsheetSummary,
      vendorNames: summary.vendorNames
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Google pricelist export failed."
    });
  }
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

router.post("/localline/audit", requireAdminPermission("localline_pull"), async (req, res) => {
  try {
    const limit = Number(req.body?.limit);
    const concurrency = Number(req.body?.concurrency);
    const includeInactive = Boolean(req.body?.includeInactive);
    const includePricelist = Boolean(req.body?.includePricelist);

    const { summary } = await runLocalLineAudit({
      killdeerEnvPath: includePricelist ? process.env.LOCALLINE_AUDIT_KILLDEER_ENV || undefined : undefined,
      includeInactive,
      skipPricelist: !includePricelist,
      limit: Number.isFinite(limit) ? limit : 20,
      concurrency: Number.isFinite(concurrency) ? concurrency : 5
    });

    res.json(summary);
  } catch (error) {
    console.error("LocalLine sync failed:", error);
    res.status(500).json({
      error: "Local Line sync failed",
      detail: error?.message || "Unknown error"
    });
  }
});

router.post("/localline/apply", requireAdminPermission("localline_pull"), async (req, res) => {
  try {
    const limit = Number(req.body?.limit);
    const concurrency = Number(req.body?.concurrency);
    const includeInactive = Boolean(req.body?.includeInactive);
    const selectedFixKeys = Array.isArray(req.body?.fixKeys)
      ? req.body.fixKeys
      : req.body?.fixKey
        ? [req.body.fixKey]
        : [];

    const { summary } = await runLocalLineAudit({
      killdeerEnvPath: process.env.LOCALLINE_AUDIT_KILLDEER_ENV || undefined,
      includeInactive,
      write: true,
      selectedFixKeys,
      limit: Number.isFinite(limit) ? limit : 20,
      concurrency: Number.isFinite(concurrency) ? concurrency : 5
    });

    res.json(summary);
  } catch (error) {
    console.error("LocalLine apply failed:", error);
    res.status(500).json({
      error: "Local Line apply failed",
      detail: error?.message || "Unknown error"
    });
  }
});

async function handleLocalLineFullSync(req, res) {
  try {
    await ensureLocalLineSyncSchema();
    const limit = Number(req.body?.limit);
    const concurrency = Number(req.body?.concurrency);
    const includePricelist = Boolean(req.body?.includePricelist);
    const forceFull = Boolean(req.body?.forceFull);

    const result = startLocalLineFullSyncJob({
      killdeerEnvPath: includePricelist ? process.env.LOCALLINE_AUDIT_KILLDEER_ENV || undefined : undefined,
      skipPricelist: !includePricelist,
      forceFull,
      limit: Number.isFinite(limit) ? limit : null,
      concurrency: Number.isFinite(concurrency) ? concurrency : 6
    });

    res.status(result.alreadyRunning ? 200 : 202).json(result);
  } catch (error) {
    console.error("LocalLine full sync failed:", error);
    res.status(500).json({
      error: "Local Line full sync failed",
      detail: error?.message || "Unknown error"
    });
  }
}

router.post("/localline/full-sync", requireAdminPermission("localline_pull"), handleLocalLineFullSync);
router.post("/localline/cache-sync", requireAdminPermission("localline_pull"), handleLocalLineFullSync);
router.post("/localline/products-sync", requireAdminPermission("localline_pull"), handleLocalLineFullSync);
router.get("/localline/full-sync", requireAdmin, (_req, res) => {
  const job = getLatestLocalLineFullSyncJob();
  if (!job) {
    return res.status(404).json({ error: "No Local Line full sync job found" });
  }
  return res.json({ job });
});
router.get("/localline/full-sync/:jobId", requireAdmin, (req, res) => {
  const job = getLocalLineFullSyncJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Local Line full sync job not found" });
  }
  return res.json({ job });
});

router.post("/categories", requireAdminPermission("admin"), async (req, res) => {
  const db = getDb();
  const payload = req.body || {};
  await db.insert(categories).values({ name: payload.name });
  res.json({ ok: true });
});

router.post("/vendors", requireAdminPermission("admin"), async (req, res) => {
  const db = getDb();
  const payload = req.body || {};
  await db.insert(vendors).values({
    name: payload.name,
    guestMarkup: payload.guestMarkup ?? undefined,
    memberMarkup: payload.memberMarkup ?? undefined
  });
  res.json({ ok: true });
});

router.put("/vendors/:id", requireAdminPermission("admin"), async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const payload = req.body || {};

  await db
    .update(vendors)
    .set({
      name: payload.name ?? undefined,
      guestMarkup: payload.guestMarkup ?? undefined,
      memberMarkup: payload.memberMarkup ?? undefined
    })
    .where(eq(vendors.id, id));

  res.json({ ok: true });
});

router.post("/drop-sites", requireAdminPermission("dropsite_admin"), async (req, res) => {
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

router.put("/drop-sites/:id", requireAdminPermission("dropsite_admin"), async (req, res) => {
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

router.put("/reviews/:id", requireAdminPermission("member_admin"), async (req, res) => {
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

router.put("/products/:id", requireAdminPermission(["inventory_admin", "pricing_admin", "membership_admin"]), async (req, res) => {
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

router.post("/products/bulk-update", requireAdminPermission(["inventory_admin", "membership_admin"]), async (req, res) => {
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

      let localLineUpdate = null;
      let localLinePriceUpdate = null;
      if (isLocalLineEnabled()) {
        try {
          const result = await updateLocalLineForProduct(db, productId, changes);
          localLineUpdate = result.inventoryOk;
          localLinePriceUpdate = result.priceOk;
        } catch (err) {
          console.error("LocalLine update failed:", err.message);
          localLineUpdate = false;
          localLinePriceUpdate = false;
        }
      }

      results.push({
        productId,
        databaseUpdate: true,
        localLineUpdate,
        localLinePriceUpdate
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

router.put("/packages/:id", requireAdminPermission(["pricing_admin", "membership_admin"]), async (req, res) => {
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

router.post("/products/:id/images", requireAdminPermission(["inventory_admin", "pricing_admin"]), upload.single("image"), async (req, res) => {
  const db = getDb();
  const productId = Number(req.params.id);
  if (!req.file) {
    return res.status(400).json({ error: "Missing image file" });
  }

  if (!process.env.DO_SPACES_BUCKET || !process.env.DO_SPACES_ENDPOINT) {
    return res.status(500).json({ error: "Spaces not configured" });
  }

  const ext = req.file.originalname.split(".").pop() || "jpg";
  const safeExt = ext.toLowerCase();
  const baseName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const key = `products/${productId}/${baseName}.${safeExt}`;
  const thumbKey = `products/${productId}/${baseName}.thumbnail.jpg`;

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

  const thumbnailBuffer = await sharp(req.file.buffer)
    .resize({ width: 480, height: 480, fit: "cover" })
    .jpeg({ quality: 80 })
    .toBuffer();

  await spacesClient.send(
    new PutObjectCommand({
      Bucket: process.env.DO_SPACES_BUCKET,
      Key: thumbKey,
      Body: thumbnailBuffer,
      ACL: "public-read",
      ContentType: "image/jpeg",
      CacheControl: "public, max-age=31536000, immutable"
    })
  );

  const url = buildPublicUrl(key);
  const thumbnailUrl = buildPublicUrl(thumbKey);
  const urlHash = url.length ? String(url).slice(-64) : String(Date.now());
  const thumbHash = thumbnailUrl.length ? String(thumbnailUrl).slice(-64) : String(Date.now() + 1);

  await db.insert(productImages).values([
    { productId, url, urlHash },
    { productId, url: thumbnailUrl, urlHash: thumbHash }
  ]);

  res.json({ ok: true, url, thumbnailUrl });
});

router.post("/recipes", requireAdminPermission("admin"), async (req, res) => {
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

router.put("/recipes/:id", requireAdminPermission("admin"), async (req, res) => {
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
