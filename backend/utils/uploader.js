import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configure Cloudinary if credentials are provided
const isCloudinaryConfigured = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
}

// Public uploads directory (mounted statically on /uploads for public item photos)
export const PUBLIC_UPLOAD_DIR = path.resolve(__dirname, "../uploads");
if (!fs.existsSync(PUBLIC_UPLOAD_DIR)) {
  fs.mkdirSync(PUBLIC_UPLOAD_DIR, { recursive: true });
}

// Private uploads directory (NEVER mounted statically; accessed only via authenticated streaming endpoint)
export const PRIVATE_UPLOAD_DIR = path.resolve(__dirname, "../uploads_private");
if (!fs.existsSync(PRIVATE_UPLOAD_DIR)) {
  fs.mkdirSync(PRIVATE_UPLOAD_DIR, { recursive: true });
}

// Max file size: 5MB
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Detect file type using magic byte signatures (header inspection)
 * Prevents disguised files and MIME-type spoofing
 * Supports JPEG, PNG, WebP, GIF, and PDF
 * @param {Buffer} buffer
 * @returns {{ mime: string, ext: string } | null}
 */
export function detectFileSignature(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: ".jpg" };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mime: "image/png", ext: ".png" };
  }

  // WebP: RIFF .... WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { mime: "image/webp", ext: ".webp" };
  }

  // GIF: GIF87a or GIF89a
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return { mime: "image/gif", ext: ".gif" };
  }

  // PDF: %PDF- (0x25, 0x50, 0x44, 0x46, 0x2D)
  if (
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return { mime: "application/pdf", ext: ".pdf" };
  }

  return null;
}

const storage = multer.memoryStorage();

// Multer parser for multipart uploads
export const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

/**
 * Save public item photographs to public upload storage
 * Rejects PDFs (public photos must be image files) and validates magic bytes
 * @param {Express.Multer.File[]} files
 * @param {string} [folder="campusfind/public"]
 * @param {import("express").Request} [req]
 * @returns {Promise<string[]>} Array of public URLs
 */
export async function savePublicImages(files = [], folder = "campusfind/public", req = null) {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  const urls = [];

  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File "${file.originalname}" exceeds the 5MB size limit.`);
    }

    const signature = detectFileSignature(file.buffer);
    if (!signature) {
      throw new Error(`File "${file.originalname}" has an invalid content signature. Only JPEG, PNG, WEBP, and GIF images are allowed.`);
    }

    if (signature.mime === "application/pdf") {
      throw new Error(`File "${file.originalname}" is a PDF. Public item photos must be images (JPEG, PNG, WebP, or GIF).`);
    }

    if (isCloudinaryConfigured) {
      const url = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder,
            resource_type: "image",
            transformation: [{ quality: "auto", fetch_format: "auto" }]
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result.secure_url);
          }
        );
        stream.end(file.buffer);
      });
      urls.push(url);
    } else {
      const randomId = crypto.randomBytes(8).toString("hex");
      const filename = `photo-${Date.now()}-${randomId}${signature.ext}`;
      const filepath = path.join(PUBLIC_UPLOAD_DIR, filename);
      fs.writeFileSync(filepath, file.buffer);

      let host = "localhost:5000";
      let protocol = "http";
      if (req) {
        host = req.get("host") || host;
        protocol = req.protocol || protocol;
      }
      urls.push(`${protocol}://${host}/uploads/${filename}`);
    }
  }

  return urls;
}

/**
 * Save private claim evidence files (ownership proofs, receipts, IDs)
 * Stored strictly outside the public static directory
 * Validates magic bytes (JPEG, PNG, WebP, GIF, or PDF)
 * Uses cryptographically unguessable filenames
 * @param {Express.Multer.File[]} files
 * @param {import("express").Request} [req]
 * @returns {Promise<Array<{ filename: string, originalName: string, mimeType: string, size: number, url: string }>>}
 */
export async function savePrivateEvidence(files = [], req = null) {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  const results = [];

  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File "${file.originalname}" exceeds the 5MB size limit.`);
    }

    const signature = detectFileSignature(file.buffer);
    if (!signature) {
      throw new Error(`File "${file.originalname}" has an invalid content signature. Allowed formats are JPEG, PNG, WEBP, GIF, and PDF.`);
    }

    // Unguessable randomized filename with verified extension
    const randomHex = crypto.randomBytes(16).toString("hex");
    const filename = `proof-${Date.now()}-${randomHex}${signature.ext}`;
    const filepath = path.join(PRIVATE_UPLOAD_DIR, filename);

    fs.writeFileSync(filepath, file.buffer);

    let host = "localhost:5000";
    let protocol = "http";
    if (req) {
      host = req.get("host") || host;
      protocol = req.protocol || protocol;
    }

    const fileUrl = `${protocol}://${host}/api/claims/proof/${filename}`;

    results.push({
      filename,
      originalName: file.originalname || filename,
      mimeType: signature.mime,
      size: file.size,
      url: fileUrl
    });
  }

  return results;
}

// Backward-compatible alias for existing callers
export async function uploadImages(files = [], folder = "campusfind", req = null) {
  return savePublicImages(files, folder, req);
}
