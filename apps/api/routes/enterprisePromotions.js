import express from "express";
import { requireAdminPermission } from "../middleware/auth.js";
import { approveEnterprisePromotion, cancelEnterprisePromotion, getEnterprisePromotion, listEnterprisePromotions, previewEnterprisePromotion, publishEnterprisePromotion, saveEnterprisePromotionDraft } from "../lib/enterprisePromotions.js";
import { hasAdminPermission } from "../lib/adminRoles.js";

const router = express.Router();
const route = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (error) { res.status(error.status || 400).json({ error: error.message }); }
};
router.use(requireAdminPermission(["pricing_editor", "pricing_publisher", "pricing_admin", "local_pricelist_admin"]));
router.get("/", route(() => listEnterprisePromotions()));
router.get("/:id", route(req => getEnterprisePromotion(req.params.id)));
router.post("/preview", requireAdminPermission(["pricing_editor", "pricing_admin", "local_pricelist_admin"]), route(req => previewEnterprisePromotion(req.body?.input)));
router.post("/", requireAdminPermission(["pricing_editor", "pricing_admin", "local_pricelist_admin"]), route(req => saveEnterprisePromotionDraft(req.body?.input, req.admin)));
router.post("/:id/approve", requireAdminPermission(["pricing_publisher", "pricing_admin"]), route(req => approveEnterprisePromotion(req.params.id, req.admin)));
const requireDestinationGrants = async (req, res, next) => {
  try {
    const promotion = await getEnterprisePromotion(req.params.id);
    const roles = req.admin?.adminRoles || [];
    if (promotion.input.channels.includes("localline") && !hasAdminPermission(roles, "localline_push")) return res.status(403).json({ error: "Local Line Push permission is required." });
    if (promotion.input.channels.includes("square") && !hasAdminPermission(roles, "square_push")) return res.status(403).json({ error: "Square Push permission is required." });
    return next();
  } catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
};
router.post("/:id/publish", requireAdminPermission(["pricing_publisher", "pricing_admin"]), requireDestinationGrants, route(req => publishEnterprisePromotion(req.params.id, req.admin)));
router.post("/:id/cancel", requireAdminPermission(["pricing_publisher", "pricing_admin"]), requireDestinationGrants, route(req => cancelEnterprisePromotion(req.params.id, req.admin)));
export default router;
