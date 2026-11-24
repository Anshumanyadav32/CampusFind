import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass }
    });
  }

  return transporter;
}

const FROM_EMAIL = process.env.EMAIL_FROM || "CampusFind <noreply@campusfind.edu>";

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
 * Safely send an email notification. Fails silently without crashing core workflows.
 */
async function sendSafeEmail({ to, subject, html, text }) {
  if (!to) return false;

  const transport = getTransporter();
  if (!transport) {
    // SMTP credentials not configured (common in dev/test) - safely log and continue
    return false;
  }

  try {
    await transport.sendMail({
      from: FROM_EMAIL,
      to,
      subject,
      text: text || html.replace(/<[^>]+>/g, " "),
      html
    });
    return true;
  } catch (error) {
    console.warn(`[EmailService] Failed to send email to ${to}: ${error.message}`);
    return false;
  }
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

export async function sendHandoverOtp({ recipientEmail, studentName, otp, expiresMinutes = 10 }) {
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px;">
      <h2>CampusFind handover verification</h2>
      <p>Hello ${escapeHtml(studentName)}, show this code only to the authorized handover officer:</p>
      <p style="font-size: 24px; font-weight: bold; letter-spacing: 4px;">${escapeHtml(otp)}</p>
      <p>This code expires in ${escapeHtml(expiresMinutes)} minutes and can only be used once.</p>
    </div>
  `;
  return sendSafeEmail({
    to: recipientEmail,
    subject: "CampusFind secure handover OTP",
    html,
    text: `Your CampusFind handover code is ${otp}. It expires in ${expiresMinutes} minutes.`
  });
}
