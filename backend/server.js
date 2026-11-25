import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as oidc from "openid-client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { User } from "./models/User.js";
import { Item } from "./models/Item.js";
import { Match } from "./models/Match.js";
import { Claim } from "./models/Claim.js";
import { AuditLog } from "./models/AuditLog.js";
import {
  normalize,
  escapeRegex,
  calculateMatchScore,
  isMatchConfident,
  buildCandidateQuery
} from "./utils/matching.js";
import {
  sanitizeString,
  parseStudentId,
  getAuthRateLimitConfig,
  sanitizePublicItem,
  validateEnvironment
} from "./utils/validation.js";
import {
  upload,
  detectFileSignature,
  uploadImages,
  savePublicImages,
  savePrivateEvidence,
  PUBLIC_UPLOAD_DIR,
  PRIVATE_UPLOAD_DIR
} from "./utils/uploader.js";
import {
  notifyMatchFound,
  notifyClaimUpdate,
  notifyClaimStatusChange,
  notifyAdminResolution,
  sendVerificationOtp,
  sendHandoverOtp,
  getSmtpConfig,
  verifySmtpConnection,
  sanitizeSmtpError
} from "./services/emailService.js";
import { encryptOtp, decryptOtp } from "./utils/encryption.js";

dotenv.config();

const PORT = Number(process.env.PORT) || 5000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/CampusFind";
const JWT_SECRET = process.env.JWT_SECRET;
const AUTH_COOKIE_NAME = "campusfind_token";
const OIDC_PENDING_COOKIE = "campusfind_oidc";
const AUTH_MODE = process.env.AUTH_MODE || (process.env.NODE_ENV === "production" ? "oidc" : "local");
const AUTH_RATE_LIMIT = getAuthRateLimitConfig(process.env);
const OIDC_ISSUER = process.env.OIDC_ISSUER;
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID;
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET;
const OIDC_REDIRECT_URI = process.env.OIDC_REDIRECT_URI;
const OIDC_STUDENT_ID_CLAIM = process.env.OIDC_STUDENT_ID_CLAIM || "student_id";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];
const allowedOrigins = new Set(
  (process.env.CLIENT_ORIGINS
    ? process.env.CLIENT_ORIGINS.split(",")
    : defaultOrigins)
    .map((origin) => origin.trim())
    .filter(Boolean)
);

let oidcConfigurationPromise;

function getSessionToken(req) {
  const cookieToken = req.cookies?.[AUTH_COOKIE_NAME];
  if (cookieToken) return cookieToken;

  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }

  return null;
}

function requireStudent(usersCollection) {
  return async (req, res, next) => {
    const token = getSessionToken(req);
    if (!token) {
      return res.status(401).json({ message: "Authentication required." });
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET, {
        issuer: "campusfind",
        audience: "campusfind-web"
      });
    } catch {
      return res.status(401).json({ message: "Session expired or invalid." });
    }

    const studentId = parseStudentId(payload.studentId);
    if (studentId === null) {
      return res.status(401).json({ message: "Session expired or invalid." });
    }

    try {
      const user = await usersCollection().findOne({ studentId });
      if (!user || String(user._id) !== String(payload.userId)) {
        return res.status(401).json({ message: "Session expired or invalid." });
      }

      req.userId = studentId;
      req.currentUser = user;

      const accountStatus = user.accountStatus || "active";
      if (accountStatus === "suspended") {
        return res.status(403).json({
          message: `Your account has been suspended due to suspicious activity.${user.statusReason ? " Reason: " + user.statusReason : ""}`
        });
      }
      if (accountStatus === "deactivated") {
        return res.status(403).json({
          message: `Your account has been deactivated.${user.statusReason ? " Reason: " + user.statusReason : ""}`
        });
      }
      if (accountStatus === "pending") {
        return res.status(403).json({
          message: "Your account is pending administrator activation."
        });
      }

      if ((user.sessionVersion || 0) !== (payload.sessionVersion || 0)) {
        return res.status(401).json({ message: "Session expired or invalid." });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireAdmin(usersCollection) {
  return async (req, res, next) => {
    await requireStudent(usersCollection)(req, res, () => {
      if (req.currentUser.role !== "admin") {
        return res.status(403).json({ message: "Admin authorization required." });
      }
      next();
    });
  };
}

function createSessionToken(user) {
  return jwt.sign(
    {
      userId: user._id.toString(),
      studentId: user.studentId,
      role: user.role || "student",
      sessionVersion: user.sessionVersion || 0
    },
    JWT_SECRET,
    {
      expiresIn: "7d",
      issuer: "campusfind",
      audience: "campusfind-web"
    }
  );
}

function createIdSelector(rawId) {
  const value = sanitizeString(rawId);
  if (!value) return null;

  return mongoose.isValidObjectId(value)
    ? new mongoose.Types.ObjectId(value)
    : value;
}

function isPubliclyVisibleItem(item) {
  return Boolean(item && (item.moderationStatus === undefined || item.moderationStatus === null || item.moderationStatus === "active"));
}

function compareItemReporterToUser(reportedBy, user) {
  if (reportedBy === undefined || reportedBy === null || reportedBy === "") return null;

  const reporterStudentId = parseStudentId(reportedBy);
  if (reporterStudentId !== null) {
    const authenticatedStudentId = parseStudentId(user?.studentId);
    return authenticatedStudentId === null ? null : reporterStudentId === authenticatedStudentId;
  }

  let reporterObjectId;
  if (reportedBy instanceof mongoose.Types.ObjectId) {
    reporterObjectId = reportedBy;
  } else if (typeof reportedBy === "string" && mongoose.isValidObjectId(reportedBy)) {
    reporterObjectId = new mongoose.Types.ObjectId(reportedBy);
  } else if (
    reportedBy && typeof reportedBy === "object"
    && typeof reportedBy.$oid === "string"
    && mongoose.isValidObjectId(reportedBy.$oid)
  ) {
    reporterObjectId = new mongoose.Types.ObjectId(reportedBy.$oid);
  } else {
    return null;
  }

  const userId = user?._id ?? user?.id;
  if (!userId) return null;

  if (userId instanceof mongoose.Types.ObjectId) {
    return reporterObjectId.equals(userId);
  }
  if (typeof userId === "string" && mongoose.isValidObjectId(userId)) {
    return reporterObjectId.equals(new mongoose.Types.ObjectId(userId));
  }
  return String(reporterObjectId) === String(userId);
}

function sanitizeStudentClaim(claim) {
  if (!claim) return null;
  const {
    handoverOtpHash,
    handoverOtpEncrypted,
    handoverOtpExpiresAt,
    handoverOtpAttempts,
    riskScore,
    riskCategory,
    riskFactors,
    riskHistory,
    verificationMatchScore,
    adminReviewedBy,
    adminRemarks,
    ...studentClaim
  } = claim;
  return studentClaim;
}

function sanitizeAdminClaim(claim) {
  if (!claim) return null;
  const { handoverOtpHash, handoverOtpEncrypted, handoverOtpExpiresAt, handoverOtpAttempts, ...adminClaim } = claim;
  return {
    ...adminClaim,
    handoverOtpActive: Boolean(claim.handoverOtpHash && claim.handoverOtpExpiresAt && new Date(claim.handoverOtpExpiresAt).getTime() > Date.now()),
    handoverOtpExpired: Boolean(claim.handoverOtpExpiresAt && new Date(claim.handoverOtpExpiresAt).getTime() <= Date.now())
  };
}

function isSafePrivateFilename(filename) {
  return typeof filename === "string"
    && filename === path.basename(filename)
    && !filename.includes("..")
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(filename);
}

async function cleanupPrivateEvidenceFiles(filenames, privateFilesCollection, allowedPurpose = null) {
  const cleaned = [];
  const failed = [];

  if (!Array.isArray(filenames)) return { cleaned, failed };

  for (const filename of filenames) {
    if (!isSafePrivateFilename(filename)) {
      failed.push({ filename, reason: "invalid filename" });
      continue;
    }

    const recordQuery = { filename };
    if (allowedPurpose) recordQuery.purpose = allowedPurpose;
    const record = await privateFilesCollection().findOne(recordQuery);
    if (!record) continue;

    const filePath = path.join(PRIVATE_UPLOAD_DIR, filename);
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
      if (typeof privateFilesCollection().deleteOne === "function") {
        await privateFilesCollection().deleteOne({ _id: record._id });
      }
      cleaned.push(filename);
    } catch (error) {
      console.warn(`[PrivateEvidenceCleanup] Failed to delete ${filename}: ${error.message}`);
      failed.push({ filename, reason: error.message });
    }
  }

  return { cleaned, failed };
}

function normalizeClaimProofFilename(reference) {
  if (typeof reference !== "string") return null;
  const value = reference.trim();
  let filename = value;

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const routePrefix = "/api/claims/proof/";
      if (!url.pathname.startsWith(routePrefix)) return null;
      filename = decodeURIComponent(url.pathname.slice(routePrefix.length));
    } catch {
      return null;
    }
  }

  return isSafePrivateFilename(filename) ? filename : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function generateSecureOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

function timingSafeTokenEqual(expected, actual) {
  const expectedBuffer = Buffer.from(String(expected));
  const actualBuffer = Buffer.from(String(actual));
  return expectedBuffer.length === actualBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function normalizeVerificationText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenSimilarity(left, right) {
  const leftTokens = new Set(normalizeVerificationText(left).split(/\s+/).filter(Boolean));
  const rightTokens = new Set(normalizeVerificationText(right).split(/\s+/).filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token) || [...rightTokens].some((candidate) =>
      candidate.length >= 5 && (candidate.includes(token) || token.includes(candidate))
    )) {
      intersection += 1;
    }
  }
  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

function buildPrivateOwnershipFacts(item) {
  return [
    item.brand,
    item.model,
    item.serialNumber,
    item.identifyingMarks,
    item.verificationQuestion,
    ...(Array.isArray(item.verificationQuestions) ? item.verificationQuestions : []),
    item.accessories,
    item.physicalDamage
  ].map(normalizeVerificationText).filter(Boolean);
}

function assessClaimVerification(item, answers, claimant, recentClaims, rejectedClaims) {
  const factors = [];
  let score = 0;

  if (process.env.REQUIRE_COLLEGE_EMAIL_VERIFICATION === "true" && !claimant?.emailVerified) {
    score += 10;
    factors.push("unverified_college_account");
  }
  if (recentClaims >= 2) {
    score += 20;
    factors.push("repeated_claim_submission");
  }
  if (rejectedClaims >= 2) {
    score += 20;
    factors.push("multiple_rejected_claims");
  }

  const privateFacts = buildPrivateOwnershipFacts(item);
  const answerText = (Array.isArray(answers) ? answers : [])
    .map((entry) => typeof entry === "object" ? entry.answer || "" : entry)
    .join(" ");

  let matchScore = 0;
  if (privateFacts.length > 0 && normalizeVerificationText(answerText)) {
    matchScore = Math.round(Math.max(...privateFacts.map((fact) => tokenSimilarity(answerText, fact))) * 100);
  }
  if (privateFacts.length > 0 && matchScore < 35) {
    score += 25;
    factors.push("contradictory_ownership_details");
  }

  return {
    score,
    category: score >= 50 ? "investigation" : score >= 20 ? "additional_review" : "normal",
    factors,
    matchScore
  };
}

async function getOIDCConfiguration() {
  if (!OIDC_ISSUER || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET || !OIDC_REDIRECT_URI) {
    throw new Error("Campus SSO is not configured. Set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_REDIRECT_URI.");
  }

  if (!oidcConfigurationPromise) {
    oidcConfigurationPromise = oidc.discovery(
      new URL(OIDC_ISSUER),
      OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET
    );
  }

  return oidcConfigurationPromise;
}

function getAuthCookieOptions(maxAge = 7 * 24 * 60 * 60 * 1000) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge,
    path: "/"
  };
}

export async function createMatchesForItem(item, itemId, collectionFactory) {
  if (!isPubliclyVisibleItem(item)) return 0;

  const itemsCollection = collectionFactory.itemsCollection;
  const matchesCollection = collectionFactory.matchesCollection;
  const usersCollection = collectionFactory.usersCollection;

  // Build candidate query using tokenized keywords and category
  const candidateQuery = buildCandidateQuery(item, itemId);
  const oppositeItems = await itemsCollection()
    .find(candidateQuery)
    .toArray();

  let matchesCreated = 0;

  for (const other of oppositeItems) {
    const lost = normalize(item.reportType) === "lost" ? item : other;
    const found = normalize(item.reportType) === "found" ? item : other;
    const score = calculateMatchScore(lost, found);

    // Apply confidence threshold
    if (!isMatchConfident(score)) {
      continue;
    }

    const lostId = normalize(item.reportType) === "lost" ? itemId : other._id;
    const foundId = normalize(item.reportType) === "found" ? itemId : other._id;

    try {
      const result = await matchesCollection().updateOne(
        {
          lostItemId: lostId,
          foundItemId: foundId,
          status: { $in: ["pending", "confirming", "confirmed", "disputed"] }
        },
        {
          $setOnInsert: {
            lostItemId: lostId,
            foundItemId: foundId,
            lostReportedBy: Number(lost.reportedBy),
            foundReportedBy: Number(found.reportedBy),
            matchScore: score,
            status: "pending",
            claimHistory: [
              {
                action: "match_created",
                performedBy: "system",
                role: "system",
                details: `Potential match generated with confidence score ${score}%`,
                timestamp: new Date()
              }
            ],
            createdAt: new Date()
          }
        },
        { upsert: true }
      );

      if (result.upsertedCount === 1) {
        matchesCreated += 1;

        // Asynchronously dispatch match notification emails if users collection is provided
        if (usersCollection) {
          Promise.all([
            usersCollection().findOne({ studentId: Number(lost.reportedBy) }),
            usersCollection().findOne({ studentId: Number(found.reportedBy) })
          ]).then(([lostUser, foundUser]) => {
            if (lostUser?.email) {
              notifyMatchFound({
                recipientEmail: lostUser.email,
                studentName: lostUser.name || "Student",
                itemReported: lost,
                matchedItem: found,
                matchScore: score
              }).catch(() => {});
            }
            if (foundUser?.email) {
              notifyMatchFound({
                recipientEmail: foundUser.email,
                studentName: foundUser.name || "Student",
                itemReported: found,
                matchedItem: lost,
                matchScore: score
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      }
    } catch (error) {
      if (error.code !== 11000) {
        throw error;
      }
    }
  }

  return matchesCreated;
}

async function completeMatchConfirmation(
  match,
  itemsCollection,
  matchesCollection,
  claimsCollection,
  confirmedByStudentId
) {
  const now = new Date();
  const actorId = parseStudentId(confirmedByStudentId || match.confirmedBy || match.lostReportedBy);
  const lockToken = crypto.randomUUID();
  const lockResult = await matchesCollection().updateOne(
    {
      _id: match._id,
      status: "confirming",
      confirmedBy: actorId,
      $or: [
        { confirmationLockUntil: { $exists: false } },
        { confirmationLockUntil: null },
        { confirmationLockUntil: { $lte: now } }
      ]
    },
    {
      $set: {
        confirmationLockToken: lockToken,
        confirmationLockUntil: new Date(now.getTime() + 2 * 60 * 1000)
      }
    }
  );
  if (lockResult.matchedCount !== 1) {
    return { ok: false, reason: "busy" };
  }

  const reportFailure = (reason, failedUpdate, result, states = {}) => {
    console.error("[MatchConfirmation] Recovery step failed.", JSON.stringify({
      matchId: String(match._id),
      lostReportId: String(match.lostItemId),
      foundReportId: String(match.foundItemId),
      failedUpdate,
      matchedCount: result?.matchedCount ?? null,
      modifiedCount: result?.modifiedCount ?? null,
      currentConfirmationState: "confirming",
      lostReportState: states.lostReportState ?? null,
      foundReportState: states.foundReportState ?? null,
      reason
    }));
    return { ok: false, reason };
  };

  const asIdSelector = (value) => {
    if (value === undefined || value === null || value === "") return null;
    return createIdSelector(String(value));
  };
  const lostItemSelector = asIdSelector(match.lostItemId);
  const foundItemSelector = asIdSelector(match.foundItemId);

  try {
    if (!actorId || !lostItemSelector || !foundItemSelector || String(lostItemSelector) === String(foundItemSelector)) {
      return reportFailure("invalid linked report identifiers", "validate-linked-report-ids");
    }

    const [lostItem, foundItem] = await Promise.all([
      itemsCollection().findOne({ _id: lostItemSelector }),
      itemsCollection().findOne({ _id: foundItemSelector })
    ]);

    if (!lostItem || !foundItem) {
      return reportFailure(
        !lostItem ? "lost report missing" : "found report missing",
        !lostItem ? "load-lost-report" : "load-found-report",
        null,
        { lostReportState: lostItem?.status, foundReportState: foundItem?.status }
      );
    }

    if (
      normalize(lostItem.reportType) !== "lost"
      || normalize(foundItem.reportType) !== "found"
      || parseStudentId(lostItem.reportedBy) !== parseStudentId(match.lostReportedBy)
      || parseStudentId(foundItem.reportedBy) !== parseStudentId(match.foundReportedBy)
    ) {
      return reportFailure(
        "linked report types or reporter identities do not match the match record",
        "validate-linked-report-ownership",
        null,
        { lostReportState: lostItem.status, foundReportState: foundItem.status }
      );
    }

    const isCompletedClaimReturn = async (item) => {
      if (!item.approvedClaimId) return false;
      const claimSelector = asIdSelector(item.approvedClaimId);
      if (!claimSelector) return false;
      const claim = await claimsCollection().findOne({ _id: claimSelector });
      return Boolean(
        claim
        && String(claim.itemId) === String(item._id)
        && parseStudentId(claim.claimantId) === actorId
        && claim.status === "returned"
        && claim.handoverDate
        && parseStudentId(claim.handoverConfirmedBy) === actorId
      );
    };

    const isResolvedForThisMatch = async (item) => {
      if (item.status !== "returned") return false;
      if (item.approvedMatchId && String(item.approvedMatchId) === String(match._id)) return true;
      return isCompletedClaimReturn(item);
    };

    for (const item of [lostItem, foundItem]) {
      if (await isResolvedForThisMatch(item)) {
        continue;
      }

      if (
        item.status === "returned"
        || item.status === "closed"
        || !["active", null, undefined].includes(item.moderationStatus)
      ) {
        return reportFailure(
          "report is already resolved or moderated outside this match",
          `reserve-${normalize(item.reportType)}-report`,
          null,
          { lostReportState: lostItem.status, foundReportState: foundItem.status }
        );
      }

      const reservation = await itemsCollection().updateOne(
        {
          _id: item._id,
          status: { $nin: ["returned", "closed"] },
          approvedClaimId: { $in: [null] },
          approvedMatchId: { $in: [null] },
          moderationStatus: { $in: ["active", null] }
        },
        {
          $set: {
            status: "returned",
            approvedMatchId: match._id,
            updatedAt: new Date()
          }
        }
      );

      if (reservation.matchedCount !== 1) {
        const latest = await itemsCollection().findOne({ _id: item._id });
        if (latest && await isResolvedForThisMatch(latest)) {
          continue;
        }
        return reportFailure(
          "conditional report update did not match",
          `reserve-${normalize(item.reportType)}-report`,
          reservation,
          { lostReportState: lostItem.status, foundReportState: foundItem.status }
        );
      }
    }

    const [verifiedLost, verifiedFound] = await Promise.all([
      itemsCollection().findOne({ _id: lostItemSelector }),
      itemsCollection().findOne({ _id: foundItemSelector })
    ]);
    if (
      !verifiedLost || !verifiedFound
      || !(await isResolvedForThisMatch(verifiedLost))
      || !(await isResolvedForThisMatch(verifiedFound))
    ) {
      return reportFailure(
        "final report state verification failed",
        "verify-final-report-states",
        null,
        { lostReportState: verifiedLost?.status, foundReportState: verifiedFound?.status }
      );
    }

    const finalized = await matchesCollection().updateOne(
      { _id: match._id, status: "confirming", confirmationLockToken: lockToken },
      {
        $set: {
          status: "confirmed",
          confirmedAt: new Date()
        },
        $unset: {
          confirmationLockToken: "",
          confirmationLockUntil: ""
        },
        $push: {
          claimHistory: {
            action: "confirmed",
            performedBy: actorId,
            role: "student",
            details: "Handover confirmed. Linked reports verified as returned.",
            timestamp: new Date()
          }
        }
      }
    );
    if (finalized.matchedCount !== 1) {
      const latestMatch = await matchesCollection().findOne({ _id: match._id });
      if (latestMatch?.status === "confirmed") return { ok: true, alreadyCompleted: true };
      return reportFailure("match finalization did not match the active recovery lease", "finalize-match", finalized);
    }

    return { ok: true, alreadyCompleted: false };
  } catch (error) {
    console.error("[MatchConfirmation] Recovery operation raised an error.", JSON.stringify({
      matchId: String(match._id),
      lostReportId: String(match.lostItemId),
      foundReportId: String(match.foundItemId),
      failedUpdate: "confirmation-recovery",
      matchedCount: null,
      modifiedCount: null,
      currentConfirmationState: "confirming",
      errorName: error?.name || "Error"
    }));
    return { ok: false, reason: "database operation failed" };
  } finally {
    await matchesCollection().updateOne(
      { _id: match._id, status: "confirming", confirmationLockToken: lockToken },
      { $unset: { confirmationLockToken: "", confirmationLockUntil: "" } }
    ).catch((error) => {
      console.error("[MatchConfirmation] Could not release recovery lease.", JSON.stringify({
        matchId: String(match._id),
        lostReportId: String(match.lostItemId),
        foundReportId: String(match.foundItemId),
        currentConfirmationState: "confirming",
        errorName: error.name
      }));
    });
  }
}

export function createApp(collectionFactory = {}) {
  const itemsCollection = collectionFactory.itemsCollection || (() => mongoose.connection.collection("items"));
  const matchesCollection = collectionFactory.matchesCollection || (() => mongoose.connection.collection("matches"));
  const usersCollection = collectionFactory.usersCollection || (() => mongoose.connection.collection("users"));
  const claimsCollection = collectionFactory.claimsCollection || (() => mongoose.connection.collection("claims"));
  const privateFilesCollection = collectionFactory.privateFilesCollection || (() => mongoose.connection.collection("privateFiles"));
  const auditLogsCollection = collectionFactory.auditLogsCollection || (() => mongoose.connection.collection("auditLogs"));
  const otpCollection = collectionFactory.otpCollection || (() => mongoose.connection.collection("otpVerifications"));
  const app = express();

  async function recordAudit({
    adminId,
    adminName,
    adminRole = "admin",
    action,
    targetUserId,
    targetClaimId,
    targetItemId,
    previousStatus,
    newStatus,
    reason = "",
    details = "",
    req
  }) {
    try {
      const ip = req?.ip || req?.headers?.["x-forwarded-for"] || "";
      await auditLogsCollection().insertOne({
        adminId: adminId ? String(adminId) : "system",
        adminName: adminName || "Administrator",
        adminRole,
        action,
        targetUserId: targetUserId ? String(targetUserId) : null,
        targetClaimId: targetClaimId ? String(targetClaimId) : null,
        targetItemId: targetItemId ? String(targetItemId) : null,
        previousStatus: previousStatus || null,
        newStatus: newStatus || null,
        reason: sanitizeString(reason),
        details: sanitizeString(details),
        ipAddress: String(ip),
        createdAt: new Date()
      });
    } catch (auditErr) {
      console.warn("[AuditLog] Failed to record audit log:", auditErr.message);
    }
  }

  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      // In non-production, allow any localhost/127.0.0.1 port to prevent dev port mismatches
      if (process.env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      callback(null, false);
    },
    credentials: true
  }));

  app.use((req, res, next) => {
    const origin = req.get("Origin");
    const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
    if (isMutation && origin) {
      const isLocal = process.env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      if (!allowedOrigins.has(origin) && !isLocal) {
        return res.status(403).json({ message: "Origin is not allowed." });
      }
    }
    next();
  });

  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));

  // Serve locally uploaded public photos statically (strictly isolated to public item images)
  app.use("/uploads", express.static(PUBLIC_UPLOAD_DIR));

  // Global rate limiter
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many requests. Please try again later." }
  });
  app.use(globalLimiter);

  // Keep production authentication limits strict while allowing more local development retries.
  const authLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT.windowMs,
    max: AUTH_RATE_LIMIT.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many authentication attempts. Please try again later." }
  });

  app.get("/", (req, res) => {
    res.send("Welcome to CampusFind API!");
  });

  const parseUploadedFiles = (req, res, next) => {
    upload.any()(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: err.message || "Invalid file upload." });
      }
      next();
    });
  };

  // Public photos and private verification photos both require an authenticated reporter.
  app.post(
    "/api/upload",
    (req, res, next) => {
      if (
        req.query.isPrivate !== undefined &&
        req.query.isPrivate !== "true" &&
        req.query.isPrivate !== "false"
      ) {
        return res.status(400).json({ message: "isPrivate must be true or false." });
      }
      requireStudent(usersCollection)(req, res, next);
    },
    parseUploadedFiles,
    async (req, res) => {
      try {
        const files = req.files || [];
        if (files.length === 0) {
          return res.status(400).json({ message: "No image files were provided for upload." });
        }

        if (req.query.isPrivate === "true") {
          if (
            files.length > 10 ||
            files.some((file) => !detectFileSignature(file.buffer)?.mime.startsWith("image/"))
          ) {
            return res.status(400).json({
              message: "Private verification photos must be valid JPEG, PNG, WebP, or GIF images (maximum 10 files)."
            });
          }

          const savedFiles = await savePrivateEvidence(files, req);
          for (const file of savedFiles) {
            await privateFilesCollection().insertOne({
              filename: file.filename,
              originalName: file.originalName,
              mimeType: file.mimeType,
              size: file.size,
              uploaderStudentId: req.userId,
              purpose: "itemVerification",
              createdAt: new Date()
            });
          }

          return res.status(201).json({
            message: "Private verification photos uploaded successfully.",
            files: savedFiles.map(({ filename, originalName, mimeType, size }) => ({
              filename,
              originalName,
              mimeType,
              size
            }))
          });
        }

        if (files.length > 10) {
          return res.status(400).json({
            message: "Public item images are limited to 10 files."
          });
        }

        const urls = await savePublicImages(files, "campusfind/public", req);

        res.json({
          message: "Images uploaded successfully.",
          urls
        });
      } catch (error) {
        res.status(400).json({ message: error.message || "Failed to upload image." });
      }
    }
  );

  // Authenticated Private Claim Evidence Upload Handler
  // Requires student authentication, verifies magic bytes (JPEG, PNG, WebP, GIF, PDF),
  // stores files strictly outside the public static directory with cryptographic unguessable filenames.
  const handlePrivateEvidenceUpload = async (req, res) => {
    try {
      const files = req.files || [];
      if (files.length === 0) {
        return res.status(400).json({ message: "No evidence files were provided for upload." });
      }

      const savedFiles = await savePrivateEvidence(files, req);

      for (const f of savedFiles) {
        await privateFilesCollection().insertOne({
          filename: f.filename,
          originalName: f.originalName,
          mimeType: f.mimeType,
          size: f.size,
          uploaderStudentId: req.userId,
          purpose: "claimProof",
          createdAt: new Date()
        });
      }

      res.status(201).json({
        message: "Private evidence file uploaded successfully.",
        urls: savedFiles.map((f) => f.url),
        files: savedFiles
      });
    } catch (error) {
      res.status(400).json({ message: error.message || "Failed to upload private evidence file." });
    }
  };

  app.post(
    "/api/claims/proof/upload",
    requireStudent(usersCollection),
    (req, res, next) => {
      upload.any()(req, res, (err) => {
        if (err) {
          return res.status(400).json({ message: err.message || "Invalid file upload." });
        }
        next();
      });
    },
    handlePrivateEvidenceUpload
  );

  // Route alias for authenticated private uploads
  app.post(
    "/api/upload/private",
    requireStudent(usersCollection),
    (req, res, next) => {
      upload.any()(req, res, (err) => {
        if (err) {
          return res.status(400).json({ message: err.message || "Invalid file upload." });
        }
        next();
      });
    },
    handlePrivateEvidenceUpload
  );

  // Item verification photos are available only to admins reviewing the owning report.
  app.get("/api/admin/items/:itemId/private-images/:filename", requireAdmin(usersCollection), async (req, res) => {
    try {
      const itemSelector = createIdSelector(req.params.itemId);
      const safeFilename = req.params.filename;
      if (!itemSelector || !isSafePrivateFilename(safeFilename)) {
        return res.status(400).json({ message: "Invalid item or file identifier." });
      }

      const [item, fileRecord] = await Promise.all([
        itemsCollection().findOne({ _id: itemSelector }),
        privateFilesCollection().findOne({
          filename: safeFilename,
          purpose: "itemVerification"
        })
      ]);
      if (!item || !Array.isArray(item.privateImages) || !item.privateImages.includes(safeFilename) || !fileRecord) {
        return res.status(404).json({ message: "Private verification photo not found." });
      }

      const filePath = path.join(PRIVATE_UPLOAD_DIR, safeFilename);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: "Private verification photo not found." });
      }

      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Disposition", "inline");
      res.type(fileRecord.mimeType || "application/octet-stream");
      res.sendFile(filePath);
    } catch (error) {
      res.status(500).json({ message: error.message || "Failed to retrieve private verification photo." });
    }
  });

  // Authenticated private claim evidence retrieval; item verification evidence uses its admin-only route above.
  app.get("/api/claims/proof/:filename", requireStudent(usersCollection), async (req, res) => {
    try {
      const rawFilename = req.params.filename;
      const safeFilename = path.basename(rawFilename);

      if (!isSafePrivateFilename(safeFilename) || safeFilename !== rawFilename) {
        return res.status(400).json({ message: "Invalid file name." });
      }

      const fileRecord = await privateFilesCollection().findOne({ filename: safeFilename });
      if (!fileRecord || fileRecord.purpose === "itemVerification") {
        return res.status(404).json({ message: "Evidence file not found." });
      }

      const filePath = path.join(PRIVATE_UPLOAD_DIR, safeFilename);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: "Evidence file not found." });
      }

      const isAdmin = req.currentUser?.role === "admin";
      const isUploader = fileRecord.uploaderStudentId === req.userId;
      if (!isAdmin && !isUploader) {
        return res.status(403).json({
          message: "You are not authorized to view this private evidence file."
        });
      }

      // Security headers to prevent sniffing and execution
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'");
      res.setHeader("Cache-Control", "private, no-store");

      if (fileRecord?.mimeType) {
        res.setHeader("Content-Type", fileRecord.mimeType);
      } else {
        const ext = path.extname(safeFilename).toLowerCase();
        if (ext === ".pdf") res.setHeader("Content-Type", "application/pdf");
        else if (ext === ".png") res.setHeader("Content-Type", "image/png");
        else if (ext === ".jpg" || ext === ".jpeg") res.setHeader("Content-Type", "image/jpeg");
        else if (ext === ".webp") res.setHeader("Content-Type", "image/webp");
      }

      res.sendFile(filePath);
    } catch (error) {
      res.status(500).json({ message: error.message || "Failed to retrieve evidence file." });
    }
  });

  // Preserve partial regex search while validating and bounding queries
  async function listPublicItems(req, res) {
    try {
      const page = Number(req.query.page ?? 1);
      const pageSize = Number(req.query.pageSize ?? 24);
      const category = sanitizeString(req.query.category);
      const location = sanitizeString(req.query.location);
      const queryText = sanitizeString(req.query.q);
      const reportType = sanitizeString(req.query.reportType).toLowerCase();

      if (!Number.isInteger(page) || page < 1) {
        return res.status(400).json({ message: "Page must be a positive integer." });
      }
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
        return res.status(400).json({ message: "Page size must be between 1 and 50." });
      }
      if (category.length > 100 || location.length > 150 || queryText.length > 100) {
        return res.status(400).json({ message: "Search filters exceed the allowed length." });
      }
      if (reportType && !["lost", "found"].includes(reportType)) {
        return res.status(400).json({ message: "reportType must be lost or found." });
      }

      const conditions = [];
      if (category) {
        conditions.push({ category: { $regex: escapeRegex(category), $options: "i" } });
      }
      if (location) {
        conditions.push({ location: { $regex: escapeRegex(location), $options: "i" } });
      }
      if (reportType) {
        conditions.push({ reportType });
      }
      if (queryText) {
        const expression = { $regex: escapeRegex(queryText), $options: "i" };
        conditions.push({
          $or: [
            { itemName: expression },
            { category: expression },
            { color: expression },
            { location: expression }
          ]
        });
      }

      // Legacy records without moderationStatus remain visible; only active reports are public.
      conditions.push({ moderationStatus: { $in: ["active", null] } });
      conditions.push({ status: { $nin: ["returned", "closed"] } });

      const filter = conditions.length ? { $and: conditions } : {};
      const collection = itemsCollection();
      const [total, items] = await Promise.all([
        collection.countDocuments(filter),
        collection
          .find(filter)
          .sort({ dateReported: -1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .toArray()
      ]);

      // Strip all private verification details before exposing publicly
      res.json({
        items: items.map(sanitizePublicItem),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize)
      });
    } catch (error) {
      console.error("Item listing error:", error);
      res.status(500).json({ message: "Could not load item reports." });
    }
  }

  app.get("/api/auth/method", (req, res) => {
    res.json({ mode: AUTH_MODE });
  });

  app.post("/api/auth/email-verification/request", requireStudent(usersCollection), authLimiter, async (req, res) => {
    try {
      const user = await usersCollection().findOne({ studentId: req.userId });
      if (!user) return res.status(404).json({ message: "User not found." });
      if (user.emailVerified) return res.json({ message: "Your college email is already verified." });

      const allowedDomains = String(process.env.ALLOWED_EMAIL_DOMAINS || "")
        .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
      if (allowedDomains.length > 0) {
        const domain = String(user.email || "").split("@")[1]?.toLowerCase();
        if (!allowedDomains.includes(domain)) {
          return res.status(403).json({ message: "Your registered email is outside the configured college domains." });
        }
      }

      const now = new Date();
      const existing = await otpCollection().findOne({ studentId: req.userId, purpose: "emailVerification" });
      if (existing?.requestedAt && now.getTime() - new Date(existing.requestedAt).getTime() < 60 * 1000) {
        return res.status(429).json({ message: "Please wait before requesting another verification code." });
      }

      const otp = generateSecureOtp();
      const expiresMinutes = Math.max(1, Number(process.env.EMAIL_OTP_EXPIRY_MINUTES || 10));
      await otpCollection().deleteMany?.({ studentId: req.userId, purpose: "emailVerification" });
      await otpCollection().insertOne({
        studentId: req.userId,
        email: user.email,
        purpose: "emailVerification",
        codeHash: sha256(otp),
        requestedAt: now,
        expiresAt: new Date(now.getTime() + expiresMinutes * 60 * 1000),
        attempts: 0,
        createdAt: now
      });

      await sendVerificationOtp({
        recipientEmail: user.email,
        studentName: user.name,
        otp,
        expiresMinutes
      });

      await recordAudit({
        adminId: "system",
        adminName: "System",
        action: "EMAIL_VERIFICATION_REQUESTED",
        targetUserId: req.userId,
        newStatus: "verification_pending",
        details: "College email verification OTP requested.",
        req
      });

      res.json({ message: "A verification code was sent to your registered college email." });
    } catch (error) {
      res.status(500).json({ message: "Could not start email verification." });
    }
  });

  app.post("/api/auth/email-verification/verify", requireStudent(usersCollection), authLimiter, async (req, res) => {
    try {
      const code = String(req.body?.code || "").trim();
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ message: "A 6-digit verification code is required." });

      const record = await otpCollection().findOne({ studentId: req.userId, purpose: "emailVerification" });
      if (!record) return res.status(400).json({ message: "No active email verification code found." });
      if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
        await otpCollection().deleteMany?.({ studentId: req.userId, purpose: "emailVerification" });
        return res.status(410).json({ message: "The verification code has expired." });
      }
      if ((record.attempts || 0) >= 5) {
        return res.status(429).json({ message: "Too many incorrect verification attempts." });
      }

      if (!timingSafeTokenEqual(record.codeHash, sha256(code))) {
        await otpCollection().updateOne?.(
          { _id: record._id },
          { $inc: { attempts: 1 } }
        );
        return res.status(400).json({ message: "Invalid verification code." });
      }

      await usersCollection().updateOne(
        { _id: req.currentUser._id },
        { $set: { emailVerified: true, emailVerifiedAt: new Date(), updatedAt: new Date() } }
      );
      await otpCollection().deleteMany?.({ studentId: req.userId, purpose: "emailVerification" });

      await recordAudit({
        adminId: "system",
        adminName: "System",
        action: "EMAIL_VERIFIED",
        targetUserId: req.userId,
        newStatus: "verified",
        details: "Registered college email verified with OTP.",
        req
      });

      res.json({ message: "College email verified successfully.", emailVerified: true });
    } catch (error) {
      res.status(500).json({ message: "Could not verify the email code." });
    }
  });

  app.get("/api/auth/sso", authLimiter, async (req, res) => {
    try {
      if (AUTH_MODE !== "oidc") {
        return res.status(404).json({ message: "Campus SSO is not enabled." });
      }

      const config = await getOIDCConfiguration();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const pendingToken = jwt.sign(
        { state, nonce, codeVerifier },
        JWT_SECRET,
        {
          expiresIn: "5m",
          issuer: "campusfind-oidc",
          audience: "campusfind-oidc-callback"
        }
      );
      const authorizationUrl = oidc.buildAuthorizationUrl(
        config,
        new URLSearchParams({
          redirect_uri: OIDC_REDIRECT_URI,
          scope: "openid email profile",
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: "S256"
        })
      );

      res.cookie(OIDC_PENDING_COOKIE, pendingToken, getAuthCookieOptions(5 * 60 * 1000));
      res.redirect(authorizationUrl.href);
    } catch (error) {
      console.error("Campus SSO start error:", error);
      res.status(503).send("Campus single sign-on is not available. Check the server configuration.");
    }
  });

  app.get("/api/auth/callback", async (req, res) => {
    try {
      if (AUTH_MODE !== "oidc") {
        return res.status(404).send("Campus SSO is not enabled.");
      }

      const pendingToken = req.cookies?.[OIDC_PENDING_COOKIE];
      if (!pendingToken) {
        return res.status(400).send("The sign-in request expired. Return to CampusFind and try again.");
      }

      const pending = jwt.verify(pendingToken, JWT_SECRET, {
        issuer: "campusfind-oidc",
        audience: "campusfind-oidc-callback"
      });
      res.clearCookie(OIDC_PENDING_COOKIE, getAuthCookieOptions(0));

      const config = await getOIDCConfiguration();
      const callbackUrl = new URL(OIDC_REDIRECT_URI);
      callbackUrl.search = new URL(req.originalUrl, OIDC_REDIRECT_URI).search;
      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        pkceCodeVerifier: pending.codeVerifier
      });

      const idTokenClaims = tokens.claims();
      if (!idTokenClaims?.sub) {
        return res.status(401).send("Campus SSO did not provide a valid identity.");
      }

      let claims = idTokenClaims;
      if (!claims.email || claims[OIDC_STUDENT_ID_CLAIM] === undefined) {
        const userInfo = await oidc.fetchUserInfo(
          config,
          tokens.access_token,
          idTokenClaims.sub
        );
        claims = { ...userInfo, ...idTokenClaims };
      }

      const studentId = parseStudentId(claims[OIDC_STUDENT_ID_CLAIM]);
      const email = sanitizeString(claims.email).toLowerCase();
      if (studentId === null || claims.email_verified !== true || !email) {
        return res.status(403).send("Your verified campus account is missing a valid student ID or email.");
      }

      let user = await usersCollection().findOne({ studentId });
      if (user) {
        if (user.oidcIssuer !== claims.iss || user.oidcSubject !== claims.sub) {
          return res.status(403).send("This student account requires administrator verification.");
        }
        await usersCollection().updateOne(
          { _id: user._id },
          { $set: { emailVerified: true, emailVerifiedAt: user.emailVerifiedAt || new Date() } }
        );
      } else {
        const conflictingEmail = await usersCollection().findOne({ email });
        if (conflictingEmail) {
          return res.status(409).send("This campus email is already linked to another account.");
        }

        const newUser = {
          studentId,
          name: sanitizeString(claims.name) || email,
          email,
          role: "student",
          oidcIssuer: claims.iss,
          oidcSubject: claims.sub,
          emailVerified: true,
          emailVerifiedAt: new Date(),
          sessionVersion: 0,
          createdAt: new Date()
        };
        const result = await usersCollection().insertOne(newUser);
        user = { ...newUser, _id: result.insertedId };
      }

      res.cookie(AUTH_COOKIE_NAME, createSessionToken(user), getAuthCookieOptions());
      res.redirect(FRONTEND_URL);
    } catch (error) {
      console.error("Campus SSO callback error:", error);
      res.status(401).send("Campus sign-in failed. Return to CampusFind and try again.");
    }
  });

  app.post("/api/auth/register", authLimiter, async (req, res) => {
    try {
      if (AUTH_MODE !== "local") {
        return res.status(403).json({
          message: "Create your account through campus single sign-on."
        });
      }

      const { studentId, name, email, password, role } = req.body;
      const parsedStudentId = parseStudentId(studentId);

      if (
        parsedStudentId === null
        || typeof name !== "string"
        || typeof email !== "string"
        || typeof password !== "string"
      ) {
        return res.status(400).json({
          message: "Student ID, name, email, and password are required."
        });
      }

      const emailAddress = sanitizeString(email).toLowerCase();
      const cleanedName = sanitizeString(name);
      const normalizedPassword = password;

      if (cleanedName.length > 100) {
        return res.status(400).json({ message: "Name must be at most 100 characters." });
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress) || emailAddress.length > 254) {
        return res.status(400).json({ message: "A valid email address is required." });
      }

      if (normalizedPassword.length < 8 || Buffer.byteLength(normalizedPassword, "utf8") > 72) {
        return res.status(400).json({
          message: "Password must be at least 8 characters long."
        });
      }

      if (!/[a-zA-Z]/.test(normalizedPassword) || !/\d/.test(normalizedPassword)) {
        return res.status(400).json({
          message: "Password must contain both letters and numbers."
        });
      }

      // Check optional domain restriction if configured
      if (process.env.ALLOWED_EMAIL_DOMAINS) {
        const allowedDomains = process.env.ALLOWED_EMAIL_DOMAINS.split(",").map(d => d.trim().toLowerCase()).filter(Boolean);
        const emailDomain = emailAddress.split("@")[1];
        if (allowedDomains.length > 0 && !allowedDomains.includes(emailDomain)) {
          return res.status(400).json({
            message: `Registration requires a valid campus email domain (${allowedDomains.join(", ")}).`
          });
        }
      }

      const existingUser = await usersCollection().findOne({
        $or: [
          { studentId: parsedStudentId },
          { email: emailAddress }
        ]
      });

      if (existingUser) {
        return res.status(409).json({
          message: "A user with that student ID or email already exists."
        });
      }

      // Public registration strictly assigns role: "student" without exceptions
      const assignedRole = "student";
      const initialStatus = process.env.REQUIRE_ACCOUNT_APPROVAL === "true" ? "pending" : "active";
      const hashedPassword = await bcrypt.hash(normalizedPassword, 10);
      const newUser = {
        studentId: parsedStudentId,
        name: cleanedName,
        email: emailAddress,
        passwordHash: hashedPassword,
        role: assignedRole,
        accountStatus: initialStatus,
        statusReason: "",
        emailVerified: false,
        sessionVersion: 0,
        createdAt: new Date()
      };

      const createdUser = await usersCollection().insertOne(newUser);

      if (initialStatus === "pending") {
        return res.status(201).json({
          message: "Account created successfully. Your account is pending administrator activation.",
          user: {
            id: createdUser.insertedId,
            studentId: parsedStudentId,
            name: cleanedName,
            email: emailAddress,
            role: assignedRole,
            accountStatus: initialStatus
          }
        });
      }

      const token = createSessionToken({
        _id: createdUser.insertedId,
        studentId: parsedStudentId,
        role: assignedRole,
        accountStatus: initialStatus,
        sessionVersion: 0
      });

      res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());
      res.status(201).json({
        message: "User registered successfully.",
        user: {
          id: createdUser.insertedId,
          studentId: parsedStudentId,
          name: cleanedName,
          email: emailAddress,
          role: assignedRole,
          accountStatus: initialStatus
        }
      });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/auth/login", authLimiter, async (req, res) => {
    try {
      if (AUTH_MODE !== "local") {
        return res.status(403).json({
          message: "Sign in through campus single sign-on."
        });
      }

      const { studentId, password } = req.body;
      const parsedStudentId = parseStudentId(studentId);

      if (parsedStudentId === null || typeof password !== "string") {
        return res.status(400).json({
          message: "Student ID and password are required."
        });
      }

      const existingUser = await usersCollection().findOne({ studentId: parsedStudentId });

      if (!existingUser) {
        return res.status(401).json({
          message: "Invalid student ID or password."
        });
      }

      const passwordMatches = await bcrypt.compare(password, existingUser.passwordHash || "");

      if (!passwordMatches) {
        return res.status(401).json({
          message: "Invalid student ID or password."
        });
      }

      const userStatus = existingUser.accountStatus || "active";
      if (userStatus === "suspended") {
        return res.status(403).json({
          message: `Your account has been suspended due to suspicious activity.${existingUser.statusReason ? " Reason: " + existingUser.statusReason : ""}`
        });
      }
      if (userStatus === "deactivated") {
        return res.status(403).json({
          message: `Your account has been deactivated.${existingUser.statusReason ? " Reason: " + existingUser.statusReason : ""}`
        });
      }
      if (userStatus === "pending") {
        return res.status(403).json({
          message: "Your account is pending administrator activation."
        });
      }

      const token = createSessionToken(existingUser);
      res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());
      res.json({
        message: "Login successful.",
        user: {
          id: existingUser._id,
          studentId: existingUser.studentId,
          name: existingUser.name,
          email: existingUser.email,
          role: existingUser.role || "student",
          accountStatus: userStatus
        }
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/auth/logout", requireStudent(usersCollection), async (req, res) => {
    try {
      await usersCollection().updateOne(
        { _id: req.currentUser._id },
        { $inc: { sessionVersion: 1 } }
      );
      res.clearCookie(AUTH_COOKIE_NAME, getAuthCookieOptions(0));
      res.json({ message: "Logged out successfully." });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/auth/current-user", requireStudent(usersCollection), (req, res) => {
    const { _id, studentId, name, email, role, accountStatus } = req.currentUser;
    res.json({
      user: {
        id: _id,
        studentId,
        name,
        email,
        role: role || "student",
        accountStatus: accountStatus || "active"
      }
    });
  });

  app.get("/api/profile", requireStudent(usersCollection), async (req, res) => {
    try {
      const reports = await itemsCollection()
        .find({ reportedBy: req.userId })
        .sort({ dateReported: -1 })
        .toArray();

      const userClaims = await claimsCollection()
        .find({ claimantId: req.userId })
        .sort({ createdAt: -1 })
        .toArray();

      const itemIds = userClaims.map((c) => c.itemId);
      const claimedItems = await itemsCollection().find({ _id: { $in: itemIds } }).toArray();
      const itemMap = new Map(claimedItems.map((i) => [String(i._id), sanitizePublicItem(i)]));
      const populatedClaims = userClaims.map((c) => ({
        ...sanitizeStudentClaim(c),
        item: itemMap.get(String(c.itemId)) || null
      }));

      const { _id, studentId, name, email, role, accountStatus, createdAt } = req.currentUser;

      res.json({
        user: {
          id: _id,
          studentId,
          name,
          email,
          role: role || "student",
          accountStatus: accountStatus || "active",
          createdAt
        },
        reports,
        claims: populatedClaims
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch("/api/profile", requireStudent(usersCollection), async (req, res) => {
    try {
      const name = sanitizeString(req.body.name);
      const email = sanitizeString(req.body.email).toLowerCase();

      if (!name || name.length > 100) {
        return res.status(400).json({ message: "Name is required and must be at most 100 characters." });
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        return res.status(400).json({ message: "A valid email address is required." });
      }

      const existingUser = await usersCollection().findOne({ email });
      if (existingUser && String(existingUser._id) !== String(req.currentUser._id)) {
        return res.status(409).json({ message: "That email address is already in use." });
      }

      await usersCollection().updateOne(
        { _id: req.currentUser._id },
        { $set: { name, email } }
      );

      res.json({
        message: "Profile updated successfully.",
        user: {
          id: req.currentUser._id,
          studentId: req.currentUser.studentId,
          name,
          email,
          role: req.currentUser.role || "student"
        }
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ message: "That email address is already in use." });
      }
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/items", listPublicItems);
  app.get("/api/items/search", listPublicItems);

  app.post("/api/items", requireStudent(usersCollection), async (req, res) => {
    try {
      const {
        itemName,
        category,
        color,
        reportType,
        location,
        reportedBy,
        identifyingMarks,
        serialNumber,
        verificationQuestion,
        verificationQuestions,
        brand,
        model,
        accessories,
        physicalDamage,
        publicImages,
        privateImages,
        description
      } = req.body;

      const authStudentId = req.userId;
      const submittedStudentId = parseStudentId(reportedBy ?? authStudentId);

      if (
        typeof itemName !== "string" ||
        typeof category !== "string" ||
        typeof color !== "string" ||
        typeof reportType !== "string" ||
        typeof location !== "string" ||
        submittedStudentId === null
      ) {
        return res.status(400).json({
          message: "Please provide all item details."
        });
      }

      if (submittedStudentId !== authStudentId) {
        return res.status(403).json({
          message: "You can only report items for your own student ID."
        });
      }

      if (!["lost", "found"].includes(normalize(reportType))) {
        return res.status(400).json({
          message: "reportType must be lost or found."
        });
      }

      const normalizedName = sanitizeString(itemName);
      const normalizedCategory = sanitizeString(category);
      const normalizedColor = sanitizeString(color);
      const normalizedLocation = sanitizeString(location);

      if (
        !normalizedName ||
        !normalizedCategory ||
        !normalizedColor ||
        !normalizedLocation
      ) {
        return res.status(400).json({
          message: "Item details cannot be empty."
        });
      }
      if (
        normalizedName.length > 100
        || normalizedCategory.length > 100
        || normalizedColor.length > 50
        || normalizedLocation.length > 150
      ) {
        return res.status(400).json({
          message: "Item details exceed the allowed length."
        });
      }

      const privateImageNames = Array.isArray(privateImages) ? [...new Set(privateImages)] : [];
      if (privateImages !== undefined && !Array.isArray(privateImages)) {
        return res.status(400).json({ message: "Private verification photos must be a list of uploaded file identifiers." });
      }
      if (
        privateImageNames.length > 10 ||
        privateImageNames.some((filename) => !isSafePrivateFilename(filename))
      ) {
        return res.status(400).json({ message: "One or more private verification photo identifiers are invalid." });
      }
      for (const filename of privateImageNames) {
        const fileRecord = await privateFilesCollection().findOne({
          filename,
          uploaderStudentId: authStudentId,
          purpose: "itemVerification"
        });
        if (!fileRecord) {
          return res.status(403).json({
            message: "You can only attach private verification photos that you uploaded."
          });
        }
      }

      const newItem = {
        itemName: normalizedName,
        category: normalizedCategory,
        color: normalizedColor,
        reportType: normalize(reportType),
        location: normalizedLocation,
        reportedBy: submittedStudentId,
        status: normalize(reportType) === "lost" ? "searching" : "unclaimed",
        dateReported: new Date(),
        publicImages: Array.isArray(publicImages) ? publicImages.filter((img) => typeof img === "string") : [],
        description: sanitizeString(description),
        // Private ownership verification details
        identifyingMarks: sanitizeString(identifyingMarks),
        serialNumber: sanitizeString(serialNumber),
        verificationQuestion: sanitizeString(verificationQuestion),
        verificationQuestions: Array.isArray(verificationQuestions)
          ? verificationQuestions.slice(0, 10).map(sanitizeString).filter(Boolean)
          : [],
        brand: sanitizeString(brand),
        model: sanitizeString(model),
        accessories: sanitizeString(accessories),
        physicalDamage: sanitizeString(physicalDamage),
        privateImages: privateImageNames,
        moderationStatus: "active"
      };

      const result = await itemsCollection().insertOne(newItem);
      const matchesCreated = await createMatchesForItem(
        newItem,
        result.insertedId,
        { itemsCollection, matchesCollection, usersCollection }
      );

      res.status(201).json({
        message: "Item reported successfully!",
        itemId: result.insertedId,
        matchesCreated,
        matchMessage: matchesCreated > 0
          ? "Potential match found! Check your notifications."
          : "No matching report found yet."
      });
    } catch (error) {
      console.error("Report error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  app.delete("/api/items/:id/withdraw", requireStudent(usersCollection), async (req, res) => {
    try {
      const itemSelector = createIdSelector(req.params.id);
      if (!itemSelector) return res.status(400).json({ message: "Invalid item ID." });

      const item = await itemsCollection().findOne({ _id: itemSelector });
      if (!item) return res.status(404).json({ message: "Item report not found." });
      if (item.reportedBy !== req.userId) {
        return res.status(403).json({ message: "You can only withdraw your own item reports." });
      }
      if (item.status === "returned" || item.status === "closed") {
        return res.status(409).json({ message: "Resolved item reports cannot be withdrawn." });
      }

      await itemsCollection().updateOne(
        { _id: itemSelector, status: { $nin: ["returned", "closed"] } },
        { $set: { moderationStatus: "removed", moderationReason: "Withdrawn by reporter.", updatedAt: new Date() } }
      );
      const cleanup = await cleanupPrivateEvidenceFiles(item.privateImages, privateFilesCollection, "itemVerification");
      if (cleanup.failed.length > 0) {
        return res.status(202).json({
          message: "Item report withdrawn, but private evidence cleanup requires retry.",
          cleanupPending: true
        });
      }

      res.json({ message: "Item report withdrawn successfully." });
    } catch (error) {
      console.error("[ReportWithdrawal] Failed:", error);
      res.status(500).json({ message: "Could not withdraw the item report." });
    }
  });

  app.delete("/api/items/:id", requireStudent(usersCollection), async (req, res) => {
    try {
      const itemSelector = createIdSelector(req.params.id);
      if (!itemSelector) return res.status(400).json({ message: "Invalid item ID." });

      const item = await itemsCollection().findOne({ _id: itemSelector });
      if (!item) return res.status(404).json({ message: "Item report not found." });
      if (item.reportedBy !== req.userId) {
        return res.status(403).json({ message: "You can only delete your own item reports." });
      }

      const cleanup = await cleanupPrivateEvidenceFiles(item.privateImages, privateFilesCollection, "itemVerification");
      if (cleanup.failed.length > 0) {
        return res.status(503).json({
          message: "Private evidence cleanup failed; the item report was not deleted. Retry the deletion.",
          cleanupPending: true
        });
      }
      if (typeof itemsCollection().deleteOne === "function") {
        const deletion = await itemsCollection().deleteOne({ _id: itemSelector, reportedBy: req.userId });
        if (deletion.deletedCount !== 1) {
          return res.status(409).json({ message: "The item report changed while it was being deleted." });
        }
      }

      res.json({ message: "Item report permanently deleted." });
    } catch (error) {
      console.error("[ReportDeletion] Failed:", error);
      res.status(500).json({ message: "Could not delete the item report." });
    }
  });

  app.get("/api/items/matches", requireStudent(usersCollection), async (req, res) => {
    try {
      const filter = {};
      const requestedStudentId = parseStudentId(req.query.reportedBy ?? req.userId);

      if (requestedStudentId === null) {
        return res.status(400).json({
          message: "A valid student ID is required."
        });
      }

      if (requestedStudentId !== req.userId) {
        return res.status(403).json({
          message: "You can only view your own matches."
        });
      }

      filter.$or = [
        { lostReportedBy: requestedStudentId },
        { foundReportedBy: requestedStudentId }
      ];

      const matches = await matchesCollection()
        .aggregate([
          {
            $match: {
              $and: [
                filter,
                { status: { $nin: ["duplicate", "confirmed"] } }
              ]
            }
          },
          {
            $lookup: {
              from: "items",
              localField: "lostItemId",
              foreignField: "_id",
              as: "lostItem"
            }
          },
          {
            $lookup: {
              from: "items",
              localField: "foundItemId",
              foreignField: "_id",
              as: "foundItem"
            }
          },
          {
            $unwind: {
              path: "$lostItem",
              preserveNullAndEmptyArrays: true
            }
          },
          {
            $unwind: {
              path: "$foundItem",
              preserveNullAndEmptyArrays: true
            }
          },
          {
            $match: {
              $or: [
                { "lostItem.status": { $ne: "returned" } },
                { "foundItem.status": { $ne: "returned" } }
              ]
            }
          },
          { $sort: { createdAt: -1 } }
        ])
        .toArray();

      const visibleMatches = matches
        .filter((match) =>
          isPubliclyVisibleItem(match.lostItem)
          && isPubliclyVisibleItem(match.foundItem)
          && !(match.lostItem.status === "returned" && match.foundItem.status === "returned")
        )
        .map((match) => ({
          _id: match._id,
          lostItemId: match.lostItemId,
          foundItemId: match.foundItemId,
          isLostReporter: match.lostReportedBy === req.userId,
          matchScore: match.matchScore,
          status: match.status,
          createdAt: match.createdAt,
          claimHistory: Array.isArray(match.claimHistory)
            ? match.claimHistory.map((entry) => ({
                action: entry.action,
                timestamp: entry.timestamp
              }))
            : [],
          lostItem: sanitizePublicItem(match.lostItem),
          foundItem: sanitizePublicItem(match.foundItem)
        }));

      res.json({
        totalMatches: visibleMatches.length,
        matches: visibleMatches
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Verification proof submission
  app.post("/api/items/matches/:id/verify", requireStudent(usersCollection), async (req, res) => {
    try {
      const { id } = req.params;
      const matchIdSelector = createIdSelector(id);
      const proofDetails = sanitizeString(req.body.proofDetails);

      if (!matchIdSelector) {
        return res.status(400).json({ message: "Invalid match ID." });
      }

      const match = await matchesCollection().findOne({ _id: matchIdSelector });
      if (!match) {
        return res.status(404).json({ message: "Match not found." });
      }

      if (req.userId !== match.lostReportedBy && req.userId !== match.foundReportedBy) {
        return res.status(403).json({ message: "You are not authorized for this match." });
      }

      const auditEvent = {
        action: "proof_submitted",
        performedBy: req.userId,
        role: req.currentUser.role || "student",
        details: proofDetails || "Verification proof details submitted.",
        timestamp: new Date()
      };

      await matchesCollection().updateOne(
        { _id: matchIdSelector },
        {
          $set: {
            status: "confirming",
            confirmedBy: req.userId,
            confirmationStartedAt: new Date()
          },
          $push: { claimHistory: auditEvent }
        }
      );

      // Notify the other party via email
      const otherStudentId = req.userId === match.lostReportedBy ? match.foundReportedBy : match.lostReportedBy;
      usersCollection().findOne({ studentId: otherStudentId }).then((otherUser) => {
        if (otherUser?.email) {
          notifyClaimUpdate({
            recipientEmail: otherUser.email,
            studentName: otherUser.name || "Student",
            itemName: "Matched Item",
            updateType: "proof_submitted",
            details: `Student #${req.userId} has submitted ownership verification details for your review.`
          }).catch(() => {});
        }
      }).catch(() => {});

      res.json({
        message: "Verification details submitted successfully.",
        claimStatus: "confirming"
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Flag or dispute a match
  app.post("/api/items/matches/:id/dispute", requireStudent(usersCollection), async (req, res) => {
    try {
      const { id } = req.params;
      const matchIdSelector = createIdSelector(id);
      const reason = sanitizeString(req.body.reason);

      if (!matchIdSelector) {
        return res.status(400).json({ message: "Invalid match ID." });
      }

      if (!reason) {
        return res.status(400).json({ message: "A reason is required to dispute a claim." });
      }

      const match = await matchesCollection().findOne({ _id: matchIdSelector });
      if (!match) {
        return res.status(404).json({ message: "Match not found." });
      }

      if (req.userId !== match.lostReportedBy && req.userId !== match.foundReportedBy) {
        return res.status(403).json({ message: "You are not authorized to dispute this match." });
      }

      const auditEvent = {
        action: "disputed",
        performedBy: req.userId,
        role: req.currentUser.role || "student",
        details: reason,
        timestamp: new Date()
      };

      await matchesCollection().updateOne(
        { _id: matchIdSelector },
        {
          $set: {
            status: "disputed",
            disputeReason: reason,
            disputedBy: req.userId,
            disputedAt: new Date()
          },
          $push: { claimHistory: auditEvent }
        }
      );

      // Notify counterpart via email
      const otherStudentId = req.userId === match.lostReportedBy ? match.foundReportedBy : match.lostReportedBy;
      usersCollection().findOne({ studentId: otherStudentId }).then((otherUser) => {
        if (otherUser?.email) {
          notifyClaimUpdate({
            recipientEmail: otherUser.email,
            studentName: otherUser.name || "Student",
            itemName: "Matched Item",
            updateType: "disputed",
            details: `A dispute was filed: "${reason}". An administrator will arbitrate this claim.`
          }).catch(() => {});
        }
      }).catch(() => {});

      res.json({
        message: "Dispute submitted. An administrator will review the claim.",
        status: "disputed"
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Confirm match and item return
  app.patch("/api/items/matches/:id/confirm", requireStudent(usersCollection), async (req, res) => {
    try {
      const { id } = req.params;
      const matchIdSelector = createIdSelector(id);

      if (!matchIdSelector) {
        return res.status(400).json({
          message: "Invalid match ID."
        });
      }

      const authStudentId = req.userId;
      const submittedUserId = req.body?.userId !== undefined
        ? parseStudentId(req.body.userId)
        : authStudentId;

      if (submittedUserId === null || submittedUserId !== authStudentId) {
        return res.status(403).json({
          message: "You can only confirm your own match."
        });
      }

      const match = await matchesCollection().findOne({
        _id: matchIdSelector
      });

      if (!match) {
        return res.status(404).json({
          message: "Match not found."
        });
      }

      if (parseStudentId(match.lostReportedBy) !== authStudentId) {
        return res.status(403).json({
          message: "Only the owner can verify this item."
        });
      }

      if (match.status === "confirmed") {
        return res.status(409).json({
          message: "This match has already been resolved."
        });
      }

      if (!["pending", "confirming"].includes(match.status)) {
        return res.status(409).json({ message: "This match cannot be confirmed in its current state." });
      }

      if (match.status === "confirming" && match.confirmedBy != null && parseStudentId(match.confirmedBy) !== authStudentId) {
        return res.status(403).json({ message: "Only the owner can resume this confirmation." });
      }

      if (match.status === "pending") {
        const auditEvent = {
          action: "claim_initiated",
          performedBy: authStudentId,
          role: "student",
          details: "Owner initiated item verification confirmation.",
          timestamp: new Date()
        };

        const claimed = await matchesCollection().updateOne(
          { _id: matchIdSelector, status: "pending" },
          {
            $set: {
              status: "confirming",
              confirmedBy: authStudentId,
              confirmationStartedAt: new Date()
            },
            $push: { claimHistory: auditEvent }
          }
        );
        if (claimed.modifiedCount !== 1) {
          const currentMatch = await matchesCollection().findOne({ _id: matchIdSelector });
          if (currentMatch?.status === "confirmed") {
            return res.status(409).json({ message: "This match has already been resolved." });
          }
          if (
            currentMatch?.status !== "confirming"
            || parseStudentId(currentMatch.confirmedBy) !== authStudentId
          ) {
            return res.status(409).json({ message: "This match is being updated. Please retry." });
          }
        }
      }

      if (match.status === "confirming" && match.confirmedBy == null) {
        const assigned = await matchesCollection().updateOne(
          { _id: matchIdSelector, status: "confirming", confirmedBy: { $in: [null] } },
          { $set: { confirmedBy: authStudentId, confirmationStartedAt: match.confirmationStartedAt || new Date() } }
        );
        if (assigned.matchedCount !== 1) {
          return res.status(409).json({ message: "This confirmation is being recovered by another request. Retry shortly." });
        }
      }

      const currentMatch = await matchesCollection().findOne({ _id: matchIdSelector });
      const completion = currentMatch
        ? await completeMatchConfirmation(
            currentMatch,
            itemsCollection,
            matchesCollection,
            claimsCollection,
            authStudentId
          )
        : { ok: false, reason: "match disappeared" };
      if (!completion.ok) {
        if (completion.reason !== "busy") {
          console.error("[MatchConfirmation] Confirmation remains recoverable.", JSON.stringify({
            matchId: String(match._id),
            lostReportId: String(match.lostItemId),
            foundReportId: String(match.foundItemId),
            failure: completion.reason,
            currentConfirmationState: "confirming"
          }));
        }
        return res.status(409).json({
          message: completion.reason === "busy"
            ? "This confirmation is already being processed. Retry shortly."
            : "The confirmation is incomplete and remains recoverable. Retry or contact campus administration."
        });
      }

      // Email finder about successful return
      usersCollection().findOne({ studentId: match.foundReportedBy }).then((finderUser) => {
        if (finderUser?.email) {
          notifyClaimUpdate({
            recipientEmail: finderUser.email,
            studentName: finderUser.name || "Student",
            itemName: "Found Item",
            updateType: "confirmed",
            details: "The owner has confirmed receipt of the item. Thank you for helping your campus community!"
          }).catch(() => {});
        }
      }).catch(() => {});

      res.json({
        message: "Success! Item has been verified and marked as RETURNED."
      });
    } catch (error) {
      console.error("Confirmation error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  // ==========================================
  // CLAIM VERIFICATION SYSTEM APIS (STUDENT)
  // ==========================================

  // Submit ownership claim for a found item or match
  app.post("/api/claims", requireStudent(usersCollection), async (req, res) => {
    try {
      const { itemId, matchId, additionalDetails, verificationAnswers, proofFiles } = req.body;
      const itemSelector = createIdSelector(itemId);

      if (!itemSelector) {
        return res.status(400).json({ message: "A valid item ID is required to claim an item." });
      }

      // Rate limiting: maximum 5 claims per hour per student
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recentClaims = await claimsCollection().countDocuments({
        claimantId: req.userId,
        createdAt: { $gte: oneHourAgo }
      });
      if (recentClaims >= 5) {
        return res.status(429).json({
          message: "You have submitted too many claims recently. Please wait before submitting another claim."
        });
      }

      if (
        process.env.REQUIRE_COLLEGE_EMAIL_VERIFICATION === "true"
        && !req.currentUser.emailVerified
      ) {
        return res.status(403).json({
          message: "You must verify your registered college email before submitting an ownership claim."
        });
      }

      const targetItem = await itemsCollection().findOne({ _id: itemSelector });
      if (!targetItem) {
        return res.status(404).json({ message: "The item you are claiming does not exist." });
      }

      if (!isPubliclyVisibleItem(targetItem)) {
        return res.status(404).json({ message: "The item you are claiming is not available." });
      }

      if (["returned", "closed"].includes(targetItem.status)) {
        return res.status(400).json({ message: "This item has already been marked as returned to its owner." });
      }

      if (targetItem.reportType !== "found") {
        return res.status(400).json({ message: "Ownership claims can only be submitted for found items." });
      }

      const reporterIsCurrentUser = compareItemReporterToUser(targetItem.reportedBy, req.currentUser);
      if (reporterIsCurrentUser === null) {
        console.warn(`[Claims] Reporter verification failed: missing or invalid reporter identity for item ${targetItem._id}.`);
        return res.status(409).json({
          message: "The item's reporter identity cannot be verified. Please contact campus administration."
        });
      }

      if (reporterIsCurrentUser) {
        return res.status(400).json({ message: "You cannot submit an ownership claim for an item you reported yourself." });
      }

      // Prevent duplicate active claims by the same student for this item
      const duplicateClaim = await claimsCollection().findOne({
        itemId: targetItem._id,
        claimantId: req.userId,
        status: { $in: ["pending", "under_review", "additional_evidence_required", "flagged"] }
      });
      if (duplicateClaim) {
        return res.status(409).json({
          message: "You already have an active claim pending for this item. Please wait for administrator review."
        });
      }

      const sanitizedAnswers = Array.isArray(verificationAnswers)
        ? verificationAnswers.map((a) =>
            typeof a === "object" && a !== null
              ? { question: sanitizeString(a.question || "Verification Question"), answer: sanitizeString(a.answer || "") }
              : { question: "Verification Question", answer: sanitizeString(a) }
          )
        : typeof verificationAnswers === "string" && verificationAnswers.trim()
          ? [{ question: "Verification Details", answer: sanitizeString(verificationAnswers) }]
          : [];

      if (proofFiles !== undefined && !Array.isArray(proofFiles)) {
        return res.status(400).json({ message: "Proof files must be uploaded private evidence identifiers." });
      }

      const proofs = [];
      for (const reference of proofFiles || []) {
        const filename = normalizeClaimProofFilename(reference);
        if (!filename) {
          return res.status(400).json({ message: "One or more proof file identifiers are invalid." });
        }

        const fileRecord = await privateFilesCollection().findOne({
          filename,
          uploaderStudentId: req.userId,
          $or: [
            { purpose: "claimProof" },
            { purpose: { $exists: false } }
          ]
        });
        if (!fileRecord) {
          return res.status(403).json({ message: "You can only attach proof files that you uploaded." });
        }
        if (!proofs.includes(filename)) proofs.push(filename);
      }

      const rejectedClaims = await claimsCollection().countDocuments({
        claimantId: req.userId,
        status: "rejected"
      });
      const risk = assessClaimVerification(
        targetItem,
        sanitizedAnswers,
        req.currentUser,
        recentClaims + 1,
        rejectedClaims
      );
      const initialStatus = risk.category === "additional_review" || risk.category === "investigation"
        ? (risk.category === "investigation" ? "additional_evidence_required" : "pending")
        : "pending";

      const newClaim = {
        itemId: targetItem._id,
        matchId: matchId ? createIdSelector(matchId) : null,
        claimantId: req.userId,
        claimantName: req.currentUser.name || "Student",
        claimantEmail: req.currentUser.email,
        additionalDetails: sanitizeString(additionalDetails || ""),
        verificationAnswers: sanitizedAnswers,
        proofFiles: proofs,
        evidenceFiles: [...proofs],
        status: initialStatus,
        reviewedBy: null,
        adminReviewedBy: null,
        adminRemarks: "",
        reviewedAt: null,
        reviewDate: null,
        reviewNotes: "",
        rejectionReason: "",
        handoverLocation: "",
        riskScore: risk.score,
        riskCategory: risk.category,
        riskFactors: risk.factors,
        riskHistory: [{
          score: risk.score,
          category: risk.category,
          factors: risk.factors,
          calculatedAt: new Date(),
          actor: "system"
        }],
        verificationAttemptCount: 1,
        verificationMatchScore: risk.matchScore,
        claimHistory: [
          {
            action: "claim_submitted",
            performedBy: req.userId,
            role: "student",
            details: `Claim submitted for ${targetItem.itemName}. Supporting evidence and answers provided.`,
            timestamp: new Date()
          }
        ],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const insertResult = await claimsCollection().insertOne(newClaim);
      newClaim._id = insertResult.insertedId;

      // Asynchronously send notification email to claimant
      notifyClaimStatusChange({
        recipientEmail: req.currentUser.email,
        claimantName: req.currentUser.name || "Student",
        itemName: targetItem.itemName,
        status: "pending",
        notes: "Your ownership claim has been submitted to campus administration for verification."
      }).catch(() => {});

      res.status(201).json({
        message: "Ownership claim submitted successfully. Campus administration will review your verification answers and proof.",
        claim: {
          _id: newClaim._id,
          itemId: newClaim.itemId,
          matchId: newClaim.matchId,
          claimantId: newClaim.claimantId,
          status: newClaim.status,
          createdAt: newClaim.createdAt
        }
      });
    } catch (error) {
      console.error("Claim submission error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  // Get current student's claims
  app.get("/api/claims/my", requireStudent(usersCollection), async (req, res) => {
    try {
      const claims = await claimsCollection()
        .find({ claimantId: req.userId })
        .sort({ createdAt: -1 })
        .toArray();

      const itemIds = claims.map((c) => c.itemId);
      const items = await itemsCollection().find({ _id: { $in: itemIds } }).toArray();
      const itemMap = new Map(items.map((i) => [String(i._id), sanitizePublicItem(i)]));

      const populatedClaims = claims.map((claim) => ({
        ...sanitizeStudentClaim(claim),
        item: itemMap.get(String(claim.itemId)) || null
      }));

      res.json({ claims: populatedClaims });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Get item verification details for claiming (Never exposes secret answers or private marks)
  app.get("/api/claims/item/:itemId", async (req, res) => {
    try {
      const itemSelector = createIdSelector(req.params.itemId);
      if (!itemSelector) {
        return res.status(400).json({ message: "Invalid item ID." });
      }

      const item = await itemsCollection().findOne({ _id: itemSelector });
      if (!isPubliclyVisibleItem(item)) {
        return res.status(404).json({ message: "Item not found." });
      }
      if (["returned", "closed"].includes(item.status)) {
        return res.status(404).json({ message: "Item not found." });
      }

      const questions = Array.isArray(item.verificationQuestions) && item.verificationQuestions.length > 0
        ? item.verificationQuestions
        : item.verificationQuestion
          ? [item.verificationQuestion]
          : [];

      res.json({
        item: sanitizePublicItem(item),
        hasVerificationQuestions: questions.length > 0,
        verificationQuestions: questions
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/claims/:id/handover/verify", requireStudent(usersCollection), async (req, res) => {
    try {
      const claimSelector = createIdSelector(req.params.id);
      if (!claimSelector) return res.status(400).json({ message: "Invalid claim ID." });

      const code = String(req.body?.otp || "").trim();
      if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ message: "A 6-digit handover OTP is required." });
      }

      const claim = await claimsCollection().findOne({ _id: claimSelector });
      if (!claim) return res.status(404).json({ message: "Claim not found." });
      if (claim.claimantId !== req.userId) {
        return res.status(403).json({ message: "Only the approved claimant can verify handover." });
      }
      if (claim.status !== "approved") {
        return res.status(409).json({ message: "This claim is not approved for handover." });
      }
      if (!claim.handoverOtpHash || !claim.handoverOtpExpiresAt) {
        return res.status(410).json({ message: "No active handover OTP exists." });
      }
      if (new Date(claim.handoverOtpExpiresAt).getTime() <= Date.now()) {
        await claimsCollection().updateOne(
          { _id: claimSelector },
          { $unset: { handoverOtpHash: "", handoverOtpExpiresAt: "", handoverOtpEncrypted: "" }, $set: { handoverOtpAttempts: 0 } }
        );
        return res.status(410).json({ message: "The handover OTP has expired." });
      }
      if ((claim.handoverOtpAttempts || 0) >= 5) {
        return res.status(429).json({ message: "Too many incorrect handover OTP attempts." });
      }

      if (!timingSafeTokenEqual(claim.handoverOtpHash, sha256(code))) {
        await claimsCollection().updateOne(
          { _id: claimSelector, status: "approved" },
          { $inc: { handoverOtpAttempts: 1 } }
        );
        return res.status(400).json({ message: "Invalid handover OTP." });
      }

      const itemReservation = await itemsCollection().updateOne(
        { _id: claim.itemId, approvedClaimId: claim._id, status: { $nin: ["returned", "closed"] } },
        { $set: { status: "returned", updatedAt: new Date() } }
      );
      if (itemReservation.matchedCount !== 1) {
        return res.status(409).json({ message: "The item cannot be marked returned in its current state." });
      }

      await claimsCollection().updateOne(
        { _id: claimSelector, status: "approved" },
        {
          $set: {
            status: "returned",
            handoverDate: new Date(),
            handoverConfirmedBy: req.userId,
            reviewedAt: new Date(),
            updatedAt: new Date()
          },
          $unset: { handoverOtpHash: "", handoverOtpExpiresAt: "", handoverOtpEncrypted: "" },
          $push: {
            claimHistory: {
              action: "handover_confirmed",
              performedBy: req.userId,
              role: "student",
              details: "Secure handover OTP verified. Item marked returned.",
              timestamp: new Date()
            }
          }
        }
      );

      await recordAudit({
        adminId: "system",
        adminName: "System",
        action: "HANDOVER_CONFIRMED",
        targetClaimId: claim._id,
        targetItemId: claim.itemId,
        targetUserId: req.userId,
        newStatus: "returned",
        details: "Claimant verified the secure handover OTP.",
        req
      });

      res.json({ message: "Handover verified successfully. The item is now marked returned." });
    } catch (error) {
      res.status(500).json({ message: "Could not verify handover OTP." });
    }
  });

  // Withdraw pending claim by claimant
  app.delete("/api/claims/:id/withdraw", requireStudent(usersCollection), async (req, res) => {
    try {
      const claimSelector = createIdSelector(req.params.id);
      if (!claimSelector) {
        return res.status(400).json({ message: "Invalid claim ID." });
      }

      const claim = await claimsCollection().findOne({ _id: claimSelector });
      if (!claim) {
        return res.status(404).json({ message: "Claim not found." });
      }

      if (claim.claimantId !== req.userId) {
        return res.status(403).json({ message: "You can only withdraw your own claims." });
      }

      if (!["pending", "under_review", "additional_evidence_required", "flagged"].includes(claim.status)) {
        return res.status(400).json({ message: `Cannot withdraw claim that is already ${claim.status}.` });
      }

      const auditEvent = {
        action: "withdrawn",
        performedBy: req.userId,
        role: "student",
        details: "Claim withdrawn by the claimant.",
        timestamp: new Date()
      };

      await claimsCollection().updateOne(
        { _id: claimSelector },
        {
          $set: { status: "withdrawn", updatedAt: new Date() },
          $push: { claimHistory: auditEvent }
        }
      );

      if (Array.isArray(claim.proofFiles) && claim.proofFiles.length > 0) {
        await cleanupPrivateEvidenceFiles(claim.proofFiles, privateFilesCollection);
      }

      res.json({ message: "Claim withdrawn successfully." });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // ==========================================
  // COMPLETE ADMIN PORTAL APIS
  // ==========================================

  // Comprehensive Admin Statistics
  app.get("/api/admin/stats", requireAdmin(usersCollection), async (req, res) => {
    try {
      const [
        totalUsers,
        activeUsers,
        pendingUsers,
        suspendedUsers,
        deactivatedUsers,
        totalItems,
        lostItems,
        foundItems,
        returnedItems,
        flaggedItems,
        totalClaims,
        pendingClaimsCount,
        underReviewClaimsCount,
        approvedClaimsCount,
        rejectedClaimsCount,
        totalMatches,
        activeDisputes,
        pendingConfirmations
      ] = await Promise.all([
        usersCollection().countDocuments({}),
        usersCollection().countDocuments({ accountStatus: { $in: ["active", null] } }),
        usersCollection().countDocuments({ accountStatus: "pending" }),
        usersCollection().countDocuments({ accountStatus: "suspended" }),
        usersCollection().countDocuments({ accountStatus: "deactivated" }),
        itemsCollection().countDocuments({}),
        itemsCollection().countDocuments({ reportType: "lost" }),
        itemsCollection().countDocuments({ reportType: "found" }),
        itemsCollection().countDocuments({ status: "returned" }),
        itemsCollection().countDocuments({ moderationStatus: "flagged" }),
        claimsCollection().countDocuments({}),
        claimsCollection().countDocuments({ status: "pending" }),
        claimsCollection().countDocuments({ status: "under_review" }),
        claimsCollection().countDocuments({ status: "approved" }),
        claimsCollection().countDocuments({ status: "rejected" }),
        matchesCollection().countDocuments({ status: { $ne: "duplicate" } }),
        matchesCollection().countDocuments({ status: "disputed" }),
        matchesCollection().countDocuments({ status: "confirming" })
      ]);

      res.json({
        totalItems,
        lostItems,
        foundItems,
        returnedItems,
        totalMatches,
        activeDisputes,
        pendingClaims: pendingClaimsCount || pendingConfirmations,
        users: {
          total: totalUsers,
          active: activeUsers,
          pending: pendingUsers,
          suspended: suspendedUsers,
          deactivated: deactivatedUsers
        },
        items: {
          total: totalItems,
          lost: lostItems,
          found: foundItems,
          returned: returnedItems,
          flagged: flaggedItems
        },
        claims: {
          total: totalClaims,
          pending: pendingClaimsCount,
          underReview: underReviewClaimsCount,
          approved: approvedClaimsCount,
          rejected: rejectedClaimsCount
        }
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Admin User Management - List all registered users
  app.get("/api/admin/users", requireAdmin(usersCollection), async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize || 20)));
      const q = sanitizeString(req.query.q || "");
      const status = sanitizeString(req.query.status || "");

      const conditions = [];
      if (status && ["active", "pending", "suspended", "deactivated"].includes(status)) {
        if (status === "active") {
          conditions.push({ accountStatus: { $in: ["active", null] } });
        } else {
          conditions.push({ accountStatus: status });
        }
      }

      if (q) {
        const regex = new RegExp(escapeRegex(q), "i");
        const parsedId = parseStudentId(q);
        const orConditions = [{ name: regex }, { email: regex }];
        if (parsedId !== null) {
          orConditions.push({ studentId: parsedId });
        }
        conditions.push({ $or: orConditions });
      }

      const query = conditions.length > 0 ? { $and: conditions } : {};

      const [total, userDocs] = await Promise.all([
        usersCollection().countDocuments(query),
        usersCollection()
          .find(query)
          .sort({ createdAt: -1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .toArray()
      ]);

      const studentIds = userDocs.map((u) => u.studentId);
      const [reportsCounts, claimsCounts] = await Promise.all([
        itemsCollection()
          .aggregate([
            { $match: { reportedBy: { $in: studentIds } } },
            { $group: { _id: "$reportedBy", count: { $sum: 1 } } }
          ])
          .toArray(),
        claimsCollection()
          .aggregate([
            { $match: { claimantId: { $in: studentIds } } },
            { $group: { _id: "$claimantId", count: { $sum: 1 } } }
          ])
          .toArray()
      ]);

      const reportMap = new Map(reportsCounts.map((r) => [r._id, r.count]));
      const claimMap = new Map(claimsCounts.map((c) => [c._id, c.count]));

      const safeUsers = userDocs.map((u) => ({
        id: u._id,
        studentId: u.studentId,
        name: u.name,
        email: u.email,
        role: u.role || "student",
        accountStatus: u.accountStatus || "active",
        statusReason: u.statusReason || "",
        emailVerified: Boolean(u.emailVerified),
        createdAt: u.createdAt,
        reportsCount: reportMap.get(u.studentId) || 0,
        claimsCount: claimMap.get(u.studentId) || 0
      }));

      res.json({
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
        users: safeUsers
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Admin User Management - Get user details
  app.get("/api/admin/users/:id", requireAdmin(usersCollection), async (req, res) => {
    try {
      const userSelector = createIdSelector(req.params.id);
      const parsedStudentId = parseStudentId(req.params.id);

      const query = userSelector
        ? { $or: [{ _id: userSelector }, { studentId: parsedStudentId || -1 }] }
        : { studentId: parsedStudentId };

      const user = await usersCollection().findOne(query);
      if (!user) {
        return res.status(404).json({ message: "User not found." });
      }

      const [reports, claims, auditHistory] = await Promise.all([
        itemsCollection().find({ reportedBy: user.studentId }).sort({ dateReported: -1 }).toArray(),
        claimsCollection().find({ claimantId: user.studentId }).sort({ createdAt: -1 }).toArray(),
        auditLogsCollection().find({ targetUserId: String(user.studentId) }).sort({ createdAt: -1 }).toArray()
      ]);

      res.json({
        user: {
          id: user._id,
          studentId: user.studentId,
          name: user.name,
          email: user.email,
          role: user.role || "student",
          accountStatus: user.accountStatus || "active",
          statusReason: user.statusReason || "",
          emailVerified: Boolean(user.emailVerified),
          createdAt: user.createdAt,
          suspendedAt: user.suspendedAt,
          deactivatedAt: user.deactivatedAt
        },
        reports,
        claims,
        auditHistory
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Admin User Management - Update Account Status (Activate, Deactivate, Suspend, Reactivate)
  app.patch("/api/admin/users/:id/status", requireAdmin(usersCollection), async (req, res) => {
    try {
      const userSelector = createIdSelector(req.params.id);
      const parsedStudentId = parseStudentId(req.params.id);
      const { status, reason } = req.body;

      if (!["active", "pending", "suspended", "deactivated"].includes(status)) {
        return res.status(400).json({ message: "Status must be active, pending, suspended, or deactivated." });
      }

      const query = userSelector
        ? { $or: [{ _id: userSelector }, { studentId: parsedStudentId || -1 }] }
        : { studentId: parsedStudentId };

      const targetUser = await usersCollection().findOne(query);
      if (!targetUser) {
        return res.status(404).json({ message: "User not found." });
      }

      // Prevent admin from deactivating or suspending their own account
      if (String(targetUser._id) === String(req.currentUser._id)) {
        return res.status(400).json({ message: "You cannot change your own administrative account status." });
      }

      const prevStatus = targetUser.accountStatus || "active";
      const sanitizedReason = sanitizeString(reason || "");

      const updateFields = {
        accountStatus: status,
        statusReason: sanitizedReason,
        updatedAt: new Date()
      };

      if (status === "suspended") updateFields.suspendedAt = new Date();
      if (status === "deactivated") updateFields.deactivatedAt = new Date();

      // When suspended or deactivated, immediately revoke sessions by bumping sessionVersion
      if (["suspended", "deactivated"].includes(status)) {
        await usersCollection().updateOne(
          { _id: targetUser._id },
          { $set: updateFields, $inc: { sessionVersion: 1 } }
        );
      } else {
        await usersCollection().updateOne(
          { _id: targetUser._id },
          { $set: updateFields }
        );
      }

      await recordAudit({
        adminId: req.userId,
        adminName: req.currentUser.name,
        action: `USER_STATUS_${status.toUpperCase()}`,
        targetUserId: targetUser.studentId,
        previousStatus: prevStatus,
        newStatus: status,
        reason: sanitizedReason,
        details: `Account status updated from ${prevStatus} to ${status}.`,
        req
      });

      res.json({
        message: `Account status successfully updated to ${status}.`,
        accountStatus: status
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Admin Claim Management - List all claims
  app.get("/api/admin/claims", requireAdmin(usersCollection), async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize || 20)));
      const status = sanitizeString(req.query.status || "");
      const q = sanitizeString(req.query.q || "");

      const conditions = [];
      if (status && ["pending", "under_review", "additional_evidence_required", "approved", "rejected", "withdrawn", "flagged"].includes(status)) {
        conditions.push({ status });
      }

      if (q) {
        const regex = new RegExp(escapeRegex(q), "i");
        const parsedId = parseStudentId(q);
        const orConditions = [{ claimantName: regex }, { claimantEmail: regex }];
        if (parsedId !== null) {
          orConditions.push({ claimantId: parsedId });
        }
        conditions.push({ $or: orConditions });
      }

      const query = conditions.length > 0 ? { $and: conditions } : {};

      const [total, claimDocs] = await Promise.all([
        claimsCollection().countDocuments(query),
        claimsCollection()
          .find(query)
          .sort({ createdAt: -1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .toArray()
      ]);

      const itemIds = claimDocs.map((c) => c.itemId);
      const items = await itemsCollection().find({ _id: { $in: itemIds } }).toArray();
      const itemMap = new Map(items.map((i) => [String(i._id), i]));

      const populatedClaims = claimDocs.map((c) => ({
        ...sanitizeAdminClaim(c),
        item: itemMap.get(String(c.itemId)) || null
      }));

      res.json({
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
        claims: populatedClaims
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Admin Claim Management - Get full claim details for verification review
  app.get("/api/admin/claims/:id", requireAdmin(usersCollection), async (req, res) => {
    try {
      const claimSelector = createIdSelector(req.params.id);
      if (!claimSelector) {
        return res.status(400).json({ message: "Invalid claim ID." });
      }

      const claim = await claimsCollection().findOne({ _id: claimSelector });
      if (!claim) {
        return res.status(404).json({ message: "Claim not found." });
      }

      // Admin has full access to inspect private marks and serial numbers for ownership comparison!
      const item = await itemsCollection().findOne({ _id: claim.itemId });
      const claimant = await usersCollection().findOne({ studentId: claim.claimantId });

      res.json({
        claim: sanitizeAdminClaim(claim),
        item,
        claimant: claimant
          ? {
              id: claimant._id,
              studentId: claimant.studentId,
              name: claimant.name,
              email: claimant.email,
              accountStatus: claimant.accountStatus || "active"
            }
          : null
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Admin Claim Management - Update status (under_review, approve, reject)
  app.patch("/api/admin/claims/:id/status", requireAdmin(usersCollection), async (req, res) => {
    try {
      const claimSelector = createIdSelector(req.params.id);
      if (!claimSelector) {
        return res.status(400).json({ message: "Invalid claim ID." });
      }

      const { status, reviewNotes, rejectionReason, handoverLocation } = req.body;
      if (!["under_review", "additional_evidence_required", "approved", "rejected", "flagged"].includes(status)) {
        return res.status(400).json({ message: "Invalid claim status transition." });
      }

      if (status === "rejected" && !rejectionReason) {
        return res.status(400).json({ message: "A rejection reason is required when rejecting an ownership claim." });
      }

      const claim = await claimsCollection().findOne({ _id: claimSelector });
      if (!claim) {
        return res.status(404).json({ message: "Claim not found." });
      }

      if (!["pending", "under_review", "additional_evidence_required", "flagged"].includes(claim.status)) {
        return res.status(409).json({
          message: "This claim is no longer eligible for review or approval."
        });
      }

      const targetItem = await itemsCollection().findOne({ _id: claim.itemId });
      if (status === "approved" && !targetItem) {
        return res.status(404).json({ message: "The claimed item no longer exists." });
      }

      const prevStatus = claim.status;

      const auditEvent = {
        action: status,
        performedBy: req.userId,
        role: "admin",
        details: status === "rejected"
          ? `Claim rejected. Reason: ${rejectionReason}`
          : status === "approved"
            ? `Claim approved. Handover location: ${handoverLocation || "Campus Security Desk"}`
            : `Claim marked as under review. Notes: ${reviewNotes || ""}`,
        timestamp: new Date()
      };

      const updatePayload = {
        status,
        reviewedBy: req.userId,
        adminReviewedBy: req.userId,
        reviewDate: new Date(),
        reviewedAt: new Date(),
        adminRemarks: sanitizeString(reviewNotes || ""),
        reviewNotes: sanitizeString(reviewNotes || ""),
        rejectionReason: status === "rejected" ? sanitizeString(rejectionReason) : "",
        handoverLocation: status === "approved" ? sanitizeString(handoverLocation || "Campus Security Desk") : "",
        handoverDate: status === "approved" ? new Date() : null,
        updatedAt: new Date()
      };

      if (status === "approved") {
        if (
          !isPubliclyVisibleItem(targetItem) ||
          ["returned", "closed"].includes(targetItem.status)
        ) {
          return res.status(409).json({
            message: "This item is no longer available to approve another claim."
          });
        }

        const reservation = await itemsCollection().updateOne(
          {
            _id: targetItem._id,
            status: { $nin: ["returned", "closed"] },
            approvedClaimId: { $in: [null] },
            moderationStatus: { $in: ["active", null] }
          },
          {
            $set: {
              approvedClaimId: claim._id,
              updatedAt: new Date()
            }
          }
        );
        if (reservation.matchedCount !== 1) {
          return res.status(409).json({
            message: "Another claim has already been approved for this item."
          });
        }

        const handoverOtp = generateSecureOtp();
        const expiryMinutes = Math.max(1, Number(process.env.HANDOVER_OTP_EXPIRY_MINUTES || 10));
        updatePayload.handoverOtpHash = sha256(handoverOtp);
        updatePayload.handoverOtpEncrypted = encryptOtp(handoverOtp);
        updatePayload.handoverOtpExpiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
        updatePayload.handoverOtpAttempts = 0;
        updatePayload.handoverOtpIssuedAt = new Date();

        const claimantUser = await usersCollection().findOne({ studentId: claim.claimantId });
        const recipientEmail = claimantUser?.email || claim.claimantEmail;

        const emailResult = await sendHandoverOtp({
          recipientEmail,
          studentName: claimantUser?.name || claim.claimantName,
          itemName: targetItem?.itemName || "Reported Item",
          handoverLocation: updatePayload.handoverLocation,
          otp: handoverOtp,
          expiresMinutes: expiryMinutes
        });
        updatePayload.handoverOtpEmailStatus = emailResult.status;
        updatePayload.handoverOtpEmailError = emailResult.success ? "" : (emailResult.errorReason || "Failed to deliver OTP email.");
      }

      const claimUpdate = await claimsCollection().updateOne(
        {
          _id: claimSelector,
          status: { $in: ["pending", "under_review", "additional_evidence_required", "flagged"] }
        },
        {
          $set: updatePayload,
          $push: { claimHistory: auditEvent }
        }
      );
      if (claimUpdate.matchedCount !== 1) {
        if (status === "approved") {
          await itemsCollection().updateOne(
            { _id: targetItem._id, approvedClaimId: claim._id },
            {
              $set: { status: targetItem.status, updatedAt: new Date() },
              $unset: { approvedClaimId: "" }
            }
          );
        }
        return res.status(409).json({
          message: "This claim changed while it was being reviewed. Refresh and try again."
        });
      }

      await recordAudit({
        adminId: req.userId,
        adminName: req.currentUser.name,
        action: `CLAIM_${status.toUpperCase()}`,
        targetClaimId: claim._id,
        targetItemId: claim.itemId,
        targetUserId: claim.claimantId,
        previousStatus: prevStatus,
        newStatus: status,
        reason: status === "rejected" ? rejectionReason : reviewNotes || "",
        details: `Claim status updated to ${status}.`,
        req
      });

      // Notify claimant via email
      notifyClaimStatusChange({
        recipientEmail: claim.claimantEmail,
        claimantName: claim.claimantName,
        itemName: targetItem?.itemName || "Reported Item",
        status,
        notes: reviewNotes,
        rejectionReason,
        handoverLocation
      }).catch(() => {});

      res.json({
        message: status === "approved"
          ? (updatePayload.handoverOtpEmailStatus === "sent"
              ? "Claim approved and handover OTP emailed to claimant."
              : updatePayload.handoverOtpEmailStatus === "smtp_not_configured"
                ? "Claim approved, but email delivery is unavailable because SMTP is not configured."
                : "Claim approved, but the handover OTP email could not be delivered.")
          : `Claim status successfully updated to ${status.toUpperCase()}.`,
        status,
        handover: status === "approved"
          ? {
              otpEmailStatus: updatePayload.handoverOtpEmailStatus,
              otpEmailError: updatePayload.handoverOtpEmailError || undefined,
              expiresInMinutes: updatePayload.handoverOtpExpiresAt
                ? Math.max(1, Math.ceil((updatePayload.handoverOtpExpiresAt.getTime() - Date.now()) / 60000))
                : null
            }
          : undefined
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Admin Handover OTP Email Retry
  app.post("/api/admin/claims/:id/handover/retry-email", requireAdmin(usersCollection), async (req, res) => {
    try {
      const claimSelector = createIdSelector(req.params.id);
      if (!claimSelector) {
        return res.status(400).json({ message: "Invalid claim ID." });
      }

      const claim = await claimsCollection().findOne({ _id: claimSelector });
      if (!claim) {
        return res.status(404).json({ message: "Claim not found." });
      }

      if (claim.status !== "approved") {
        return res.status(409).json({ message: "Only approved claims awaiting handover have an active OTP." });
      }

      if (!claim.handoverOtpHash || !claim.handoverOtpExpiresAt) {
        return res.status(410).json({ message: "No active handover OTP exists for this claim." });
      }

      if (new Date(claim.handoverOtpExpiresAt).getTime() <= Date.now()) {
        return res.status(410).json({ message: "The handover OTP has expired and cannot be resent. Please re-arbitrate." });
      }

      // Check rate limit: maximum 5 retries per 10 minutes per claim
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const recentRetries = (claim.claimHistory || []).filter(
        (h) => h.action === "otp_email_retry" && new Date(h.timestamp) >= tenMinutesAgo
      ).length;
      if (recentRetries >= 5) {
        return res.status(429).json({ message: "Too many email retry attempts. Please wait before retrying again." });
      }

      if (!claim.handoverOtpEncrypted) {
        return res.status(409).json({
          message: "Secure OTP retry is not available for this claim because it was generated before encrypted retry support."
        });
      }

      const decryptedOtp = decryptOtp(claim.handoverOtpEncrypted);
      if (!decryptedOtp) {
        return res.status(500).json({ message: "Could not safely recover OTP for retry. Security decryption failed." });
      }

      if (sha256(decryptedOtp) !== claim.handoverOtpHash) {
        return res.status(500).json({ message: "Security integrity check failed: OTP mismatch." });
      }

      const targetItem = await itemsCollection().findOne({ _id: claim.itemId });
      const claimantUser = await usersCollection().findOne({ studentId: claim.claimantId });
      const recipientEmail = claimantUser?.email || claim.claimantEmail;
      const remainingMinutes = Math.max(1, Math.ceil((new Date(claim.handoverOtpExpiresAt).getTime() - Date.now()) / 60000));

      const emailResult = await sendHandoverOtp({
        recipientEmail,
        studentName: claimantUser?.name || claim.claimantName,
        itemName: targetItem?.itemName || "Reported Item",
        handoverLocation: claim.handoverLocation || "Campus Security Desk",
        otp: decryptedOtp,
        expiresMinutes: remainingMinutes
      });

      const auditEvent = {
        action: "otp_email_retry",
        performedBy: req.userId,
        role: "admin",
        details: emailResult.success
          ? "Handover OTP email resent successfully to claimant."
          : `Handover OTP email retry failed: ${emailResult.errorReason || "SMTP error"}`,
        timestamp: new Date()
      };

      await claimsCollection().updateOne(
        { _id: claimSelector },
        {
          $set: {
            handoverOtpEmailStatus: emailResult.status,
            handoverOtpEmailError: emailResult.success ? "" : (emailResult.errorReason || "Failed to deliver OTP email."),
            updatedAt: new Date()
          },
          $push: { claimHistory: auditEvent }
        }
      );

      await recordAudit({
        adminId: req.userId,
        adminName: req.currentUser.name,
        action: "CLAIM_HANDOVER_OTP_EMAIL_RETRY",
        targetClaimId: claim._id,
        targetItemId: claim.itemId,
        targetUserId: claim.claimantId,
        details: emailResult.success ? "Resent handover OTP email to claimant." : `Email retry failed: ${emailResult.errorReason}`,
        req
      });

      if (!emailResult.success) {
        return res.status(502).json({
          message: emailResult.errorReason || "Failed to deliver handover OTP email.",
          handoverOtpEmailStatus: emailResult.status,
          errorReason: emailResult.errorReason
        });
      }

      res.json({
        message: "Handover OTP email resent successfully to the claimant.",
        handoverOtpEmailStatus: emailResult.status,
        recipientEmail: claimantUser?.email || claim.claimantEmail
      });
    } catch (error) {
      console.error("OTP email retry error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  // Admin SMTP Status
  app.get("/api/admin/smtp/status", requireAdmin(usersCollection), async (req, res) => {
    try {
      const config = getSmtpConfig();
      res.json({
        configured: config.isConfigured,
        missingFields: config.missingFields,
        host: config.host || null,
        port: config.port,
        user: config.user ? config.user.replace(/^(.)(.*)(@.*)$/, "$1***$3") : null,
        from: config.from
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Admin Item Management - List all items with moderation info
  app.get("/api/admin/items", requireAdmin(usersCollection), async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize || 20)));
      const q = sanitizeString(req.query.q || "");
      const reportType = sanitizeString(req.query.reportType || "");
      const status = sanitizeString(req.query.status || "");
      const moderationStatus = sanitizeString(req.query.moderationStatus || "");

      const conditions = [];
      if (reportType && ["lost", "found"].includes(reportType)) {
        conditions.push({ reportType });
      }
      if (status) {
        conditions.push({ status });
      }
      if (moderationStatus) {
        conditions.push({ moderationStatus });
      }

      if (q) {
        const regex = new RegExp(escapeRegex(q), "i");
        conditions.push({
          $or: [
            { itemName: regex },
            { category: regex },
            { color: regex },
            { location: regex }
          ]
        });
      }

      const query = conditions.length > 0 ? { $and: conditions } : {};

      const [total, itemDocs] = await Promise.all([
        itemsCollection().countDocuments(query),
        itemsCollection()
          .find(query)
          .sort({ dateReported: -1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .toArray()
      ]);

      const itemIds = itemDocs.map((i) => i._id);
      const claimCounts = await claimsCollection()
        .aggregate([
          { $match: { itemId: { $in: itemIds } } },
          { $group: { _id: "$itemId", count: { $sum: 1 } } }
        ])
        .toArray();

      const claimCountMap = new Map(claimCounts.map((c) => [String(c._id), c.count]));

      const itemsWithClaims = itemDocs.map((item) => ({
        ...item,
        claimsCount: claimCountMap.get(String(item._id)) || 0
      }));

      res.json({
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
        items: itemsWithClaims
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Admin Item Management - Moderate item report (flag or restore)
  app.patch("/api/admin/items/:id/moderate", requireAdmin(usersCollection), async (req, res) => {
    try {
      const itemSelector = createIdSelector(req.params.id);
      if (!itemSelector) {
        return res.status(400).json({ message: "Invalid item ID." });
      }

      const { moderationStatus, reason } = req.body;
      if (!["active", "flagged", "removed"].includes(moderationStatus)) {
        return res.status(400).json({ message: "Moderation status must be active, flagged, or removed." });
      }

      const item = await itemsCollection().findOne({ _id: itemSelector });
      if (!item) {
        return res.status(404).json({ message: "Item not found." });
      }

      const prevModeration = item.moderationStatus || "active";
      const sanitizedReason = sanitizeString(reason || "");

      await itemsCollection().updateOne(
        { _id: itemSelector },
        {
          $set: {
            moderationStatus,
            moderationReason: sanitizedReason,
            updatedAt: new Date()
          }
        }
      );

      let cleanupPending = false;
      if (moderationStatus === "removed" && Array.isArray(item.privateImages) && item.privateImages.length > 0) {
        const cleanup = await cleanupPrivateEvidenceFiles(item.privateImages, privateFilesCollection, "itemVerification");
        cleanupPending = cleanup.failed.length > 0;
      }

      await recordAudit({
        adminId: req.userId,
        adminName: req.currentUser.name,
        action: `ITEM_${moderationStatus.toUpperCase()}`,
        targetItemId: item._id,
        targetUserId: item.reportedBy,
        previousStatus: prevModeration,
        newStatus: moderationStatus,
        reason: sanitizedReason,
        details: `Item report moderated to ${moderationStatus}.`,
        req
      });

      res.json({
        message: `Item report status successfully set to ${moderationStatus}.`,
        moderationStatus,
        cleanupPending
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Enforce append-only immutability on audit logs at HTTP routing level
  app.use("/api/admin/audit-logs", (req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      return res.status(405).json({
        message: "Audit logs are strictly append-only and cannot be altered or deleted."
      });
    }
    next();
  });

  // Admin Activity Logs - View historical audit trail
  app.get("/api/admin/audit-logs", requireAdmin(usersCollection), async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize || 25)));
      const action = sanitizeString(req.query.action || "");

      const query = action ? { action } : {};

      const [total, logs] = await Promise.all([
        auditLogsCollection().countDocuments(query),
        auditLogsCollection()
          .find(query)
          .sort({ createdAt: -1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .toArray()
      ]);

      res.json({
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
        logs
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/admin/matches/disputed", requireAdmin(usersCollection), async (req, res) => {
    try {
      const disputed = await matchesCollection()
        .aggregate([
          { $match: { status: "disputed" } },
          {
            $lookup: {
              from: "items",
              localField: "lostItemId",
              foreignField: "_id",
              as: "lostItem"
            }
          },
          {
            $lookup: {
              from: "items",
              localField: "foundItemId",
              foreignField: "_id",
              as: "foundItem"
            }
          },
          { $unwind: { path: "$lostItem", preserveNullAndEmptyArrays: true } },
          { $unwind: { path: "$foundItem", preserveNullAndEmptyArrays: true } },
          { $sort: { disputedAt: -1 } }
        ])
        .toArray();

      res.json({
        count: disputed.length,
        disputes: disputed
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/admin/matches/pending", requireAdmin(usersCollection), async (req, res) => {
    try {
      const pending = await matchesCollection()
        .aggregate([
          { $match: { status: { $in: ["confirming", "pending"] } } },
          {
            $lookup: {
              from: "items",
              localField: "lostItemId",
              foreignField: "_id",
              as: "lostItem"
            }
          },
          {
            $lookup: {
              from: "items",
              localField: "foundItemId",
              foreignField: "_id",
              as: "foundItem"
            }
          },
          { $unwind: { path: "$lostItem", preserveNullAndEmptyArrays: true } },
          { $unwind: { path: "$foundItem", preserveNullAndEmptyArrays: true } },
          { $sort: { createdAt: -1 } }
        ])
        .toArray();

      res.json({
        count: pending.length,
        claims: pending
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch("/api/admin/matches/:id/resolve", requireAdmin(usersCollection), async (req, res) => {
    try {
      const { id } = req.params;
      const matchIdSelector = createIdSelector(id);
      const { decision, resolutionNotes, handoverLocation } = req.body;

      if (!matchIdSelector) {
        return res.status(400).json({ message: "Invalid match ID." });
      }

      if (!["approve", "reject"].includes(decision)) {
        return res.status(400).json({ message: "Decision must be 'approve' or 'reject'." });
      }

      const match = await matchesCollection().findOne({ _id: matchIdSelector });
      if (!match) {
        return res.status(404).json({ message: "Match not found." });
      }

      const auditEvent = {
        action: "admin_resolved",
        performedBy: req.userId,
        role: "admin",
        details: `Admin decision: ${decision.toUpperCase()}. ${resolutionNotes || ""}`,
        timestamp: new Date()
      };

      if (decision === "approve") {
        if (["confirmed", "duplicate"].includes(match.status)) {
          return res.status(409).json({ message: "This match has already been resolved." });
        }
        const priorMatchStatus = match.status;
        const matchReservation = await matchesCollection().updateOne(
          {
            _id: matchIdSelector,
            status: { $in: ["pending", "confirming", "disputed"] }
          },
          {
            $set: {
              status: "confirmed",
              resolvedBy: req.userId,
              resolutionNotes: sanitizeString(resolutionNotes),
              handoverLocation: sanitizeString(handoverLocation) || "Campus Security Desk",
              confirmedAt: new Date()
            }
          }
        );
        if (matchReservation.matchedCount !== 1) {
          return res.status(409).json({ message: "This match has already been resolved." });
        }

        const reservedItems = [];
        const originalStatuses = new Map();

        for (const itemId of [match.lostItemId, match.foundItemId]) {
          const item = await itemsCollection().findOne({ _id: itemId });
          if (!item) {
            for (const reserved of reservedItems) {
              await itemsCollection().updateOne(
                { _id: reserved._id, status: "returned", approvedMatchId: match._id },
                {
                  $set: { status: originalStatuses.get(String(reserved._id)) || reserved.status },
                  $unset: { approvedMatchId: "" }
                }
              );
            }
            await matchesCollection().updateOne(
              { _id: matchIdSelector, status: "confirmed" },
              { $set: { status: priorMatchStatus } }
            );
            return res.status(409).json({ message: "The linked item reports are no longer available." });
          }

          if (["returned", "closed"].includes(item.status) || !["active", null, undefined].includes(item.moderationStatus)) {
            for (const reserved of reservedItems) {
              await itemsCollection().updateOne(
                { _id: reserved._id, status: "returned", approvedMatchId: match._id },
                {
                  $set: { status: originalStatuses.get(String(reserved._id)) || reserved.status },
                  $unset: { approvedMatchId: "" }
                }
              );
            }
            await matchesCollection().updateOne(
              { _id: matchIdSelector, status: "confirmed" },
              { $set: { status: priorMatchStatus } }
            );
            return res.status(409).json({ message: "Another match or claim has already resolved this item." });
          }

          const reservation = await itemsCollection().updateOne(
            {
              _id: item._id,
              status: { $nin: ["returned", "closed"] },
              approvedMatchId: { $in: [null] },
              moderationStatus: { $in: ["active", null] }
            },
            { $set: { status: "returned", approvedMatchId: match._id, updatedAt: new Date() } }
          );
          if (reservation.matchedCount !== 1) {
            for (const reserved of reservedItems) {
              await itemsCollection().updateOne(
                { _id: reserved._id, status: "returned", approvedMatchId: match._id },
                {
                  $set: { status: originalStatuses.get(String(reserved._id)) || reserved.status },
                  $unset: { approvedMatchId: "" }
                }
              );
            }
            await matchesCollection().updateOne(
              { _id: matchIdSelector, status: "confirmed" },
              { $set: { status: priorMatchStatus } }
            );
            return res.status(409).json({ message: "Another match or claim has already resolved this item." });
          }

          originalStatuses.set(String(item._id), item.status);
          reservedItems.push(item);
        }

        await matchesCollection().updateOne(
          { _id: matchIdSelector },
          {
            $set: {
              status: "confirmed",
              resolvedBy: req.userId,
              resolutionNotes: sanitizeString(resolutionNotes),
              handoverLocation: sanitizeString(handoverLocation) || "Campus Security Desk",
              confirmedAt: new Date()
            },
            $push: { claimHistory: auditEvent }
          }
        );

        // Notify both parties of resolution
        usersCollection().findOne({ studentId: match.lostReportedBy }).then((lostUser) => {
          if (lostUser?.email) {
            notifyAdminResolution({
              recipientEmail: lostUser.email,
              studentName: lostUser.name || "Student",
              itemName: "Lost Item",
              decision: "approve",
              handoverLocation: sanitizeString(handoverLocation) || "Campus Security Desk",
              notes: resolutionNotes
            }).catch(() => {});
          }
        }).catch(() => {});

        return res.json({ message: "Claim approved and item marked as returned." });
      } else {
        await matchesCollection().updateOne(
          { _id: matchIdSelector },
          {
            $set: {
              status: "rejected",
              resolvedBy: req.userId,
              resolutionNotes: sanitizeString(resolutionNotes)
            },
            $push: { claimHistory: auditEvent }
          }
        );

        usersCollection().findOne({ studentId: match.lostReportedBy }).then((lostUser) => {
          if (lostUser?.email) {
            notifyAdminResolution({
              recipientEmail: lostUser.email,
              studentName: lostUser.name || "Student",
              itemName: "Lost Item",
              decision: "reject",
              notes: resolutionNotes
            }).catch(() => {});
          }
        }).catch(() => {});

        return res.json({ message: "Dispute resolved: Claim was rejected." });
      }
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  return app;
}

const app = createApp();

async function startServer() {
  try {
    const envValidation = validateEnvironment(process.env);
    if (!envValidation.isValid) {
      throw new Error(`Environment validation failed:\n- ${envValidation.errors.join("\n- ")}`);
    }

    await mongoose.connect(MONGO_URI);
    const users = mongoose.connection.collection("users");
    const items = mongoose.connection.collection("items");
    const matches = mongoose.connection.collection("matches");
    const claims = mongoose.connection.collection("claims");
    const auditLogs = mongoose.connection.collection("auditLogs");

    // Helper to safely create or update indexes without crashing on IndexKeySpecsConflict
    const safeCreateIndex = async (collection, keys, options = {}) => {
      try {
        await collection.createIndex(keys, options);
      } catch (err) {
        if (err.code === 86 || err.codeName === "IndexKeySpecsConflict") {
          const indexName = options.name || Object.entries(keys).map(([k, v]) => `${k}_${v}`).join("_");
          try {
            await collection.dropIndex(indexName);
            await collection.createIndex(keys, options);
          } catch (dropErr) {
            console.warn(`Could not recreate index ${indexName}:`, dropErr.message);
          }
        } else {
          throw err;
        }
      }
    };

    // Indexes for frequently queried fields
    await safeCreateIndex(
      users,
      { studentId: 1 },
      {
        unique: true,
        partialFilterExpression: { studentId: { $type: "number" } }
      }
    );
    await safeCreateIndex(
      users,
      { email: 1 },
      {
        unique: true,
        partialFilterExpression: { email: { $type: "string" } }
      }
    );
    await safeCreateIndex(
      users,
      { oidcIssuer: 1, oidcSubject: 1 },
      {
        unique: true,
        partialFilterExpression: {
          oidcIssuer: { $type: "string" },
          oidcSubject: { $type: "string" }
        }
      }
    );
    await safeCreateIndex(users, { role: 1 });
    await safeCreateIndex(users, { accountStatus: 1 });

    await safeCreateIndex(items, { reportType: 1, dateReported: -1 });
    await safeCreateIndex(items, { reportedBy: 1, dateReported: -1 });
    await safeCreateIndex(items, { category: 1, reportType: 1, status: 1 });
    await safeCreateIndex(items, { status: 1 });
    await safeCreateIndex(items, { moderationStatus: 1 });

    await safeCreateIndex(claims, { itemId: 1 });
    await safeCreateIndex(claims, { claimantId: 1, createdAt: -1 });
    await safeCreateIndex(claims, { status: 1 });

    await safeCreateIndex(auditLogs, { adminId: 1, createdAt: -1 });
    await safeCreateIndex(auditLogs, { action: 1 });
    await safeCreateIndex(auditLogs, { createdAt: -1 });

    // Clean duplicate matches
    const duplicateMatchGroups = await matches.aggregate([
      {
        $match: {
          status: { $in: ["pending", "confirming", "confirmed", "disputed"] }
        }
      },
      {
        $group: {
          _id: { lostItemId: "$lostItemId", foundItemId: "$foundItemId" },
          ids: { $push: "$_id" }
        }
      }
    ]).toArray();

    for (const group of duplicateMatchGroups) {
      for (const duplicateId of group.ids.slice(1)) {
        await matches.updateOne(
          { _id: duplicateId },
          { $set: { status: "duplicate", duplicateOf: group.ids[0] } }
        );
      }
    }

    // Atomic uniqueness index for matches
    await safeCreateIndex(
      matches,
      { lostItemId: 1, foundItemId: 1 },
      {
        unique: true,
        partialFilterExpression: {
          status: { $in: ["pending", "confirming", "confirmed", "disputed"] }
        }
      }
    );
    await safeCreateIndex(matches, { lostReportedBy: 1, status: 1 });
    await safeCreateIndex(matches, { foundReportedBy: 1, status: 1 });
    await safeCreateIndex(matches, { status: 1 });

    // Resume interrupted match confirmations
    const confirmationsToResume = await matches.find({ status: "confirming" }).toArray();
    for (const match of confirmationsToResume) {
      try {
        if (match.confirmedBy == null) {
          await matches.updateOne(
            { _id: match._id, status: "confirming", confirmedBy: { $in: [null] } },
            { $set: { confirmedBy: match.lostReportedBy } }
          );
        }
        const completed = await completeMatchConfirmation(
          match,
          () => items,
          () => matches,
          () => claims,
          match.confirmedBy || match.lostReportedBy
        );
        if (!completed.ok && completed.reason !== "busy") {
          console.error(`[MatchConfirmation] Startup recovery needs review for ${match._id}: ${completed.reason}`);
        }
      } catch (error) {
        console.error(`Could not resume match confirmation ${match._id}:`, error);
      }
    }

    console.log("MongoDB connected successfully!");

    const smtpConfig = getSmtpConfig();
    if (!smtpConfig.isConfigured) {
      console.warn(
        `[SMTP Warning] SMTP is not configured. Missing: ${smtpConfig.missingFields.join(", ")}. Handover OTP emails will fail until SMTP is configured in .env.`
      );
    } else {
      console.log(`[SMTP] Checking connection to ${smtpConfig.host}:${smtpConfig.port}...`);
      try {
        const verifyResult = await verifySmtpConnection();
        if (verifyResult.success) {
          console.log(`[SMTP] Connection verified successfully for ${smtpConfig.host}:${smtpConfig.port}`);
        } else {
          console.warn(`[SMTP Warning] SMTP verification failed: ${verifyResult.errorReason}`);
        }
      } catch (smtpErr) {
        console.warn(`[SMTP Warning] SMTP connection check error: ${sanitizeSmtpError(smtpErr)}`);
      }
    }

    app.listen(PORT, () => {
      console.log(`CampusFind server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  startServer();
}

export { app, startServer, parseStudentId, compareItemReporterToUser };
