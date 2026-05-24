import nodemailer from "nodemailer";

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

export async function sendSubscribeLeadNotification({ lead = {}, marketing = {}, submittedAt }) {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn("Subscribe lead notification skipped: email is not configured.");
    return { sent: false, reason: "Email is not configured." };
  }

  const to = String(
    process.env.SUBSCRIBE_LEAD_NOTIFY_TO ||
      process.env.SUBSCRIBE_NOTIFY_TO ||
      process.env.ADMIN_EMAIL ||
      getSenderAddress()
  ).trim();
  if (!to) {
    console.warn("Subscribe lead notification skipped: SUBSCRIBE_LEAD_NOTIFY_TO is not configured.");
    return { sent: false, reason: "Notification recipient is not configured." };
  }

  const from = getSenderAddress();
  const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim();
  const submittedLabel = formatMaybeDate(submittedAt) || "Unknown";
  const address = formatAddress(lead);
  const subject = `New CSA subscribe request: ${leadName || lead.email || "unknown"}`;
  const fields = [
    ["Submitted", submittedLabel],
    ["Name", leadName],
    ["Email", lead.email],
    ["Phone", lead.phone],
    ["Address", address],
    ["Selected plan", lead.selectedPlanLabel || lead.selectedPlan],
    ["Preferred pickup / delivery", lead.selectedDropSite],
    ["Referral source", lead.referralSource],
    ["Notes", lead.notes],
    ["Agreement signer", lead.liabilityAgreementSignerName],
    ["Agreement PDF", lead.liabilityAgreementRecordUrl],
    ["Source", [lead.sourceHost, lead.sourcePath].filter(Boolean).join("")],
    ["UTM source", marketing.utmSource],
    ["UTM medium", marketing.utmMedium],
    ["UTM campaign", marketing.utmCampaign],
    ["UTM content", marketing.utmContent],
    ["UTM term", marketing.utmTerm],
    ["CSA link", marketing.csaLinkSlug],
    ["CSA campaign", marketing.csaCampaignSlug],
    ["CSA tracking token", marketing.csaTrackToken],
    ["Attribution match", marketing.matchMethod]
  ];
  const text = [
    "A new Full Farm CSA subscribe request was submitted.",
    "",
    ...fields.map(([label, value]) => `${label}: ${displayValue(value)}`)
  ].join("\n");
  const htmlRows = fields
    .map(
      ([label, value]) => `
        <tr>
          <th align="left" valign="top" style="padding:4px 12px 4px 0;">${escapeHtml(label)}</th>
          <td style="padding:4px 0; white-space:pre-line;">${escapeHtml(displayValue(value))}</td>
        </tr>
      `
    )
    .join("");

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
    html: `
      <p>A new Full Farm CSA subscribe request was submitted.</p>
      <table>${htmlRows}</table>
    `
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
