export const ADMIN_ROLE_DEFINITIONS = [
  {
    key: "admin",
    label: "Admin",
    description: "Full access to all CSA Store administration."
  },
  {
    key: "user_admin",
    label: "User Admin",
    description: "Add backend users and assign roles."
  },
  {
    key: "inventory_admin",
    label: "Inventory Admin",
    description: "Manage inventory, visibility, stock, and sale status."
  },
  {
    key: "pricing_admin",
    label: "Remote Pricing Admin",
    description: "Manage the remote pricelist workflow, formulas, and Local Line pricing adjustments."
  },
  {
    key: "local_pricelist_admin",
    label: "Local Pricelist",
    description: "Manage local products, package pricing, and local pricing inputs."
  },
  {
    key: "localline_pull",
    label: "Local Line Pull",
    description: "Review and pull approved changes from Local Line."
  },
  {
    key: "localline_push",
    label: "Local Line Push",
    description: "Push approved local changes to Local Line."
  },
  {
    key: "dropsite_admin",
    label: "Drop Site Admin",
    description: "Add and update drop sites."
  },
  {
    key: "membership_admin",
    label: "Membership Admin",
    description: "Configure membership plans and levels."
  },
  {
    key: "member_admin",
    label: "Member Admin",
    description: "Manage storefront members and member records."
  },
  {
    key: "marketing_admin",
    label: "Marketing Admin",
    description: "Full access to campaign tracking, attribution, and marketing reporting."
  },
  {
    key: "campaign_manager",
    label: "Campaign Manager",
    description: "Create campaigns, tracked links, and managed channel guidance."
  },
  {
    key: "content_editor",
    label: "Content Editor",
    description: "Manage marketing content records and message metadata."
  },
  {
    key: "ad_spend_approver",
    label: "Ad Spend Approver",
    description: "Review and update marketing spend records."
  },
  {
    key: "analytics_viewer",
    label: "Analytics Viewer",
    description: "View campaign attribution and marketing analytics."
  }
];

export const ADMIN_ROLE_KEYS = ADMIN_ROLE_DEFINITIONS.map((role) => role.key);

export function normalizeAdminRoleKey(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeAdminRoleKeys(values = []) {
  const allowed = new Set(ADMIN_ROLE_KEYS);
  const seen = new Set();
  const normalized = [];

  for (const value of Array.isArray(values) ? values : []) {
    const key = normalizeAdminRoleKey(value);
    if (!allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
}

export function hasAdminPermission(roleKeys = [], required = []) {
  const assigned = new Set(roleKeys.map(normalizeAdminRoleKey));
  if (assigned.has("admin")) return true;
  const requiredList = Array.isArray(required) ? required : [required];
  return requiredList.some((role) => assigned.has(normalizeAdminRoleKey(role)));
}
