import nodemailer from "nodemailer";

let activeTransporter = null;

export function getSmtpConfig(env = process.env) {
  const host = env.SMTP_HOST ? String(env.SMTP_HOST).trim() : "";
  const rawPort = env.SMTP_PORT ? Number(env.SMTP_PORT) : 587;
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 587;
  const user = env.SMTP_USER ? String(env.SMTP_USER).trim() : "";
  const pass = env.SMTP_PASS ? String(env.SMTP_PASS).trim() : "";
  const from = env.EMAIL_FROM
    ? String(env.EMAIL_FROM).trim()
    : (user ? `CampusFind <${user}>` : "CampusFind <noreply@campusfind.edu>");

  const missingFields = [];
  if (!host) missingFields.push("SMTP_HOST");
  if (!user) missingFields.push("SMTP_USER");
  if (!pass) missingFields.push("SMTP_PASS");

  return {
    isConfigured: missingFields.length === 0,
    missingFields,
    host,
    port,
    user,
    pass,
    from
  };
}

export function createTransportOptions(config) {
  const isGmail = config.host.toLowerCase().includes("gmail");
  const isSecurePort = config.port === 465;

  const options = {
    host: config.host,
    port: config.port,
    secure: isSecurePort, // true for port 465, false for 587/25
    auth: {
      user: config.user,
      pass: config.pass
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  };

  // For Gmail or port 587, require STARTTLS upgrade
  if (config.port === 587 || isGmail) {
    options.requireTLS = true;
  }

  return options;
}

export function getTransporter() {
  if (activeTransporter) return activeTransporter;

  const config = getSmtpConfig();
  if (config.isConfigured) {
    const transportOptions = createTransportOptions(config);
    activeTransporter = nodemailer.createTransport(transportOptions);
  }

  return activeTransporter;
}

export function setTransporter(customTransporter) {
  activeTransporter = customTransporter;
}

export function resetTransporter() {
  activeTransporter = null;
}

export function sanitizeSmtpError(error) {
  if (!error) return "Unknown SMTP error occurred.";

  const message = String(error.message || "");
  const code = error.code || "";
  const responseCode = error.responseCode || "";

  if (
    code === "EAUTH" ||
    responseCode === 535 ||
    message.includes("535") ||
    message.toLowerCase().includes("badcredentials") ||
    message.toLowerCase().includes("username and password not accepted")
  ) {
    return "SMTP authentication failed. Check your SMTP_USER and SMTP_PASS (use a Gmail App Password if 2-factor authentication is active).";
  }

  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    message.toLowerCase().includes("timeout") ||
    message.toLowerCase().includes("timed out")
  ) {
    return "SMTP connection timed out. Check network connectivity or firewall rules for the SMTP port.";
  }

  if (code === "ECONNREFUSED") {
    return "SMTP connection refused. Ensure the SMTP server host and port are correct.";
  }

  if (code === "ENOTFOUND") {
    return "SMTP server host not found. Verify the SMTP_HOST setting.";
  }

  if (code === "EPROTOCOL" || message.toLowerCase().includes("starttls")) {
    return "SMTP TLS/STARTTLS handshake failed. Verify port and security settings.";
  }

  // Never return raw strings that might contain credentials
  return message
    .replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, "[email]")
    .replace(/[a-z]{4}\s+[a-z]{4}\s+[a-z]{4}\s+[a-z]{4}/gi, "[redacted-app-password]")
    .replace(/(?:password|pass|secret|token)\s*[:=]\s*\S+/gi, "[redacted]") || "SMTP delivery error occurred.";
}

export async function verifySmtpConnection(customTransport, env = process.env) {
  const config = getSmtpConfig(env);
  const transport = customTransport || (config.isConfigured ? getTransporter() : null);

  if (!config.isConfigured && !transport) {
    return {
      success: false,
      status: "smtp_not_configured",
      error: "SMTP_NOT_CONFIGURED",
      errorReason: `SMTP configuration missing (${config.missingFields.join(", ")}).`
    };
  }

  if (!transport) {
    return {
      success: false,
      status: "smtp_not_configured",
      error: "SMTP_NOT_CONFIGURED",
      errorReason: "SMTP transport could not be initialized."
    };
  }

  try {
    await transport.verify();
    return { success: true, status: "verified" };
  } catch (error) {
    const sanitizedReason = sanitizeSmtpError(error);
    return {
      success: false,
      status: "failed",
      error: error.code || "SMTP_VERIFY_FAILED",
      errorReason: sanitizedReason
    };
  }
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function safeSubject(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

/**
 * Send an email notification with full delivery diagnostics.
 * Never exposes credentials, passwords, or secrets.
 */
export async function sendEmail({ to, subject, html, text }) {
  if (!to) {
    return {
      success: false,
      status: "failed",
      error: "MISSING_RECIPIENT",
      errorReason: "No recipient email address provided."
    };
  }

  const config = getSmtpConfig();
  if (!config.isConfigured && !activeTransporter) {
    return {
      success: false,
      status: "smtp_not_configured",
      error: "SMTP_NOT_CONFIGURED",
      errorReason: `SMTP configuration is missing (${config.missingFields.join(", ")}).`
    };
  }

  const transport = getTransporter();
  if (!transport) {
    return {
      success: false,
      status: "smtp_not_configured",
      error: "SMTP_NOT_CONFIGURED",
      errorReason: "SMTP transport could not be initialized."
    };
  }

  try {
    const info = await transport.sendMail({
      from: config.from,
      to,
      subject,
      text: text || (html ? html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : ""),
      html
    });

    return {
      success: true,
      status: "sent",
      messageId: info?.messageId || "sent"
    };
  } catch (error) {
    const sanitizedReason = sanitizeSmtpError(error);
    console.warn(`[EmailService] Failed to send email to ${to}: ${sanitizedReason}`);
    return {
      success: false,
      status: "failed",
      error: error.code || "SEND_FAILED",
      errorReason: sanitizedReason
    };
  }
}

/**
 * Safely send an email notification. Fails silently without crashing core workflows.
 */
async function sendSafeEmail(options) {
  const result = await sendEmail(options);
  return result.success;
}

export function renderMatchFoundEmail({ studentName, itemReported, matchedItem, matchScore }) {
  const safeMatchScore = escapeHtml(matchScore);
  const subject = safeSubject(`[CampusFind] Potential Match Found for your ${itemReported.itemName} (${matchScore}% match)`);
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0d5; border-radius: 8px;">
      <h2 style="color: #274029;">Good news, ${escapeHtml(studentName)}!</h2>
      <p>A potential match has been reported on the CampusFind board with a <strong>${safeMatchScore}% confidence score</strong>.</p>
      
      <div style="background: #fbfbf7; padding: 16px; border-radius: 6px; margin: 16px 0;">
        <h4 style="margin: 0 0 8px 0; color: #435b44;">Your Report:</h4>
        <p style="margin: 4px 0;"><strong>${escapeHtml(itemReported.itemName)}</strong> (${escapeHtml(itemReported.color)}) - ${escapeHtml(itemReported.location)}</p>
        
        <h4 style="margin: 16px 0 8px 0; color: #435b44;">Correlated Report:</h4>
        <p style="margin: 4px 0;"><strong>${escapeHtml(matchedItem.itemName)}</strong> (${escapeHtml(matchedItem.color)}) - ${escapeHtml(matchedItem.location)}</p>
      </div>

      <p>Log into your CampusFind account and visit your <strong>Profile > Potential Matches</strong> to review or confirm this reunion.</p>
      <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
      <small style="color: #888;">CampusFind · The Campus Community Lost & Found Board</small>
    </div>
  `;

  return { subject, html };
}

export async function notifyMatchFound({ recipientEmail, ...data }) {
  return sendSafeEmail({ to: recipientEmail, ...renderMatchFoundEmail(data) });
}

export function renderClaimUpdateEmail({ studentName, itemName, updateType, details }) {
  const titles = {
    claim_initiated: "New Claim Initiated",
    proof_submitted: "Verification Proof Submitted",
    confirmed: "Item Handover Confirmed & Returned",
    disputed: "Claim Disputed - Under Admin Review"
  };

  const subject = safeSubject(`[CampusFind] ${titles[updateType] || "Claim Update"}: ${itemName}`);
  const statusLabel = titles[updateType] || escapeHtml(updateType);
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0d5; border-radius: 8px;">
      <h2 style="color: #274029;">Hello ${escapeHtml(studentName)},</h2>
      <p>There is a new update regarding your item report <strong>${escapeHtml(itemName)}</strong>.</p>
      <div style="background: #fbfbf7; padding: 14px; border-left: 4px solid #b18c38; margin: 16px 0;">
        <p style="margin: 0; font-weight: bold;">Status: ${statusLabel}</p>
        <p style="margin: 8px 0 0 0; color: #555;">${escapeHtml(details || "Please review your CampusFind profile for details.")}</p>
      </div>
      <p>Visit your CampusFind profile to view full history and manage your claims.</p>
    </div>
  `;

  return { subject, html };
}

export async function notifyClaimUpdate({ recipientEmail, ...data }) {
  return sendSafeEmail({ to: recipientEmail, ...renderClaimUpdateEmail(data) });
}

export function renderClaimStatusChangeEmail({ claimantName, itemName, status, notes, rejectionReason, handoverLocation }) {
  const statusLabels = {
    pending: "Claim Received - Pending Review",
    under_review: "Claim Under Administrative Review",
    approved: "Claim Approved! Handover Arranged",
    rejected: "Claim Rejected",
    withdrawn: "Claim Withdrawn"
  };

  const subject = safeSubject(`[CampusFind] Claim Update: ${itemName} (${statusLabels[status] || status})`);
  const statusLabel = statusLabels[status] || escapeHtml(status);
  const isApproved = status === "approved";
  const isRejected = status === "rejected";

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0d5; border-radius: 8px;">
      <h2 style="color: #274029;">Hello ${escapeHtml(claimantName)},</h2>
      <p>There is an update on your ownership claim for <strong>${escapeHtml(itemName)}</strong>.</p>
      
      <div style="background: ${isApproved ? "#f3f8f3" : isRejected ? "#fdf4f4" : "#fbfbf7"}; padding: 14px; border-radius: 6px; margin: 16px 0; border-left: 4px solid ${isApproved ? "#274029" : isRejected ? "#b12d2d" : "#b18c38"};">
        <h4 style="margin: 0 0 8px 0; color: ${isApproved ? "#274029" : isRejected ? "#a12828" : "#435b44"};">
          Status: ${statusLabel}
        </h4>
        ${isApproved && handoverLocation ? `<p style="margin: 4px 0;"><strong>Collection Desk:</strong> ${escapeHtml(handoverLocation)}</p>` : ""}
        ${isRejected && rejectionReason ? `<p style="margin: 4px 0; color: #a12828;"><strong>Reason:</strong> ${escapeHtml(rejectionReason)}</p>` : ""}
        ${notes ? `<p style="margin: 4px 0; color: #555;"><strong>Admin Notes:</strong> ${escapeHtml(notes)}</p>` : ""}
      </div>

      <p>Visit your CampusFind profile under <strong>My Claims</strong> to view the full details.</p>
      <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
      <small style="color: #888;">CampusFind · The Campus Community Lost & Found Board</small>
    </div>
  `;

  return { subject, html };
}

export async function notifyClaimStatusChange({ recipientEmail, ...data }) {
  return sendSafeEmail({ to: recipientEmail, ...renderClaimStatusChangeEmail(data) });
}

export function renderAdminResolutionEmail({ studentName, itemName, decision, handoverLocation, notes }) {
  const isApproved = decision === "approve";
  const subject = safeSubject(`[CampusFind] Admin Decision: Claim for ${itemName} has been ${isApproved ? "Approved" : "Rejected"}`);
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0d5; border-radius: 8px;">
      <h2 style="color: #274029;">Hello ${escapeHtml(studentName)},</h2>
      <p>An administrator has reviewed the dispute regarding <strong>${escapeHtml(itemName)}</strong>.</p>
      <div style="background: ${isApproved ? "#f3f8f3" : "#fdf4f4"}; padding: 14px; border-radius: 6px; margin: 16px 0;">
        <h4 style="margin: 0 0 8px 0; color: ${isApproved ? "#274029" : "#a12828"};">
          Decision: ${isApproved ? "APPROVED ✓" : "REJECTED ✕"}
        </h4>
        ${isApproved ? `<p><strong>Handover Location:</strong> ${escapeHtml(handoverLocation || "Campus Security Desk")}</p>` : ""}
        ${notes ? `<p><strong>Admin Notes:</strong> ${escapeHtml(notes)}</p>` : ""}
      </div>
      <p>Please present your student ID at the designated desk if collecting your item.</p>
    </div>
  `;

  return { subject, html };
}

export async function notifyAdminResolution({ recipientEmail, ...data }) {
  return sendSafeEmail({ to: recipientEmail, ...renderAdminResolutionEmail(data) });
}

export async function sendVerificationOtp({ recipientEmail, studentName, otp, expiresMinutes = 10 }) {
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px;">
      <h2>Verify your CampusFind email</h2>
      <p>Hello ${escapeHtml(studentName)}, use this verification code:</p>
      <p style="font-size: 24px; font-weight: bold; letter-spacing: 4px;">${escapeHtml(otp)}</p>
      <p>This code expires in ${escapeHtml(expiresMinutes)} minutes.</p>
    </div>
  `;
  return sendSafeEmail({
    to: recipientEmail,
    subject: "CampusFind college email verification",
    html,
    text: `Your CampusFind verification code is ${otp}. It expires in ${expiresMinutes} minutes.`
  });
}

/**
 * Render professional CampusFind handover verification email with complete security context.
 */
export function renderHandoverOtpEmail({ studentName, itemName, handoverLocation, otp, expiresMinutes = 10 }) {
  const subject = safeSubject("CampusFind — Your Handover Verification OTP");
  const safeName = escapeHtml(studentName || "Student");
  const safeItem = escapeHtml(itemName || "Reported Item");
  const safeLocation = handoverLocation ? escapeHtml(handoverLocation) : "";
  const safeOtp = escapeHtml(otp);
  const safeExpires = escapeHtml(expiresMinutes);

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e8e7dd; border-radius: 12px; background: #ffffff; color: #222220;">
  <div style="border-bottom: 2px solid #274029; padding-bottom: 16px; margin-bottom: 20px;">
    <h1 style="font-size: 22px; color: #274029; margin: 0; letter-spacing: -0.5px;">
      CampusFind<span style="color: #b18c38;">.</span>
    </h1>
    <p style="margin: 4px 0 0 0; font-size: 13px; color: #666;">The Campus Community Lost &amp; Found Platform</p>
  </div>

  <h2 style="font-size: 18px; color: #274029; margin-top: 0;">Claim Approved — Handover Verification Code</h2>
  <p style="font-size: 14px; line-height: 1.5; color: #333;">
    Hello <strong>${safeName}</strong>,
  </p>
  <p style="font-size: 14px; line-height: 1.5; color: #333;">
    Your ownership claim for <strong>${safeItem}</strong> has been approved by campus administration.
  </p>

  ${safeLocation ? `
  <div style="background: #fbfbf7; padding: 12px 16px; border-left: 4px solid #274029; border-radius: 4px; margin: 16px 0;">
    <p style="margin: 0; font-size: 13px; color: #555;"><strong>Collection Desk:</strong> ${safeLocation}</p>
  </div>
  ` : ""}

  <div style="background: #f3f8f3; border: 1px solid #cce3cc; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0;">
    <span style="display: block; font-size: 12px; font-weight: 700; color: #274029; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 8px;">
      Your Six-Digit Handover OTP
    </span>
    <span style="display: inline-block; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #274029; font-family: 'Courier New', monospace; background: #ffffff; padding: 10px 24px; border-radius: 8px; border: 1px solid #b8dab8;">
      ${safeOtp}
    </span>
    <p style="margin: 12px 0 0 0; font-size: 12px; color: #555;">
      This code expires in <strong>${safeExpires} minutes</strong> and can only be used once.
    </p>
  </div>

  <div style="margin: 20px 0; font-size: 14px; line-height: 1.6; color: #333;">
    <h3 style="font-size: 14px; color: #274029; margin-bottom: 6px;">How to complete your item handover:</h3>
    <ol style="padding-left: 20px; margin: 0;">
      <li style="margin-bottom: 4px;">Visit the collection desk with your valid student ID.</li>
      <li style="margin-bottom: 4px;">Inspect your item with the handover officer to confirm it is yours.</li>
      <li style="margin-bottom: 4px;">Log in to your <strong>CampusFind Profile &gt; My Claims</strong> on your phone.</li>
      <li style="margin-bottom: 4px;">Enter the 6-digit OTP above and click <strong>Verify handover OTP</strong> to record the return.</li>
    </ol>
  </div>

  <div style="background: #fdf0ed; border-left: 4px solid #b12d2d; padding: 12px 16px; border-radius: 4px; margin: 20px 0;">
    <p style="margin: 0; font-size: 12px; color: #8a1f1f; line-height: 1.4;">
      <strong>Security Warning:</strong> Never share this code via chat, phone, or email. Only enter it in your CampusFind profile when physically collecting your item. Campus staff will never ask for your code remotely.
    </p>
  </div>

  <hr style="border: 0; border-top: 1px solid #eee; margin: 24px 0 16px 0;" />
  <small style="display: block; font-size: 11px; color: #888; text-align: center;">
    CampusFind · Automated notification · Please do not reply directly to this email.
  </small>
</div>
`;

  const text = `CampusFind — Your Handover Verification OTP

Hello ${studentName || "Student"},

Your ownership claim for ${itemName || "your item"} has been approved by campus administration.
${handoverLocation ? `Collection Desk: ${handoverLocation}\n` : ""}
Your Six-Digit Handover OTP is: ${otp}

This code expires in ${expiresMinutes} minutes and can only be used once.

How to complete your item handover:
1. Visit the collection desk with your valid student ID.
2. Inspect your item with the handover officer to confirm it is yours.
3. Log in to your CampusFind Profile > My Claims.
4. Enter the 6-digit OTP and click "Verify handover OTP".

Security Warning: Never share this code via chat, phone, or email. Only enter it in your CampusFind profile when physically collecting your item. Campus staff will never ask for your code remotely.

CampusFind — Automated notification`;

  return { subject, html, text };
}

/**
 * Deliver handover OTP email specifically to the approved claimant.
 * Returns delivery result object with status: "sent" | "failed" | "smtp_not_configured".
 */
export async function sendHandoverOtp({ recipientEmail, studentName, itemName, handoverLocation, otp, expiresMinutes = 10 }) {
  const { subject, html, text } = renderHandoverOtpEmail({
    studentName,
    itemName,
    handoverLocation,
    otp,
    expiresMinutes
  });

  return sendEmail({
    to: recipientEmail,
    subject,
    html,
    text
  });
}
