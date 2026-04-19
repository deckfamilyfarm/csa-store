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

export async function sendPasswordResetEmail({ to, name, username, resetUrl }) {
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
      "This link expires soon. If you did not request it, you can ignore this email."
    ].join("\n"),
    html: `
      <p>Hi ${safeName},</p>
      ${loginName ? `<p>Username: <strong>${escapeHtml(loginName)}</strong></p>` : ""}
      <p>Use this link to set your ${escapeHtml(appName)} password:</p>
      <p><a href="${safeUrl}">${safeUrl}</a></p>
      <p>This link expires soon. If you did not request it, you can ignore this email.</p>
    `
  });

  return { sent: true };
}
