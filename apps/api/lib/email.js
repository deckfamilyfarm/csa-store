import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SUBSCRIBE_ACCOUNT_SCREENSHOT_CID = "subscribe-account-menu-image";
const SUBSCRIBE_PAYMENT_SCREENSHOT_CID = "subscribe-add-payment-image";
const DEFAULT_SUBSCRIBE_ACCOUNT_SCREENSHOT_PATH = path.resolve(
  __dirname,
  "../assets/subscribe-account-menu.png"
);
const DEFAULT_SUBSCRIBE_PAYMENT_SCREENSHOT_PATH = path.resolve(
  __dirname,
  "../assets/subscribe-add-payment.png"
);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createTransporter() {
  const smtpHost = process.env.SMTP_HOST || process.env.MAIL_HOST;
  const smtpUser = process.env.SMTP_USER || process.env.MAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.MAIL_PASS || process.env.MAIL_ACCESS;

  if (smtpHost && smtpUser && smtpPass) {
    return nodemailer.createTransport({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
      auth: { user: smtpUser, pass: smtpPass }
    });
  }

  const gmailUser = process.env.EMAIL_USER || process.env.MAIL_USER;
  const gmailPass = process.env.EMAIL_PASS || process.env.MAIL_PASS || process.env.MAIL_ACCESS;
  if (gmailUser && gmailPass) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailPass }
    });
  }

  return null;
}

function formatExpiryText(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "This link expires soon.";
  const utcText = date.toISOString().replace(".000Z", " UTC");
  return `This link expires on ${utcText}.`;
}

function getSenderAddress() {
  return (
    process.env.EMAIL_FROM ||
    process.env.EMAIL_USER ||
    process.env.SMTP_USER ||
    process.env.MAIL_USER ||
    ""
  );
}

function displayValue(value, fallback = "Not provided") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function formatAddress(lead = {}) {
  return [
    lead.addressLine1,
    lead.addressLine2,
    [lead.city, lead.stateProvince, lead.postalCode].filter(Boolean).join(", "),
    lead.country
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
}

function formatMaybeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Los_Angeles"
  });
}

function getSubscribeLoginUrl() {
  return (
    process.env.PUBLIC_SUBSCRIBE_LOGIN_URL ||
    process.env.SUBSCRIBE_LOGIN_URL ||
    "https://fullfarmcsa.deckfamilyfarm.com/"
  );
}

function getSubscribeLeadFromAddress() {
  return process.env.SUBSCRIBE_LEAD_FROM || getSenderAddress() || "fullfarmcsa@deckfamilyfarm.com";
}

function getSubscribeLeadBccAddress() {
  const addresses = [
    "fullfarmcsa@deckfamilyfarm.com",
    process.env.SUBSCRIBE_LEAD_NOTIFY_TO_BCC,
    process.env.SUBSCRIBE_LEAD_NOTIFY_TO,
    process.env.SUBSCRIBE_NOTIFY_TO
  ];
  return [...new Set(addresses.map((value) => String(value || "").trim()).filter(Boolean))].join(",");
}

function getLiabilityReleaseNotifyAddress() {
  return (
    process.env.LIABILITY_RELEASE_NOTIFY_TO ||
    process.env.SUBSCRIBE_LEAD_NOTIFY_TO ||
    process.env.SUBSCRIBE_NOTIFY_TO ||
    "fullfarmcsa@deckfamilyfarm.com"
  );
}

function getDropSiteHostNotifyAddress() {
  return (
    process.env.DROPSITE_HOST_NOTIFY_TO ||
    process.env.DROP_SITE_HOST_NOTIFY_TO ||
    process.env.SUBSCRIBE_LEAD_NOTIFY_TO ||
    process.env.SUBSCRIBE_NOTIFY_TO ||
    "fullfarmcsa@deckfamilyfarm.com"
  );
}

function getPublicAppBaseUrl() {
  return (
    process.env.PUBLIC_APP_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.PUBLIC_SUBSCRIBE_URL ||
    "https://fullfarmcsa.deckfamilyfarm.com"
  ).replace(/\/$/, "");
}

function buildSubscriptionRequestIntro() {
  return {
    title: "Almost there! Please take these steps to complete your subscription:",
    body: "To activate your Full Farm Subscription, please complete these steps:",
    accountStep: "Create your account in our store:",
    accountButtonLabel: "Create Store Account",
    paymentStep: "Please add payment in the account menu:",
    confirmationStep:
      "Look for the subscription confirmation email within 24 hours with full description of how to place your first order.",
    questions:
      "Questions? If you have any questions please don't hesitate to call or text us at 541-321-0925.",
    signoff: "Sincerely,\n\nFull Farm CSA"
  };
}

function getConfiguredAssetPath(envKey, fallbackPath) {
  const configuredPath = process.env[envKey];
  if (!configuredPath) return fallbackPath;
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);
}

function buildSubscribeLeadAttachments() {
  const imageConfigs = [
    {
      filename: "subscribe-account-menu.png",
      path: getConfiguredAssetPath(
        "SUBSCRIBE_LEAD_ACCOUNT_SCREENSHOT_PATH",
        DEFAULT_SUBSCRIBE_ACCOUNT_SCREENSHOT_PATH
      ),
      cid: SUBSCRIBE_ACCOUNT_SCREENSHOT_CID
    },
    {
      filename: "subscribe-add-payment.png",
      path: getConfiguredAssetPath(
        "SUBSCRIBE_LEAD_PAYMENT_SCREENSHOT_PATH",
        DEFAULT_SUBSCRIBE_PAYMENT_SCREENSHOT_PATH
      ),
      cid: SUBSCRIBE_PAYMENT_SCREENSHOT_CID
    }
  ];

  return imageConfigs
    .filter((image) => image.path && fs.existsSync(image.path))
    .map((image) => ({
      ...image,
      contentType: "image/png"
    }));
}

function renderSubscribePaymentScreenshotsHtml(attachments = []) {
  const images = attachments
    .filter((attachment) =>
      [SUBSCRIBE_ACCOUNT_SCREENSHOT_CID, SUBSCRIBE_PAYMENT_SCREENSHOT_CID].includes(attachment.cid)
    )
    .map((attachment) =>
      [
        "<td style=\"padding:0 10px 10px 0;vertical-align:top;\">",
        `<img src="cid:${attachment.cid}" alt="Account payment step screenshot" style="display:block;max-width:245px;width:100%;height:auto;border:1px solid #e6e0d8;border-radius:8px;" />`,
        "</td>"
      ].join("")
    )
    .join("");

  if (!images) return "";
  return `<table role="presentation" style="border-collapse:collapse;margin:12px 0 0;"><tr>${images}</tr></table>`;
}

function buildSubscribeLeadFields(lead = {}, submittedAt) {
  const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim();
  const submittedLabel = formatMaybeDate(submittedAt) || "Unknown";
  const address = formatAddress(lead);
  return [
    ["Submitted", submittedLabel],
    ["Name", leadName],
    ["Email", lead.email],
    ["Phone", lead.phone],
    ["Address", address],
    ["Selected plan", lead.selectedPlanLabel || lead.selectedPlan],
    ["Preferred pickup / delivery", lead.selectedDropSite],
    ["SNAP/EBT card", lead.hasCurrentSnapEbtCard ? "Yes" : "No"],
    ["Farm employee", lead.isFarmEmployee ? "Yes" : "No"],
    ["Referral source", lead.referralSource],
    ["Notes", lead.notes],
    ["Agreement signer", lead.liabilityAgreementSignerName],
    ["Agreement PDF", lead.liabilityAgreementRecordUrl]
  ];
}

function renderSubmittedRows(fields = []) {
  return fields
    .map(([label, value]) => {
      const displayed = displayValue(value);
      const isAgreement =
        (label === "Agreement PDF" || label === "Signed PDF") && String(value || "").trim();
      const valueHtml = isAgreement
        ? `<a href="${escapeHtml(value)}">${escapeHtml(displayed)}</a>`
        : escapeHtml(displayed);
      return `
        <tr>
          <th align="left" valign="top" style="padding:4px 12px 4px 0;">${escapeHtml(label)}</th>
          <td style="padding:4px 0; white-space:pre-line;">${valueHtml}</td>
        </tr>
      `;
    })
    .join("");
}

export async function sendSubscribeLeadFollowupEmail({ lead = {}, submittedAt }) {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn("Subscribe lead follow-up email skipped: email is not configured.");
    return { sent: false, reason: "Email is not configured." };
  }

  const to = String(lead.email || "").trim();
  if (!to) {
    return { sent: false, reason: "Lead email is not configured." };
  }

  const from = getSubscribeLeadFromAddress();
  const bcc = String(getSubscribeLeadBccAddress() || "").trim();
  const intro = buildSubscriptionRequestIntro();
  const loginUrl = getSubscribeLoginUrl();
  const fields = buildSubscribeLeadFields(lead, submittedAt);
  const submittedText = fields.map(([label, value]) => `${label}: ${displayValue(value)}`).join("\n");
  const submittedRows = renderSubmittedRows(fields);
  const attachments = buildSubscribeLeadAttachments();
  const paymentScreenshotsHtml = renderSubscribePaymentScreenshotsHtml(attachments);

  await transporter.sendMail({
    from,
    to,
    bcc: bcc || undefined,
    subject: "Almost there! Complete your Full Farm Subscription",
    text: [
      intro.title,
      "",
      intro.body,
      "",
      `1. ${intro.accountStep}`,
      "",
      `${intro.accountButtonLabel}: ${loginUrl}`,
      "or click on this link: " + loginUrl,
      "",
      "2. " + intro.paymentStep,
      "",
      "3. " + intro.confirmationStep,
      "",
      intro.questions,
      "",
      intro.signoff,
      "",
      "What you submitted...",
      "",
      submittedText
    ].join("\n"),
    html: `
      <h2>${escapeHtml(intro.title)}</h2>
      <p>${escapeHtml(intro.body)}</p>
      <ol style="padding-left:22px;">
        <li style="margin-bottom:18px;">
          <p>${escapeHtml(intro.accountStep)}</p>
          <p>
            <a href="${escapeHtml(loginUrl)}" style="display:inline-block;padding:12px 18px;background:#233427;color:#ffffff;text-decoration:none;font-weight:bold;">
              ${escapeHtml(intro.accountButtonLabel)}
            </a>
          </p>
          <p>or click on this link: <a href="${escapeHtml(loginUrl)}">${escapeHtml(loginUrl)}</a></p>
        </li>
        <li style="margin-bottom:18px;">
          <p>${escapeHtml(intro.paymentStep)}</p>
          ${paymentScreenshotsHtml}
        </li>
        <li style="margin-bottom:18px;">
          <p>${escapeHtml(intro.confirmationStep)}</p>
        </li>
      </ol>
      <p>${escapeHtml(intro.questions)}</p>
      <p style="white-space:pre-line;">${escapeHtml(intro.signoff)}</p>
      <h3>What you submitted...</h3>
      <table>${submittedRows}</table>
    `,
    attachments
  });

  return { sent: true };
}

export async function sendLiabilityReleaseEmails({ submission = {}, template = {} }) {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn("Liability release email skipped: email is not configured.");
    return { sent: false, reason: "Email is not configured." };
  }

  const from = getSubscribeLeadFromAddress();
  const notifyTo = String(getLiabilityReleaseNotifyAddress() || "").trim();
  const signerTo = String(submission.signerEmail || "").trim();
  const recordUrl = String(submission.recordUrl || "").trim();
  const releaseTitle = template.title || submission.templateTitle || "Liability release";
  const signedLabel = formatMaybeDate(submission.signedAt || submission.createdAt) || "Unknown";
  const publicBaseUrl = getPublicAppBaseUrl();
  const adminUrl = `${publicBaseUrl}/#/admin`;
  const fields = [
    ["Release", releaseTitle],
    ["Template", `${submission.templateSlug || template.slug || ""}`],
    ["Signer", submission.signerName],
    ["Email", submission.signerEmail],
    ["Phone", submission.signerPhone],
    ["Signed", signedLabel],
    ["Signed PDF", recordUrl]
  ];
  const submittedText = fields.map(([label, value]) => `${label}: ${displayValue(value)}`).join("\n");
  const submittedRows = renderSubmittedRows(fields);

  if (signerTo) {
    await transporter.sendMail({
      from,
      to: signerTo,
      subject: `Signed ${releaseTitle}`,
      text: [
        `Thank you for signing ${releaseTitle}.`,
        "",
        recordUrl ? `Signed PDF: ${recordUrl}` : "",
        "",
        "Deck Family Farm"
      ].join("\n"),
      html: `
        <p>Thank you for signing ${escapeHtml(releaseTitle)}.</p>
        ${recordUrl ? `<p><a href="${escapeHtml(recordUrl)}">Open your signed PDF</a></p>` : ""}
        <p>Deck Family Farm</p>
      `
    });
  }

  if (notifyTo) {
    await transporter.sendMail({
      from,
      to: notifyTo,
      subject: `Liability release signed: ${releaseTitle}`,
      text: [
        "A liability release was signed.",
        "",
        submittedText,
        "",
        `Admin: ${adminUrl}`
      ].join("\n"),
      html: `
        <p>A liability release was signed.</p>
        <table>${submittedRows}</table>
        <p><a href="${escapeHtml(adminUrl)}">Open admin panel</a></p>
      `
    });
  }

  return { sent: true };
}

function sanitizeAttachmentName(value, index) {
  const cleaned = String(value || "")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || `dropsite-photo-${index + 1}`;
}

export async function sendDropSiteHostInterestEmail({ payload = {}, photos = [], submittedAt }) {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn("Drop-site host interest email skipped: email is not configured.");
    return { sent: false, reason: "Email is not configured." };
  }

  const from = getSubscribeLeadFromAddress();
  const notifyTo = String(getDropSiteHostNotifyAddress() || "").trim();
  if (!notifyTo) {
    return { sent: false, reason: "Drop-site notification recipient is not configured." };
  }

  const submittedLabel = formatMaybeDate(submittedAt) || "Unknown";
  const address = [
    payload.address,
    [payload.city, payload.stateProvince, payload.postalCode].filter(Boolean).join(", ")
  ].map((value) => String(value || "").trim()).filter(Boolean).join("\n");
  const fields = [
    ["Submitted", submittedLabel],
    ["Name", payload.name],
    ["Email", payload.email],
    ["Phone", payload.phone],
    ["Current FFCSA member", payload.memberStatus],
    ["Proposed address", address],
    ["Availability", payload.availability],
    ["Parking", payload.parking],
    ["Street access", payload.streetAccess],
    ["Van access", payload.vanAccess],
    ["Stairs", payload.stairs],
    ["Room near house", payload.roomNearHouse],
    ["Covered/shaded area", payload.shade],
    ["Secure location", payload.secureLocation],
    ["Behind gate", payload.behindGate],
    ["Tote/cooler storage", payload.toteStorage],
    ["Neighbor/HOA concerns", payload.neighborConcerns],
    ["Referral name/link label", payload.referralName],
    ["Source", [payload.sourceHost, payload.sourcePath].filter(Boolean).join("")],
    ["Query string", payload.queryString],
    ["Notes", payload.notes]
  ];
  const submittedText = fields.map(([label, value]) => `${label}: ${displayValue(value)}`).join("\n");
  const submittedRows = renderSubmittedRows(fields);
  const attachments = (Array.isArray(photos) ? photos : []).map((file, index) => ({
    filename: sanitizeAttachmentName(file.originalname, index),
    content: file.buffer,
    contentType: file.mimetype || "application/octet-stream"
  }));

  await transporter.sendMail({
    from,
    to: notifyTo,
    replyTo: payload.email || undefined,
    subject: `New drop-site host interest: ${displayValue(payload.name, "Unknown")}`,
    text: [
      "A new drop-site host interest form was submitted.",
      "",
      submittedText,
      "",
      attachments.length ? `${attachments.length} photo attachment(s) included.` : "No photos attached."
    ].join("\n"),
    html: `
      <p>A new drop-site host interest form was submitted.</p>
      <table>${submittedRows}</table>
      <p>${attachments.length ? `${attachments.length} photo attachment(s) included.` : "No photos attached."}</p>
    `,
    attachments
  });

  return { sent: true };
}

export async function sendPasswordResetEmail({ to, name, username, resetUrl, expiresAt }) {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn("Password reset email skipped: SMTP_HOST/SMTP_USER/SMTP_PASS, EMAIL_USER/EMAIL_PASS, or MAIL_USER/MAIL_ACCESS is not configured.");
    console.warn(`Password reset link for ${to}: ${resetUrl}`);
    return { sent: false, reason: "Email is not configured." };
  }

  const displayName = String(name || "").trim() || "there";
  const loginName = String(username || "").trim();
  const from =
    getSenderAddress();
  const appName = process.env.APP_NAME || "CSA Store";
  const safeName = escapeHtml(displayName);
  const safeUrl = escapeHtml(resetUrl);
  const expiryText = formatExpiryText(expiresAt);

  await transporter.sendMail({
    from,
    to,
    subject: `${appName} password setup`,
    text: [
      `Hi ${displayName},`,
      "",
      loginName ? `Username: ${loginName}` : "",
      loginName ? "" : "",
      `Use this link to set your ${appName} password:`,
      resetUrl,
      "",
      expiryText,
      "If you request another password email, only the newest link will keep working.",
      "If you did not request it, you can ignore this email."
    ].join("\n"),
    html: `
      <p>Hi ${safeName},</p>
      ${loginName ? `<p>Username: <strong>${escapeHtml(loginName)}</strong></p>` : ""}
      <p>Use this link to set your ${escapeHtml(appName)} password:</p>
      <p><a href="${safeUrl}">${safeUrl}</a></p>
      <p>${escapeHtml(expiryText)}</p>
      <p>If you request another password email, only the newest link will keep working.</p>
      <p>If you did not request it, you can ignore this email.</p>
    `
  });

  return { sent: true };
}
