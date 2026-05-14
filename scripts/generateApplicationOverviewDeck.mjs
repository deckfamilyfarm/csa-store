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
    fontSize: 28,
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
      fontSize: 10,
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
  const fontSize = opts.fontSize ?? 18;
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
    fontSize: 18,
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
      "One interface",
      "Better conversion",
      "Stronger control"
    ],
    { x: 8.4, y: 1.85, w: 4.2, h: 3.4, fontSize: 18 }
  );
}

function slideCurrentSituation() {
  const slide = pptx.addSlide();
  addTitle(slide, "Current situation", "Too many systems. Too many handoffs.");
  addBullets(slide, [
    "Wix front-end and Wix CMS",
    "Zapier hooks",
    "Local Line backend",
    "Standalone Node scripts",
    "Google Sheets for customer operations",
    "Result: duplicated work and weak reporting"
  ]);
  addSummaryBox(slide, "Current stack", "6+ moving parts", 8.25, 4.75, 2.1, 1.2, COLORS.barn);
  addSummaryBox(slide, "Operating pattern", "Scotch-tape ecosystem", 10.55, 4.75, 2.1, 1.2, COLORS.green);
  addFooter(slide);
}

function slideNow() {
  const slide = pptx.addSlide();
  addTitle(slide, "What CSA Store does now", "The platform already acts as the operating layer.");
  addBullets(slide, [
    "Pulls Local Line orders, products, fulfillments, and subscribers",
    "Controls pricing from one place",
    "Tracks drop-site performance",
    "Publishes dashboards from local data",
    "Runs a local subscribe page",
    "Tracks subscription leads in admin"
  ]);
  addFooter(slide);
}

function slideWhyOneInterface() {
  const slide = pptx.addSlide();
  addTitle(slide, "Why one interface matters", "This is not just cleaner. It is more effective.");
  addBullets(slide, [
    "One source of truth",
    "Less Wix, Zapier, script, and Sheet overhead",
    "Faster changes",
    "Better pricing control",
    "Better conversion tracking",
    "Less manual work for Laura"
  ]);
  addSummaryBox(slide, "Laura's time", "Less admin friction", 8.9, 5.0, 2.8, 1.1, COLORS.slate);
  addFooter(slide);
}

function slideFutureState() {
  const slide = pptx.addSlide();
  addTitle(slide, "What we want next", "One vertically managed platform.");
  addBullets(slide, [
    "Replace the remaining stitched-together workflow",
    "Capture and convert subscription leads more efficiently",
    "Match members to nearest drop site or delivery",
    "Add campaign tracking and subscriber attribution",
    "Add better retention and communication tools",
    "Run it on DigitalOcean with Codex-assisted iteration"
  ]);
  addSummaryBox(slide, "End goal", "Operate the system in one place", 8.6, 5.0, 3.2, 1.1, COLORS.green);
  addFooter(slide);
}

function slideCostSavings() {
  const slide = pptx.addSlide();
  addTitle(slide, "ROI: direct cost savings", "Savings begin before growth upside.");
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
  addSummaryBox(slide, "Labor savings", "Less manual work", 9.55, 4.1, 2.8, 1.1, COLORS.green);
  addFooter(slide);
}

function slideGrowthUpside() {
  const slide = pptx.addSlide();
  addTitle(slide, "ROI: conversion and retention", "A better portal should grow members.");
  addBullets(slide, [
    "About 150 members leave each year",
    "About 150 new members join each year",
    "Better intake and retention can add about 30 members",
    "Estimated annual value: about $72,000"
  ], { h: 2.6 });
  addSummaryBox(slide, "Member upside", "30 additional members / year", 1.0, 4.8, 3.8, 1.2, COLORS.green);
  addSummaryBox(slide, "Estimated value", "$72K / year", 5.1, 4.8, 3.1, 1.2, COLORS.barn);
  slide.addText("This reflects both better conversion and better retention.", {
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
  addTitle(slide, "ROI: pricing and margin", "Pricing control directly drives profit.");
  addBullets(slide, [
    "Cleaner formula pricing",
    "Less inconsistency",
    "Better review of margin decisions",
    "A 2% markup improvement is worth more than $10K per year"
  ], { h: 3.2 });
  addSummaryBox(slide, "Pricing upside", "> $10K / year", 4.55, 4.9, 4.1, 1.35, COLORS.gold);
  addFooter(slide);
}

function slideMarketingUpside() {
  const slide = pptx.addSlide();
  addTitle(slide, "Marketing and attribution", "Spend should be guided by data.");
  addBullets(slide, [
    "Today, attribution is weak",
    "Future module connects campaigns, locations, subscriptions, and spend",
    "That improves where to spend and what to promote",
    "This upside is not included in the base ROI math"
  ], { h: 3.2 });
  addSummaryBox(slide, "Not yet counted", "Advertising efficiency upside", 4.45, 4.95, 4.4, 1.25, COLORS.green);
  addFooter(slide);
}

function slideSummary() {
  const slide = pptx.addSlide();
  addTitle(slide, "Annual value summary", "Base ROI before added marketing upside.");
  addTwoColumnTableLike(slide, "Source of value", "Annual value", [
    { label: "Direct software / support savings", value: "$5,000" },
    { label: "Conversion and retention upside", value: "$72,000" },
    { label: "Pricing and margin upside", value: ">$10,000" },
    { label: "Total identified annual value", value: ">$87,000", bold: true }
  ], { x: 0.9, y: 1.95, leftW: 6.6, rightW: 2.5, rowH: 0.52 });
  addSummaryBox(slide, "Annual maintenance", "$5K", 9.85, 2.3, 2.1, 1.15, COLORS.slate);
  addSummaryBox(slide, "Gross benefit", ">$87K", 9.85, 3.75, 2.1, 1.15, COLORS.green);
  addSummaryBox(slide, "ROI multiple", ">17x", 9.85, 5.2, 2.1, 1.15, COLORS.barn);
  addFooter(slide);
}

function slideEndGoal() {
  const slide = pptx.addSlide();
  addTitle(slide, "End goal", "One operating platform.");
  addBullets(slide, [
    "Run subscriptions, pricing, analytics, workflows, and marketing in one place",
    "Reduce fragile handoffs",
    "Own the platform",
    "Keep improving it with Codex-assisted iteration"
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
