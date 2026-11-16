
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import * as oidc from "openid-client";

dotenv.config();

const PORT = Number(process.env.PORT) || 5000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/CampusFind";
const JWT_SECRET = process.env.JWT_SECRET;
const AUTH_COOKIE_NAME = "campusfind_token";
const OIDC_PENDING_COOKIE = "campusfind_oidc";
const AUTH_MODE = process.env.AUTH_MODE || (process.env.NODE_ENV === "production" ? "oidc" : "local");
const OIDC_ISSUER = process.env.OIDC_ISSUER;
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID;
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET;
const OIDC_REDIRECT_URI = process.env.OIDC_REDIRECT_URI;
const OIDC_STUDENT_ID_CLAIM = process.env.OIDC_STUDENT_ID_CLAIM || "student_id";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const allowedOrigins = new Set(
  (process.env.CLIENT_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
let oidcConfigurationPromise;

const sanitizeString = (value, fallback = "") => {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
};

const parseStudentId = (value) => {
  const normalized = Number(sanitizeString(value));

  if (!Number.isInteger(normalized) || normalized <= 0) {
    return null;
  }

  return normalized;
};

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSessionToken(req) {
  const cookieToken = req.cookies?.[AUTH_COOKIE_NAME];

  if (cookieToken) {
    return cookieToken;
  }

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
    } catch (error) {
      return res.status(401).json({ message: "Session expired or invalid." });
    }

    const studentId = parseStudentId(payload.studentId);
    if (studentId === null) {
      return res.status(401).json({ message: "Session expired or invalid." });
    }

    try {
      const user = await usersCollection().findOne({ studentId });
      if (
        !user
        || String(user._id) !== String(payload.userId)
        || (user.sessionVersion || 0) !== (payload.sessionVersion || 0)
      ) {
        return res.status(401).json({ message: "Session expired or invalid." });
      }

      req.userId = studentId;
      req.currentUser = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function createSessionToken(user) {
  return jwt.sign(
    {
      userId: user._id.toString(),
      studentId: user.studentId,
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

  if (!value) {
    return null;
  }

  return mongoose.isValidObjectId(value)
    ? new mongoose.Types.ObjectId(value)
    : value;
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

function calculateMatchScore(lost, found) {
  let score = 0;

  if (normalize(lost.itemName) === normalize(found.itemName)) {
    score += 40;
  }

  if (normalize(lost.category) === normalize(found.category)) {
    score += 25;
  }

  if (normalize(lost.color) === normalize(found.color)) {
    score += 25;
  }

  if (normalize(lost.location) === normalize(found.location)) {
    score += 10;
  }

  return score;
}

async function createMatchesForItem(item, itemId, collectionFactory) {
  const itemsCollection = collectionFactory.itemsCollection;
  const matchesCollection = collectionFactory.matchesCollection;
  const oppositeType = normalize(item.reportType) === "lost" ? "found" : "lost";

  const oppositeItems = await itemsCollection()
    .find({
      reportType: oppositeType,
      status: { $nin: ["returned", "closed"] },
      _id: { $ne: itemId },
      category: item.category,
      color: item.color,
      itemName: item.itemName
    })
    .collation({ locale: "en", strength: 2 })
    .toArray();

  let matchesCreated = 0;

  for (const other of oppositeItems) {
    const lost = normalize(item.reportType) === "lost" ? item : other;
    const found = normalize(item.reportType) === "found" ? item : other;
    const score = calculateMatchScore(lost, found);

    if (score < 90) {
      continue;
    }

    const lostId = normalize(item.reportType) === "lost" ? itemId : other._id;
    const foundId = normalize(item.reportType) === "found" ? itemId : other._id;
    try {
      const result = await matchesCollection().updateOne(
        {
          lostItemId: lostId,
          foundItemId: foundId,
          status: { $in: ["pending", "confirming", "confirmed"] }
        },
        {
          $setOnInsert: {
            lostItemId: lostId,
            foundItemId: foundId,
            lostReportedBy: Number(lost.reportedBy),
            foundReportedBy: Number(found.reportedBy),
            matchScore: score,
            status: "pending",
            createdAt: new Date()
          }
        },
        { upsert: true }
      );

      if (result.upsertedCount === 1) {
        matchesCreated += 1;
      }
    } catch (error) {
      if (error.code !== 11000) {
        throw error;
      }
    }
  }

  return matchesCreated;
}

async function completeMatchConfirmation(match, itemsCollection, matchesCollection) {
  const updatedItems = await itemsCollection().updateMany(
    {
      _id: {
        $in: [match.lostItemId, match.foundItemId]
      }
    },
    {
      $set: { status: "returned" }
    }
  );

  if (updatedItems.matchedCount !== 2) {
    return false;
  }

  await matchesCollection().updateOne(
    { _id: match._id, status: "confirming" },
    {
      $set: {
        status: "confirmed",
        confirmedAt: new Date()
      },
      $unset: { confirmationStartedAt: "" }
    }
  );
  return true;
}

export function createApp(collectionFactory = {}) {
  const itemsCollection = collectionFactory.itemsCollection || (() => mongoose.connection.collection("items"));
  const matchesCollection = collectionFactory.matchesCollection || (() => mongoose.connection.collection("matches"));
  const usersCollection = collectionFactory.usersCollection || (() => mongoose.connection.collection("users"));
  const app = express();

  app.use(cors({
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    },
    credentials: true
  }));
  app.use((req, res, next) => {
    const origin = req.get("Origin");
    const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
    if (isMutation && origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ message: "Origin is not allowed." });
    }
    next();
  });
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { message: "Too many requests. Please try again later." }
    })
  );

  app.get("/", (req, res) => {
    res.send("Welcome to CampusFind API!");
  });

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

      res.json({
        items: items.map(({ reportedBy, ...item }) => item),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize)
      });
    } catch (error) {
      res.status(500).json({ message: "Could not load item reports." });
    }
  }

  app.get("/api/auth/method", (req, res) => {
    res.json({ mode: AUTH_MODE });
  });

  app.get("/api/auth/sso", async (req, res) => {
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
      } else {
        const conflictingEmail = await usersCollection().findOne({ email });
        if (conflictingEmail) {
          return res.status(409).send("This campus email is already linked to another account.");
        }

        const newUser = {
          studentId,
          name: sanitizeString(claims.name) || email,
          email,
          oidcIssuer: claims.iss,
          oidcSubject: claims.sub,
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

  app.post("/api/auth/register", async (req, res) => {
    try {
      if (AUTH_MODE !== "local") {
        return res.status(403).json({
          message: "Create your account through campus single sign-on."
        });
      }

      const { studentId, name, email, password } = req.body;
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
          message: "Password must be 8–72 bytes long."
        });
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

      const hashedPassword = await bcrypt.hash(normalizedPassword, 10);
      const createdUser = await usersCollection().insertOne({
        studentId: parsedStudentId,
        name: cleanedName,
        email: emailAddress,
        passwordHash: hashedPassword,
        sessionVersion: 0,
        createdAt: new Date()
      });

      const token = createSessionToken({
        _id: createdUser.insertedId,
        studentId: parsedStudentId,
        sessionVersion: 0
      });

      res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());
      res.status(201).json({
        message: "User registered successfully.",
        user: {
          id: createdUser.insertedId,
          studentId: parsedStudentId,
          name: cleanedName,
          email: emailAddress
        }
      });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
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

      const token = createSessionToken(existingUser);

      res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());
      res.json({
        message: "Login successful.",
        user: {
          id: existingUser._id,
          studentId: existingUser.studentId,
          name: existingUser.name,
          email: existingUser.email
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
    const { _id, studentId, name, email } = req.currentUser;
    res.json({ user: { id: _id, studentId, name, email } });
  });

  app.get("/api/profile", requireStudent(usersCollection), async (req, res) => {
    try {
      const reports = await itemsCollection()
        .find({ reportedBy: req.userId })
        .sort({ dateReported: -1 })
        .toArray();
      const { _id, studentId, name, email, createdAt } = req.currentUser;

      res.json({
        user: { id: _id, studentId, name, email, createdAt },
        reports
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
          email
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

  app.post("/api/items", requireStudent(usersCollection), async (req, res) => {
    try {
      const {
        itemName,
        category,
        color,
        reportType,
        location,
        reportedBy
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

      const newItem = {
        itemName: normalizedName,
        category: normalizedCategory,
        color: normalizedColor,
        reportType: normalize(reportType),
        location: normalizedLocation,
        reportedBy: submittedStudentId,
        status: normalize(reportType) === "lost" ? "searching" : "unclaimed",
        dateReported: new Date()
      };

      const result = await itemsCollection().insertOne(newItem);
      const matchesCreated = await createMatchesForItem(
        newItem,
        result.insertedId,
        { itemsCollection, matchesCollection }
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

  app.get("/api/items/search", async (req, res) => {
    return listPublicItems(req, res);
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
                { status: { $ne: "duplicate" } }
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
          { $sort: { createdAt: -1 } }
        ])
        .toArray();

      res.json({
        totalMatches: matches.length,
        matches
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch("/api/items/matches/:id/confirm", requireStudent(usersCollection), async (req, res) => {
    try {
      const { id } = req.params;
      const providedUserId = parseStudentId(req.body.userId ?? req.userId);
      const matchIdSelector = createIdSelector(id);

      if (!matchIdSelector) {
        return res.status(400).json({
          message: "Invalid match ID."
        });
      }

      if (providedUserId === null || providedUserId !== req.userId) {
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

      if (providedUserId !== match.lostReportedBy) {
        return res.status(403).json({
          message: "Only the owner can verify this item."
        });
      }

      if (match.status === "confirmed") {
        return res.json({
          message: "This item has already been marked as returned."
        });
      }

      if (!["pending", "confirming"].includes(match.status)) {
        return res.status(409).json({ message: "This match cannot be confirmed in its current state." });
      }

      if (match.status === "confirming" && match.confirmedBy !== providedUserId) {
        return res.status(403).json({ message: "Only the owner can resume this confirmation." });
      }

      if (match.status === "pending") {
        const claimed = await matchesCollection().updateOne(
          { _id: matchIdSelector, status: "pending" },
          {
            $set: {
              status: "confirming",
              confirmedBy: providedUserId,
              confirmationStartedAt: new Date()
            }
          }
        );
        if (claimed.modifiedCount !== 1) {
          const currentMatch = await matchesCollection().findOne({ _id: matchIdSelector });
          if (currentMatch?.status === "confirmed") {
            return res.json({ message: "This item has already been marked as returned." });
          }
          if (
            currentMatch?.status !== "confirming"
            || currentMatch.confirmedBy !== providedUserId
          ) {
            return res.status(409).json({ message: "This match is being updated. Please retry." });
          }
        }
      }

      const currentMatch = await matchesCollection().findOne({ _id: matchIdSelector });
      if (!currentMatch || !(await completeMatchConfirmation(currentMatch, itemsCollection, matchesCollection))) {
        return res.status(409).json({
          message: "The linked reports could not both be updated. Retry confirmation to resume."
        });
      }

      res.json({
        message: "Success! Item has been verified and marked as RETURNED."
      });
    } catch (error) {
      console.error("Confirmation error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  return app;
}

const app = createApp();

async function startServer() {
  try {
    if (!JWT_SECRET || JWT_SECRET.length < 32) {
      throw new Error("Set JWT_SECRET to a random secret of at least 32 characters.");
    }
    if (!["local", "oidc"].includes(AUTH_MODE)) {
      throw new Error("AUTH_MODE must be either local or oidc.");
    }
    if (process.env.NODE_ENV === "production" && AUTH_MODE !== "oidc") {
      throw new Error("Production deployments must use AUTH_MODE=oidc.");
    }
    if (AUTH_MODE === "oidc" && (!OIDC_ISSUER || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET || !OIDC_REDIRECT_URI)) {
      throw new Error("Configure OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_REDIRECT_URI for campus SSO.");
    }

    await mongoose.connect(MONGO_URI);
    const users = mongoose.connection.collection("users");
    const items = mongoose.connection.collection("items");
    const matches = mongoose.connection.collection("matches");
    await users.createIndex(
      { studentId: 1 },
      {
        unique: true,
        partialFilterExpression: { studentId: { $type: "number" } }
      }
    );
    await items.createIndex({ reportType: 1, dateReported: -1 });
    await items.createIndex({ reportedBy: 1, dateReported: -1 });
    await items.createIndex(
      { reportType: 1, category: 1, color: 1, itemName: 1, status: 1 },
      { collation: { locale: "en", strength: 2 } }
    );

    const duplicateMatchGroups = await matches.aggregate([
      {
        $match: {
          lostItemId: { $type: "objectId" },
          foundItemId: { $type: "objectId" },
          status: { $in: ["pending", "confirming", "confirmed"] }
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
    if (duplicateMatchGroups.length > 0) {
      console.warn(`Archived ${duplicateMatchGroups.reduce((count, group) => count + group.ids.length - 1, 0)} duplicate match records.`);
    }
    await matches.createIndex(
      { lostItemId: 1, foundItemId: 1 },
      {
        unique: true,
        partialFilterExpression: {
          lostItemId: { $type: "objectId" },
          foundItemId: { $type: "objectId" },
          status: { $in: ["pending", "confirming", "confirmed"] }
        }
      }
    );
    await users.createIndex(
      { email: 1 },
      {
        unique: true,
        partialFilterExpression: { email: { $type: "string" } }
      }
    );
    await users.createIndex(
      { oidcIssuer: 1, oidcSubject: 1 },
      {
        unique: true,
        partialFilterExpression: {
          oidcIssuer: { $type: "string" },
          oidcSubject: { $type: "string" }
        }
      }
    );

    const confirmationsToResume = await matches.find({ status: "confirming" }).toArray();
    for (const match of confirmationsToResume) {
      try {
        const completed = await completeMatchConfirmation(match, () => items, () => matches);
        if (!completed) {
          console.error(`Match confirmation ${match._id} needs manual review because its linked reports are missing.`);
        }
      } catch (error) {
        console.error(`Could not resume match confirmation ${match._id}:`, error);
      }
    }

    console.log("MongoDB connected successfully!");

    app.listen(PORT, () => {
      console.log(`CampusFind server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  startServer();
}

export { app, startServer, parseStudentId };
