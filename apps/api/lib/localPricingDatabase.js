export const isLocalPricingDatabaseName = name => /^csa_pricing_local(?:_\d{14})?$/.test(String(name || ""));
