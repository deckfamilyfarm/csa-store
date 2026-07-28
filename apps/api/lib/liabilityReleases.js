import crypto from "crypto";
import zlib from "zlib";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import xlsx from "xlsx";
import { eq } from "drizzle-orm";
import { ensureLiabilityReleaseSchema, getDb, getPool } from "../db.js";
import {
  liabilityReleaseImportBatches,
  liabilityReleaseSubmissions,
  liabilityReleaseTemplates,
  liabilityReleaseTemplateVersions
} from "../schema.js";
import { sendLiabilityReleaseEmails } from "./email.js";

export const PRODUCT_LIABILITY_AGREEMENT_URL =
  "https://docs.google.com/document/d/1VFMc4euofQ1S1kjtd6jZI46uxo6YKft9cufT6Q3-nrc/edit?tab=t.0";

export const PRODUCT_LIABILITY_AGREEMENT_TITLE =
  "Full Farm CSA LLC Product Liability Agreement";

export const PRODUCT_LIABILITY_AGREEMENT_PARAGRAPHS = [
  "Mailing address: P.O. Box 565, Junction City, OR 97128",
  "Farm Location: 25362 High Pass Rd, Junction City, OR 97448",
  "541-321-0925 • fullfarmcsa@deckfamilyfarm.com",
  "Thank you for becoming a member of the Full Farm CSA! We are excited to have you be part of our “farmily” and share in the adventure of producing wholesome, nutrient dense foods. Our commitment to you is to produce our farm products in the cleanest and safest way possible; however, it is important to acknowledge that there are inherent risks in consuming food direct from the farm, and we expect that you are educated in the decision to eat as we do. Your food options will include raw milk, farm-processed meat animals, eggs, vegetables, fruit, grains, and other incidentals. Oregon State law prohibits selling these products to consumers, so it needs to be made explicitly clear that our Full Farm CSA, herein called “FFCSA” is a membership group that shares ownership with the farm in the meat, milk and other products that the FFCSA produces.",
  "Ownership agreement:",
  "I/we agree to become full members in the FFCSA and take ownership, along with other FFCSA members, Deck Family Farm, Sweet Leaf Organics, Organic Corner Market, Little Wings Farm, Lonesome Whistle Farm, Camas Country Mill, Beetanical Apiary, and any additional member farms, in the dairy herd, any meat animals (hogs, cattle, poultry, sheep), laying hens, and produce, grains, legumes, nuts, honey and fruit crops. My membership fees listed on the financial agreement compensate the farmers for pasturing, feeding, milking, and any required health care for my animals, as well as the cost of producing the non-animal crops. Full Farm CSA LLC retains full decision-making power over animals and crops.",
  "I/we agree and understand that raw milk, farm processed meat, and the products that come to me direct from the garden are raw agricultural products and I/we accept all of the health benefits and concerns associated with it, and I/we do not hold Full Farm CSA LLC nor its members or member farms responsible for any food borne illnesses associated with raw milk, meat or raw produce, nuts, honey or fruit consumption.",
  "I/we have been informed and understand that I/we are choosing to receive as part of my farm membership raw cow milk and other raw agricultural products. I/we will not hold Full Farm CSA LLC, other FFCSA members, or member farms responsible or liable for any injury, in any way, after purchasing this membership and receiving the products including but not limited to raw milk, meat, eggs; and I/we am solely responsible for my health and safety while on the farm premises for any activity, including but not limited to: CSA pick-up, U-pick harvests, and farm events.",
  "I/we agree that I/we will not pursue any legal actions, suits, claims for relief, demands, damages, and any other obligations, known and unknown, suspected and unsuspected, in law or equity, direct or indirect, and whether now or in the future, for any injury or death arising from use of these products what-so-ever.",
  "I/we agree that my FFCSA Membership is not transferable and that I/we will not sell nor share my membership to/with anyone else. I/we agree to give written notice immediately upon decision to cancel membership. I/we agree that I am not entitled to a refund of unused membership shares, but may choose to donate unused funds to our Feed-a-Friend program.",
  "I/we understand as a FFCSA Member that it is my responsibility to ensure that any product I/we purchase is cared for properly to guarantee its freshness and quality. Therefore, I/we agree to bring clean containers and a cooler with ice to pick-up for safe transport of my goods to my home refrigerator and pantry. I/we also agree to conscientiously follow all health and safety guidelines while at pick-up and on the farm.",
  "I/we agree to pick up my share from my drop site or farm each week and if I/we intend to come to the farm for Friday pick up I/we will give 24 hours advance notice if I/we want to attend the farm dinner.",
  "I/we understand that Full Farm CSA LLC is committed to supplying a wide variety of abundant fresh farm products, however I/we understand that farming is unpredictable. In joining Full Farm CSA LLC, I/we understand that there will be variations in the quantity and the quality of food that I/we receive, including substitutions, depending on weather and other factors.",
  "By purchasing products through the Full Farm CSA, I/we have read and understand the Full Farm CSA LLC Product Liability Agreement and agree to their contents on behalf of my member household. This document supersedes any prior document on the same subject."
];

export const PRODUCT_LIABILITY_AGREEMENT_TEXT =
  PRODUCT_LIABILITY_AGREEMENT_PARAGRAPHS.join("\n\n");

export const VISITOR_RELEASE_TEXT = [
  "Document ID: 261389371293061",
  "RELEASE OF LIABILITY FOR VISITORS",
  "In exchange for participation in the activity of farm visiting or volunteering organized by Deck Family Farm, of 25362 High Pass Road, Junction City, Oregon, 97448 and/or use of the property, facilities, and services of Deck Family Farm, I agree for myself and (if applicable) for the members of my family to the following:",
  "AGREEMENT TO FOLLOW DIRECTIONS. I agree to observe and obey all posted rules and warnings, and further agree to follow any oral instructions or directions given by Deck Family Farm, or the employees, representatives, or agents of Deck Family Farm.",
  "ASSUMPTION OF THE RISKS AND RELEASE. I recognize that there are certain inherent risks associated with the above described activity and I assume full responsibility for personal injury to myself and (if applicable) my family members, and further release and discharge Deck Family Farm for injury, loss, or damage arising out of my or my family’s use of or presence upon the facilities of Deck Family Farm, whether caused by the fault of myself, my family, Deck Family Farm, or other third parties.",
  "INDEMNIFICATION. I agree to indemnify and defend Deck Family Farm against all claims, causes of actions, damages, judgments, costs, or expenses, including attorney fees and other litigation costs, which may in any way arise from my or my family’s use of or presence upon the facilities of Deck Family Farm.",
  "FEES. I agree to pay for all damages to the facilities of Deck Family Farm caused by any negligent, reckless, or willful actions by me or my family.",
  "APPLICABLE LAW. Any legal or equitable claim that may arise from participation in the above shall be resolved under Oregon law.",
  "NO DURESS. I agree and acknowledge that I am under no pressure or duress to sign this Agreement and that I have been given a reasonable opportunity to review it before signing. I further agree and acknowledge that I am free to have my own legal counsel review this Agreement if I so desire. I further agree and acknowledge that Deck Family Farm has offered to refund any fees I have paid to use its facilities if I choose not to sign this Agreement.",
  "ARM’S LENGTH AGREEMENT. This Agreement and each of its terms are the product of an arm’s length negotiation between the Parties. In the event any ambiguity is found to exist in the interpretation of this Agreement or any of its provisions, the Parties, and each of them, explicitly reject the application of any legal or equitable rule of interpretation which would lead to a construction either “for” or “against” a particular party based upon their status as the drafter of a specific term, language, or provision giving rise to such ambiguity.",
  "ENFORCEABILITY. The invalidity or unenforceability of any provisions of this Agreement, whether standing alone or as applied to a particular occurrence or circumstance, shall not affect the validity or enforceability of any other provision of this Agreement or of any other applications of such provisions, as the case may be, and such invalid or unenforceable provision shall be deemed not to be a part of this Agreement.",
  "ARBITRATION. All claims and disputes arising under or relating to this Agreement are to be settled by binding arbitration in the state of Oregon or another location mutually agreeable to the parties. An award of arbitration may be confirmed in a court of competent jurisdiction.",
  "I HAVE READ THIS DOCUMENT AND UNDERSTAND IT. I FURTHER UNDERSTAND THAT BY SIGNING THIS RELEASE, I VOLUNTARY SURRENDER CERTAIN LEGAL RIGHTS"
].join("\n\n");

export const FIREARM_LIABILITY_RELEASE_TEXT = [
  "FIREARMS LIABILITY RELEASE, ASSUMPTION OF RISK, AND INDEMNITY AGREEMENT",
  "This Firearms Liability Release is for visitors, volunteers, guests, participants, and any other person who handles, observes, transports, stores, shoots, or is present near firearms, ammunition, targets, shooting areas, firearm demonstrations, firearm instruction, hunting-related activities, or any other firearm-related activity on or around Deck Family Farm property at 25362 High Pass Road, Junction City, Oregon 97448, or any other location where Deck Family Farm, Full Farm CSA LLC, their owners, employees, representatives, hosts, volunteers, agents, contractors, affiliated farms, or event organizers are involved. In this agreement, those persons and entities are called the Released Parties.",
  "LEGAL CAPACITY AND FIREARM ELIGIBILITY. I represent that I am legally permitted to possess, handle, transport, and use firearms and ammunition under federal, state, and local law. I am not prohibited from possessing firearms. I am not under the influence of alcohol, marijuana, controlled substances, medication, fatigue, illness, or any condition that would impair my judgment, coordination, or ability to safely participate. If I am signing for a minor or another participant, I represent that I am the parent, legal guardian, or authorized responsible adult for that participant and that I accept responsibility for that participant's conduct and safety.",
  "AGREEMENT TO FOLLOW DIRECTIONS. I agree to follow all written, posted, and verbal safety instructions immediately. I agree that any firearm will be treated as loaded at all times; the muzzle will always be pointed in a safe direction; my finger will remain off the trigger until I am instructed that I may shoot and I am ready to shoot; I will know my target and what is beyond it; and I will not handle, load, unload, display, dry fire, shoot, clean, transport, or pass any firearm or ammunition except as specifically allowed by the person supervising the activity. I agree to wear eye and ear protection when instructed. I agree that the supervising person may immediately stop my participation for any reason, including unsafe conduct, unsafe conditions, or failure to follow instructions.",
  "ASSUMPTION OF INHERENT AND EXTRAORDINARY RISKS. I understand that firearm-related activities are inherently dangerous and can result in serious bodily injury, permanent disability, emotional distress, property damage, or death. Risks include, but are not limited to: accidental or negligent discharge; ricochet; bullet or projectile impact; misfire, hangfire, squib load, malfunction, or equipment failure; hearing damage; eye injury; burns; cuts; lead or chemical exposure; falling, tripping, uneven ground, weather, animals, vehicles, gates, fences, farm equipment, and the acts or omissions of other participants or third parties. I knowingly and voluntarily assume all risks, known and unknown, foreseeable and unforeseeable, associated with being present for or participating in firearm-related activities.",
  "RELEASE OF LIABILITY. To the fullest extent allowed by Oregon law, I release and discharge the Released Parties from all claims, demands, causes of action, damages, losses, costs, attorney fees, expenses, or liability of any kind arising out of or related to my presence on the property or my participation in firearm-related activities, including claims involving ordinary negligence. This release is intended to be as broad and inclusive as Oregon law permits. It does not release claims that cannot legally be released under Oregon law.",
  "INDEMNIFICATION AND DUTY TO DEFEND. I agree to indemnify, defend, and hold harmless the Released Parties from any claim, demand, cause of action, damage, judgment, cost, attorney fee, expense, or liability arising out of or related to my conduct, my firearm or ammunition, my guests, any participant for whom I sign, my violation of law or safety instructions, or any claim brought by or on behalf of a participant for whom I sign.",
  "PERSONAL RESPONSIBILITY FOR FIREARMS AND AMMUNITION. I am responsible for any firearm, ammunition, magazine, holster, case, target, equipment, or personal property I bring or control. I agree not to bring unsafe, illegal, modified, defective, or inappropriate firearms or ammunition. I agree that firearms and ammunition must remain secured unless expressly authorized for use. I agree to comply with all applicable firearm storage, transportation, possession, and use laws.",
  "MEDICAL TREATMENT. If I or a participant for whom I sign is injured or appears to need emergency care, I authorize the Released Parties to seek emergency medical assistance. I understand that the Released Parties are not required to provide medical care and that I am responsible for medical costs arising from my participation or the participation of anyone for whom I sign.",
  "APPLICABLE LAW AND SEVERABILITY. This agreement is governed by Oregon law. If any provision is found invalid or unenforceable, the remaining provisions remain in effect to the fullest extent allowed by law.",
  "VOLUNTARY ELECTRONIC SIGNATURE. I have had the opportunity to read this agreement, ask questions, decline participation, and seek legal advice before signing. By signing electronically, I agree that my electronic signature has the same legal effect as a handwritten signature. I understand that I am giving up substantial legal rights, including the right to sue for certain claims.",
  "I HAVE READ THIS FIREARMS LIABILITY RELEASE, UNDERSTAND IT, AND SIGN IT VOLUNTARILY."
].join("\n\n");

const DEFAULT_TEMPLATES = [
  {
    slug: "visitor",
    title: "Visitor Liability Release",
    description: "General visitor release replacing the former Jotform visitor agreement.",
    bodyText: VISITOR_RELEASE_TEXT,
    sourceUrl:
      "https://www.jotform.com/sign/240635472078055/invite/01hr8v2cnv65524c8ac72550cf",
    status: "published",
    publicPath: "/liability/visitor",
    renewalMonths: null,
    requiresParticipants: 0,
    allowDrawnSignature: 1
  },
  {
    slug: "horse",
    title: "Horse Liability Release",
    description: "Horse and equine activity release replacing the former Jotform horse agreement.",
    bodyText: "",
    sourceUrl:
      "https://www.jotform.com/sign/241205842481048/invite/01hwr9k4j04390b77f6afbb433",
    status: "draft",
    publicPath: "/liability/horse",
    renewalMonths: null,
    requiresParticipants: 1,
    allowDrawnSignature: 1
  },
  {
    slug: "firearm",
    title: "Firearms Liability Release",
    description: "Firearms activity release for visitors and participants.",
    bodyText: FIREARM_LIABILITY_RELEASE_TEXT,
    sourceUrl: "",
    status: "published",
    publicPath: "/liability/firearm",
    renewalMonths: null,
    requiresParticipants: 0,
    allowDrawnSignature: 1
  },
  {
    slug: "product-liability",
    title: PRODUCT_LIABILITY_AGREEMENT_TITLE,
    description: "Product liability agreement signed during Full Farm CSA subscription.",
    bodyText: PRODUCT_LIABILITY_AGREEMENT_TEXT,
    sourceUrl: PRODUCT_LIABILITY_AGREEMENT_URL,
    status: "published",
    publicPath: "",
    renewalMonths: null,
    requiresParticipants: 0,
    allowDrawnSignature: 1
  }
];

let spacesClient = null;

function getSpacesClient() {
  if (!spacesClient) {
    spacesClient = new S3Client({
      region: process.env.DO_SPACES_REGION || "sfo3",
      endpoint: process.env.DO_SPACES_ENDPOINT,
      credentials: {
        accessKeyId: process.env.DO_SPACES_KEY,
        secretAccessKey: process.env.DO_SPACES_SECRET
      }
    });
  }
  return spacesClient;
}

export function hasLiabilityReleaseStorageConfig() {
  return Boolean(
    process.env.DO_SPACES_BUCKET &&
      process.env.DO_SPACES_ENDPOINT &&
      process.env.DO_SPACES_KEY &&
      process.env.DO_SPACES_SECRET
  );
}

function buildPublicUrl(key) {
  const base = process.env.DO_SPACES_PUBLIC_BASE_URL;
  if (base) return `${base.replace(/\/$/, "")}/${key}`;
  return `${process.env.DO_SPACES_ENDPOINT}/${process.env.DO_SPACES_BUCKET}/${key}`;
}

function cleanString(value, maxLength = 255) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return trimmed.slice(0, maxLength);
}

function cleanOptionalString(value, maxLength = 255) {
  const trimmed = cleanString(value, maxLength);
  return trimmed || null;
}

function cleanOptionalText(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
}

function normalizeStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "published") return "published";
  if (normalized === "archived") return "archived";
  return "draft";
}

function toBooleanTinyInt(value, fallback = 0) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === 1 || value === "1") return 1;
  if (value === 0 || value === "0") return 0;
  const normalized = String(value || "").trim().toLowerCase();
  if (["true", "yes", "on"].includes(normalized)) return 1;
  if (["false", "no", "off"].includes(normalized)) return 0;
  return fallback;
}

function toNullableInt(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const numeric = Number.parseInt(text, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function validatePublicLiabilityHumanCheck(payload = {}) {
  const honeypot = cleanString(payload.website || payload.companyWebsite || payload.url, 255);
  if (honeypot) {
    const error = new Error("Unable to submit this release.");
    error.status = 400;
    throw error;
  }

  const answer = String(payload.humanCheck || payload.liabilityReleaseHumanCheck || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (!["farm", "deck", "deckfamilyfarm", "fullfarm"].includes(answer)) {
    const error = new Error('Type "farm" in the human check field.');
    error.status = 400;
    throw error;
  }
}

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function isLikelySpamLiabilityRelease(row = {}) {
  const sourceType = String(row.sourceType || "").trim().toLowerCase();
  if (sourceType && sourceType !== "public") return false;

  const name = String(row.signerName || "").trim();
  const email = String(row.signerEmail || "").trim().toLowerCase();
  const phone = String(row.signerPhone || "").trim();
  const address = [
    row.signerAddressLine1,
    row.signerAddressLine2,
    row.signerCity,
    row.signerPostalCode
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");

  const compactName = name.replace(/\s+/g, "");
  const randomTokenName =
    compactName.length >= 14 &&
    /^[a-z0-9]+$/i.test(compactName) &&
    /[a-z]/.test(compactName) &&
    /[A-Z]/.test(compactName) &&
    !phone &&
    !address;
  const invalidEmail = email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const dotHeavyEmail = /^[^@]*\.{2,}[^@]*@/.test(email);

  return randomTokenName || invalidEmail || dotHeavyEmail;
}

export function parseSignatureDataUrl(value) {
  const input = String(value || "").trim();
  const match = input.match(/^data:(image\/png);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (!buffer.length) return null;
    return {
      mimeType: match[1].toLowerCase(),
      buffer,
      hash: crypto.createHash("sha256").update(buffer).digest("hex")
    };
  } catch (_error) {
    return null;
  }
}

function wrapPdfText(text, maxChars = 86) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function formatDateLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/Los_Angeles"
  });
}

function computeExpiresAt(version, signedAt) {
  const months = toNullableInt(version.renewalMonths);
  if (!months) return null;
  const expires = new Date(signedAt);
  expires.setMonth(expires.getMonth() + months);
  return expires;
}

function normalizeParticipants(value) {
  const raw = Array.isArray(value) ? value : parseJsonArray(value);
  return raw
    .map((entry) => ({
      name: cleanString(entry?.name || entry?.participantName || entry, 255),
      relationship: cleanOptionalString(entry?.relationship, 128),
      minor: toBooleanTinyInt(entry?.minor, 0),
      birthdate: cleanOptionalString(entry?.birthdate || entry?.dateOfBirth, 32)
    }))
    .filter((entry) => entry.name);
}

async function buildSignedReleasePdf({
  templateVersion,
  signer,
  participants = [],
  signatureBuffer,
  signatureMode,
  sourceHost,
  sourcePath,
  signedAt
}) {
  const pdfDoc = await PDFDocument.create();
  let page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
  const signatureImage = signatureBuffer ? await pdfDoc.embedPng(signatureBuffer) : null;
  const pageSize = [612, 792];
  const marginX = 48;
  const pageBottom = 56;

  function newPage() {
    page = pdfDoc.addPage(pageSize);
    return 740;
  }

  function drawWrapped(text, options = {}) {
    const lines = wrapPdfText(text, options.maxChars || 88);
    for (const line of lines) {
      if (y <= pageBottom) y = newPage();
      page.drawText(line, {
        x: marginX,
        y,
        size: options.size || 10.5,
        font: options.font || font,
        color: options.color || rgb(0.12, 0.11, 0.09)
      });
      y -= options.lineHeight || 14;
    }
    y -= options.after || 8;
  }

  let y = 740;
  page.drawText(templateVersion.title, {
    x: marginX,
    y,
    size: 20,
    font: boldFont,
    color: rgb(0.12, 0.18, 0.23)
  });
  y -= 30;
  drawWrapped(`Template: ${templateVersion.slug} v${templateVersion.versionNumber}`, {
    size: 10,
    after: 2
  });
  if (templateVersion.sourceUrl) {
    drawWrapped(`Agreement source: ${templateVersion.sourceUrl}`, { size: 10, after: 2 });
  }
  y -= 8;

  const signerLines = [
    `Signer: ${signer.signerName}`,
    `Email: ${signer.signerEmail || "Not provided"}`,
    `Phone: ${signer.signerPhone || "Not provided"}`,
    `Signed at: ${formatDateLabel(signedAt) || signedAt.toISOString()}`,
    `Source: ${[sourceHost, sourcePath].filter(Boolean).join("") || "CSA Store"}`
  ];
  signerLines.forEach((line) => drawWrapped(line, { size: 11, after: 2 }));

  if (participants.length) {
    y -= 10;
    page.drawText("Covered Participants", {
      x: marginX,
      y,
      size: 14,
      font: boldFont,
      color: rgb(0.12, 0.18, 0.23)
    });
    y -= 22;
    participants.forEach((participant, index) => {
      const parts = [
        `${index + 1}. ${participant.name}`,
        participant.relationship ? `relationship: ${participant.relationship}` : "",
        participant.minor ? "minor" : "",
        participant.birthdate ? `DOB: ${participant.birthdate}` : ""
      ].filter(Boolean);
      drawWrapped(parts.join(" - "), { size: 10.5, after: 2 });
    });
  }

  y -= 12;
  page.drawText("Agreement Text", {
    x: marginX,
    y,
    size: 14,
    font: boldFont,
    color: rgb(0.12, 0.18, 0.23)
  });
  y -= 24;

  String(templateVersion.bodyText || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .forEach((paragraph) => {
      const isHeading = paragraph.endsWith(":");
      drawWrapped(paragraph, {
        maxChars: 92,
        size: isHeading ? 12 : 10.5,
        font: isHeading ? boldFont : font,
        lineHeight: isHeading ? 16 : 14,
        after: isHeading ? 6 : 10
      });
    });

  y = newPage();
  page.drawText("Signature", {
    x: marginX,
    y,
    size: 14,
    font: boldFont,
    color: rgb(0.12, 0.18, 0.23)
  });
  y -= 160;
  if (signatureImage) {
    const dims = signatureImage.scale(0.5);
    page.drawImage(signatureImage, {
      x: marginX,
      y,
      width: Math.min(dims.width, 320),
      height: Math.min(dims.height, 120)
    });
  } else {
    page.drawText(signer.signerName, {
      x: marginX,
      y: y + 42,
      size: 28,
      font: italicFont,
      color: rgb(0.12, 0.11, 0.09)
    });
    page.drawText("Electronic signature by typed name", {
      x: marginX,
      y: y + 16,
      size: 10,
      font,
      color: rgb(0.35, 0.3, 0.26)
    });
  }
  page.drawLine({
    start: { x: marginX, y: y - 8 },
    end: { x: 380, y: y - 8 },
    thickness: 1,
    color: rgb(0.12, 0.11, 0.09)
  });
  page.drawText(signer.signerName, {
    x: marginX,
    y: y - 24,
    size: 10,
    font,
    color: rgb(0.12, 0.11, 0.09)
  });
  page.drawText(`Signature mode: ${signatureMode}`, {
    x: marginX,
    y: y - 42,
    size: 10,
    font,
    color: rgb(0.35, 0.3, 0.26)
  });

  return Buffer.from(await pdfDoc.save());
}

async function uploadLiabilityReleasePdf({ buffer, key, contentType = "application/pdf" }) {
  if (!hasLiabilityReleaseStorageConfig()) {
    throw new Error(
      "Signed release storage is not configured. Set DO_SPACES_BUCKET, DO_SPACES_ENDPOINT, DO_SPACES_KEY, and DO_SPACES_SECRET."
    );
  }

  await getSpacesClient().send(
    new PutObjectCommand({
      Bucket: process.env.DO_SPACES_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: "public-read"
    })
  );
  return buildPublicUrl(key);
}

function buildSubmissionStorageKey({ slug, signedAt, sourceType = "public", extension = "pdf" }) {
  const stamp = signedAt.toISOString().replace(/[:.]/g, "-");
  const nonce = crypto.randomBytes(6).toString("hex");
  return `liability-releases/${slug}/${signedAt.getUTCFullYear()}/${String(
    signedAt.getUTCMonth() + 1
  ).padStart(2, "0")}/${sourceType}-${stamp}-${nonce}.${extension}`;
}

export async function ensureDefaultLiabilityReleaseTemplates() {
  await ensureLiabilityReleaseSchema();
  const pool = getPool();
  const now = new Date();

  for (const template of DEFAULT_TEMPLATES) {
    await pool.query(
      `
        INSERT INTO liability_release_templates (
          slug, title, description, body_text, source_url, status, public_path,
          renewal_months, requires_participants, allow_drawn_signature,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          title = IF(body_text IS NULL OR TRIM(body_text) = '' OR slug = 'product-liability', VALUES(title), title),
          description = IF(description IS NULL OR TRIM(description) = '' OR slug = 'product-liability', VALUES(description), description),
          body_text = IF(body_text IS NULL OR TRIM(body_text) = '' OR slug = 'product-liability', VALUES(body_text), body_text),
          source_url = IF(source_url IS NULL OR TRIM(source_url) = '' OR slug = 'product-liability', VALUES(source_url), source_url),
          status = IF(
            (body_text IS NULL OR TRIM(body_text) = '')
              AND VALUES(body_text) IS NOT NULL
              AND TRIM(VALUES(body_text)) <> '',
            VALUES(status),
            status
          ),
          public_path = IF(public_path IS NULL OR TRIM(public_path) = '', VALUES(public_path), public_path),
          requires_participants = IF(slug = 'visitor', VALUES(requires_participants), requires_participants),
          updated_at = VALUES(updated_at)
      `,
      [
        template.slug,
        template.title,
        template.description,
        template.bodyText,
        template.sourceUrl,
        template.status,
        template.publicPath,
        template.renewalMonths,
        template.requiresParticipants,
        template.allowDrawnSignature,
        now,
        now
      ]
    );
  }

  const [publishedRows] = await pool.query(
    `
      SELECT *
      FROM liability_release_templates
      WHERE status = 'published'
        AND current_version_id IS NULL
        AND body_text IS NOT NULL
        AND TRIM(body_text) <> ''
    `
  );
  for (const template of publishedRows) {
    await publishLiabilityReleaseTemplate(template.id, { userId: null });
  }

  const [visitorVersionRows] = await pool.query(
    `
      SELECT
        t.id AS templateId,
        t.requires_participants AS templateRequiresParticipants,
        v.requires_participants AS versionRequiresParticipants
      FROM liability_release_templates t
      LEFT JOIN liability_release_template_versions v ON v.id = t.current_version_id
      WHERE t.slug = 'visitor'
      LIMIT 1
    `
  );
  const visitorVersion = visitorVersionRows[0];
  if (
    visitorVersion &&
    Number(visitorVersion.templateRequiresParticipants || 0) === 0 &&
    Number(visitorVersion.versionRequiresParticipants || 0) !== 0
  ) {
    await publishLiabilityReleaseTemplate(visitorVersion.templateId, { userId: null });
  }
}

export async function listLiabilityReleaseTemplates({ includeArchived = false } = {}) {
  await ensureDefaultLiabilityReleaseTemplates();
  const db = getDb();
  const rows = await db.select().from(liabilityReleaseTemplates);
  return rows
    .filter((row) => includeArchived || row.status !== "archived")
    .sort((left, right) => String(left.slug).localeCompare(String(right.slug)));
}

export async function getLiabilityReleaseTemplateBySlug(slug, { publicOnly = false } = {}) {
  await ensureDefaultLiabilityReleaseTemplates();
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(liabilityReleaseTemplates)
    .where(eq(liabilityReleaseTemplates.slug, normalizedSlug));
  const template = rows[0] || null;
  if (!template) return null;
  if (publicOnly && (template.status !== "published" || !template.currentVersionId)) return null;
  return template;
}

export async function getPublishedLiabilityReleaseVersion(slugOrTemplate) {
  const template =
    typeof slugOrTemplate === "object"
      ? slugOrTemplate
      : await getLiabilityReleaseTemplateBySlug(slugOrTemplate, { publicOnly: true });
  if (!template?.currentVersionId) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(liabilityReleaseTemplateVersions)
    .where(eq(liabilityReleaseTemplateVersions.id, Number(template.currentVersionId)));
  return rows[0] || null;
}

export async function upsertLiabilityReleaseTemplate(payload = {}, { userId = null } = {}) {
  await ensureDefaultLiabilityReleaseTemplates();
  const db = getDb();
  const now = new Date();
  const templateId = Number(payload.id || 0);
  const slug = normalizeSlug(payload.slug);
  const title = cleanString(payload.title);
  if (!slug) {
    const error = new Error("Template slug is required.");
    error.status = 400;
    throw error;
  }
  if (!title) {
    const error = new Error("Template title is required.");
    error.status = 400;
    throw error;
  }

  const values = {
    slug,
    title,
    description: cleanOptionalText(payload.description),
    bodyText: cleanOptionalText(payload.bodyText),
    sourceUrl: cleanOptionalString(payload.sourceUrl, 2048),
    status: normalizeStatus(payload.status),
    publicPath: cleanOptionalString(payload.publicPath, 255),
    renewalMonths: toNullableInt(payload.renewalMonths),
    requiresParticipants: toBooleanTinyInt(payload.requiresParticipants, 0),
    allowDrawnSignature: toBooleanTinyInt(payload.allowDrawnSignature, 1),
    updatedByUserId: userId,
    updatedAt: now
  };

  if (templateId > 0) {
    const existingRows = await db
      .select()
      .from(liabilityReleaseTemplates)
      .where(eq(liabilityReleaseTemplates.id, templateId));
    if (!existingRows.length) {
      const error = new Error("Release template not found.");
      error.status = 404;
      throw error;
    }
    await db
      .update(liabilityReleaseTemplates)
      .set(values)
      .where(eq(liabilityReleaseTemplates.id, templateId));
    const updatedRows = await db
      .select()
      .from(liabilityReleaseTemplates)
      .where(eq(liabilityReleaseTemplates.id, templateId));
    return updatedRows[0] || null;
  }

  const result = await db.insert(liabilityReleaseTemplates).values({
    ...values,
    currentVersionId: null,
    createdByUserId: userId,
    createdAt: now
  });
  const insertedId = Number(result[0]?.insertId);
  const insertedRows = await db
    .select()
    .from(liabilityReleaseTemplates)
    .where(eq(liabilityReleaseTemplates.id, insertedId));
  return insertedRows[0] || null;
}

export async function publishLiabilityReleaseTemplate(templateId, { userId = null } = {}) {
  await ensureLiabilityReleaseSchema();
  const db = getDb();
  const pool = getPool();
  const id = Number(templateId);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error("Valid template id is required.");
    error.status = 400;
    throw error;
  }
  const rows = await db
    .select()
    .from(liabilityReleaseTemplates)
    .where(eq(liabilityReleaseTemplates.id, id));
  const template = rows[0] || null;
  if (!template) {
    const error = new Error("Release template not found.");
    error.status = 404;
    throw error;
  }
  if (!cleanOptionalText(template.bodyText)) {
    const error = new Error("Release template text is required before publishing.");
    error.status = 400;
    throw error;
  }

  const [versionRows] = await pool.query(
    "SELECT COALESCE(MAX(version_number), 0) AS maxVersion FROM liability_release_template_versions WHERE template_id = ?",
    [id]
  );
  const versionNumber = Number(versionRows[0]?.maxVersion || 0) + 1;
  const now = new Date();
  const result = await db.insert(liabilityReleaseTemplateVersions).values({
    templateId: id,
    versionNumber,
    slug: template.slug,
    title: template.title,
    description: template.description,
    bodyText: template.bodyText,
    sourceUrl: template.sourceUrl,
    publicPath: template.publicPath,
    renewalMonths: template.renewalMonths,
    requiresParticipants: template.requiresParticipants,
    allowDrawnSignature: template.allowDrawnSignature,
    publishedByUserId: userId,
    publishedAt: now,
    createdAt: now
  });
  const versionId = Number(result[0]?.insertId);
  await db
    .update(liabilityReleaseTemplates)
    .set({
      status: "published",
      currentVersionId: versionId,
      publishedAt: now,
      updatedAt: now,
      updatedByUserId: userId
    })
    .where(eq(liabilityReleaseTemplates.id, id));

  const updatedRows = await db
    .select()
    .from(liabilityReleaseTemplates)
    .where(eq(liabilityReleaseTemplates.id, id));
  return {
    template: updatedRows[0] || null,
    versionId,
    versionNumber
  };
}

export function publicTemplatePayload(template, version) {
  if (!template || !version) return null;
  return {
    slug: template.slug,
    title: version.title,
    description: version.description,
    bodyText: version.bodyText,
    sourceUrl: version.sourceUrl,
    publicPath: version.publicPath,
    renewalMonths: version.renewalMonths,
    requiresParticipants: Boolean(version.requiresParticipants),
    allowDrawnSignature: Boolean(version.allowDrawnSignature),
    versionNumber: version.versionNumber,
    publishedAt: version.publishedAt
  };
}

export async function createSignedLiabilityRelease({
  slug,
  payload = {},
  sourceType = "public",
  subscribeLeadId = null,
  memberUserId = null,
  sourceHost = null,
  sourcePath = null,
  sendEmails = true
}) {
  await ensureDefaultLiabilityReleaseTemplates();
  if (sourceType === "public") validatePublicLiabilityHumanCheck(payload);
  const template = await getLiabilityReleaseTemplateBySlug(slug, { publicOnly: true });
  if (!template) {
    const error = new Error("This release is not available for signing.");
    error.status = 404;
    throw error;
  }
  const version = await getPublishedLiabilityReleaseVersion(template);
  if (!version) {
    const error = new Error("This release does not have a published version.");
    error.status = 404;
    throw error;
  }

  const signer = {
    signerName: cleanString(payload.signerName || payload.liabilityAgreementSignerName),
    signerEmail: cleanOptionalString(payload.signerEmail || payload.email, 255),
    signerPhone: cleanOptionalString(payload.signerPhone || payload.phone, 64),
    signerAddressLine1: cleanOptionalString(payload.signerAddressLine1 || payload.addressLine1, 255),
    signerAddressLine2: cleanOptionalString(payload.signerAddressLine2 || payload.addressLine2, 255),
    signerCity: cleanOptionalString(payload.signerCity || payload.city, 255),
    signerStateProvince: cleanOptionalString(
      payload.signerStateProvince || payload.stateProvince,
      255
    ),
    signerPostalCode: cleanOptionalString(payload.signerPostalCode || payload.postalCode, 32)
  };
  if (!signer.signerName) {
    const error = new Error("Signer full name is required.");
    error.status = 400;
    throw error;
  }
  if (!payload.accepted && !payload.liabilityAgreementAccepted) {
    const error = new Error("You must review and accept the release.");
    error.status = 400;
    throw error;
  }
  const participants = normalizeParticipants(payload.participants);
  if (version.requiresParticipants && !participants.length) {
    const error = new Error("At least one covered participant is required.");
    error.status = 400;
    throw error;
  }

  const signatureMode =
    String(payload.signatureMode || payload.liabilityAgreementSignatureMode || "typed")
      .trim()
      .toLowerCase() === "draw"
      ? "draw"
      : "typed";
  const signature =
    signatureMode === "draw"
      ? parseSignatureDataUrl(
          payload.signatureDataUrl || payload.liabilityAgreementSignatureDataUrl
        )
      : null;
  if (signatureMode === "draw" && !signature) {
    const error = new Error("Please provide a drawn signature.");
    error.status = 400;
    throw error;
  }

  const signedAt = new Date();
  const expiresAt = computeExpiresAt(version, signedAt);
  const pdf = await buildSignedReleasePdf({
    templateVersion: version,
    signer,
    participants,
    signatureBuffer: signature?.buffer || null,
    signatureMode,
    sourceHost,
    sourcePath,
    signedAt
  });
  const storageKey = buildSubmissionStorageKey({
    slug: version.slug,
    signedAt,
    sourceType
  });
  const recordUrl = await uploadLiabilityReleasePdf({ buffer: pdf, key: storageKey });
  const now = new Date();
  const db = getDb();
  const result = await db.insert(liabilityReleaseSubmissions).values({
    templateId: template.id,
    templateVersionId: version.id,
    templateSlug: version.slug,
    templateTitle: version.title,
    status: "signed",
    sourceType,
    sourceSubmissionId: cleanOptionalString(payload.sourceSubmissionId, 255),
    subscribeLeadId,
    memberUserId,
    ...signer,
    participantJson: JSON.stringify(participants),
    signatureMode,
    signatureHash:
      signature?.hash ||
      crypto.createHash("sha256").update(`${signer.signerName}:${signedAt.toISOString()}`).digest("hex"),
    acceptedAt: signedAt,
    signedAt,
    expiresAt,
    sourceHost: cleanOptionalString(sourceHost, 255),
    sourcePath: cleanOptionalString(sourcePath, 255),
    documentUrl: version.sourceUrl,
    recordUrl,
    storageKey,
    notes: cleanOptionalText(payload.notes),
    rawJson: JSON.stringify(payload || {}),
    createdAt: now,
    updatedAt: now
  });
  const submissionId = Number(result[0]?.insertId);
  const rows = await db
    .select()
    .from(liabilityReleaseSubmissions)
    .where(eq(liabilityReleaseSubmissions.id, submissionId));
  const submission = rows[0] || null;

  if (sendEmails) {
    await sendLiabilityReleaseEmails({ submission, template: version }).catch((error) => {
      console.warn("Liability release email skipped:", error?.message || error);
    });
  }

  return submission;
}

export async function listSignedLiabilityReleases({
  includeHidden = false,
  includeSpam = false,
  templateSlug = ""
} = {}) {
  await ensureDefaultLiabilityReleaseTemplates();
  const normalizedTemplateSlug = normalizeSlug(templateSlug);
  const db = getDb();
  const rows = await db.select().from(liabilityReleaseSubmissions);
  return rows
    .filter((row) => {
      const status = String(row.status || "signed").trim().toLowerCase();
      if (includeHidden) {
        if (!["signed", "hidden"].includes(status)) return false;
      } else if (status !== "signed") {
        return false;
      }
      if (!includeSpam && isLikelySpamLiabilityRelease(row)) return false;
      return !normalizedTemplateSlug || row.templateSlug === normalizedTemplateSlug;
    })
    .map((row) => ({
      ...row,
      participants: parseJsonArray(row.participantJson)
    }))
    .sort((left, right) => {
      const leftTime = left.signedAt ? new Date(left.signedAt).getTime() : 0;
      const rightTime = right.signedAt ? new Date(right.signedAt).getTime() : 0;
      return rightTime - leftTime || Number(right.id || 0) - Number(left.id || 0);
    });
}

export async function updateLiabilityReleaseSubmissionStatus(
  submissionId,
  payload = {}
) {
  await ensureDefaultLiabilityReleaseTemplates();
  const id = Number(submissionId);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error("Valid liability release id is required.");
    error.status = 400;
    throw error;
  }

  const status = String(payload.status || "")
    .trim()
    .toLowerCase();
  if (!["signed", "hidden"].includes(status)) {
    const error = new Error("Release status must be signed or hidden.");
    error.status = 400;
    throw error;
  }

  const db = getDb();
  const existingRows = await db
    .select()
    .from(liabilityReleaseSubmissions)
    .where(eq(liabilityReleaseSubmissions.id, id));
  if (!existingRows.length) {
    const error = new Error("Signed liability release not found.");
    error.status = 404;
    throw error;
  }

  const updateValues = {
    status,
    updatedAt: new Date()
  };
  const adminNotes = cleanOptionalText(payload.adminNotes);
  if (adminNotes) updateValues.adminNotes = adminNotes;

  await db
    .update(liabilityReleaseSubmissions)
    .set(updateValues)
    .where(eq(liabilityReleaseSubmissions.id, id));

  const updatedRows = await db
    .select()
    .from(liabilityReleaseSubmissions)
    .where(eq(liabilityReleaseSubmissions.id, id));
  const row = updatedRows[0] || null;
  return row ? { ...row, participants: parseJsonArray(row.participantJson) } : null;
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values.map((value) => value.trim());
}

export function parseLegacyReleaseCsv(buffer) {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((header) =>
    header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
  );
  return lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    const row = { rowNumber: index + 2 };
    headers.forEach((header, headerIndex) => {
      row[header] = values[headerIndex] || "";
    });
    return row;
  });
}

function normalizeImportHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function parseLegacyReleaseXlsx(buffer) {
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
  return rows.map((row, index) => {
    const normalized = { rowNumber: index + 2 };
    Object.entries(row).forEach(([key, value]) => {
      normalized[normalizeImportHeader(key)] = value;
    });
    return normalized;
  });
}

function parseLegacyReleaseRows(file) {
  const name = String(file?.originalname || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    return parseLegacyReleaseXlsx(file.buffer);
  }
  return parseLegacyReleaseCsv(file.buffer);
}

function firstRowValue(row, keys = []) {
  for (const key of keys) {
    const value = row[key];
    if (String(value ?? "").trim()) return value;
  }
  return "";
}

function deriveJotformSourceSubmissionId(signatureUrl) {
  const url = cleanOptionalString(signatureUrl, 2048);
  if (!url) return null;
  const matches = [...url.matchAll(/(\d{8,})(?=\/|_signature|\.png|$)/g)].map(
    (match) => match[1]
  );
  if (matches.length) return `jotform:${matches[matches.length - 1]}`;
  return `jotform-signature:${crypto.createHash("sha256").update(url).digest("hex").slice(0, 32)}`;
}

function normalizeLegacyImportRow(row) {
  const signatureUrl = cleanOptionalString(firstRowValue(row, ["signature_url", "signature"]), 2048);
  const signerName = cleanString(firstRowValue(row, ["signer_name", "printed_name", "name"]));
  const inferredVisitorSlug = signerName && signatureUrl ? "visitor" : "";
  return {
    ...row,
    templateSlug: normalizeSlug(
      firstRowValue(row, ["template_slug", "release_slug", "template"]) || inferredVisitorSlug
    ),
    signerName,
    signerEmail: cleanOptionalString(firstRowValue(row, ["signer_email", "email"]), 255),
    signerPhone: cleanOptionalString(firstRowValue(row, ["signer_phone", "phone_number", "phone"]), 64),
    signerAddressLine1: cleanOptionalString(
      firstRowValue(row, ["signer_address_line1", "signer_address_line_1", "address"]),
      255
    ),
    signerCity: cleanOptionalString(firstRowValue(row, ["signer_city", "city"]), 255),
    signerState: cleanOptionalString(firstRowValue(row, ["signer_state", "state"]), 255),
    signerPostalCode: cleanOptionalString(
      firstRowValue(row, ["signer_postal_code", "postal_code", "zip"]),
      32
    ),
    pdfFilename: cleanString(firstRowValue(row, ["pdf_filename", "pdf_file", "signed_pdf"]), 255),
    signedAtValue: firstRowValue(row, ["signed_at", "date", "submission_date"]),
    participantNames: firstRowValue(row, ["participant_names", "participants", "covered_participants"]),
    sourceSubmissionId:
      cleanOptionalString(firstRowValue(row, ["source_submission_id", "submission_id"]), 255) ||
      deriveJotformSourceSubmissionId(signatureUrl),
    signatureUrl,
    notes: cleanOptionalText(firstRowValue(row, ["notes", "note"]))
  };
}

function extractZipEntries(buffer) {
  const entries = new Map();
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return entries;
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let cursor = buffer.readUInt32LE(eocdOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const fileName = buffer
      .subarray(cursor + 46, cursor + 46 + fileNameLength)
      .toString("utf8")
      .replace(/^\/+/, "");
    cursor += 46 + fileNameLength + extraLength + commentLength;
    if (!fileName || fileName.endsWith("/")) continue;
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) continue;
    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let content = null;
    if (method === 0) {
      content = Buffer.from(compressed);
    } else if (method === 8) {
      content = zlib.inflateRawSync(compressed);
    }
    if (content) entries.set(fileName.split("/").pop(), content);
  }
  return entries;
}

export function collectLegacyImportFiles(files = []) {
  const spreadsheetFiles = [];
  const pdfs = new Map();
  for (const file of files) {
    const originalName = String(file.originalname || "").trim();
    const lower = originalName.toLowerCase();
    if (lower.endsWith(".csv") || lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
      spreadsheetFiles.push(file);
    } else if (lower.endsWith(".pdf")) {
      pdfs.set(originalName, file.buffer);
      pdfs.set(originalName.split("/").pop(), file.buffer);
    } else if (lower.endsWith(".zip")) {
      for (const [name, content] of extractZipEntries(file.buffer).entries()) {
        if (name.toLowerCase().endsWith(".pdf")) {
          pdfs.set(name, content);
        }
      }
    }
  }
  return { spreadsheetFiles, pdfs };
}

function parseSignedAt(value) {
  const date = new Date(String(value || "").trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function validateLegacyImport(files = []) {
  await ensureDefaultLiabilityReleaseTemplates();
  const { spreadsheetFiles, pdfs } = collectLegacyImportFiles(files);
  if (spreadsheetFiles.length !== 1) {
    return {
      ok: false,
      errors: ["Upload exactly one CSV or XLSX file."],
      rows: [],
      fileCount: pdfs.size
    };
  }
  const rows = parseLegacyReleaseRows(spreadsheetFiles[0]);
  const templates = await listLiabilityReleaseTemplates({ includeArchived: true });
  const templateBySlug = new Map(templates.map((template) => [template.slug, template]));
  const errors = [];
  const seenSourceSubmissionIds = new Set();
  const existingSourceSubmissionIds = new Set();
  const sourceSubmissionIds = rows
    .map((row) => normalizeLegacyImportRow(row).sourceSubmissionId)
    .filter(Boolean);
  for (const sourceSubmissionId of sourceSubmissionIds) {
    const [existingRows] = await getPool().query(
      "SELECT id FROM liability_release_submissions WHERE source_submission_id = ? LIMIT 1",
      [sourceSubmissionId]
    );
    if (existingRows.length) existingSourceSubmissionIds.add(sourceSubmissionId);
  }
  const normalizedRows = rows.map((row) => {
    const normalized = normalizeLegacyImportRow(row);
    const templateSlug = normalized.templateSlug;
    const template = templateBySlug.get(templateSlug);
    const pdfFilename = normalized.pdfFilename;
    const signedAt = parseSignedAt(normalized.signedAtValue);
    const sourceSubmissionId = normalized.sourceSubmissionId;
    const rowErrors = [];
    if (!templateSlug || !template) rowErrors.push("template_slug does not match a template");
    if (!normalized.signerName) rowErrors.push("signer_name or Printed Name is required");
    if (!signedAt) rowErrors.push("signed_at is required and must parse as a date");
    if (pdfFilename && !pdfs.has(pdfFilename)) rowErrors.push("pdf_filename is missing from upload");
    if (!pdfFilename && !normalized.signatureUrl) {
      rowErrors.push("pdf_filename or Jotform Signature URL is required");
    }
    if (sourceSubmissionId && seenSourceSubmissionIds.has(sourceSubmissionId)) {
      rowErrors.push("source_submission_id is duplicated in this CSV");
    }
    if (sourceSubmissionId && existingSourceSubmissionIds.has(sourceSubmissionId)) {
      rowErrors.push("source_submission_id already exists");
    }
    if (sourceSubmissionId) seenSourceSubmissionIds.add(sourceSubmissionId);
    if (rowErrors.length) errors.push(`Row ${row.rowNumber}: ${rowErrors.join("; ")}`);
    return {
      ...row,
      ...normalized,
      templateSlug,
      templateId: template?.id || null,
      pdfFilename,
      signedAt,
      rowErrors
    };
  });

  return {
    ok: errors.length === 0,
    errors,
    rows: normalizedRows,
    fileCount: pdfs.size,
    csvFilename: spreadsheetFiles[0].originalname,
    pdfs
  };
}

export async function commitLegacyImport(files = [], { userId = null } = {}) {
  const validation = await validateLegacyImport(files);
  if (!validation.ok) {
    const error = new Error("Legacy import has validation errors.");
    error.status = 400;
    error.details = validation.errors;
    throw error;
  }

  const db = getDb();
  const now = new Date();
  const batchResult = await db.insert(liabilityReleaseImportBatches).values({
    status: "imported",
    originalFilename: validation.csvFilename,
    fileCount: validation.fileCount,
    importedCount: validation.rows.length,
    errorCount: 0,
    summaryJson: JSON.stringify({
      rows: validation.rows.length,
      csvFilename: validation.csvFilename
    }),
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now
  });
  const batchId = Number(batchResult[0]?.insertId);
  const imported = [];

  for (const row of validation.rows) {
    const template = await getLiabilityReleaseTemplateBySlug(row.templateSlug);
    const version =
      template?.currentVersionId && template.status === "published"
        ? await getPublishedLiabilityReleaseVersion(template)
        : null;
    if (!template) continue;
    const signedAt = row.signedAt;
    const pdf = validation.pdfs.get(row.pdfFilename);
    const storageKey = buildSubmissionStorageKey({
      slug: row.templateSlug,
      signedAt,
      sourceType: "legacy-import"
    });
    const participants = String(row.participantNames || "")
      .split(/[;\n]/)
      .map((name) => ({ name: cleanString(name, 255) }))
      .filter((entry) => entry.name);
    const recordPdf =
      pdf ||
      (version
        ? await buildSignedReleasePdf({
            templateVersion: version,
            signer: {
              signerName: row.signerName,
              signerEmail: row.signerEmail,
              signerPhone: row.signerPhone,
              signerAddressLine1: row.signerAddressLine1,
              signerCity: row.signerCity,
              signerStateProvince: row.signerState,
              signerPostalCode: row.signerPostalCode
            },
            participants,
            signatureBuffer: null,
            signatureMode: "legacy_jotform_url",
            sourceHost: "jotform.com",
            sourcePath: row.signatureUrl,
            signedAt
          })
        : null);
    if (!recordPdf) continue;
    const recordUrl = await uploadLiabilityReleasePdf({ buffer: recordPdf, key: storageKey });
    const submissionResult = await db.insert(liabilityReleaseSubmissions).values({
      templateId: template.id,
      templateVersionId: version?.id || 0,
      templateSlug: template.slug,
      templateTitle: version?.title || template.title,
      status: "signed",
      sourceType: "legacy_import",
      sourceSubmissionId: row.sourceSubmissionId,
      importBatchId: batchId,
      signerName: row.signerName,
      signerEmail: row.signerEmail,
      signerPhone: row.signerPhone,
      signerAddressLine1: row.signerAddressLine1,
      signerCity: row.signerCity,
      signerStateProvince: row.signerState,
      signerPostalCode: row.signerPostalCode,
      participantJson: JSON.stringify(participants),
      signatureMode: pdf ? "legacy_pdf" : "legacy_jotform_url",
      signatureHash: row.signatureUrl
        ? crypto.createHash("sha256").update(row.signatureUrl).digest("hex")
        : null,
      acceptedAt: signedAt,
      signedAt,
      expiresAt: version ? computeExpiresAt(version, signedAt) : null,
      documentUrl: template.sourceUrl,
      recordUrl,
      storageKey,
      notes: row.notes,
      rawJson: JSON.stringify(row),
      createdAt: now,
      updatedAt: now
    });
    imported.push(Number(submissionResult[0]?.insertId));
  }

  return {
    ok: true,
    batchId,
    importedCount: imported.length
  };
}
