import express from "express";
import { requireAdminPermission } from "../middleware/auth.js";
import { SYNC_ROLES } from "../lib/productSyncCore.js";
import {
  createProductSyncAudit, getProductSyncAudit, listProductSyncActions, createProductSyncRelease,
  getProductSyncRelease, listProductSyncReleases, runProductSyncRelease, cancelProductSyncRelease,
  reviewProductSyncRelease, applyProductSyncIncoming, productSyncStatus, pendingProductSync, syncCatalog, selectedActions,
  queueProductSyncRelease, getProductSyncReleaseProgress, activeProductSyncReleases
} from "../lib/productSync.js";

const router = express.Router();
router.use(requireAdminPermission(SYNC_ROLES));
const route = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (error) { res.status(error.status || 400).json({ error: error.message }); }
};
router.get("/status", route(() => productSyncStatus()));
router.get("/pending", route(req => pendingProductSync(req.query)));
router.get("/matches/localline", route(async () => ({ rows: (await syncCatalog()).filter(row => row.categoryName?.trim().toLowerCase() !== "membership") })));
router.post("/audits", route(req => createProductSyncAudit(req.body || {}, req.admin)));
router.get("/audits/:id", route(req => getProductSyncAudit(req.params.id)));
router.get("/audits/:id/actions", route(req => listProductSyncActions(req.params.id, req.query)));
router.get("/audits/:id/action-ids", route(req => listProductSyncActions(req.params.id, req.query, true, req.admin.adminRoles || [])));
router.post("/audits/:id/selection", route(async req => ({ actions: await selectedActions(req.params.id, req.body?.actionIds) })));
router.post("/incoming/apply", route(req => applyProductSyncIncoming(req.body || {}, req.admin)));
router.get("/releases", route(() => listProductSyncReleases()));
router.get("/releases/active", route(() => activeProductSyncReleases()));
router.get("/releases/:id/progress", route(req => getProductSyncReleaseProgress(req.params.id)));
router.get("/releases/:id", route(req => getProductSyncRelease(req.params.id)));
router.post("/releases", route(async req => {
  const release = await createProductSyncRelease(req.body || {}, req.admin);
  if (!release.scheduled && req.body?.background === true) return queueProductSyncRelease(release.id, req.admin);
  // Both immediate and timed publication use the same durable runner.
  if (!release.scheduled) await runProductSyncRelease(release.id, { user: req.admin, allowFuture: true });
  return getProductSyncRelease(release.id);
}));
router.post("/releases/:id/cancel", route(req => cancelProductSyncRelease(req.params.id, req.admin)));
router.post("/releases/:id/run-now", route(req => req.body?.background === true ? queueProductSyncRelease(req.params.id, req.admin) : runProductSyncRelease(req.params.id, { user: req.admin, allowFuture: true })));
router.post("/releases/:id/retry", route(req => req.body?.background === true ? queueProductSyncRelease(req.params.id, req.admin) : runProductSyncRelease(req.params.id, { user: req.admin, allowFuture: true })));
router.post("/releases/:id/review", route(req => reviewProductSyncRelease(req.params.id, req.admin)));
export default router;
