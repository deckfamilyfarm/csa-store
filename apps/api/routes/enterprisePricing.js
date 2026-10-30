import { refreshFullFarmInventory } from "../lib/inventorySync.js";
import { saveProductSale } from "../lib/enterpriseProductSales.js";
import { createEnterpriseProduct, previewEnterpriseProductCreation } from "../lib/enterpriseProductCreation.js";
import express from "express";
import { requireAdminPermission } from "../middleware/auth.js";
import { listBundles, getBundle, previewBundle, saveBundle, createBundle } from '../lib/enterpriseBundles.js';
import {
  approveEnterprisePricingRevision, enterprisePricingMigrationReport, enterprisePricingSummary, getEnterprisePricingProduct,
  getPricingSettings, getPricingSettingsDraft, listEnterprisePricingProducts, listEnterprisePricingReview,
  listPricingEnterprises, previewEnterprisePricing, saveEnterprisePricingDraft, saveEnterpriseBuyPrice,
  previewPricingSettings, savePricingSettingsDraft, approvePricingSettingsDraft,
  rejectEnterprisePricingRevision, activateEnterprisePricingLocally, getEnterprisePricingSync
} from "../lib/enterprisePricingService.js";

import {reviewBundlePublication,getBundlePublication,publishBundle} from '../lib/enterpriseBundlePublications.js';
const router = express.Router();
const view = requireAdminPermission(["pricing_editor", "pricing_publisher", "pricing_admin", "local_pricelist_admin"]);
const edit = requireAdminPermission(["pricing_editor", "pricing_admin", "local_pricelist_admin"]);
const approve = requireAdminPermission(["pricing_publisher", "pricing_admin"]);
const route = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (error) { res.status(error.status || 400).json({ error: error.message }); }
};

router.use(view);
router.get('/bundles', route(() => listBundles()));
router.post('/bundles', edit, route(req => createBundle(req.body, req.admin)));
router.post('/bundles/:id/review', approve, requireAdminPermission('localline_pull'), route(req => reviewBundlePublication(req.params.id,req.admin)));
router.get('/bundle-publications/:id', route(req => getBundlePublication(req.params.id)));
router.post('/bundle-publications/:id/publish', approve, requireAdminPermission('localline_push'), route(req => publishBundle(req.params.id,req.admin)));

router.get('/bundles/:id', route(req => getBundle(req.params.id)));
router.post('/bundles/preview', edit, route(req => previewBundle(req.body?.input)));
router.post('/bundles/:id', edit, route(req => saveBundle(req.params.id, req.body, req.admin)));
router.get("/settings", route(() => getPricingSettings()));
router.get("/settings/draft", route(() => getPricingSettingsDraft()));
router.post("/settings/preview", requireAdminPermission("pricing_admin"), route(req => previewPricingSettings(req.body?.settings)));
router.post("/settings/drafts", requireAdminPermission("pricing_admin"), route(req => savePricingSettingsDraft(req.body?.settings, req.admin)));
router.post("/settings/drafts/:id/approve", requireAdminPermission("pricing_admin"), route(req => approvePricingSettingsDraft(req.params.id, req.admin)));
router.get("/enterprises", route(() => listPricingEnterprises()));
router.post("/products/preview", edit, route(req => previewEnterpriseProductCreation(req.body)));
router.post("/products", edit, route(req => createEnterpriseProduct(req.body, req.admin)));
router.post("/inventory/refresh", route(req => refreshFullFarmInventory(req.body?.productIds)));
router.get("/products", route(req => listEnterprisePricingProducts(req.query)));
router.get("/summary", route(() => enterprisePricingSummary()));
router.get("/products/:id", route(req => getEnterprisePricingProduct(req.params.id)));
router.post("/products/:id/sale", edit, route(req => saveProductSale(req.params.id, req.body, req.admin)));
router.get("/products/:id/sync", route(req => getEnterprisePricingSync(req.params.id)));
router.post("/products/:id/buy-price", edit, route(req => saveEnterpriseBuyPrice(
  req.params.id, req.body?.price, req.body?.expectedRevision, req.admin)));
router.post("/products/:id/preview", edit, route(req => previewEnterprisePricing(req.params.id, req.body?.input)));
router.post("/products/:id/revisions", edit, route(req => saveEnterprisePricingDraft(req.params.id, req.body?.input, req.body?.expectedLatestRevisionId, req.admin, req.body?.expectedBuyPriceRevision)));
router.get("/review", route(req => listEnterprisePricingReview({ productId: req.query.productId })));
router.post("/revisions/:id/approve", approve, route(req => approveEnterprisePricingRevision(req.params.id, req.admin)));
router.post("/revisions/:id/activate-local", approve, route(req => activateEnterprisePricingLocally(req.params.id, req.admin)));
router.post("/revisions/:id/reject", approve, route(req => rejectEnterprisePricingRevision(req.params.id, req.body?.reason, req.admin)));
router.get("/migration-report", route(req => enterprisePricingMigrationReport(req.query)));

export default router;
