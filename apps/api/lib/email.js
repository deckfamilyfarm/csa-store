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
    process.env.EMAIL_FROM ||
    process.env.EMAIL_USER ||
    process.env.SMTP_USER ||
    process.env.MAIL_USER;
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
