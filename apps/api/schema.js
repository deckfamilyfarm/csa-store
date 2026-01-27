import {
  mysqlTable,
  int,
  varchar,
  text,
  datetime,
  decimal,
  tinyint,
  primaryKey
} from "drizzle-orm/mysql-core";

export const vendors = mysqlTable("vendors", {
  id: int("id").primaryKey(),
  name: varchar("name", { length: 255 })
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

export const admins = mysqlTable("admins", {
  id: int("id").autoincrement().primaryKey(),
  username: varchar("username", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  createdAt: datetime("created_at")
});

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: varchar("role", { length: 32 }).default("member"),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at")
});

export const reviews = mysqlTable("reviews", {
  id: int("id").autoincrement().primaryKey(),
  productId: int("product_id").notNull(),
  rating: int("rating").notNull(),
  title: varchar("title", { length: 255 }),
  body: text("body"),
  status: varchar("status", { length: 32 }).default("pending"),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at")
});

export const dropSites = mysqlTable("drop_sites", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  address: text("address"),
  dayOfWeek: varchar("day_of_week", { length: 16 }),
  openTime: varchar("open_time", { length: 16 }),
  closeTime: varchar("close_time", { length: 16 }),
  active: tinyint("active").default(1),
  createdAt: datetime("created_at"),
  updatedAt: datetime("updated_at")
});
