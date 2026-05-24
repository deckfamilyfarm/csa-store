import {
  mysqlTable,
  int,
  varchar,
  text,
  datetime,
  decimal,
  tinyint,
  primaryKey,
  index,
  uniqueIndex
} from "drizzle-orm/mysql-core";

export const vendors = mysqlTable("vendors", {
  id: int("id").primaryKey(),
  name: varchar("name", { length: 255 }),
  priceListMarkup: decimal("price_list_markup", { precision: 10, scale: 4 }),
  sourceMultiplier: decimal("source_multiplier", { precision: 10, scale: 4 }),
  guestMarkup: decimal("guest_markup", { precision: 5, scale: 2 }).default("0.55"),
  memberMarkup: decimal("member_markup", { precision: 5, scale: 2 }).default("0.40")
});

export const categories = mysqlTable("categories", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).unique()
});

export const products = mysqlTable("products", {
  id: int("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  visible: tinyint("visible"),
  trackInventory: tinyint("track_inventory"),
  inventory: int("inventory"),
  categoryId: int("category_id"),
  vendorId: int("vendor_id"),
  thumbnailUrl: text("thumbnail_url"),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at"),
  isDeleted: tinyint("is_deleted")
});

export const packages = mysqlTable("packages", {
  id: int("id").primaryKey(),
  productId: int("product_id").notNull(),
  name: varchar("name", { length: 255 }),
  price: decimal("price", { precision: 10, scale: 2 }),
  packageCode: varchar("package_code", { length: 255 }),
  unit: varchar("unit", { length: 50 }),
  numOfItems: int("num_of_items"),
  trackType: varchar("track_type", { length: 50 }),
  chargeType: varchar("charge_type", { length: 50 }),
  visible: tinyint("visible"),
  trackInventory: tinyint("track_inventory"),
  inventory: int("inventory")
});

export const productImages = mysqlTable("product_images", {
  id: int("id").autoincrement().primaryKey(),
  productId: int("product_id").notNull(),
  url: varchar("url", { length: 2048 }).notNull(),
  urlHash: varchar("url_hash", { length: 64 }).notNull()
});

export const tags = mysqlTable("tags", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).unique()
});

export const productTags = mysqlTable(
  "product_tags",
  {
    productId: int("product_id").notNull(),
    tagId: int("tag_id").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.productId, table.tagId] })
  })
);

export const productSales = mysqlTable(
  "product_sales",
  {
    productId: int("product_id").notNull().primaryKey(),
    onSale: tinyint("on_sale").default(0),
    saleDiscount: decimal("sale_discount", { precision: 5, scale: 2 }),
    updatedAt: datetime("updated_at")
  }
);

export const recipes = mysqlTable("recipes", {
  id: int("id").autoincrement().primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  note: text("note"),
  imageUrl: text("image_url"),
  ingredientsJson: text("ingredients_json"),
  stepsJson: text("steps_json"),
  published: tinyint("published").default(1),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at")
});

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  username: varchar("username", { length: 255 }).notNull().unique(),
  email: varchar("email", { length: 255 }),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: varchar("role", { length: 32 }).default("member"),
  name: varchar("name", { length: 255 }),
  active: tinyint("active").default(1),
  timesheetsUserId: varchar("timesheets_user_id", { length: 64 }),
  timesheetsEmployeeId: varchar("timesheets_employee_id", { length: 64 }),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at")
});

export const adminRoles = mysqlTable("admin_roles", {
  id: int("id").autoincrement().primaryKey(),
  roleKey: varchar("role_key", { length: 64 }).notNull().unique(),
  label: varchar("label", { length: 128 }).notNull(),
  description: text("description"),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at")
});

export const adminUserRoles = mysqlTable(
  "admin_user_roles",
  {
    userId: int("user_id").notNull(),
    roleId: int("role_id").notNull(),
    createdAt: datetime("created_at")
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.roleId] })
  })
);

export const passwordResetTokens = mysqlTable(
  "password_reset_tokens",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    requestedByUserId: int("requested_by_user_id"),
    requestedByAdmin: tinyint("requested_by_admin").default(0),
    usedAt: datetime("used_at"),
    expiresAt: datetime("expires_at").notNull(),
    createdAt: datetime("created_at")
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("ux_password_reset_tokens_hash").on(table.tokenHash),
    userIdx: index("idx_password_reset_tokens_user").on(table.userId),
    expiresIdx: index("idx_password_reset_tokens_expires").on(table.expiresAt)
  })
);

export const reviews = mysqlTable("reviews", {
  id: int("id").autoincrement().primaryKey(),
  productId: int("product_id").notNull(),
  userId: int("user_id"),
  rating: int("rating").notNull(),
  title: varchar("title", { length: 255 }),
  body: text("body"),
  status: varchar("status", { length: 32 }).default("pending"),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at")
});

export const subscribeLeads = mysqlTable(
  "subscribe_leads",
  {
    id: int("id").autoincrement().primaryKey(),
    status: varchar("status", { length: 32 }).default("in_progress"),
    firstName: varchar("first_name", { length: 255 }).notNull(),
    lastName: varchar("last_name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 64 }),
    country: varchar("country", { length: 128 }),
    addressLine1: varchar("address_line_1", { length: 255 }),
    addressLine2: varchar("address_line_2", { length: 255 }),
    city: varchar("city", { length: 255 }),
    stateProvince: varchar("state_province", { length: 255 }),
    postalCode: varchar("postal_code", { length: 32 }),
    geocodedLatitude: decimal("geocoded_latitude", { precision: 10, scale: 7 }),
    geocodedLongitude: decimal("geocoded_longitude", { precision: 10, scale: 7 }),
    geocodedDisplayName: varchar("geocoded_display_name", { length: 1024 }),
    closestDropSite: varchar("closest_drop_site", { length: 255 }),
    closestDropSiteAddress: varchar("closest_drop_site_address", { length: 1024 }),
    closestDropSiteDistanceMiles: decimal("closest_drop_site_distance_miles", {
      precision: 10,
      scale: 2
    }),
    insideHomeDeliveryArea: tinyint("inside_home_delivery_area").default(0),
    addressValidatedAt: datetime("address_validated_at"),
    referralSource: text("referral_source"),
    selectedPlan: varchar("selected_plan", { length: 64 }),
    selectedPlanLabel: varchar("selected_plan_label", { length: 255 }),
    selectedDropSite: varchar("selected_drop_site", { length: 255 }),
    notes: text("notes"),
    adminNotes: text("admin_notes"),
    liabilityAgreementAccepted: tinyint("liability_agreement_accepted").default(0),
    liabilityAgreementSignerName: varchar("liability_agreement_signer_name", { length: 255 }),
    liabilityAgreementDocumentUrl: varchar("liability_agreement_document_url", { length: 2048 }),
    liabilityAgreementRecordUrl: varchar("liability_agreement_record_url", { length: 2048 }),
    liabilityAgreementSignedAt: datetime("liability_agreement_signed_at"),
    memberUserId: int("member_user_id"),
    desiredBillingDayOfMonth: int("desired_billing_day_of_month"),
    activationCompletedAt: datetime("activation_completed_at"),
    sourceHost: varchar("source_host", { length: 255 }),
    sourcePath: varchar("source_path", { length: 255 }),
    utmSource: varchar("utm_source", { length: 255 }),
    utmMedium: varchar("utm_medium", { length: 255 }),
    utmCampaign: varchar("utm_campaign", { length: 255 }),
    utmContent: varchar("utm_content", { length: 255 }),
    utmTerm: varchar("utm_term", { length: 255 }),
    csaTrackToken: varchar("csa_track_token", { length: 64 }),
    csaLinkSlug: varchar("csa_link_slug", { length: 255 }),
    csaCampaignSlug: varchar("csa_campaign_slug", { length: 255 }),
    messageFocus: varchar("message_focus", { length: 32 }),
    targetCity: varchar("target_city", { length: 255 }),
    targetZip: varchar("target_zip", { length: 64 }),
    targetLocationLabel: varchar("target_location_label", { length: 255 }),
    targetDropSiteId: int("target_drop_site_id"),
    rawJson: text("raw_json"),
    submittedAt: datetime("submitted_at"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    emailIdx: index("idx_subscribe_leads_email").on(table.email),
    submittedIdx: index("idx_subscribe_leads_submitted_at").on(table.submittedAt),
    statusIdx: index("idx_subscribe_leads_status").on(table.status)
  })
);

export const subscriptionSettings = mysqlTable("subscription_settings", {
  id: int("id").autoincrement().primaryKey(),
  dividendRatePercent: decimal("dividend_rate_percent", { precision: 6, scale: 3 }).default("3.000"),
  herdshareMonthlyFeeCents: int("herdshare_monthly_fee_cents").default(500),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at")
});

export const memberProfiles = mysqlTable(
  "member_profiles",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").notNull(),
    subscribeLeadId: int("subscribe_lead_id"),
    firstName: varchar("first_name", { length: 255 }).notNull(),
    lastName: varchar("last_name", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 64 }),
    country: varchar("country", { length: 128 }),
    addressLine1: varchar("address_line_1", { length: 255 }),
    addressLine2: varchar("address_line_2", { length: 255 }),
    city: varchar("city", { length: 255 }),
    stateProvince: varchar("state_province", { length: 255 }),
    postalCode: varchar("postal_code", { length: 32 }),
    geocodedLatitude: decimal("geocoded_latitude", { precision: 10, scale: 7 }),
    geocodedLongitude: decimal("geocoded_longitude", { precision: 10, scale: 7 }),
    geocodedDisplayName: varchar("geocoded_display_name", { length: 1024 }),
    preferredDropSite: varchar("preferred_drop_site", { length: 255 }),
    insideHomeDeliveryArea: tinyint("inside_home_delivery_area").default(0),
    closestDropSite: varchar("closest_drop_site", { length: 255 }),
    closestDropSiteAddress: varchar("closest_drop_site_address", { length: 1024 }),
    closestDropSiteDistanceMiles: decimal("closest_drop_site_distance_miles", {
      precision: 10,
      scale: 2
    }),
    referralSource: text("referral_source"),
    notes: text("notes"),
    localLineSetupStatus: varchar("local_line_setup_status", { length: 32 }),
    localLineSetupMode: varchar("local_line_setup_mode", { length: 32 }),
    localLineSetupNote: text("local_line_setup_note"),
    sourceHost: varchar("source_host", { length: 255 }),
    sourcePath: varchar("source_path", { length: 255 }),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    userIdx: uniqueIndex("ux_member_profiles_user").on(table.userId),
    subscribeLeadIdx: index("idx_member_profiles_lead").on(table.subscribeLeadId)
  })
);

export const memberSubscriptions = mysqlTable(
  "member_subscriptions",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").notNull(),
    subscribeLeadId: int("subscribe_lead_id"),
    planKey: varchar("plan_key", { length: 64 }).notNull(),
    planAmountCents: int("plan_amount_cents").notNull(),
    billingDayOfMonth: int("billing_day_of_month").notNull(),
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }),
    status: varchar("status", { length: 32 }).default("pending_payment_method"),
    nextBillingDate: datetime("next_billing_date"),
    currentPeriodStart: datetime("current_period_start"),
    currentPeriodEnd: datetime("current_period_end"),
    pausedAt: datetime("paused_at"),
    canceledAt: datetime("canceled_at"),
    lastDepositAt: datetime("last_deposit_at"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    userIdx: uniqueIndex("ux_member_subscriptions_user").on(table.userId),
    subscribeLeadIdx: index("idx_member_subscriptions_lead").on(table.subscribeLeadId),
    stripeSubscriptionIdx: uniqueIndex("ux_member_subscriptions_stripe").on(table.stripeSubscriptionId)
  })
);

export const memberHerdshareStatuses = mysqlTable(
  "member_herdshare_statuses",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").notNull(),
    monthlyFeeCents: int("monthly_fee_cents").default(500),
    status: varchar("status", { length: 32 }).default("active"),
    nextBillingDate: datetime("next_billing_date"),
    agreementAccepted: tinyint("agreement_accepted").default(0),
    agreementSignerName: varchar("agreement_signer_name", { length: 255 }),
    agreementDocumentUrl: varchar("agreement_document_url", { length: 2048 }),
    agreementRecordUrl: varchar("agreement_record_url", { length: 2048 }),
    signedAt: datetime("signed_at"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    userIdx: uniqueIndex("ux_member_herdshare_user").on(table.userId)
  })
);

export const memberLedgerAccounts = mysqlTable(
  "member_ledger_accounts",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").notNull(),
    accountType: varchar("account_type", { length: 64 }).notNull(),
    currency: varchar("currency", { length: 3 }).default("USD"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    userTypeIdx: uniqueIndex("ux_member_ledger_accounts_user_type").on(table.userId, table.accountType)
  })
);

export const memberLedgerEntries = mysqlTable(
  "member_ledger_entries",
  {
    id: int("id").autoincrement().primaryKey(),
    accountId: int("account_id").notNull(),
    userId: int("user_id").notNull(),
    entryType: varchar("entry_type", { length: 64 }).notNull(),
    amountCents: int("amount_cents").notNull(),
    effectiveDate: datetime("effective_date").notNull(),
    referenceType: varchar("reference_type", { length: 64 }),
    referenceId: varchar("reference_id", { length: 255 }),
    description: text("description"),
    metadataJson: text("metadata_json"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    accountIdx: index("idx_member_ledger_entries_account").on(table.accountId),
    userIdx: index("idx_member_ledger_entries_user").on(table.userId),
    referenceIdx: index("idx_member_ledger_entries_reference").on(table.referenceType, table.referenceId),
    effectiveIdx: index("idx_member_ledger_entries_effective").on(table.effectiveDate)
  })
);

export const memberExternalAccountLinks = mysqlTable(
  "member_external_account_links",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    externalCustomerId: varchar("external_customer_id", { length: 255 }).notNull(),
    externalEmail: varchar("external_email", { length: 255 }),
    metadataJson: text("metadata_json"),
    linkedAt: datetime("linked_at"),
    lastSyncedAt: datetime("last_synced_at"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    userProviderIdx: uniqueIndex("ux_member_external_links_user_provider").on(table.userId, table.provider)
  })
);

export const memberCreditMirrors = mysqlTable(
  "member_credit_mirrors",
  {
    id: int("id").autoincrement().primaryKey(),
    externalLinkId: int("external_link_id").notNull(),
    userId: int("user_id").notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    lastKnownBalanceCents: int("last_known_balance_cents").default(0),
    lastOrderSyncedAt: datetime("last_order_synced_at"),
    lastMirroredAt: datetime("last_mirrored_at"),
    lastLedgerImportAt: datetime("last_ledger_import_at"),
    lastLedgerImportedTransactionId: varchar("last_ledger_imported_transaction_id", { length: 255 }),
    lastLedgerImportedTransactionAt: datetime("last_ledger_imported_transaction_at"),
    lastLedgerImportedBalanceCents: int("last_ledger_imported_balance_cents"),
    ledgerBackfillCompleted: tinyint("ledger_backfill_completed").default(0),
    lastLedgerImportError: text("last_ledger_import_error"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    linkIdx: uniqueIndex("ux_member_credit_mirrors_link").on(table.externalLinkId),
    userProviderIdx: index("idx_member_credit_mirrors_user_provider").on(table.userId, table.provider)
  })
);

export const marketingCampaigns = mysqlTable(
  "marketing_campaigns",
  {
    id: int("id").autoincrement().primaryKey(),
    slug: varchar("slug", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    status: varchar("status", { length: 32 }).default("active"),
    platform: varchar("platform", { length: 64 }),
    channel: varchar("channel", { length: 64 }),
    messageFocus: varchar("message_focus", { length: 32 }),
    targetCity: varchar("target_city", { length: 255 }),
    targetZip: varchar("target_zip", { length: 64 }),
    targetLocationLabel: varchar("target_location_label", { length: 255 }),
    targetDropSiteId: int("target_drop_site_id"),
    destinationType: varchar("destination_type", { length: 64 }),
    destinationUrl: varchar("destination_url", { length: 2048 }),
    budgetAmount: decimal("budget_amount", { precision: 10, scale: 2 }),
    notes: text("notes"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    slugIdx: uniqueIndex("ux_marketing_campaigns_slug").on(table.slug),
    statusIdx: index("idx_marketing_campaigns_status").on(table.status),
    channelIdx: index("idx_marketing_campaigns_channel").on(table.channel)
  })
);

export const marketingContentPosts = mysqlTable(
  "marketing_content_posts",
  {
    id: int("id").autoincrement().primaryKey(),
    campaignId: int("campaign_id"),
    title: varchar("title", { length: 255 }).notNull(),
    platform: varchar("platform", { length: 64 }),
    contentType: varchar("content_type", { length: 64 }),
    status: varchar("status", { length: 32 }).default("draft"),
    messageFocus: varchar("message_focus", { length: 32 }),
    notes: text("notes"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    campaignIdx: index("idx_marketing_content_posts_campaign").on(table.campaignId),
    platformIdx: index("idx_marketing_content_posts_platform").on(table.platform)
  })
);

export const marketingUtmLinks = mysqlTable(
  "marketing_utm_links",
  {
    id: int("id").autoincrement().primaryKey(),
    campaignId: int("campaign_id"),
    contentPostId: int("content_post_id"),
    slug: varchar("slug", { length: 255 }).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    isActive: tinyint("is_active").default(1),
    destinationType: varchar("destination_type", { length: 64 }),
    destinationUrl: varchar("destination_url", { length: 2048 }).notNull(),
    channel: varchar("channel", { length: 64 }),
    usageInstructions: text("usage_instructions"),
    utmSource: varchar("utm_source", { length: 255 }),
    utmMedium: varchar("utm_medium", { length: 255 }),
    utmCampaign: varchar("utm_campaign", { length: 255 }),
    utmContent: varchar("utm_content", { length: 255 }),
    utmTerm: varchar("utm_term", { length: 255 }),
    trackToken: varchar("track_token", { length: 64 }),
    messageFocus: varchar("message_focus", { length: 32 }),
    targetCity: varchar("target_city", { length: 255 }),
    targetZip: varchar("target_zip", { length: 64 }),
    targetLocationLabel: varchar("target_location_label", { length: 255 }),
    targetDropSiteId: int("target_drop_site_id"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    slugIdx: uniqueIndex("ux_marketing_utm_links_slug").on(table.slug),
    campaignIdx: index("idx_marketing_utm_links_campaign").on(table.campaignId),
    activeIdx: index("idx_marketing_utm_links_active").on(table.isActive)
  })
);

export const marketingSessions = mysqlTable(
  "marketing_sessions",
  {
    id: int("id").autoincrement().primaryKey(),
    sessionToken: varchar("session_token", { length: 64 }).notNull(),
    campaignId: int("campaign_id"),
    utmLinkId: int("utm_link_id"),
    sourceHost: varchar("source_host", { length: 255 }),
    sourcePath: varchar("source_path", { length: 255 }),
    landingUrl: varchar("landing_url", { length: 2048 }),
    referrerUrl: varchar("referrer_url", { length: 2048 }),
    utmSource: varchar("utm_source", { length: 255 }),
    utmMedium: varchar("utm_medium", { length: 255 }),
    utmCampaign: varchar("utm_campaign", { length: 255 }),
    utmContent: varchar("utm_content", { length: 255 }),
    utmTerm: varchar("utm_term", { length: 255 }),
    messageFocus: varchar("message_focus", { length: 32 }),
    targetCity: varchar("target_city", { length: 255 }),
    targetZip: varchar("target_zip", { length: 64 }),
    targetLocationLabel: varchar("target_location_label", { length: 255 }),
    targetDropSiteId: int("target_drop_site_id"),
    clientIp: varchar("client_ip", { length: 255 }),
    userAgent: varchar("user_agent", { length: 1024 }),
    firstSeenAt: datetime("first_seen_at"),
    lastSeenAt: datetime("last_seen_at"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    tokenIdx: uniqueIndex("ux_marketing_sessions_token").on(table.sessionToken),
    campaignIdx: index("idx_marketing_sessions_campaign").on(table.campaignId),
    linkIdx: index("idx_marketing_sessions_link").on(table.utmLinkId),
    firstSeenIdx: index("idx_marketing_sessions_first_seen").on(table.firstSeenAt)
  })
);

export const marketingClickEvents = mysqlTable(
  "marketing_click_events",
  {
    id: int("id").autoincrement().primaryKey(),
    sessionId: int("session_id"),
    campaignId: int("campaign_id"),
    utmLinkId: int("utm_link_id"),
    contentPostId: int("content_post_id"),
    eventType: varchar("event_type", { length: 32 }).default("click"),
    pageUrl: varchar("page_url", { length: 2048 }),
    referrerUrl: varchar("referrer_url", { length: 2048 }),
    destinationUrl: varchar("destination_url", { length: 2048 }),
    sourceHost: varchar("source_host", { length: 255 }),
    sourcePath: varchar("source_path", { length: 255 }),
    utmSource: varchar("utm_source", { length: 255 }),
    utmMedium: varchar("utm_medium", { length: 255 }),
    utmCampaign: varchar("utm_campaign", { length: 255 }),
    utmContent: varchar("utm_content", { length: 255 }),
    utmTerm: varchar("utm_term", { length: 255 }),
    messageFocus: varchar("message_focus", { length: 32 }),
    targetCity: varchar("target_city", { length: 255 }),
    targetZip: varchar("target_zip", { length: 64 }),
    targetLocationLabel: varchar("target_location_label", { length: 255 }),
    targetDropSiteId: int("target_drop_site_id"),
    occurredAt: datetime("occurred_at"),
    createdAt: datetime("created_at")
  },
  (table) => ({
    sessionIdx: index("idx_marketing_click_events_session").on(table.sessionId),
    campaignIdx: index("idx_marketing_click_events_campaign").on(table.campaignId),
    linkIdx: index("idx_marketing_click_events_link").on(table.utmLinkId),
    occurredIdx: index("idx_marketing_click_events_occurred").on(table.occurredAt)
  })
);

export const marketingSubscriberEvents = mysqlTable(
  "marketing_subscriber_events",
  {
    id: int("id").autoincrement().primaryKey(),
    subscribeLeadId: int("subscribe_lead_id"),
    campaignId: int("campaign_id"),
    utmLinkId: int("utm_link_id"),
    sessionId: int("session_id"),
    externalSubscriberId: varchar("external_subscriber_id", { length: 255 }),
    matchMethod: varchar("match_method", { length: 64 }),
    email: varchar("email", { length: 255 }),
    firstName: varchar("first_name", { length: 255 }),
    lastName: varchar("last_name", { length: 255 }),
    city: varchar("city", { length: 255 }),
    postalCode: varchar("postal_code", { length: 64 }),
    selectedDropSite: varchar("selected_drop_site", { length: 255 }),
    subscribedAt: datetime("subscribed_at"),
    sourceHost: varchar("source_host", { length: 255 }),
    sourcePath: varchar("source_path", { length: 255 }),
    utmSource: varchar("utm_source", { length: 255 }),
    utmMedium: varchar("utm_medium", { length: 255 }),
    utmCampaign: varchar("utm_campaign", { length: 255 }),
    utmContent: varchar("utm_content", { length: 255 }),
    utmTerm: varchar("utm_term", { length: 255 }),
    csaTrackToken: varchar("csa_track_token", { length: 64 }),
    csaLinkSlug: varchar("csa_link_slug", { length: 255 }),
    csaCampaignSlug: varchar("csa_campaign_slug", { length: 255 }),
    messageFocus: varchar("message_focus", { length: 32 }),
    targetCity: varchar("target_city", { length: 255 }),
    targetZip: varchar("target_zip", { length: 64 }),
    targetLocationLabel: varchar("target_location_label", { length: 255 }),
    targetDropSiteId: int("target_drop_site_id"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    leadIdx: index("idx_marketing_subscriber_events_lead").on(table.subscribeLeadId),
    emailIdx: index("idx_marketing_subscriber_events_email").on(table.email),
    campaignIdx: index("idx_marketing_subscriber_events_campaign").on(table.campaignId),
    subscribedIdx: index("idx_marketing_subscriber_events_subscribed").on(table.subscribedAt)
  })
);

export const marketingAdSpend = mysqlTable(
  "marketing_ad_spend",
  {
    id: int("id").autoincrement().primaryKey(),
    campaignId: int("campaign_id"),
    platform: varchar("platform", { length: 64 }),
    spendDate: datetime("spend_date"),
    spendAmount: decimal("spend_amount", { precision: 10, scale: 2 }),
    impressions: int("impressions"),
    clicks: int("clicks"),
    notes: text("notes"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    campaignIdx: index("idx_marketing_ad_spend_campaign").on(table.campaignId),
    spendDateIdx: index("idx_marketing_ad_spend_date").on(table.spendDate)
  })
);

export const marketingRecommendations = mysqlTable(
  "marketing_recommendations",
  {
    id: int("id").autoincrement().primaryKey(),
    campaignId: int("campaign_id"),
    status: varchar("status", { length: 32 }).default("draft"),
    title: varchar("title", { length: 255 }).notNull(),
    summary: text("summary"),
    rationale: text("rationale"),
    channelRecommendation: varchar("channel_recommendation", { length: 64 }),
    messageFocus: varchar("message_focus", { length: 32 }),
    targetCity: varchar("target_city", { length: 255 }),
    targetZip: varchar("target_zip", { length: 64 }),
    targetLocationLabel: varchar("target_location_label", { length: 255 }),
    targetDropSiteId: int("target_drop_site_id"),
    dataJson: text("data_json"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    campaignIdx: index("idx_marketing_recommendations_campaign").on(table.campaignId),
    statusIdx: index("idx_marketing_recommendations_status").on(table.status)
  })
);

export const dropSites = mysqlTable(
  "drop_sites",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    address: text("address"),
    dayOfWeek: varchar("day_of_week", { length: 16 }),
    openTime: varchar("open_time", { length: 16 }),
    closeTime: varchar("close_time", { length: 16 }),
    active: tinyint("active").default(1),
    source: varchar("source", { length: 32 }).default("local"),
    localLineFulfillmentStrategyId: int("local_line_fulfillment_strategy_id"),
    type: varchar("type", { length: 32 }),
    fulfillmentType: varchar("fulfillment_type", { length: 32 }),
    timezone: varchar("timezone", { length: 64 }),
    latitude: decimal("latitude", { precision: 10, scale: 7 }),
    longitude: decimal("longitude", { precision: 10, scale: 7 }),
    instructions: text("instructions"),
    addressJson: text("address_json"),
    availabilityJson: text("availability_json"),
    priceListsJson: text("price_lists_json"),
    rawJson: text("raw_json"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at"),
    lastSyncedAt: datetime("last_synced_at")
  },
  (table) => ({
    localLineFulfillmentIdx: uniqueIndex("ux_drop_sites_local_line_fulfillment").on(
      table.localLineFulfillmentStrategyId
    )
  })
);

export const localLineOrders = mysqlTable(
  "local_line_orders",
  {
    id: int("id").autoincrement().primaryKey(),
    localLineOrderId: int("local_line_order_id").notNull(),
    status: varchar("status", { length: 64 }),
    priceListId: int("price_list_id"),
    priceListName: varchar("price_list_name", { length: 255 }),
    customerId: int("customer_id"),
    customerName: varchar("customer_name", { length: 255 }),
    createdAtRemote: datetime("created_at_remote"),
    updatedAtRemote: datetime("updated_at_remote"),
    openedAtRemote: datetime("opened_at_remote"),
    fulfillmentStrategyId: int("fulfillment_strategy_id"),
    fulfillmentStrategyName: varchar("fulfillment_strategy_name", { length: 255 }),
    fulfillmentType: varchar("fulfillment_type", { length: 64 }),
    fulfillmentStatus: varchar("fulfillment_status", { length: 64 }),
    fulfillmentDate: datetime("fulfillment_date"),
    pickupStartTime: varchar("pickup_start_time", { length: 32 }),
    pickupEndTime: varchar("pickup_end_time", { length: 32 }),
    paymentStatus: varchar("payment_status", { length: 64 }),
    subtotal: decimal("subtotal", { precision: 10, scale: 2 }),
    tax: decimal("tax", { precision: 10, scale: 2 }),
    total: decimal("total", { precision: 10, scale: 2 }),
    discount: decimal("discount", { precision: 10, scale: 2 }),
    productCount: int("product_count"),
    rawJson: text("raw_json"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at"),
    lastSyncedAt: datetime("last_synced_at")
  },
  (table) => ({
    localLineOrderIdx: uniqueIndex("ux_local_line_orders_remote_id").on(table.localLineOrderId)
  })
);

export const localLineOrderEntries = mysqlTable(
  "local_line_order_entries",
  {
    id: int("id").autoincrement().primaryKey(),
    localLineOrderEntryId: int("local_line_order_entry_id").notNull(),
    localLineOrderId: int("local_line_order_id").notNull(),
    productId: int("product_id"),
    productName: varchar("product_name", { length: 255 }),
    packageName: varchar("package_name", { length: 255 }),
    vendorId: int("vendor_id"),
    vendorName: varchar("vendor_name", { length: 255 }),
    categoryName: varchar("category_name", { length: 255 }),
    unitQuantity: decimal("unit_quantity", { precision: 10, scale: 3 }),
    inventoryQuantity: decimal("inventory_quantity", { precision: 10, scale: 3 }),
    price: decimal("price", { precision: 10, scale: 2 }),
    totalPrice: decimal("total_price", { precision: 10, scale: 2 }),
    pricePerUnit: varchar("price_per_unit", { length: 64 }),
    chargeType: varchar("charge_type", { length: 64 }),
    trackType: varchar("track_type", { length: 64 }),
    packWeight: decimal("pack_weight", { precision: 10, scale: 3 }),
    rawJson: text("raw_json"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at"),
    lastSyncedAt: datetime("last_synced_at")
  },
  (table) => ({
    localLineOrderEntryIdx: uniqueIndex("ux_local_line_order_entries_remote_id").on(
      table.localLineOrderEntryId
    )
  })
);

export const localLineOrderReportingEntries = mysqlTable("local_line_order_reporting_entries", {
  id: int("id").autoincrement().primaryKey(),
  fulfillmentMonth: varchar("fulfillment_month", { length: 7 }),
  fulfillmentDate: varchar("fulfillment_date", { length: 32 }),
  weekStart: varchar("week_start", { length: 10 }),
  localLineOrderId: int("local_line_order_id"),
  customerName: varchar("customer_name", { length: 255 }),
  priceListName: varchar("price_list_name", { length: 255 }),
  orderStatus: varchar("order_status", { length: 64 }),
  paymentStatus: varchar("payment_status", { length: 64 }),
  fulfillmentName: varchar("fulfillment_name", { length: 255 }),
  fulfillmentAddress: varchar("fulfillment_address", { length: 512 }),
  vendorId: int("vendor_id"),
  vendorName: varchar("vendor_name", { length: 255 }),
  categoryName: varchar("category_name", { length: 255 }),
  productId: int("product_id"),
  productName: varchar("product_name", { length: 255 }),
  packageId: varchar("package_id", { length: 64 }),
  packageName: varchar("package_name", { length: 255 }),
  quantity: decimal("quantity", { precision: 10, scale: 3 }),
  retailAmount: decimal("retail_amount", { precision: 10, scale: 2 }),
  purchaseUnitPrice: decimal("purchase_unit_price", { precision: 10, scale: 2 }),
  purchaseTotal: decimal("purchase_total", { precision: 10, scale: 2 }),
  rawJson: text("raw_json"),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at"),
  lastSyncedAt: datetime("last_synced_at")
});

export const localLineOrderReportingMonths = mysqlTable("local_line_order_reporting_months", {
  monthKey: varchar("month_key", { length: 7 }).primaryKey(),
  status: varchar("status", { length: 32 }),
  rowCount: int("row_count"),
  message: text("message"),
  syncedAt: datetime("synced_at"),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at")
});

export const localLineSubscriptionSnapshotRows = mysqlTable(
  "local_line_subscription_snapshot_rows",
  {
    snapshotWeekEnd: varchar("snapshot_week_end", { length: 10 }).notNull(),
    snapshotKey: varchar("snapshot_key", { length: 255 }).notNull(),
    planNumber: varchar("plan_number", { length: 64 }),
    customerName: varchar("customer_name", { length: 255 }),
    email: varchar("email", { length: 255 }),
    status: varchar("status", { length: 64 }),
    nextFulfillmentStatus: varchar("next_fulfillment_status", { length: 64 }),
    total: decimal("total", { precision: 10, scale: 2 }),
    isFeedAFriend: tinyint("is_feed_a_friend").default(0),
    rawJson: text("raw_json"),
    capturedAt: datetime("captured_at"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    pk: primaryKey({ columns: [table.snapshotWeekEnd, table.snapshotKey] })
  })
);

export const localLineSubscriptionSnapshotRuns = mysqlTable(
  "local_line_subscription_snapshot_runs",
  {
    snapshotWeekEnd: varchar("snapshot_week_end", { length: 10 }).primaryKey(),
    rowCount: int("row_count"),
    activeSubscriberCount: int("active_subscriber_count"),
    snapSubscriberCount: int("snap_subscriber_count"),
    projectedMonthlyRevenue: decimal("projected_monthly_revenue", { precision: 10, scale: 2 }),
    skippedSubscriberCount: int("skipped_subscriber_count"),
    feedAFriendSubscriberCount: int("feed_a_friend_subscriber_count"),
    capturedAt: datetime("captured_at"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  }
);

export const localLineSyncCursors = mysqlTable("local_line_sync_cursors", {
  syncKey: varchar("sync_key", { length: 64 }).primaryKey(),
  cursorValue: varchar("cursor_value", { length: 255 }),
  syncedThroughAt: datetime("synced_through_at"),
  lastStartedAt: datetime("last_started_at"),
  lastFinishedAt: datetime("last_finished_at"),
  lastStatus: varchar("last_status", { length: 32 }),
  lastMessage: text("last_message"),
  summaryJson: text("summary_json"),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at")
});

export const priceLists = mysqlTable(
  "price_lists",
  {
    id: int("id").autoincrement().primaryKey(),
    localLinePriceListId: int("local_line_price_list_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    active: tinyint("active").default(1),
    source: varchar("source", { length: 32 }).default("localline"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at"),
    lastSyncedAt: datetime("last_synced_at")
  },
  (table) => ({
    localLinePriceListIdx: uniqueIndex("ux_price_lists_local_line_id").on(table.localLinePriceListId)
  })
);

export const packagePriceListMemberships = mysqlTable(
  "package_price_list_memberships",
  {
    packageId: int("package_id").notNull(),
    priceListId: int("price_list_id").notNull(),
    present: tinyint("present").default(1),
    adjustmentType: tinyint("adjustment_type"),
    adjustmentValue: decimal("adjustment_value", { precision: 10, scale: 2 }),
    calculatedValue: decimal("calculated_value", { precision: 10, scale: 2 }),
    basePriceUsed: decimal("base_price_used", { precision: 10, scale: 2 }),
    finalPriceCache: decimal("final_price_cache", { precision: 10, scale: 2 }),
    onSale: tinyint("on_sale").default(0),
    onSaleToggle: tinyint("on_sale_toggle").default(0),
    strikethroughDisplayValue: decimal("strikethrough_display_value", { precision: 10, scale: 2 }),
    maxUnitsPerOrder: int("max_units_per_order"),
    rawJson: text("raw_json"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at"),
    lastSyncedAt: datetime("last_synced_at")
  },
  (table) => ({
    pk: primaryKey({ columns: [table.packageId, table.priceListId] }),
    priceListIdx: index("idx_package_price_list_memberships_price_list").on(table.priceListId)
  })
);

export const productPriceListMemberships = mysqlTable(
  "product_price_list_memberships",
  {
    productId: int("product_id").notNull(),
    priceListId: int("price_list_id").notNull(),
    packageCount: int("package_count").default(0),
    allPackagesPresent: tinyint("all_packages_present").default(0),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at"),
    lastSyncedAt: datetime("last_synced_at")
  },
  (table) => ({
    pk: primaryKey({ columns: [table.productId, table.priceListId] }),
    priceListIdx: index("idx_product_price_list_memberships_price_list").on(table.priceListId)
  })
);

export const productPricingProfiles = mysqlTable("product_pricing_profiles", {
  productId: int("product_id").primaryKey(),
  unitOfMeasure: varchar("unit_of_measure", { length: 16 }).default("each"),
  sourceUnitPrice: decimal("source_unit_price", { precision: 10, scale: 2 }),
  minWeight: decimal("min_weight", { precision: 10, scale: 3 }),
  maxWeight: decimal("max_weight", { precision: 10, scale: 3 }),
  avgWeightOverride: decimal("avg_weight_override", { precision: 10, scale: 3 }),
  sourceMultiplier: decimal("source_multiplier", { precision: 10, scale: 4 }).default("0.5412"),
  guestMarkup: decimal("guest_markup", { precision: 10, scale: 4 }),
  memberMarkup: decimal("member_markup", { precision: 10, scale: 4 }),
  herdShareMarkup: decimal("herd_share_markup", { precision: 10, scale: 4 }),
  snapMarkup: decimal("snap_markup", { precision: 10, scale: 4 }),
  onSale: tinyint("on_sale").default(0),
  saleDiscount: decimal("sale_discount", { precision: 5, scale: 4 }),
  priceChangedAt: datetime("price_changed_at"),
  remoteSyncStatus: varchar("remote_sync_status", { length: 32 }).default("pending"),
  remoteSyncMessage: text("remote_sync_message"),
  remoteSyncedAt: datetime("remote_synced_at"),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at")
});

export const productMedia = mysqlTable(
  "product_media",
  {
    id: int("id").autoincrement().primaryKey(),
    productId: int("product_id").notNull(),
    source: varchar("source", { length: 32 }).default("localline"),
    sourceMediaId: varchar("source_media_id", { length: 255 }),
    sourceUrl: text("source_url"),
    remoteUrl: text("remote_url"),
    storageKey: varchar("storage_key", { length: 512 }),
    publicUrl: text("public_url"),
    thumbnailUrl: text("thumbnail_url"),
    sortOrder: int("sort_order").default(0),
    isPrimary: tinyint("is_primary").default(0),
    altText: varchar("alt_text", { length: 512 }),
    contentHash: varchar("content_hash", { length: 128 }),
    width: int("width"),
    height: int("height"),
    mimeType: varchar("mime_type", { length: 128 }),
    fetchedAt: datetime("fetched_at"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at"),
    lastSyncedAt: datetime("last_synced_at")
  },
  (table) => ({
    productIdx: index("idx_product_media_product").on(table.productId),
    sourceMediaIdx: index("idx_product_media_source_media").on(table.source, table.sourceMediaId)
  })
);

export const localLineProductMeta = mysqlTable(
  "local_line_product_meta",
  {
    productId: int("product_id").primaryKey(),
    localLineProductId: int("local_line_product_id").notNull(),
    internalId: varchar("internal_id", { length: 255 }),
    vendorName: varchar("vendor_name", { length: 255 }),
    status: varchar("status", { length: 64 }),
    visible: tinyint("visible"),
    trackInventory: tinyint("track_inventory"),
    trackInventoryBy: varchar("track_inventory_by", { length: 64 }),
    inventoryType: varchar("inventory_type", { length: 64 }),
    productInventory: int("product_inventory"),
    reservedInventory: int("reserved_inventory"),
    availableInventory: int("available_inventory"),
    packageCodesEnabled: tinyint("package_codes_enabled"),
    ownershipType: varchar("ownership_type", { length: 64 }),
    packingTag: varchar("packing_tag", { length: 255 }),
    exportHash: varchar("export_hash", { length: 64 }),
    liveHash: varchar("live_hash", { length: 64 }),
    lastLiveFetchStatus: int("last_live_fetch_status"),
    lastLiveFetchError: text("last_live_fetch_error"),
    rawJson: text("raw_json"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at"),
    lastSyncedAt: datetime("last_synced_at")
  },
  (table) => ({
    localLineIdIdx: index("idx_local_line_product_meta_local_line_id").on(table.localLineProductId)
  })
);

export const localLinePackageMeta = mysqlTable(
  "local_line_package_meta",
  {
    packageId: int("package_id").primaryKey(),
    productId: int("product_id").notNull(),
    localLinePackageId: int("local_line_package_id").notNull(),
    liveName: varchar("live_name", { length: 255 }),
    livePrice: decimal("live_price", { precision: 10, scale: 2 }),
    liveVisible: tinyint("live_visible"),
    liveTrackInventory: tinyint("live_track_inventory"),
    inventoryType: varchar("inventory_type", { length: 64 }),
    packageInventory: int("package_inventory"),
    packageReservedInventory: int("package_reserved_inventory"),
    packageAvailableInventory: int("package_available_inventory"),
    avgPackageWeight: decimal("avg_package_weight", { precision: 10, scale: 3 }),
    numOfItems: int("num_of_items"),
    packageCode: varchar("package_code", { length: 255 }),
    rawJson: text("raw_json"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at"),
    lastSyncedAt: datetime("last_synced_at")
  },
  (table) => ({
    productIdx: index("idx_local_line_package_meta_product").on(table.productId),
    localLineIdIdx: index("idx_local_line_package_meta_local_line_id").on(table.localLinePackageId)
  })
);

export const localLinePriceListEntries = mysqlTable(
  "local_line_price_list_entries",
  {
    id: int("id").autoincrement().primaryKey(),
    productId: int("product_id").notNull(),
    localLineProductId: int("local_line_product_id"),
    packageId: int("package_id"),
    localLinePackageId: int("local_line_package_id"),
    priceListId: int("price_list_id").notNull(),
    localLinePriceListId: int("local_line_price_list_id").notNull(),
    entryScope: varchar("entry_scope", { length: 16 }).notNull(),
    sourceEntryId: varchar("source_entry_id", { length: 255 }),
    priceListName: varchar("price_list_name", { length: 255 }),
    productName: varchar("product_name", { length: 255 }),
    packageName: varchar("package_name", { length: 255 }),
    visible: tinyint("visible"),
    trackInventory: tinyint("track_inventory"),
    packageCode: varchar("package_code", { length: 255 }),
    adjustmentType: tinyint("adjustment_type"),
    adjustmentValue: decimal("adjustment_value", { precision: 10, scale: 2 }),
    calculatedValue: decimal("calculated_value", { precision: 10, scale: 2 }),
    basePriceUsed: decimal("base_price_used", { precision: 10, scale: 2 }),
    finalPriceCache: decimal("final_price_cache", { precision: 10, scale: 2 }),
    onSale: tinyint("on_sale").default(0),
    onSaleToggle: tinyint("on_sale_toggle").default(0),
    strikethroughDisplayValue: decimal("strikethrough_display_value", { precision: 10, scale: 2 }),
    maxUnitsPerOrder: int("max_units_per_order"),
    rawJson: text("raw_json"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at"),
    lastSyncedAt: datetime("last_synced_at")
  },
  (table) => ({
    productIdx: index("idx_local_line_price_list_entries_product").on(table.productId),
    packageIdx: index("idx_local_line_price_list_entries_package").on(table.packageId),
    priceListIdx: index("idx_local_line_price_list_entries_price_list").on(table.priceListId)
  })
);

export const localLineSyncRuns = mysqlTable("local_line_sync_runs", {
  id: int("id").autoincrement().primaryKey(),
  mode: varchar("mode", { length: 32 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  startedAt: datetime("started_at").notNull(),
  finishedAt: datetime("finished_at"),
  summaryJson: text("summary_json"),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at")
});

export const localLineSyncIssues = mysqlTable(
  "local_line_sync_issues",
  {
    id: int("id").autoincrement().primaryKey(),
    syncRunId: int("sync_run_id").notNull(),
    severity: varchar("severity", { length: 16 }).notNull(),
    issueType: varchar("issue_type", { length: 64 }).notNull(),
    productId: int("product_id"),
    packageId: int("package_id"),
    priceListId: int("price_list_id"),
    detailsJson: text("details_json"),
    resolvedAt: datetime("resolved_at"),
    createdAt: datetime("created_at"),
    updatedAt: datetime("updated_at")
  },
  (table) => ({
    syncRunIdx: index("idx_local_line_sync_issues_run").on(table.syncRunId),
    productIdx: index("idx_local_line_sync_issues_product").on(table.productId),
    packageIdx: index("idx_local_line_sync_issues_package").on(table.packageId),
    priceListIdx: index("idx_local_line_sync_issues_price_list").on(table.priceListId)
  })
);
