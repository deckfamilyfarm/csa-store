import express from "express";
import {
  createSignedLiabilityRelease,
  ensureDefaultLiabilityReleaseTemplates,
  getLiabilityReleaseTemplateBySlug,
  getPublishedLiabilityReleaseVersion,
  publicTemplatePayload
} from "../lib/liabilityReleases.js";

const router = express.Router();

router.use(async (_req, _res, next) => {
  try {
    await ensureDefaultLiabilityReleaseTemplates();
    next();
  } catch (error) {
    next(error);
  }
});

router.get("/templates/:slug", async (req, res) => {
  try {
    const template = await getLiabilityReleaseTemplateBySlug(req.params.slug, {
      publicOnly: true
    });
    const version = template ? await getPublishedLiabilityReleaseVersion(template) : null;
    const payload = publicTemplatePayload(template, version);
    if (!payload) {
      return res.status(404).json({ error: "This release is not available for signing." });
    }
    res.json({ template: payload });
  } catch (error) {
    console.error("Liability template fetch failed:", error);
    res.status(500).json({ error: "Failed to load liability release." });
  }
});

router.post("/sign/:slug", async (req, res) => {
  try {
    const sourceHost = req.get("x-forwarded-host") || req.get("host") || req.body?.sourceHost;
    const sourcePath = req.body?.sourcePath;
    const submission = await createSignedLiabilityRelease({
      slug: req.params.slug,
      payload: req.body || {},
      sourceType: "public",
      sourceHost,
      sourcePath
    });
    res.json({
      ok: true,
      submission: {
        id: submission.id,
        templateSlug: submission.templateSlug,
        templateTitle: submission.templateTitle,
        signerName: submission.signerName,
        signerEmail: submission.signerEmail,
        signedAt: submission.signedAt,
        expiresAt: submission.expiresAt,
        recordUrl: submission.recordUrl
      }
    });
  } catch (error) {
    console.error("Liability release signing failed:", error);
    res.status(error.status || 500).json({
      error: error?.message || "Failed to sign liability release."
    });
  }
});

export default router;
