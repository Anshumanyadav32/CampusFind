import crypto from "node:crypto";

/**
 * Reversibly encrypt an unexpired six-digit handover OTP using AES-256-GCM.
 * This ensures that plaintext OTPs are NEVER stored in MongoDB or written to logs,
 * while allowing authorized administrators to securely retry email delivery of the
 * SAME unexpired OTP if initial SMTP delivery fails.
 */
export function encryptOtp(otp, secret = process.env.JWT_SECRET) {
  if (!otp || !/^\d{6}$/.test(String(otp))) {
    throw new Error("Invalid OTP format for encryption. Must be exactly 6 digits.");
  }
  if (!secret || secret.length < 32) {
    throw new Error("Encryption secret must be at least 32 characters.");
  }

  const key = crypto.createHash("sha256").update(String(secret)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(String(otp), "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypt and authenticate an AES-256-GCM encrypted OTP.
 * Returns the exact 6-digit OTP string, or null if tampering or decryption fails.
 */
export function decryptOtp(token, secret = process.env.JWT_SECRET) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(":");
  if (parts.length !== 3) return null;

  const [ivHex, authTagHex, cipherHex] = parts;
  if (!ivHex || !authTagHex || !cipherHex) return null;

  try {
    const key = crypto.createHash("sha256").update(String(secret)).digest();
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(cipherHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return /^\d{6}$/.test(decrypted) ? decrypted : null;
  } catch {
    return null;
  }
}
