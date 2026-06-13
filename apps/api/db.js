import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { relations } from "drizzle-orm";
import * as schema from "./schema.js";
import { ADMIN_ROLE_DEFINITIONS } from "./lib/adminRoles.js";

let db;
let pool;
let localLineSchemaPromise;
let adminAccessSchemaPromise;
let adminPricelistIndexesPromise;
let vendorPricingSchemaPromise;
let productPricingSchemaPromise;
let subscriberCaptureSchemaPromise;
let siteContentSchemaPromise;
let marketingSchemaPromise;
let subscriptionPortalSchemaPromise;
let liabilityReleaseSchemaPromise;

const SOURCE_PRICING_VENDOR_FACTOR_DEFAULT = 0.5412;

const VENDOR_PRICING_COLUMN_STATEMENTS = [
  {
    tableName: "vendors",
    columnName: "price_list_markup",
    definition: "price_list_markup DECIMAL(10, 4)"
  },
  {
    tableName: "vendors",
    columnName: "source_multiplier",
    definition: "source_multiplier DECIMAL(10, 4)"
  }
];

const PRODUCT_PRICING_COLUMN_STATEMENTS = [
  {
    tableName: "product_pricing_profiles",
    columnName: "price_changed_at",
    definition: "price_changed_at DATETIME"
  }
];

const SUBSCRIBER_CAPTURE_TABLE_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS subscribe_leads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      status VARCHAR(32) NOT NULL DEFAULT 'in_progress',
      first_name VARCHAR(255) NOT NULL,
      last_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(64),
      country VARCHAR(128),
      address_line_1 VARCHAR(255),
      address_line_2 VARCHAR(255),
      city VARCHAR(255),
      state_province VARCHAR(255),
      postal_code VARCHAR(32),
      geocoded_latitude DECIMAL(10, 7),
      geocoded_longitude DECIMAL(10, 7),
      geocoded_display_name VARCHAR(1024),
      closest_drop_site VARCHAR(255),
      closest_drop_site_address VARCHAR(1024),
      closest_drop_site_distance_miles DECIMAL(10, 2),
      inside_home_delivery_area TINYINT(1) DEFAULT 0,
      address_validated_at DATETIME,
      referral_source TEXT,
      selected_plan VARCHAR(64),
      selected_plan_label VARCHAR(255),
      selected_drop_site VARCHAR(255),
      has_current_snap_ebt_card TINYINT(1) DEFAULT 0,
      is_farm_employee TINYINT(1) DEFAULT 0,
      notes TEXT,
      admin_notes TEXT,
      liability_agreement_accepted TINYINT(1) DEFAULT 0,
      liability_agreement_signer_name VARCHAR(255),
      liability_agreement_document_url VARCHAR(2048),
      liability_agreement_record_url VARCHAR(2048),
      liability_agreement_signed_at DATETIME,
      source_host VARCHAR(255),
      source_path VARCHAR(255),
      utm_source VARCHAR(255),
      utm_medium VARCHAR(255),
      utm_campaign VARCHAR(255),
      utm_content VARCHAR(255),
      utm_term VARCHAR(255),
      csa_track_token VARCHAR(64),
      csa_link_slug VARCHAR(255),
      csa_campaign_slug VARCHAR(255),
      message_focus VARCHAR(32),
      target_city VARCHAR(255),
      target_zip VARCHAR(64),
      target_location_label VARCHAR(255),
      target_drop_site_id INT,
      raw_json TEXT,
      submitted_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME
    )
  `
];

const SUBSCRIBER_CAPTURE_INDEX_STATEMENTS = [
  {
    tableName: "subscribe_leads",
    indexName: "idx_subscribe_leads_email",
    columns: "email"
  },
  {
    tableName: "subscribe_leads",
    indexName: "idx_subscribe_leads_submitted_at",
    columns: "submitted_at"
  },
  {
    tableName: "subscribe_leads",
    indexName: "idx_subscribe_leads_status",
    columns: "status"
  }
];

const SUBSCRIBER_CAPTURE_COLUMN_STATEMENTS = [
  {
    tableName: "subscribe_leads",
    columnName: "member_user_id",
    definition: "member_user_id INT"
  },
  {
    tableName: "subscribe_leads",
    columnName: "desired_billing_day_of_month",
    definition: "desired_billing_day_of_month INT"
  },
  {
    tableName: "subscribe_leads",
    columnName: "activation_completed_at",
    definition: "activation_completed_at DATETIME"
  },
  {
    tableName: "subscribe_leads",
    columnName: "admin_notes",
    definition: "admin_notes TEXT"
  },
  {
    tableName: "subscribe_leads",
    columnName: "has_current_snap_ebt_card",
    definition: "has_current_snap_ebt_card TINYINT(1) DEFAULT 0"
  },
  {
    tableName: "subscribe_leads",
    columnName: "is_farm_employee",
    definition: "is_farm_employee TINYINT(1) DEFAULT 0"
  },
  {
    tableName: "subscribe_leads",
    columnName: "liability_agreement_accepted",
    definition: "liability_agreement_accepted TINYINT(1) DEFAULT 0"
  },
  {
    tableName: "subscribe_leads",
    columnName: "liability_agreement_signer_name",
    definition: "liability_agreement_signer_name VARCHAR(255)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "liability_agreement_document_url",
    definition: "liability_agreement_document_url VARCHAR(2048)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "liability_agreement_record_url",
    definition: "liability_agreement_record_url VARCHAR(2048)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "liability_agreement_signed_at",
    definition: "liability_agreement_signed_at DATETIME"
  },
  {
    tableName: "subscribe_leads",
    columnName: "geocoded_latitude",
    definition: "geocoded_latitude DECIMAL(10, 7)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "geocoded_longitude",
    definition: "geocoded_longitude DECIMAL(10, 7)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "geocoded_display_name",
    definition: "geocoded_display_name VARCHAR(1024)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "closest_drop_site",
    definition: "closest_drop_site VARCHAR(255)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "closest_drop_site_address",
    definition: "closest_drop_site_address VARCHAR(1024)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "closest_drop_site_distance_miles",
    definition: "closest_drop_site_distance_miles DECIMAL(10, 2)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "inside_home_delivery_area",
    definition: "inside_home_delivery_area TINYINT(1) DEFAULT 0"
  },
  {
    tableName: "subscribe_leads",
    columnName: "address_validated_at",
    definition: "address_validated_at DATETIME"
  },
  {
    tableName: "subscribe_leads",
    columnName: "csa_track_token",
    definition: "csa_track_token VARCHAR(64)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "csa_link_slug",
    definition: "csa_link_slug VARCHAR(255)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "csa_campaign_slug",
    definition: "csa_campaign_slug VARCHAR(255)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "message_focus",
    definition: "message_focus VARCHAR(32)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "target_city",
    definition: "target_city VARCHAR(255)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "target_zip",
    definition: "target_zip VARCHAR(64)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "target_location_label",
    definition: "target_location_label VARCHAR(255)"
  },
  {
    tableName: "subscribe_leads",
    columnName: "target_drop_site_id",
    definition: "target_drop_site_id INT"
  }
];

const SITE_CONTENT_TABLE_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS site_content_blocks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      page VARCHAR(64) NOT NULL,
      section VARCHAR(128) NOT NULL,
      field VARCHAR(128) NOT NULL,
      label VARCHAR(255),
      value TEXT,
      input_type VARCHAR(32) DEFAULT 'textarea',
      sort_order INT DEFAULT 0,
      updated_by_user_id INT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `
];

const SITE_CONTENT_INDEX_STATEMENTS = [
  {
    tableName: "site_content_blocks",
    indexName: "ux_site_content_key",
    columns: "page, section, field",
    unique: true
  },
  {
    tableName: "site_content_blocks",
    indexName: "idx_site_content_page",
    columns: "page"
  }
];

const SITE_CONTENT_BLOCK_DEFAULTS = [
  {
    page: "home",
    section: "hero",
    field: "draftLabel",
    label: "Draft banner",
    value: "DRAFT STORE",
    inputType: "text",
    sortOrder: 10
  },
  {
    page: "home",
    section: "hero",
    field: "eyebrow",
    label: "Hero eyebrow",
    value: "Deck Family Farm",
    inputType: "text",
    sortOrder: 20
  },
  {
    page: "home",
    section: "hero",
    field: "title",
    label: "Hero title",
    value: "Full Farm Direct",
    inputType: "text",
    sortOrder: 30
  },
  {
    page: "home",
    section: "hero",
    field: "body",
    label: "Hero body",
    value:
      "Shop pasture-raised meat, raw dairy, seasonal produce, pantry staples, and partner-farm foods in one weekly catalog.",
    inputType: "textarea",
    sortOrder: 40
  },
  {
    page: "home",
    section: "hero",
    field: "primaryButton",
    label: "Primary button",
    value: "Shop the catalog",
    inputType: "text",
    sortOrder: 50
  },
  {
    page: "home",
    section: "hero",
    field: "secondaryButton",
    label: "Secondary button",
    value: "Build a box",
    inputType: "text",
    sortOrder: 60
  },
  {
    page: "home",
    section: "shop",
    field: "eyebrow",
    label: "Shop eyebrow",
    value: "Live catalog",
    inputType: "text",
    sortOrder: 110
  },
  {
    page: "home",
    section: "shop",
    field: "title",
    label: "Shop title",
    value: "Shop by how you cook.",
    inputType: "text",
    sortOrder: 120
  },
  {
    page: "home",
    section: "shop",
    field: "body",
    label: "Shop body",
    value:
      "Start with a box, choose a store category, or scan the week's staples from local farms and producers.",
    inputType: "textarea",
    sortOrder: 130
  },
  {
    page: "home",
    section: "boxes",
    field: "eyebrow",
    label: "Boxes eyebrow",
    value: "Box design",
    inputType: "text",
    sortOrder: 210
  },
  {
    page: "home",
    section: "boxes",
    field: "title",
    label: "Boxes title",
    value: "Build a week around one box.",
    inputType: "text",
    sortOrder: 220
  },
  {
    page: "home",
    section: "boxes",
    field: "body",
    label: "Boxes body",
    value:
      "A simple shopping path for members who want meals planned from farm staples without sorting the entire catalog.",
    inputType: "textarea",
    sortOrder: 230
  },
  {
    page: "home",
    section: "sides",
    field: "eyebrow",
    label: "Sides eyebrow",
    value: "Sides and deposits",
    inputType: "text",
    sortOrder: 310
  },
  {
    page: "home",
    section: "sides",
    field: "title",
    label: "Sides title",
    value: "Fill your freezer from one animal.",
    inputType: "text",
    sortOrder: 320
  },
  {
    page: "home",
    section: "sides",
    field: "body",
    label: "Sides body",
    value:
      "Sides are for customers who want value, a deeper connection to the farm, and a freezer full of meat from a single animal. These purchases are about participating in the farm, using more of the animal, and planning meals over months rather than a single week.",
    inputType: "textarea",
    sortOrder: 330
  },
  {
    page: "home",
    section: "sides",
    field: "body2",
    label: "Sides second paragraph",
    value:
      "Raised and slaughtered on site, sides and deposits fit households that want to stock up directly and eat with a clearer sense of where their food came from.",
    inputType: "textarea",
    sortOrder: 340
  },
  {
    page: "home",
    section: "pickup",
    field: "eyebrow",
    label: "Pickup eyebrow",
    value: "Pickup and delivery",
    inputType: "text",
    sortOrder: 410
  },
  {
    page: "home",
    section: "pickup",
    field: "title",
    label: "Pickup title",
    value: "Choose the rhythm that fits your household.",
    inputType: "text",
    sortOrder: 420
  },
  {
    page: "home",
    section: "pickup",
    field: "body",
    label: "Pickup body",
    value:
      "Members can order around their schedule, use pickup sites, and keep monthly food credit rolling forward for future shopping.",
    inputType: "textarea",
    sortOrder: 430
  },
  {
    page: "home",
    section: "pickup",
    field: "button",
    label: "Pickup button",
    value: "Become a member",
    inputType: "text",
    sortOrder: 440
  },
  {
    page: "dropsites",
    section: "hero",
    field: "eyebrow",
    label: "Hero eyebrow",
    value: "Full Farm Drop Sites",
    inputType: "text",
    sortOrder: 510
  },
  {
    page: "dropsites",
    section: "hero",
    field: "title",
    label: "Hero title",
    value: "Nourish your neighborhood.",
    inputType: "text",
    sortOrder: 520
  },
  {
    page: "dropsites",
    section: "hero",
    field: "body",
    label: "Hero body",
    value:
      "Drop site hosts make farm-fresh, locally grown food accessible to more people while supporting regenerative agriculture right in your backyard. By offering a simple pickup spot and helping spread the word, you become an essential link in building a healthier, more sustainable food system. The more local hosts we have, the more affordable and accessible that food becomes for everyone.",
    inputType: "textarea",
    sortOrder: 530
  },
  {
    page: "dropsites",
    section: "resources",
    field: "title",
    label: "Resources title",
    value: "Host Resources and Responsibilities",
    inputType: "text",
    sortOrder: 610
  },
  {
    page: "dropsites",
    section: "resources",
    field: "body",
    label: "Resources body",
    value:
      "Use these materials to manage your site, handle pickup-day communication, and share Full Farm resources with your community.",
    inputType: "textarea",
    sortOrder: 620
  },
  {
    page: "dropsites",
    section: "metrics",
    field: "hostCreditInfo",
    label: "Host credit info bubble",
    value:
      "Host credit is the food credit hosts receive for hosting a drop site. A site qualifies by averaging 3 or more orders per active drop week OR more than 5 unique customers in the month. We count guest and member orders per drop site.",
    inputType: "textarea",
    sortOrder: 710
  },
  {
    page: "dropsites",
    section: "apply",
    field: "title",
    label: "Application title",
    value: "Become a Drop Site Host",
    inputType: "text",
    sortOrder: 810
  },
  {
    page: "dropsites",
    section: "apply",
    field: "introTitle",
    label: "Application intro title",
    value: "Tell Us About Your Pickup Location",
    inputType: "text",
    sortOrder: 820
  },
  {
    page: "dropsites",
    section: "apply",
    field: "introBody",
    label: "Application intro body",
    value:
      "Drop sites help connect local families with food from local farms. Use this form to tell us about your location. Our farm team will review access, parking, storage options, and delivery logistics.",
    inputType: "textarea",
    sortOrder: 830
  },
  {
    page: "dropsites",
    section: "apply",
    field: "whyTitle",
    label: "Why host title",
    value: "Why Become a Drop Site Host?",
    inputType: "text",
    sortOrder: 840
  },
  {
    page: "dropsites",
    section: "apply",
    field: "closingBody",
    label: "Application closing body",
    value:
      "Hosting a drop site is a simple way to support local farms, connect your community with good food, and help grow a stronger regional food network.",
    inputType: "textarea",
    sortOrder: 850
  },
  {
    page: "subscribe",
    section: "hero",
    field: "eyebrow",
    label: "Hero eyebrow",
    value: "Deck Family Farm",
    inputType: "text",
    sortOrder: 910
  },
  {
    page: "subscribe",
    section: "hero",
    field: "title",
    label: "Hero title",
    value: "Welcome to Full Farm",
    inputType: "text",
    sortOrder: 920
  },
  {
    page: "subscribe",
    section: "hero",
    field: "welcomeLine",
    label: "Welcome line",
    value: "We are happy you're here.",
    inputType: "text",
    sortOrder: 930
  },
  {
    page: "subscribe",
    section: "hero",
    field: "body",
    label: "Hero body",
    value:
      "Full Farm provides essential staples from Deck Family Farm and other hyper-local farms with shared growing standards. Members can shop online for pickup at local farmers markets, drop sites, and home delivery. Membership involves a scheduled monthly payment: 100% of your monthly payment is store credit, with no hidden fees. Any unused balance rolls over for future shopping!",
    inputType: "textarea",
    sortOrder: 940
  },
  {
    page: "subscribe",
    section: "hero",
    field: "feeBody",
    label: "Membership fee body",
    value:
      "We charge a one-time membership fee of $50 which includes Herdshare Agreement and access to raw dairy products.",
    inputType: "textarea",
    sortOrder: 950
  },
  {
    page: "subscribe",
    section: "form",
    field: "introBody",
    label: "Form intro body",
    value: "First, give us your name, email, phone number, address, and preferred plan.",
    inputType: "textarea",
    sortOrder: 1010
  }
];

const MARKETING_TABLE_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS marketing_campaigns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      status VARCHAR(32) DEFAULT 'active',
      platform VARCHAR(64),
      channel VARCHAR(64),
      message_focus VARCHAR(32),
      target_city VARCHAR(255),
      target_zip VARCHAR(64),
      target_location_label VARCHAR(255),
      target_drop_site_id INT,
      destination_type VARCHAR(64),
      destination_url VARCHAR(2048),
      budget_amount DECIMAL(10, 2),
      notes TEXT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS marketing_content_posts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      campaign_id INT,
      title VARCHAR(255) NOT NULL,
      platform VARCHAR(64),
      content_type VARCHAR(64),
      status VARCHAR(32) DEFAULT 'draft',
      message_focus VARCHAR(32),
      notes TEXT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS marketing_utm_links (
      id INT AUTO_INCREMENT PRIMARY KEY,
      campaign_id INT,
      content_post_id INT,
      slug VARCHAR(255) NOT NULL,
      label VARCHAR(255) NOT NULL,
      is_active TINYINT(1) DEFAULT 1,
      destination_type VARCHAR(64),
      destination_url VARCHAR(2048) NOT NULL,
      channel VARCHAR(64),
      usage_instructions TEXT,
      utm_source VARCHAR(255),
      utm_medium VARCHAR(255),
      utm_campaign VARCHAR(255),
      utm_content VARCHAR(255),
      utm_term VARCHAR(255),
      track_token VARCHAR(64),
      message_focus VARCHAR(32),
      target_city VARCHAR(255),
      target_zip VARCHAR(64),
      target_location_label VARCHAR(255),
      target_drop_site_id INT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS marketing_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_token VARCHAR(64) NOT NULL,
      campaign_id INT,
      utm_link_id INT,
      source_host VARCHAR(255),
      source_path VARCHAR(255),
      landing_url VARCHAR(2048),
      referrer_url VARCHAR(2048),
      utm_source VARCHAR(255),
      utm_medium VARCHAR(255),
      utm_campaign VARCHAR(255),
      utm_content VARCHAR(255),
      utm_term VARCHAR(255),
      message_focus VARCHAR(32),
      target_city VARCHAR(255),
      target_zip VARCHAR(64),
      target_location_label VARCHAR(255),
      target_drop_site_id INT,
      client_ip VARCHAR(255),
      user_agent VARCHAR(1024),
      first_seen_at DATETIME,
      last_seen_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS marketing_click_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_id INT,
      campaign_id INT,
      utm_link_id INT,
      content_post_id INT,
      event_type VARCHAR(32) DEFAULT 'click',
      page_url VARCHAR(2048),
      referrer_url VARCHAR(2048),
      destination_url VARCHAR(2048),
      source_host VARCHAR(255),
      source_path VARCHAR(255),
      utm_source VARCHAR(255),
      utm_medium VARCHAR(255),
      utm_campaign VARCHAR(255),
      utm_content VARCHAR(255),
      utm_term VARCHAR(255),
      message_focus VARCHAR(32),
      target_city VARCHAR(255),
      target_zip VARCHAR(64),
      target_location_label VARCHAR(255),
      target_drop_site_id INT,
      occurred_at DATETIME,
      created_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS marketing_subscriber_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      subscribe_lead_id INT,
      campaign_id INT,
      utm_link_id INT,
      session_id INT,
      external_subscriber_id VARCHAR(255),
      match_method VARCHAR(64),
      email VARCHAR(255),
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      city VARCHAR(255),
      postal_code VARCHAR(64),
      selected_drop_site VARCHAR(255),
      subscribed_at DATETIME,
      source_host VARCHAR(255),
      source_path VARCHAR(255),
      utm_source VARCHAR(255),
      utm_medium VARCHAR(255),
      utm_campaign VARCHAR(255),
      utm_content VARCHAR(255),
      utm_term VARCHAR(255),
      csa_track_token VARCHAR(64),
      csa_link_slug VARCHAR(255),
      csa_campaign_slug VARCHAR(255),
      message_focus VARCHAR(32),
      target_city VARCHAR(255),
      target_zip VARCHAR(64),
      target_location_label VARCHAR(255),
      target_drop_site_id INT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS marketing_ad_spend (
      id INT AUTO_INCREMENT PRIMARY KEY,
      campaign_id INT,
      platform VARCHAR(64),
      spend_date DATETIME,
      spend_amount DECIMAL(10, 2),
      impressions INT,
      clicks INT,
      notes TEXT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS marketing_recommendations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      campaign_id INT,
      status VARCHAR(32) DEFAULT 'draft',
      title VARCHAR(255) NOT NULL,
      summary TEXT,
      rationale TEXT,
      channel_recommendation VARCHAR(64),
      message_focus VARCHAR(32),
      target_city VARCHAR(255),
      target_zip VARCHAR(64),
      target_location_label VARCHAR(255),
      target_drop_site_id INT,
      data_json TEXT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `
];

const SUBSCRIPTION_PORTAL_TABLE_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS subscription_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      dividend_rate_percent DECIMAL(6, 3) DEFAULT 3.000,
      herdshare_monthly_fee_cents INT DEFAULT 500,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS member_profiles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      subscribe_lead_id INT,
      first_name VARCHAR(255) NOT NULL,
      last_name VARCHAR(255) NOT NULL,
      phone VARCHAR(64),
      country VARCHAR(128),
      address_line_1 VARCHAR(255),
      address_line_2 VARCHAR(255),
      city VARCHAR(255),
      state_province VARCHAR(255),
      postal_code VARCHAR(32),
      geocoded_latitude DECIMAL(10, 7),
      geocoded_longitude DECIMAL(10, 7),
      geocoded_display_name VARCHAR(1024),
      preferred_drop_site VARCHAR(255),
      inside_home_delivery_area TINYINT(1) DEFAULT 0,
      closest_drop_site VARCHAR(255),
      closest_drop_site_address VARCHAR(1024),
      closest_drop_site_distance_miles DECIMAL(10, 2),
      referral_source TEXT,
      notes TEXT,
      local_line_setup_status VARCHAR(32),
      local_line_setup_mode VARCHAR(32),
      local_line_setup_note TEXT,
      source_host VARCHAR(255),
      source_path VARCHAR(255),
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS member_subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      subscribe_lead_id INT,
      plan_key VARCHAR(64) NOT NULL,
      plan_amount_cents INT NOT NULL,
      billing_day_of_month INT NOT NULL,
      stripe_customer_id VARCHAR(255),
      stripe_subscription_id VARCHAR(255),
      status VARCHAR(32) DEFAULT 'pending_payment_method',
      next_billing_date DATETIME,
      current_period_start DATETIME,
      current_period_end DATETIME,
      paused_at DATETIME,
      canceled_at DATETIME,
      last_deposit_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS member_herdshare_statuses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      monthly_fee_cents INT DEFAULT 500,
      status VARCHAR(32) DEFAULT 'active',
      next_billing_date DATETIME,
      agreement_accepted TINYINT(1) DEFAULT 0,
      agreement_signer_name VARCHAR(255),
      agreement_document_url VARCHAR(2048),
      agreement_record_url VARCHAR(2048),
      signed_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS member_ledger_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      account_type VARCHAR(64) NOT NULL,
      currency VARCHAR(3) DEFAULT 'USD',
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS member_ledger_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id INT NOT NULL,
      user_id INT NOT NULL,
      entry_type VARCHAR(64) NOT NULL,
      amount_cents INT NOT NULL,
      effective_date DATETIME NOT NULL,
      reference_type VARCHAR(64),
      reference_id VARCHAR(255),
      description TEXT,
      metadata_json TEXT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS member_external_account_links (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      provider VARCHAR(64) NOT NULL,
      external_customer_id VARCHAR(255) NOT NULL,
      external_email VARCHAR(255),
      metadata_json TEXT,
      linked_at DATETIME,
      last_synced_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS member_credit_mirrors (
      id INT AUTO_INCREMENT PRIMARY KEY,
      external_link_id INT NOT NULL,
      user_id INT NOT NULL,
      provider VARCHAR(64) NOT NULL,
      last_known_balance_cents INT DEFAULT 0,
      last_order_synced_at DATETIME,
      last_mirrored_at DATETIME,
      last_ledger_import_at DATETIME,
      last_ledger_imported_transaction_id VARCHAR(255),
      last_ledger_imported_transaction_at DATETIME,
      last_ledger_imported_balance_cents INT,
      ledger_backfill_completed TINYINT DEFAULT 0,
      last_ledger_import_error TEXT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `
];

const SUBSCRIPTION_PORTAL_INDEX_STATEMENTS = [
  {
    tableName: "member_profiles",
    indexName: "ux_member_profiles_user",
    columns: "user_id",
    unique: true
  },
  {
    tableName: "member_profiles",
    indexName: "idx_member_profiles_lead",
    columns: "subscribe_lead_id"
  },
  {
    tableName: "member_subscriptions",
    indexName: "ux_member_subscriptions_user",
    columns: "user_id",
    unique: true
  },
  {
    tableName: "member_subscriptions",
    indexName: "ux_member_subscriptions_stripe",
    columns: "stripe_subscription_id",
    unique: true
  },
  {
    tableName: "member_herdshare_statuses",
    indexName: "ux_member_herdshare_user",
    columns: "user_id",
    unique: true
  },
  {
    tableName: "member_ledger_accounts",
    indexName: "ux_member_ledger_accounts_user_type",
    columns: "user_id, account_type",
    unique: true
  },
  {
    tableName: "member_ledger_entries",
    indexName: "idx_member_ledger_entries_account",
    columns: "account_id"
  },
  {
    tableName: "member_ledger_entries",
    indexName: "idx_member_ledger_entries_user",
    columns: "user_id"
  },
  {
    tableName: "member_ledger_entries",
    indexName: "idx_member_ledger_entries_reference",
    columns: "reference_type, reference_id"
  },
  {
    tableName: "member_ledger_entries",
    indexName: "ux_member_ledger_entries_user_reference",
    columns: "user_id, reference_type, reference_id",
    unique: true
  },
  {
    tableName: "member_ledger_entries",
    indexName: "idx_member_ledger_entries_effective",
    columns: "effective_date"
  },
  {
    tableName: "member_external_account_links",
    indexName: "ux_member_external_links_user_provider",
    columns: "user_id, provider",
    unique: true
  },
  {
    tableName: "member_credit_mirrors",
    indexName: "ux_member_credit_mirrors_link",
    columns: "external_link_id",
    unique: true
  },
  {
    tableName: "member_credit_mirrors",
    indexName: "idx_member_credit_mirrors_user_provider",
    columns: "user_id, provider"
  }
];

const MARKETING_INDEX_STATEMENTS = [
  {
    tableName: "marketing_campaigns",
    indexName: "ux_marketing_campaigns_slug",
    columns: "slug",
    unique: true
  },
  {
    tableName: "marketing_campaigns",
    indexName: "idx_marketing_campaigns_status",
    columns: "status"
  },
  {
    tableName: "marketing_campaigns",
    indexName: "idx_marketing_campaigns_channel",
    columns: "channel"
  },
  {
    tableName: "marketing_content_posts",
    indexName: "idx_marketing_content_posts_campaign",
    columns: "campaign_id"
  },
  {
    tableName: "marketing_utm_links",
    indexName: "ux_marketing_utm_links_slug",
    columns: "slug",
    unique: true
  },
  {
    tableName: "marketing_utm_links",
    indexName: "idx_marketing_utm_links_campaign",
    columns: "campaign_id"
  },
  {
    tableName: "marketing_utm_links",
    indexName: "idx_marketing_utm_links_active",
    columns: "is_active"
  },
  {
    tableName: "marketing_sessions",
    indexName: "ux_marketing_sessions_token",
    columns: "session_token",
    unique: true
  },
  {
    tableName: "marketing_sessions",
    indexName: "idx_marketing_sessions_campaign",
    columns: "campaign_id"
  },
  {
    tableName: "marketing_sessions",
    indexName: "idx_marketing_sessions_link",
    columns: "utm_link_id"
  },
  {
    tableName: "marketing_sessions",
    indexName: "idx_marketing_sessions_first_seen",
    columns: "first_seen_at"
  },
  {
    tableName: "marketing_click_events",
    indexName: "idx_marketing_click_events_session",
    columns: "session_id"
  },
  {
    tableName: "marketing_click_events",
    indexName: "idx_marketing_click_events_campaign",
    columns: "campaign_id"
  },
  {
    tableName: "marketing_click_events",
    indexName: "idx_marketing_click_events_link",
    columns: "utm_link_id"
  },
  {
    tableName: "marketing_click_events",
    indexName: "idx_marketing_click_events_occurred",
    columns: "occurred_at"
  },
  {
    tableName: "marketing_subscriber_events",
    indexName: "idx_marketing_subscriber_events_lead",
    columns: "subscribe_lead_id"
  },
  {
    tableName: "marketing_subscriber_events",
    indexName: "idx_marketing_subscriber_events_email",
    columns: "email"
  },
  {
    tableName: "marketing_subscriber_events",
    indexName: "idx_marketing_subscriber_events_campaign",
    columns: "campaign_id"
  },
  {
    tableName: "marketing_subscriber_events",
    indexName: "idx_marketing_subscriber_events_subscribed",
    columns: "subscribed_at"
  },
  {
    tableName: "marketing_ad_spend",
    indexName: "idx_marketing_ad_spend_campaign",
    columns: "campaign_id"
  },
  {
    tableName: "marketing_ad_spend",
    indexName: "idx_marketing_ad_spend_date",
    columns: "spend_date"
  },
  {
    tableName: "marketing_recommendations",
    indexName: "idx_marketing_recommendations_campaign",
    columns: "campaign_id"
  },
  {
    tableName: "marketing_recommendations",
    indexName: "idx_marketing_recommendations_status",
    columns: "status"
  }
];

const LIABILITY_RELEASE_TABLE_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS liability_release_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(128) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      body_text TEXT,
      source_url VARCHAR(2048),
      status VARCHAR(32) DEFAULT 'draft',
      public_path VARCHAR(255),
      renewal_months INT,
      requires_participants TINYINT(1) DEFAULT 0,
      allow_drawn_signature TINYINT(1) DEFAULT 1,
      current_version_id INT,
      created_by_user_id INT,
      updated_by_user_id INT,
      published_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME,
      UNIQUE KEY ux_liability_release_templates_slug (slug)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS liability_release_template_versions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      template_id INT NOT NULL,
      version_number INT NOT NULL,
      slug VARCHAR(128) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      body_text TEXT,
      source_url VARCHAR(2048),
      public_path VARCHAR(255),
      renewal_months INT,
      requires_participants TINYINT(1) DEFAULT 0,
      allow_drawn_signature TINYINT(1) DEFAULT 1,
      published_by_user_id INT,
      published_at DATETIME,
      created_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS liability_release_import_batches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      status VARCHAR(32) DEFAULT 'validated',
      original_filename VARCHAR(255),
      file_count INT DEFAULT 0,
      imported_count INT DEFAULT 0,
      error_count INT DEFAULT 0,
      summary_json TEXT,
      created_by_user_id INT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS liability_release_submissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      template_id INT NOT NULL,
      template_version_id INT NOT NULL,
      template_slug VARCHAR(128) NOT NULL,
      template_title VARCHAR(255) NOT NULL,
      status VARCHAR(32) DEFAULT 'signed',
      source_type VARCHAR(64) DEFAULT 'public',
      source_submission_id VARCHAR(255),
      import_batch_id INT,
      subscribe_lead_id INT,
      member_user_id INT,
      signer_name VARCHAR(255) NOT NULL,
      signer_email VARCHAR(255),
      signer_phone VARCHAR(64),
      signer_address_line_1 VARCHAR(255),
      signer_address_line_2 VARCHAR(255),
      signer_city VARCHAR(255),
      signer_state_province VARCHAR(255),
      signer_postal_code VARCHAR(32),
      participant_json TEXT,
      signature_mode VARCHAR(32) DEFAULT 'typed',
      signature_hash VARCHAR(64),
      accepted_at DATETIME,
      signed_at DATETIME,
      expires_at DATETIME,
      source_host VARCHAR(255),
      source_path VARCHAR(255),
      document_url VARCHAR(2048),
      record_url VARCHAR(2048),
      storage_key VARCHAR(1024),
      notes TEXT,
      admin_notes TEXT,
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `
];

const LIABILITY_RELEASE_INDEX_STATEMENTS = [
  {
    tableName: "liability_release_templates",
    indexName: "idx_liability_release_templates_status",
    columns: "status"
  },
  {
    tableName: "liability_release_template_versions",
    indexName: "idx_liability_release_versions_template",
    columns: "template_id"
  },
  {
    tableName: "liability_release_template_versions",
    indexName: "idx_liability_release_versions_slug",
    columns: "slug"
  },
  {
    tableName: "liability_release_template_versions",
    indexName: "ux_liability_release_versions_template_number",
    columns: "template_id, version_number",
    unique: true
  },
  {
    tableName: "liability_release_submissions",
    indexName: "idx_liability_release_submissions_template",
    columns: "template_id"
  },
  {
    tableName: "liability_release_submissions",
    indexName: "idx_liability_release_submissions_slug",
    columns: "template_slug"
  },
  {
    tableName: "liability_release_submissions",
    indexName: "idx_liability_release_submissions_email",
    columns: "signer_email"
  },
  {
    tableName: "liability_release_submissions",
    indexName: "idx_liability_release_submissions_signed_at",
    columns: "signed_at"
  },
  {
    tableName: "liability_release_submissions",
    indexName: "idx_liability_release_submissions_source",
    columns: "source_submission_id"
  }
];

const LOCAL_LINE_TABLE_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS price_lists (
      id INT AUTO_INCREMENT PRIMARY KEY,
      local_line_price_list_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      active TINYINT(1) DEFAULT 1,
      source VARCHAR(32) DEFAULT 'localline',
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS package_price_list_memberships (
      package_id INT NOT NULL,
      price_list_id INT NOT NULL,
      present TINYINT(1) DEFAULT 1,
      adjustment_type TINYINT(1),
      adjustment_value DECIMAL(10, 2),
      calculated_value DECIMAL(10, 2),
      base_price_used DECIMAL(10, 2),
      final_price_cache DECIMAL(10, 2),
      on_sale TINYINT(1) DEFAULT 0,
      on_sale_toggle TINYINT(1) DEFAULT 0,
      strikethrough_display_value DECIMAL(10, 2),
      max_units_per_order INT,
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME,
      PRIMARY KEY (package_id, price_list_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS product_price_list_memberships (
      product_id INT NOT NULL,
      price_list_id INT NOT NULL,
      package_count INT DEFAULT 0,
      all_packages_present TINYINT(1) DEFAULT 0,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME,
      PRIMARY KEY (product_id, price_list_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS product_pricing_profiles (
      product_id INT PRIMARY KEY,
      unit_of_measure VARCHAR(16) DEFAULT 'each',
      source_unit_price DECIMAL(10, 2),
      min_weight DECIMAL(10, 3),
      max_weight DECIMAL(10, 3),
      avg_weight_override DECIMAL(10, 3),
      source_multiplier DECIMAL(10, 4) DEFAULT 0.5412,
      guest_markup DECIMAL(10, 4),
      member_markup DECIMAL(10, 4),
      herd_share_markup DECIMAL(10, 4),
      snap_markup DECIMAL(10, 4),
      on_sale TINYINT(1) DEFAULT 0,
      sale_discount DECIMAL(5, 4),
      price_changed_at DATETIME,
      remote_sync_status VARCHAR(32) DEFAULT 'pending',
      remote_sync_message TEXT,
      remote_synced_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS product_media (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      source VARCHAR(32) DEFAULT 'localline',
      source_media_id VARCHAR(255),
      source_url TEXT,
      remote_url TEXT,
      storage_key VARCHAR(512),
      public_url TEXT,
      thumbnail_url TEXT,
      sort_order INT DEFAULT 0,
      is_primary TINYINT(1) DEFAULT 0,
      alt_text VARCHAR(512),
      content_hash VARCHAR(128),
      width INT,
      height INT,
      mime_type VARCHAR(128),
      fetched_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_product_meta (
      product_id INT PRIMARY KEY,
      local_line_product_id INT NOT NULL,
      internal_id VARCHAR(255),
      visible TINYINT(1),
      track_inventory TINYINT(1),
      track_inventory_by VARCHAR(64),
      inventory_type VARCHAR(64),
      product_inventory INT,
      package_codes_enabled TINYINT(1),
      export_hash VARCHAR(64),
      live_hash VARCHAR(64),
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_package_meta (
      package_id INT PRIMARY KEY,
      product_id INT NOT NULL,
      local_line_package_id INT NOT NULL,
      inventory_type VARCHAR(64),
      package_inventory INT,
      package_reserved_inventory INT,
      package_available_inventory INT,
      avg_package_weight DECIMAL(10, 3),
      num_of_items INT,
      package_code VARCHAR(255),
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_sync_runs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      mode VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL,
      started_at DATETIME NOT NULL,
      finished_at DATETIME,
      summary_json TEXT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_price_list_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      local_line_product_id INT,
      package_id INT,
      local_line_package_id INT,
      price_list_id INT NOT NULL,
      local_line_price_list_id INT NOT NULL,
      entry_scope VARCHAR(16) NOT NULL,
      source_entry_id VARCHAR(255),
      price_list_name VARCHAR(255),
      product_name VARCHAR(255),
      package_name VARCHAR(255),
      visible TINYINT(1),
      track_inventory TINYINT(1),
      package_code VARCHAR(255),
      adjustment_type TINYINT(1),
      adjustment_value DECIMAL(10, 2),
      calculated_value DECIMAL(10, 2),
      base_price_used DECIMAL(10, 2),
      final_price_cache DECIMAL(10, 2),
      on_sale TINYINT(1) DEFAULT 0,
      on_sale_toggle TINYINT(1) DEFAULT 0,
      strikethrough_display_value DECIMAL(10, 2),
      max_units_per_order INT,
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_sync_issues (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sync_run_id INT NOT NULL,
      severity VARCHAR(16) NOT NULL,
      issue_type VARCHAR(64) NOT NULL,
      product_id INT,
      package_id INT,
      price_list_id INT,
      details_json TEXT,
      resolved_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      local_line_order_id INT NOT NULL,
      status VARCHAR(64),
      price_list_id INT,
      price_list_name VARCHAR(255),
      customer_id INT,
      customer_name VARCHAR(255),
      created_at_remote DATETIME,
      updated_at_remote DATETIME,
      opened_at_remote DATETIME,
      fulfillment_strategy_id INT,
      fulfillment_strategy_name VARCHAR(255),
      fulfillment_type VARCHAR(64),
      fulfillment_status VARCHAR(64),
      fulfillment_date DATETIME,
      pickup_start_time VARCHAR(32),
      pickup_end_time VARCHAR(32),
      payment_status VARCHAR(64),
      subtotal DECIMAL(10, 2),
      tax DECIMAL(10, 2),
      total DECIMAL(10, 2),
      discount DECIMAL(10, 2),
      product_count INT,
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_order_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      local_line_order_entry_id INT NOT NULL,
      local_line_order_id INT NOT NULL,
      product_id INT,
      product_name VARCHAR(255),
      package_name VARCHAR(255),
      vendor_id INT,
      vendor_name VARCHAR(255),
      category_name VARCHAR(255),
      unit_quantity DECIMAL(10, 3),
      inventory_quantity DECIMAL(10, 3),
      price DECIMAL(10, 2),
      total_price DECIMAL(10, 2),
      price_per_unit VARCHAR(64),
      charge_type VARCHAR(64),
      track_type VARCHAR(64),
      pack_weight DECIMAL(10, 3),
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_order_reporting_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      fulfillment_month VARCHAR(7),
      fulfillment_date VARCHAR(32),
      week_start VARCHAR(10),
      local_line_order_id INT,
      customer_name VARCHAR(255),
      price_list_name VARCHAR(255),
      order_status VARCHAR(64),
      payment_status VARCHAR(64),
      fulfillment_name VARCHAR(255),
      fulfillment_address VARCHAR(512),
      vendor_id INT,
      vendor_name VARCHAR(255),
      category_name VARCHAR(255),
      product_id INT,
      product_name VARCHAR(255),
      package_id VARCHAR(64),
      package_name VARCHAR(255),
      quantity DECIMAL(10, 3),
      retail_amount DECIMAL(10, 2),
      purchase_unit_price DECIMAL(10, 2),
      purchase_total DECIMAL(10, 2),
      raw_json TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      last_synced_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_order_reporting_months (
      month_key VARCHAR(7) PRIMARY KEY,
      status VARCHAR(32),
      row_count INT,
      message TEXT,
      synced_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_subscription_snapshot_rows (
      snapshot_week_end VARCHAR(10) NOT NULL,
      snapshot_key VARCHAR(255) NOT NULL,
      plan_number VARCHAR(64),
      customer_name VARCHAR(255),
      email VARCHAR(255),
      status VARCHAR(64),
      next_fulfillment_status VARCHAR(64),
      total DECIMAL(10, 2),
      is_feed_a_friend TINYINT(1) DEFAULT 0,
      raw_json TEXT,
      captured_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME,
      PRIMARY KEY (snapshot_week_end, snapshot_key)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_subscription_snapshot_runs (
      snapshot_week_end VARCHAR(10) PRIMARY KEY,
      row_count INT,
      active_subscriber_count INT,
      snap_subscriber_count INT,
      projected_monthly_revenue DECIMAL(10, 2),
      skipped_subscriber_count INT,
      feed_a_friend_subscriber_count INT,
      captured_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_sync_cursors (
      sync_key VARCHAR(64) PRIMARY KEY,
      cursor_value VARCHAR(255),
      synced_through_at DATETIME,
      last_started_at DATETIME,
      last_finished_at DATETIME,
      last_status VARCHAR(32),
      last_message TEXT,
      summary_json TEXT,
      created_at DATETIME,
      updated_at DATETIME
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS local_line_job_runs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      job_id VARCHAR(64) NOT NULL,
      dataset_key VARCHAR(64) NOT NULL,
      dataset_label VARCHAR(255),
      job_type VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL,
      progress_json LONGTEXT,
      phases_json LONGTEXT,
      result_json LONGTEXT,
      error_json LONGTEXT,
      created_at DATETIME,
      started_at DATETIME,
      finished_at DATETIME,
      updated_at DATETIME,
      UNIQUE KEY ux_local_line_job_runs_job_id (job_id),
      KEY idx_local_line_job_runs_dataset_type (dataset_key, job_type),
      KEY idx_local_line_job_runs_started (started_at),
      KEY idx_local_line_job_runs_status (status)
    )
  `
];

const LOCAL_LINE_INDEX_STATEMENTS = [
  {
    tableName: "price_lists",
    indexName: "ux_price_lists_local_line_id",
    unique: true,
    columns: "local_line_price_list_id"
  },
  {
    tableName: "package_price_list_memberships",
    indexName: "idx_package_price_list_memberships_price_list",
    columns: "price_list_id"
  },
  {
    tableName: "product_price_list_memberships",
    indexName: "idx_product_price_list_memberships_price_list",
    columns: "price_list_id"
  },
  {
    tableName: "product_media",
    indexName: "idx_product_media_product",
    columns: "product_id"
  },
  {
    tableName: "product_media",
    indexName: "idx_product_media_source_media",
    columns: "source, source_media_id"
  },
  {
    tableName: "local_line_product_meta",
    indexName: "idx_local_line_product_meta_local_line_id",
    columns: "local_line_product_id"
  },
  {
    tableName: "local_line_package_meta",
    indexName: "idx_local_line_package_meta_product",
    columns: "product_id"
  },
  {
    tableName: "local_line_package_meta",
    indexName: "idx_local_line_package_meta_local_line_id",
    columns: "local_line_package_id"
  },
  {
    tableName: "local_line_price_list_entries",
    indexName: "idx_local_line_price_list_entries_product",
    columns: "product_id"
  },
  {
    tableName: "local_line_price_list_entries",
    indexName: "idx_local_line_price_list_entries_package",
    columns: "package_id"
  },
  {
    tableName: "local_line_price_list_entries",
    indexName: "idx_local_line_price_list_entries_price_list",
    columns: "price_list_id"
  },
  {
    tableName: "local_line_sync_issues",
    indexName: "idx_local_line_sync_issues_run",
    columns: "sync_run_id"
  },
  {
    tableName: "local_line_sync_issues",
    indexName: "idx_local_line_sync_issues_product",
    columns: "product_id"
  },
  {
    tableName: "local_line_sync_issues",
    indexName: "idx_local_line_sync_issues_package",
    columns: "package_id"
  },
  {
    tableName: "local_line_sync_issues",
    indexName: "idx_local_line_sync_issues_price_list",
    columns: "price_list_id"
  },
  {
    tableName: "drop_sites",
    indexName: "ux_drop_sites_local_line_fulfillment",
    unique: true,
    columns: "local_line_fulfillment_strategy_id"
  },
  {
    tableName: "local_line_orders",
    indexName: "ux_local_line_orders_remote_id",
    unique: true,
    columns: "local_line_order_id"
  },
  {
    tableName: "local_line_orders",
    indexName: "idx_local_line_orders_created_remote",
    columns: "created_at_remote"
  },
  {
    tableName: "local_line_orders",
    indexName: "idx_local_line_orders_updated_remote",
    columns: "updated_at_remote"
  },
  {
    tableName: "local_line_orders",
    indexName: "idx_local_line_orders_fulfillment_site",
    columns: "fulfillment_strategy_name"
  },
  {
    tableName: "local_line_orders",
    indexName: "idx_local_line_orders_status_payment_created",
    columns: "status, payment_status, created_at_remote"
  },
  {
    tableName: "local_line_orders",
    indexName: "idx_local_line_orders_fulfillment_strategy",
    columns: "fulfillment_strategy_id"
  },
  {
    tableName: "local_line_orders",
    indexName: "idx_local_line_orders_fulfillment_date",
    columns: "fulfillment_date"
  },
  {
    tableName: "local_line_order_entries",
    indexName: "ux_local_line_order_entries_remote_id",
    unique: true,
    columns: "local_line_order_entry_id"
  },
  {
    tableName: "local_line_order_entries",
    indexName: "idx_local_line_order_entries_order",
    columns: "local_line_order_id"
  },
  {
    tableName: "local_line_order_entries",
    indexName: "idx_local_line_order_entries_vendor",
    columns: "vendor_name"
  },
  {
    tableName: "local_line_order_entries",
    indexName: "idx_local_line_order_entries_product",
    columns: "product_name"
  },
  {
    tableName: "local_line_order_entries",
    indexName: "idx_local_line_order_entries_category",
    columns: "category_name"
  },
  {
    tableName: "local_line_order_reporting_entries",
    indexName: "idx_local_line_order_reporting_month",
    columns: "fulfillment_month"
  },
  {
    tableName: "local_line_order_reporting_entries",
    indexName: "idx_local_line_order_reporting_week",
    columns: "week_start"
  },
  {
    tableName: "local_line_order_reporting_entries",
    indexName: "idx_local_line_order_reporting_vendor",
    columns: "vendor_name"
  },
  {
    tableName: "local_line_order_reporting_entries",
    indexName: "idx_local_line_order_reporting_category",
    columns: "category_name"
  },
  {
    tableName: "local_line_order_reporting_entries",
    indexName: "idx_local_line_order_reporting_product",
    columns: "product_name"
  },
  {
    tableName: "local_line_order_reporting_entries",
    indexName: "idx_local_line_order_reporting_fulfillment",
    columns: "fulfillment_name"
  },
  {
    tableName: "local_line_order_reporting_entries",
    indexName: "idx_local_line_order_reporting_status_payment_month",
    columns: "order_status, payment_status, fulfillment_month"
  },
  {
    tableName: "local_line_order_reporting_entries",
    indexName: "idx_local_line_order_reporting_status_payment_week",
    columns: "order_status, payment_status, week_start"
  },
  {
    tableName: "local_line_subscription_snapshot_rows",
    indexName: "idx_local_line_subscription_snapshot_status",
    columns: "snapshot_week_end, status"
  },
  {
    tableName: "local_line_subscription_snapshot_rows",
    indexName: "idx_local_line_subscription_snapshot_email",
    columns: "email"
  },
  {
    tableName: "local_line_subscription_snapshot_runs",
    indexName: "idx_local_line_subscription_snapshot_runs_captured",
    columns: "captured_at"
  }
];

const LOCAL_LINE_COLUMN_STATEMENTS = [
  {
    tableName: "local_line_product_meta",
    columnName: "vendor_name",
    definition: "vendor_name VARCHAR(255)"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "status",
    definition: "status VARCHAR(64)"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "reserved_inventory",
    definition: "reserved_inventory INT"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "available_inventory",
    definition: "available_inventory INT"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "ownership_type",
    definition: "ownership_type VARCHAR(64)"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "packing_tag",
    definition: "packing_tag VARCHAR(255)"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "export_hash",
    definition: "export_hash VARCHAR(64)"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "live_hash",
    definition: "live_hash VARCHAR(64)"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "last_live_fetch_status",
    definition: "last_live_fetch_status INT"
  },
  {
    tableName: "local_line_product_meta",
    columnName: "last_live_fetch_error",
    definition: "last_live_fetch_error TEXT"
  },
  {
    tableName: "local_line_package_meta",
    columnName: "live_name",
    definition: "live_name VARCHAR(255)"
  },
  {
    tableName: "local_line_package_meta",
    columnName: "live_price",
    definition: "live_price DECIMAL(10, 2)"
  },
  {
    tableName: "local_line_package_meta",
    columnName: "live_visible",
    definition: "live_visible TINYINT(1)"
  },
  {
    tableName: "local_line_package_meta",
    columnName: "live_track_inventory",
    definition: "live_track_inventory TINYINT(1)"
  },
  {
    tableName: "drop_sites",
    columnName: "source",
    definition: "source VARCHAR(32) DEFAULT 'local'"
  },
  {
    tableName: "drop_sites",
    columnName: "local_line_fulfillment_strategy_id",
    definition: "local_line_fulfillment_strategy_id INT"
  },
  {
    tableName: "drop_sites",
    columnName: "type",
    definition: "type VARCHAR(32)"
  },
  {
    tableName: "drop_sites",
    columnName: "fulfillment_type",
    definition: "fulfillment_type VARCHAR(32)"
  },
  {
    tableName: "drop_sites",
    columnName: "timezone",
    definition: "timezone VARCHAR(64)"
  },
  {
    tableName: "drop_sites",
    columnName: "latitude",
    definition: "latitude DECIMAL(10, 7)"
  },
  {
    tableName: "drop_sites",
    columnName: "longitude",
    definition: "longitude DECIMAL(10, 7)"
  },
  {
    tableName: "drop_sites",
    columnName: "instructions",
    definition: "instructions TEXT"
  },
  {
    tableName: "drop_sites",
    columnName: "address_json",
    definition: "address_json TEXT"
  },
  {
    tableName: "drop_sites",
    columnName: "availability_json",
    definition: "availability_json TEXT"
  },
  {
    tableName: "drop_sites",
    columnName: "price_lists_json",
    definition: "price_lists_json TEXT"
  },
  {
    tableName: "drop_sites",
    columnName: "raw_json",
    definition: "raw_json TEXT"
  },
  {
    tableName: "drop_sites",
    columnName: "last_synced_at",
    definition: "last_synced_at DATETIME"
  },
  {
    tableName: "local_line_orders",
    columnName: "fulfillment_strategy_id",
    definition: "fulfillment_strategy_id INT"
  },
  {
    tableName: "local_line_orders",
    columnName: "fulfillment_strategy_name",
    definition: "fulfillment_strategy_name VARCHAR(255)"
  },
  {
    tableName: "local_line_orders",
    columnName: "fulfillment_date",
    definition: "fulfillment_date DATETIME"
  },
  {
    tableName: "local_line_orders",
    columnName: "pickup_start_time",
    definition: "pickup_start_time VARCHAR(32)"
  },
  {
    tableName: "local_line_orders",
    columnName: "pickup_end_time",
    definition: "pickup_end_time VARCHAR(32)"
  },
  {
    tableName: "local_line_subscription_snapshot_runs",
    columnName: "snap_subscriber_count",
    definition: "snap_subscriber_count INT"
  }
];

const ADMIN_ACCESS_TABLE_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS admin_roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      role_key VARCHAR(64) NOT NULL,
      label VARCHAR(128) NOT NULL,
      description TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      UNIQUE KEY ux_admin_roles_key (role_key)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS admin_user_roles (
      user_id INT NOT NULL,
      role_id INT NOT NULL,
      created_at DATETIME,
      PRIMARY KEY (user_id, role_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash VARCHAR(64) NOT NULL,
      requested_by_user_id INT,
      requested_by_admin TINYINT(1) DEFAULT 0,
      used_at DATETIME,
      expires_at DATETIME NOT NULL,
      created_at DATETIME,
      UNIQUE KEY ux_password_reset_tokens_hash (token_hash)
    )
  `
];

const ADMIN_ACCESS_COLUMN_STATEMENTS = [
  {
    tableName: "users",
    columnName: "username",
    definition: "username VARCHAR(255)"
  },
  {
    tableName: "users",
    columnName: "name",
    definition: "name VARCHAR(255)"
  },
  {
    tableName: "users",
    columnName: "active",
    definition: "active TINYINT(1) DEFAULT 1"
  },
  {
    tableName: "users",
    columnName: "timesheets_user_id",
    definition: "timesheets_user_id VARCHAR(64)"
  },
  {
    tableName: "users",
    columnName: "timesheets_employee_id",
    definition: "timesheets_employee_id VARCHAR(64)"
  }
];

const ADMIN_ACCESS_INDEX_STATEMENTS = [
  {
    tableName: "admin_user_roles",
    indexName: "idx_admin_user_roles_role",
    columns: "role_id"
  },
  {
    tableName: "password_reset_tokens",
    indexName: "idx_password_reset_tokens_user",
    columns: "user_id"
  },
  {
    tableName: "password_reset_tokens",
    indexName: "idx_password_reset_tokens_expires",
    columns: "expires_at"
  },
  {
    tableName: "users",
    indexName: "ux_users_username",
    unique: true,
    columns: "username"
  }
];

const ADMIN_PRICELIST_INDEX_STATEMENTS = [
  {
    tableName: "products",
    indexName: "idx_products_category",
    columns: "category_id"
  },
  {
    tableName: "products",
    indexName: "idx_products_vendor",
    columns: "vendor_id"
  },
  {
    tableName: "products",
    indexName: "idx_products_name",
    columns: "name"
  },
  {
    tableName: "packages",
    indexName: "idx_packages_product",
    columns: "product_id"
  }
];

async function indexExists(connection, tableName, indexName) {
  const [rows] = await connection.query(
    `
      SELECT 1
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND index_name = ?
      LIMIT 1
    `,
    [tableName, indexName]
  );
  return rows.length > 0;
}

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND column_name = ?
      LIMIT 1
    `,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function singleColumnUniqueIndexes(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `
      SELECT index_name AS indexName
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND non_unique = 0
      GROUP BY index_name
      HAVING COUNT(*) = 1
        AND MAX(column_name = ?) = 1
    `,
    [tableName, columnName]
  );
  return rows.map((row) => row.indexName).filter((indexName) => indexName !== "PRIMARY");
}

async function runLocalLineSchemaBootstrap(connection) {
  for (const statement of LOCAL_LINE_TABLE_STATEMENTS) {
    await connection.query(statement);
  }

  for (const columnDefinition of LOCAL_LINE_COLUMN_STATEMENTS) {
    const exists = await columnExists(
      connection,
      columnDefinition.tableName,
      columnDefinition.columnName
    );
    if (exists) continue;

    await connection.query(
      `ALTER TABLE ${columnDefinition.tableName} ADD COLUMN ${columnDefinition.definition}`
    );
  }

  for (const indexDefinition of LOCAL_LINE_INDEX_STATEMENTS) {
    const exists = await indexExists(
      connection,
      indexDefinition.tableName,
      indexDefinition.indexName
    );
    if (exists) continue;

    const uniqueClause = indexDefinition.unique ? "UNIQUE " : "";
    await connection.query(
      `CREATE ${uniqueClause}INDEX ${indexDefinition.indexName} ON ${indexDefinition.tableName} (${indexDefinition.columns})`
    );
  }
}

async function runAdminAccessSchemaBootstrap(connection) {
  for (const statement of ADMIN_ACCESS_TABLE_STATEMENTS) {
    await connection.query(statement);
  }

  for (const columnDefinition of ADMIN_ACCESS_COLUMN_STATEMENTS) {
    const exists = await columnExists(
      connection,
      columnDefinition.tableName,
      columnDefinition.columnName
    );
    if (exists) continue;

    await connection.query(
      `ALTER TABLE ${columnDefinition.tableName} ADD COLUMN ${columnDefinition.definition}`
    );
  }

  await connection.query(
    `
      UPDATE users
      SET username = TRIM(email)
      WHERE (username IS NULL OR TRIM(username) = '')
        AND email IS NOT NULL
        AND TRIM(email) <> ''
    `
  );
  await connection.query(
    `
      UPDATE users
      SET username = CONCAT('user-', id)
      WHERE username IS NULL
        OR TRIM(username) = ''
    `
  );
  await connection.query(
    `
      UPDATE users
      SET email = NULL
      WHERE email IS NOT NULL
        AND email NOT REGEXP '^[^[:space:]@]+@[^[:space:]@]+\\\\.[^[:space:]@]+$'
    `
  );

  await connection.query("ALTER TABLE users MODIFY username VARCHAR(255) NOT NULL");
  await connection.query("ALTER TABLE users MODIFY email VARCHAR(255)");

  const emailUniqueIndexes = await singleColumnUniqueIndexes(connection, "users", "email");
  for (const indexName of emailUniqueIndexes) {
    await connection.query(`ALTER TABLE users DROP INDEX \`${String(indexName).replace(/`/g, "``")}\``);
  }

  for (const indexDefinition of ADMIN_ACCESS_INDEX_STATEMENTS) {
    const exists = await indexExists(
      connection,
      indexDefinition.tableName,
      indexDefinition.indexName
    );
    if (exists) continue;

    const uniqueClause = indexDefinition.unique ? "UNIQUE " : "";
    await connection.query(
      `CREATE ${uniqueClause}INDEX ${indexDefinition.indexName} ON ${indexDefinition.tableName} (${indexDefinition.columns})`
    );
  }

  const now = new Date();
  for (const role of ADMIN_ROLE_DEFINITIONS) {
    await connection.query(
      `
        INSERT INTO admin_roles (role_key, label, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          label = VALUES(label),
          description = VALUES(description),
          updated_at = VALUES(updated_at)
      `,
      [role.key, role.label, role.description, now, now]
    );
  }

  await connection.query(
    `
      INSERT IGNORE INTO admin_user_roles (user_id, role_id, created_at)
      SELECT u.id, r.id, ?
      FROM users u
      JOIN admin_roles r ON r.role_key = 'admin'
      WHERE u.role IN ('admin', 'administrator')
    `,
    [now]
  );
}

async function runAdminPricelistIndexBootstrap(connection) {
  for (const indexDefinition of ADMIN_PRICELIST_INDEX_STATEMENTS) {
    const exists = await indexExists(
      connection,
      indexDefinition.tableName,
      indexDefinition.indexName
    );
    if (exists) continue;

    await connection.query(
      `CREATE INDEX ${indexDefinition.indexName} ON ${indexDefinition.tableName} (${indexDefinition.columns})`
    );
  }
}

async function runVendorPricingSchemaBootstrap(connection) {
  for (const columnDefinition of VENDOR_PRICING_COLUMN_STATEMENTS) {
    const exists = await columnExists(
      connection,
      columnDefinition.tableName,
      columnDefinition.columnName
    );
    if (exists) continue;

    await connection.query(
      `ALTER TABLE ${columnDefinition.tableName} ADD COLUMN ${columnDefinition.definition}`
    );
  }

  const [vendorRows] = await connection.query(
    `
      SELECT
        id,
        name,
        guest_markup AS guestMarkup,
        member_markup AS memberMarkup,
        price_list_markup AS priceListMarkup,
        source_multiplier AS sourceMultiplier
      FROM vendors
    `
  );

  for (const vendor of vendorRows) {
    const vendorId = Number(vendor.id);
    if (!Number.isFinite(vendorId)) continue;

    let nextPriceListMarkup = vendor.priceListMarkup;
    let nextSourceMultiplier = vendor.sourceMultiplier;
    const normalizedVendorName = String(vendor.name || "").trim().toLowerCase();
    const isSourcePricingVendor =
      normalizedVendorName.includes("deck family farm") ||
      normalizedVendorName.includes("hyland") ||
      normalizedVendorName.includes("creamy cow");

    if (nextPriceListMarkup === null || typeof nextPriceListMarkup === "undefined") {
      const [markupRows] = await connection.query(
        `
          SELECT
            member_markup AS memberMarkup,
            guest_markup AS guestMarkup,
            COUNT(*) AS totalRows
          FROM product_pricing_profiles pp
          JOIN products p ON p.id = pp.product_id
          WHERE p.vendor_id = ?
            AND COALESCE(pp.member_markup, 0) > 0
          GROUP BY pp.member_markup, pp.guest_markup
          ORDER BY totalRows DESC, pp.member_markup DESC
          LIMIT 1
        `,
        [vendorId]
      );

      nextPriceListMarkup =
        markupRows[0]?.memberMarkup ??
        vendor.memberMarkup ??
        vendor.guestMarkup ??
        null;
    }

    if (
      isSourcePricingVendor &&
      (nextSourceMultiplier === null || typeof nextSourceMultiplier === "undefined")
    ) {
      const [factorRows] = await connection.query(
        `
          SELECT
            source_multiplier AS sourceMultiplier,
            COUNT(*) AS totalRows
          FROM product_pricing_profiles pp
          JOIN products p ON p.id = pp.product_id
          WHERE p.vendor_id = ?
            AND COALESCE(pp.source_multiplier, 0) > 0
            AND LOWER(p.name) NOT LIKE '%deposit%'
          GROUP BY pp.source_multiplier
          ORDER BY totalRows DESC, pp.source_multiplier DESC
          LIMIT 1
        `,
        [vendorId]
      );

      nextSourceMultiplier =
        factorRows[0]?.sourceMultiplier ?? SOURCE_PRICING_VENDOR_FACTOR_DEFAULT;
    }

    await connection.query(
      `
        UPDATE vendors
        SET price_list_markup = COALESCE(price_list_markup, ?),
            source_multiplier = COALESCE(source_multiplier, ?)
        WHERE id = ?
      `,
      [nextPriceListMarkup, nextSourceMultiplier, vendorId]
    );
  }
}

async function runProductPricingSchemaBootstrap(connection) {
  let addedColumn = false;
  for (const columnDefinition of PRODUCT_PRICING_COLUMN_STATEMENTS) {
    const exists = await columnExists(
      connection,
      columnDefinition.tableName,
      columnDefinition.columnName
    );
    if (exists) continue;

    await connection.query(
      `ALTER TABLE ${columnDefinition.tableName} ADD COLUMN ${columnDefinition.definition}`
    );
    addedColumn = true;
  }

  if (addedColumn) {
    await connection.query(
      `
        UPDATE product_pricing_profiles
        SET price_changed_at = CASE
          WHEN updated_at IS NOT NULL
            AND updated_at >= (UTC_TIMESTAMP() - INTERVAL 14 DAY)
            AND (
              remote_sync_message = 'Local source pricing updated. Apply to remote store pending.'
              OR remote_sync_message = 'Local pricing updated. Apply to remote store pending.'
              OR remote_sync_message = 'Local sale updated. Apply to remote store pending.'
              OR remote_sync_message = 'Duplicate created with default CSA markup applied to all price lists. Apply to remote store pending.'
              OR remote_sync_message = 'Vendor pricing defaults updated. Apply to remote store pending.'
              OR remote_sync_message = 'Applied to store pricing and remote sync completed.'
            )
            THEN updated_at
          ELSE (UTC_TIMESTAMP() - INTERVAL 21 DAY)
        END
        WHERE price_changed_at IS NULL
      `
    );
  }
}

async function runSubscriberCaptureSchemaBootstrap(connection) {
  for (const statement of SUBSCRIBER_CAPTURE_TABLE_STATEMENTS) {
    await connection.query(statement);
  }

  for (const columnDefinition of SUBSCRIBER_CAPTURE_COLUMN_STATEMENTS) {
    const exists = await columnExists(
      connection,
      columnDefinition.tableName,
      columnDefinition.columnName
    );
    if (exists) continue;

    await connection.query(
      `ALTER TABLE ${columnDefinition.tableName} ADD COLUMN ${columnDefinition.definition}`
    );
  }

  await connection.query(
    `
      UPDATE subscribe_leads
      SET status = 'in_progress'
      WHERE status IS NULL
        OR TRIM(status) = ''
        OR LOWER(TRIM(status)) = 'new'
    `
  );

  await connection.query(
    `
      ALTER TABLE subscribe_leads
      MODIFY COLUMN status VARCHAR(32) NOT NULL DEFAULT 'in_progress'
    `
  );

  for (const indexDefinition of SUBSCRIBER_CAPTURE_INDEX_STATEMENTS) {
    const exists = await indexExists(
      connection,
      indexDefinition.tableName,
      indexDefinition.indexName
    );
    if (exists) continue;

    await connection.query(
      `CREATE INDEX ${indexDefinition.indexName} ON ${indexDefinition.tableName} (${indexDefinition.columns})`
    );
  }
}

async function runSiteContentSchemaBootstrap(connection) {
  for (const statement of SITE_CONTENT_TABLE_STATEMENTS) {
    await connection.query(statement);
  }

  for (const indexDefinition of SITE_CONTENT_INDEX_STATEMENTS) {
    const exists = await indexExists(
      connection,
      indexDefinition.tableName,
      indexDefinition.indexName
    );
    if (exists) continue;

    const uniqueClause = indexDefinition.unique ? "UNIQUE " : "";
    await connection.query(
      `CREATE ${uniqueClause}INDEX ${indexDefinition.indexName} ON ${indexDefinition.tableName} (${indexDefinition.columns})`
    );
  }

  const now = new Date();
  for (const block of SITE_CONTENT_BLOCK_DEFAULTS) {
    await connection.query(
      `
        INSERT IGNORE INTO site_content_blocks (
          page,
          section,
          field,
          label,
          value,
          input_type,
          sort_order,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        block.page,
        block.section,
        block.field,
        block.label,
        block.value,
        block.inputType,
        block.sortOrder,
        now,
        now
      ]
    );
  }
}

async function runMarketingSchemaBootstrap(connection) {
  for (const statement of MARKETING_TABLE_STATEMENTS) {
    await connection.query(statement);
  }

  for (const indexDefinition of MARKETING_INDEX_STATEMENTS) {
    const exists = await indexExists(
      connection,
      indexDefinition.tableName,
      indexDefinition.indexName
    );
    if (exists) continue;

    const uniqueClause = indexDefinition.unique ? "UNIQUE " : "";
    await connection.query(
      `CREATE ${uniqueClause}INDEX ${indexDefinition.indexName} ON ${indexDefinition.tableName} (${indexDefinition.columns})`
    );
  }
}

async function runSubscriptionPortalSchemaBootstrap(connection) {
  for (const statement of SUBSCRIPTION_PORTAL_TABLE_STATEMENTS) {
    await connection.query(statement);
  }

  const memberProfileColumnDefinitions = [
    {
      tableName: "member_profiles",
      columnName: "local_line_setup_status",
      definition: "local_line_setup_status VARCHAR(32)"
    },
    {
      tableName: "member_profiles",
      columnName: "local_line_setup_mode",
      definition: "local_line_setup_mode VARCHAR(32)"
    },
    {
      tableName: "member_profiles",
      columnName: "local_line_setup_note",
      definition: "local_line_setup_note TEXT"
    },
    {
      tableName: "member_credit_mirrors",
      columnName: "last_ledger_import_at",
      definition: "last_ledger_import_at DATETIME"
    },
    {
      tableName: "member_credit_mirrors",
      columnName: "last_ledger_imported_transaction_id",
      definition: "last_ledger_imported_transaction_id VARCHAR(255)"
    },
    {
      tableName: "member_credit_mirrors",
      columnName: "last_ledger_imported_transaction_at",
      definition: "last_ledger_imported_transaction_at DATETIME"
    },
    {
      tableName: "member_credit_mirrors",
      columnName: "last_ledger_imported_balance_cents",
      definition: "last_ledger_imported_balance_cents INT"
    },
    {
      tableName: "member_credit_mirrors",
      columnName: "ledger_backfill_completed",
      definition: "ledger_backfill_completed TINYINT DEFAULT 0"
    },
    {
      tableName: "member_credit_mirrors",
      columnName: "last_ledger_import_error",
      definition: "last_ledger_import_error TEXT"
    }
  ];

  for (const columnDefinition of memberProfileColumnDefinitions) {
    const exists = await columnExists(
      connection,
      columnDefinition.tableName,
      columnDefinition.columnName
    );
    if (exists) continue;

    await connection.query(
      `ALTER TABLE ${columnDefinition.tableName} ADD COLUMN ${columnDefinition.definition}`
    );
  }

  await connection.query(`
    DELETE duplicate_entries
    FROM member_ledger_entries AS duplicate_entries
    INNER JOIN member_ledger_entries AS canonical_entries
      ON duplicate_entries.user_id = canonical_entries.user_id
      AND duplicate_entries.reference_type = canonical_entries.reference_type
      AND duplicate_entries.reference_id = canonical_entries.reference_id
      AND duplicate_entries.id < canonical_entries.id
    WHERE duplicate_entries.reference_type = 'localline_credit_transaction'
      AND duplicate_entries.reference_id IS NOT NULL
  `);

  for (const indexDefinition of SUBSCRIPTION_PORTAL_INDEX_STATEMENTS) {
    const exists = await indexExists(
      connection,
      indexDefinition.tableName,
      indexDefinition.indexName
    );
    if (exists) continue;

    const uniqueClause = indexDefinition.unique ? "UNIQUE " : "";
    await connection.query(
      `CREATE ${uniqueClause}INDEX ${indexDefinition.indexName} ON ${indexDefinition.tableName} (${indexDefinition.columns})`
    );
  }

  const [settingsRows] = await connection.query(
    "SELECT id FROM subscription_settings ORDER BY id ASC LIMIT 1"
  );
  if (!settingsRows.length) {
    const now = new Date();
    await connection.query(
      `
        INSERT INTO subscription_settings (
          dividend_rate_percent,
          herdshare_monthly_fee_cents,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?)
      `,
      [3, 500, now, now]
    );
  }
}

async function runLiabilityReleaseSchemaBootstrap(connection) {
  for (const statement of LIABILITY_RELEASE_TABLE_STATEMENTS) {
    await connection.query(statement);
  }

  for (const indexDefinition of LIABILITY_RELEASE_INDEX_STATEMENTS) {
    const exists = await indexExists(
      connection,
      indexDefinition.tableName,
      indexDefinition.indexName
    );
    if (exists) continue;

    const uniqueClause = indexDefinition.unique ? "UNIQUE " : "";
    await connection.query(
      `CREATE ${uniqueClause}INDEX ${indexDefinition.indexName} ON ${indexDefinition.tableName} (${indexDefinition.columns})`
    );
  }
}

export function initDb() {
  if (db) return db;

  pool = mysql.createPool({
    host: process.env.STORE_DB_HOST,
    port: Number(process.env.STORE_DB_PORT || 3306),
    user: process.env.STORE_DB_USER,
    password: process.env.STORE_DB_PASSWORD,
    database: process.env.STORE_DB_DATABASE || "store",
    connectTimeout: Number(process.env.STORE_DB_CONNECT_TIMEOUT_MS || 15000),
    enableKeepAlive: true,
    keepAliveInitialDelay: Number(process.env.STORE_DB_KEEPALIVE_INITIAL_DELAY_MS || 10000),
    waitForConnections: true,
    connectionLimit: Number(process.env.STORE_DB_CONNECTION_LIMIT || 10),
    queueLimit: 0
  });

  db = drizzle(pool, { schema, mode: "default" });
  return db;
}

export function getDb() {
  return db ?? initDb();
}

export function getPool() {
  if (!pool) initDb();
  return pool;
}

export async function ensureLocalLineSyncSchema(connection = getPool()) {
  if (connection === getPool()) {
    if (!localLineSchemaPromise) {
      localLineSchemaPromise = runLocalLineSchemaBootstrap(connection).catch((error) => {
        localLineSchemaPromise = null;
        throw error;
      });
    }
    return localLineSchemaPromise;
  }

  return runLocalLineSchemaBootstrap(connection);
}

export async function ensureAdminAccessSchema(connection = getPool()) {
  if (connection === getPool()) {
    if (!adminAccessSchemaPromise) {
      adminAccessSchemaPromise = runAdminAccessSchemaBootstrap(connection).catch((error) => {
        adminAccessSchemaPromise = null;
        throw error;
      });
    }
    return adminAccessSchemaPromise;
  }

  return runAdminAccessSchemaBootstrap(connection);
}

export async function ensureAdminPricelistIndexes(connection = getPool()) {
  if (connection === getPool()) {
    if (!adminPricelistIndexesPromise) {
      adminPricelistIndexesPromise = runAdminPricelistIndexBootstrap(connection).catch((error) => {
        adminPricelistIndexesPromise = null;
        throw error;
      });
    }
    return adminPricelistIndexesPromise;
  }

  return runAdminPricelistIndexBootstrap(connection);
}

export async function ensureVendorPricingSchema(connection = getPool()) {
  if (connection === getPool()) {
    if (!vendorPricingSchemaPromise) {
      vendorPricingSchemaPromise = runVendorPricingSchemaBootstrap(connection).catch((error) => {
        vendorPricingSchemaPromise = null;
        throw error;
      });
    }
    return vendorPricingSchemaPromise;
  }

  return runVendorPricingSchemaBootstrap(connection);
}

export async function ensureProductPricingSchema(connection = getPool()) {
  if (connection === getPool()) {
    if (!productPricingSchemaPromise) {
      productPricingSchemaPromise = runProductPricingSchemaBootstrap(connection).catch((error) => {
        productPricingSchemaPromise = null;
        throw error;
      });
    }
    return productPricingSchemaPromise;
  }

  return runProductPricingSchemaBootstrap(connection);
}

export async function ensureSubscriberCaptureSchema(connection = getPool()) {
  if (connection === getPool()) {
    if (!subscriberCaptureSchemaPromise) {
      subscriberCaptureSchemaPromise = runSubscriberCaptureSchemaBootstrap(connection).catch(
        (error) => {
          subscriberCaptureSchemaPromise = null;
          throw error;
        }
      );
    }
    return subscriberCaptureSchemaPromise;
  }

  return runSubscriberCaptureSchemaBootstrap(connection);
}

export async function ensureSiteContentSchema(connection = getPool()) {
  if (connection === getPool()) {
    if (!siteContentSchemaPromise) {
      siteContentSchemaPromise = runSiteContentSchemaBootstrap(connection).catch((error) => {
        siteContentSchemaPromise = null;
        throw error;
      });
    }
    return siteContentSchemaPromise;
  }

  return runSiteContentSchemaBootstrap(connection);
}

export async function ensureMarketingSchema(connection = getPool()) {
  if (connection === getPool()) {
    if (!marketingSchemaPromise) {
      marketingSchemaPromise = runMarketingSchemaBootstrap(connection).catch((error) => {
        marketingSchemaPromise = null;
        throw error;
      });
    }
    return marketingSchemaPromise;
  }

  return runMarketingSchemaBootstrap(connection);
}

export async function ensureSubscriptionPortalSchema(connection = getPool()) {
  if (connection === getPool()) {
    if (!subscriptionPortalSchemaPromise) {
      subscriptionPortalSchemaPromise = runSubscriptionPortalSchemaBootstrap(connection).catch(
        (error) => {
          subscriptionPortalSchemaPromise = null;
          throw error;
        }
      );
    }
    return subscriptionPortalSchemaPromise;
  }

  return runSubscriptionPortalSchemaBootstrap(connection);
}

export async function ensureLiabilityReleaseSchema(connection = getPool()) {
  if (connection === getPool()) {
    if (!liabilityReleaseSchemaPromise) {
      liabilityReleaseSchemaPromise = runLiabilityReleaseSchemaBootstrap(connection).catch(
        (error) => {
          liabilityReleaseSchemaPromise = null;
          throw error;
        }
      );
    }
    return liabilityReleaseSchemaPromise;
  }

  return runLiabilityReleaseSchemaBootstrap(connection);
}

export function isMissingTableError(error, tableName = "") {
  if (!error) return false;
  if (error.code !== "ER_NO_SUCH_TABLE") return false;
  if (!tableName) return true;
  return String(error.sqlMessage || error.message || "").includes(`.${tableName}`);
}

export { schema, relations };
