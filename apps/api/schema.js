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
