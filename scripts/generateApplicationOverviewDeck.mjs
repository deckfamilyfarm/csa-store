import PptxGenJS from "pptxgenjs";
import fs from "fs";
import path from "path";

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "OpenAI Codex";
pptx.company = "Deck Family Farm / Full Farm CSA";
pptx.subject = "CSA Store application overview and ROI";
pptx.title = "CSA Store Application Overview";
pptx.lang = "en-US";
pptx.theme = {
  headFontFace: "Aptos Display",
  bodyFontFace: "Aptos",
  lang: "en-US"
};

const COLORS = {
  green: "667042",
  moss: "8D9475",
  cream: "F4F0E6",
  barn: "8F2E2B",
  ink: "21303A",
  slate: "46535D",
  white: "FFFFFF",
  gold: "C89D4F"
};

function addBackground(slide) {
  slide.background = { color: COLORS.cream };
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 13.333,
    h: 0.55,
    line: { color: COLORS.green, transparency: 100 },
    fill: { color: COLORS.green }
  });
  slide.addText("CSA Store", {
    x: 0.5,
    y: 0.16,
    w: 2.2,
    h: 0.2,
    fontFace: "Aptos Display",
    fontSize: 20,
    color: COLORS.white,
    bold: true,
    margin: 0
  });
}

function addTitle(slide, title, subtitle = "") {
  addBackground(slide);
  slide.addText(title, {
    x: 0.7,
    y: 0.85,
    w: 12,
    h: 0.5,
    fontFace: "Aptos Display",
    fontSize: 24,
    bold: true,
    color: COLORS.ink,
    margin: 0
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.7,
      y: 1.28,
      w: 12,
      h: 0.35,
      fontSize: 11,
      color: COLORS.slate,
      italic: true,
      margin: 0
    });
  }
}

function addBullets(slide, bullets, opts = {}) {
  const x = opts.x ?? 0.9;
  const y = opts.y ?? 1.75;
  const w = opts.w ?? 11.7;
  const h = opts.h ?? 5.2;
  const fontSize = opts.fontSize ?? 20;
  const lines = [];
  for (const bullet of bullets) {
    if (typeof bullet === "string") {
      lines.push({
        text: bullet,
        options: { bullet: { indent: 18 } }
      });
    } else {
      lines.push({
        text: bullet.text,
        options: {
          bullet: bullet.bullet === false ? undefined : { indent: bullet.indent ?? 18 },
          indentLevel: bullet.level ?? 0,
          breakLine: bullet.breakLine ?? false
        }
      });
    }
  }
  slide.addText(lines, {
    x,
    y,
    w,
    h,
    fontFace: "Aptos",
    fontSize,
    color: COLORS.ink,
    breakLine: true,
    paraSpaceAfterPt: 9,
    valign: "top",
    margin: 0.02
  });
}

function addSummaryBox(slide, title, value, x, y, w, h, fill) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x,
    y,
    w,
    h,
    rectRadius: 0.08,
    line: { color: fill, transparency: 100 },
    fill: { color: fill }
  });
  slide.addText(title, {
    x: x + 0.18,
    y: y + 0.14,
    w: w - 0.36,
    h: 0.2,
    fontSize: 11,
    bold: true,
    color: COLORS.white,
    margin: 0
  });
  slide.addText(value, {
    x: x + 0.18,
    y: y + 0.45,
    w: w - 0.36,
    h: h - 0.55,
    fontSize: 22,
    bold: true,
    color: COLORS.white,
    margin: 0
  });
}

function addTwoColumnTableLike(slide, leftTitle, rightTitle, rows, opts = {}) {
  const x = opts.x ?? 0.85;
  const y = opts.y ?? 1.95;
  const leftW = opts.leftW ?? 7.2;
  const rightW = opts.rightW ?? 3.2;
  const rowH = opts.rowH ?? 0.42;
  slide.addShape(pptx.ShapeType.roundRect, {
    x,
    y,
    w: leftW + rightW,
    h: rowH,
    rectRadius: 0.02,
    line: { color: COLORS.green, transparency: 100 },
    fill: { color: COLORS.green }
  });
  slide.addText(leftTitle, {
    x: x + 0.15,
    y: y + 0.1,
    w: leftW - 0.25,
    h: 0.16,
    fontSize: 12,
    bold: true,
    color: COLORS.white,
    margin: 0
  });
  slide.addText(rightTitle, {
    x: x + leftW + 0.05,
    y: y + 0.1,
    w: rightW - 0.2,
    h: 0.16,
    fontSize: 12,
    bold: true,
    color: COLORS.white,
    align: "right",
    margin: 0
  });
  rows.forEach((row, idx) => {
    const rowY = y + rowH + idx * rowH;
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y: rowY,
      w: leftW + rightW,
      h: rowH,
      line: { color: "D9D3C5", pt: 0.5 },
      fill: { color: idx % 2 === 0 ? "FBF8F0" : COLORS.white }
    });
    slide.addText(row.label, {
      x: x + 0.15,
      y: rowY + 0.1,
      w: leftW - 0.25,
      h: 0.16,
      fontSize: 12,
      color: COLORS.ink,
      margin: 0
    });
    slide.addText(row.value, {
      x: x + leftW + 0.05,
      y: rowY + 0.1,
      w: rightW - 0.2,
      h: 0.16,
      fontSize: 12,
      color: COLORS.ink,
      align: "right",
      bold: row.bold ?? false,
      margin: 0
    });
  });
}

function addFooter(slide, text = "Deck Family Farm | Full Farm CSA | DigitalOcean-hosted CSA Store") {
  slide.addText(text, {
    x: 0.7,
    y: 7.05,
    w: 12,
    h: 0.18,
    fontSize: 9,
    color: COLORS.slate,
    align: "right",
    margin: 0
  });
}

function slideTitle() {
  const slide = pptx.addSlide();
  slide.background = { color: COLORS.cream };
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 13.333,
    h: 7.5,
    line: { color: COLORS.green, transparency: 100 },
    fill: { color: COLORS.green }
  });
  slide.addShape(pptx.ShapeType.rect, {
    x: 7.8,
    y: 0,
    w: 5.533,
    h: 7.5,
    line: { color: COLORS.moss, transparency: 100 },
    fill: { color: COLORS.moss }
  });
  slide.addText("CSA Store", {
    x: 0.85,
    y: 1.2,
    w: 5.8,
    h: 0.7,
    fontFace: "Aptos Display",
    fontSize: 28,
    bold: true,
    color: COLORS.white,
    margin: 0
  });
  slide.addText("What it does now, where it is going, and why it pays for itself", {
    x: 0.85,
    y: 2.05,
    w: 5.9,
    h: 1.1,
    fontSize: 17,
    color: COLORS.white,
    breakLine: true,
    margin: 0
  });
  slide.addText("Deck Family Farm / Full Farm CSA", {
    x: 0.85,
    y: 5.9,
    w: 4,
    h: 0.25,
    fontSize: 14,
    color: "E8E2D5",
    bold: true,
    margin: 0
  });
  slide.addText("May 14, 2026", {
    x: 0.85,
    y: 6.25,
    w: 3,
    h: 0.2,
    fontSize: 11,
    color: "E8E2D5",
    margin: 0
  });
  slide.addText("Objective", {
    x: 8.45,
    y: 1.4,
    w: 2,
    h: 0.2,
    fontSize: 13,
    bold: true,
    color: COLORS.white,
    margin: 0
  });
  addBullets(
    slide,
    [
      "Consolidate operations into one interface",
      "Improve subscriptions, pricing, analytics, and marketing control",
      "Build a platform the farm can actually own and steer"
    ],
    { x: 8.4, y: 1.85, w: 4.2, h: 3.4, fontSize: 16 }
  );
}

function slideCurrentSituation() {
  const slide = pptx.addSlide();
  addTitle(slide, "Current situation", "Today’s workflow is spread across several systems and manual handoffs.");
  addBullets(slide, [
    "Wix portal front-end and Wix CMS tables handle customer-facing pieces.",
    "Zapier hooks move data between tools.",
    "Local Line remains the core storefront backend.",
    "Standalone Node.js scripts fill reporting and operational gaps.",
    "Google Sheets still carries part of the customer and operations load.",
    "Result: duplicated work, weaker attribution, brittle reporting, and slower changes."
  ]);
  addSummaryBox(slide, "Current stack", "6+ moving parts", 8.25, 4.75, 2.1, 1.2, COLORS.barn);
  addSummaryBox(slide, "Operating pattern", "Scotch-tape ecosystem", 10.55, 4.75, 2.1, 1.2, COLORS.green);
  addFooter(slide);
}

function slideNow() {
  const slide = pptx.addSlide();
  addTitle(slide, "What CSA Store does now", "The application already functions as an operating layer around Local Line, subscriptions, and reporting.");
  addBullets(slide, [
    "Pulls Local Line products, orders, fulfillments, and subscriber snapshots into one local admin.",
    "Applies consistent pricing controls and formula-pricing rules from one place.",
    "Tracks drop-site performance, trends, and order behavior.",
    "Publishes operational dashboards and Google outputs from local data.",
    "Runs a local subscribe page with lead capture, agreement handling, and nearest drop-site / home-delivery guidance.",
    "Manages subscription leads in admin with status, notes, and signed records."
  ]);
  addFooter(slide);
}

function slideWhyOneInterface() {
  const slide = pptx.addSlide();
  addTitle(slide, "Why one interface matters", "Consolidation is not just cleaner architecture; it creates operating leverage.");
  addBullets(slide, [
    "One source of truth for pricing, subscriptions, analytics, and operations.",
    "Less reliance on Wix CMS tables, Zapier glue, standalone scripts, and Google Sheet workarounds.",
    "Faster changes because the team edits one application instead of coordinating several tools.",
    "Clearer control over pricing, customer conversion, reporting, and advertising efficiency.",
    "A platform that can keep expanding instead of adding another side tool each time a gap appears."
  ]);
  addFooter(slide);
}

function slideFutureState() {
  const slide = pptx.addSlide();
  addTitle(slide, "What we want it to do next", "The goal is vertical control of the system on a DigitalOcean-hosted application.");
  addBullets(slide, [
    "Replace remaining stitched-together workflows with one interface.",
    "Make subscriptions more efficient: capture leads, match people to nearest drop site or delivery, and track status through conversion.",
    "Add marketing attribution: campaigns, tracked links, subscriber source tracking, and location-aware analytics.",
    "Add better member lifecycle tools for retention, communication, and cleaner customer records.",
    "Use Codex-assisted design and iteration to improve the platform quickly without fragmenting the stack further."
  ]);
  addSummaryBox(slide, "End goal", "Operate the system in one place", 8.6, 5.0, 3.2, 1.1, COLORS.green);
  addFooter(slide);
}

function slideCostSavings() {
  const slide = pptx.addSlide();
  addTitle(slide, "ROI: direct cost savings", "The current tool stack carries recurring cost before counting lost efficiency.");
  addTwoColumnTableLike(slide, "Current annual tools and support", "Annual cost", [
    { label: "Local Line subscription", value: "$2,500" },
    { label: "Wix", value: "$1,500" },
    { label: "Biocode script support", value: "$5,000" },
    { label: "Wix design help", value: "$1,000" },
    { label: "Current annual total", value: "$10,000", bold: true },
    { label: "Target Biocode maintenance for CSA Store", value: "$5,000", bold: true },
    { label: "Direct annual savings", value: "$5,000", bold: true }
  ], { x: 0.85, y: 1.85, leftW: 6.6, rightW: 2.3, rowH: 0.45 });
  addSummaryBox(slide, "Direct savings", "$5K / year", 9.55, 2.4, 2.8, 1.3, COLORS.barn);
  addFooter(slide);
}

function slideGrowthUpside() {
  const slide = pptx.addSlide();
  addTitle(slide, "ROI: conversion and retention upside", "Better subscription tools create value even before marketing optimization.");
  addBullets(slide, [
    "Current assumption: about 150 members leave each year and about 150 new members come in.",
    "If better portal design and subscription tools improve new intake by 5% and retention by 5%, the business gains about 30 additional members per year.",
    "Estimated annual value of those 30 members: about $28,800."
  ], { h: 2.6 });
  addSummaryBox(slide, "Member upside", "30 additional members / year", 1.0, 4.8, 3.8, 1.2, COLORS.green);
  addSummaryBox(slide, "Estimated value", "$28.8K / year", 5.1, 4.8, 3.1, 1.2, COLORS.barn);
  slide.addText("This includes the value of better customer conversion and reduced churn from a cleaner member experience.", {
    x: 0.95,
    y: 6.35,
    w: 9.2,
    h: 0.3,
    fontSize: 11,
    color: COLORS.slate,
    italic: true,
    margin: 0
  });
  addFooter(slide);
}

function slidePricingUpside() {
  const slide = pptx.addSlide();
  addTitle(slide, "ROI: pricing and margin control", "Centralized pricing control creates profit leverage.");
  addBullets(slide, [
    "The application already centralizes price controls instead of scattering them across side tools.",
    "Better formula pricing, cleaner review, and less inconsistency improve margin discipline.",
    "Even a 2% improvement in markup management is estimated to produce more than $10,000 in annual net profit.",
    "This is not labor savings; it is direct operating value from better business control."
  ], { h: 3.2 });
  addSummaryBox(slide, "Pricing upside", "> $10K / year", 4.55, 4.9, 4.1, 1.35, COLORS.gold);
  addFooter(slide);
}

function slideMarketingUpside() {
  const slide = pptx.addSlide();
  addTitle(slide, "Marketing and attribution value", "The next phase is not just ad tracking; it is better allocation of spend and message.");
  addBullets(slide, [
    "Today, campaign performance and subscriber attribution are weak because the stack is fragmented.",
    "The planned marketing module would connect campaigns, tracked links, subscriber capture, drop-site demand, and spend decisions.",
    "This improves the ability to answer: where should we spend, which message belongs on which channel, and which locations are responding?",
    "That value is real, but it is not included in the base ROI math here."
  ], { h: 3.2 });
  addSummaryBox(slide, "Not yet counted", "Advertising efficiency upside", 4.45, 4.95, 4.4, 1.25, COLORS.green);
  addFooter(slide);
}

function slideSummary() {
  const slide = pptx.addSlide();
  addTitle(slide, "Annual value summary", "Base ROI case before additional marketing upside.");
  addTwoColumnTableLike(slide, "Source of value", "Annual value", [
    { label: "Direct software / support savings", value: "$5,000" },
    { label: "Conversion and retention upside", value: "$28,800" },
    { label: "Pricing and margin upside", value: ">$10,000" },
    { label: "Total identified annual value", value: ">$43,800", bold: true }
  ], { x: 0.9, y: 1.95, leftW: 6.6, rightW: 2.5, rowH: 0.52 });
  addSummaryBox(slide, "Annual maintenance", "$5K", 9.85, 2.3, 2.1, 1.15, COLORS.slate);
  addSummaryBox(slide, "Gross benefit", ">$43.8K", 9.85, 3.75, 2.1, 1.15, COLORS.green);
  addSummaryBox(slide, "ROI multiple", ">8x", 9.85, 5.2, 2.1, 1.15, COLORS.barn);
  addFooter(slide);
}

function slideEndGoal() {
  const slide = pptx.addSlide();
  addTitle(slide, "End goal", "Move from stitched-together operations to one controllable platform.");
  addBullets(slide, [
    "Manage subscriptions, pricing, analytics, customer workflows, and marketing in one place.",
    "Reduce reliance on fragile handoffs between Wix, Zapier, scripts, Local Line, and Google Sheets.",
    "Give the farm a platform it can improve, own, and operate deliberately over time.",
    "Use Codex-assisted design and iteration to keep improving workflow and business intelligence instead of paying for fragmented fixes."
  ]);
  addFooter(slide, "CSA Store target state | One operating platform instead of many stitched-together tools");
}

slideTitle();
slideCurrentSituation();
slideNow();
slideWhyOneInterface();
slideFutureState();
slideCostSavings();
slideGrowthUpside();
slidePricingUpside();
slideMarketingUpside();
slideSummary();
slideEndGoal();

const outPath = path.resolve("docs/csa_store_application_overview_deck.pptx");
await pptx.writeFile({ fileName: outPath });
console.log(`Wrote ${outPath}`);
