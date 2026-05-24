function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

// Temporary merge-prep toggles. Set these Vite env vars to "true" to restore
// the public member portal link and full portal onboarding from the subscribe form.
export const MEMBER_PORTAL_LINK_ENABLED = isEnabled(import.meta.env.VITE_MEMBER_PORTAL_LINK_ENABLED);
export const SUBSCRIBE_PORTAL_ONBOARDING_ENABLED = isEnabled(
  import.meta.env.VITE_SUBSCRIBE_PORTAL_ONBOARDING_ENABLED
);
