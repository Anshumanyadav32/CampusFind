import test from "node:test";
import assert from "node:assert/strict";
import supertest from "supertest";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-characters";
const { createApp, parseStudentId } = await import("./server.js");
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
const { getAuthRateLimitConfig } = await import("./utils/validation.js");
const {
  renderAdminResolutionEmail,
  renderClaimStatusChangeEmail,
  renderClaimUpdateEmail,
  renderMatchFoundEmail,
  renderHandoverOtpEmail,
  getSmtpConfig,
  verifySmtpConnection,
  sanitizeSmtpError,
  sendHandoverOtp,
  setTransporter,
  resetTransporter
} = await import("./services/emailService.js");
resetTransporter();
const { encryptOtp, decryptOtp } = await import("./utils/encryption.js");
const { PRIVATE_UPLOAD_DIR } = await import("./utils/uploader.js");
const { calculateMatchScore, isMatchConfident, tokenize } = await import("./utils/matching.js");

function matchesValue(actual, expected) {
  if (expected && typeof expected === "object" && !(expected instanceof RegExp)) {
    if (expected.$regex !== undefined) {
      return new RegExp(expected.$regex, expected.$options).test(String(actual || ""));
    }
    if (expected.$exists !== undefined) return (actual !== undefined) === expected.$exists;
    if (expected.$in) {
      return expected.$in.includes(actual) || (actual === undefined && expected.$in.includes(null));
    }
    if (expected.$nin) return !expected.$nin.includes(actual);
    if (expected.$ne !== undefined) return String(actual) !== String(expected.$ne);
    if (expected.$gte !== undefined) return new Date(actual) >= new Date(expected.$gte);
    if (expected.$lte !== undefined) return new Date(actual) <= new Date(expected.$lte);
  }
  return String(actual) === String(expected);
}

function matchesQuery(document, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$and") return expected.every((part) => matchesQuery(document, part));
    if (key === "$or") return expected.some((part) => matchesQuery(document, part));
    const actual = key.includes(".")
      ? key.split(".").reduce((value, part) => value?.[part], document)
      : document[key];
    return matchesValue(actual, expected);
  });
}

const buildTestApp = () => {
  const items = [];
  const matches = [];
  const users = [];
  const claims = [];
  const auditLogs = [];
  const itemUpdateFailures = new Map();

  const usersCollection = () => ({
    countDocuments: async (query = {}) => users.filter((u) => matchesQuery(u, query)).length,
    find: (query = {}) => {
      let offset = 0;
      let maximum = Infinity;
      const cursor = {
        sort() { return cursor; },
        skip(value) { offset = value; return cursor; },
        limit(value) { maximum = value; return cursor; },
        toArray: async () => users.filter((u) => matchesQuery(u, query)).slice(offset, offset + maximum)
      };
      return cursor;
    },
    findOne: async (query) => {
      if (query && query.$or) {
        return users.find((user) =>
          query.$or.some((condition) => matchesQuery(user, condition))
        ) || null;
      }
      return users.find((user) => matchesQuery(user, query)) || null;
    },
    insertOne: async (document) => {
      const insertedId = `user-${users.length + 1}`;
      const entry = { ...document, _id: insertedId };
      users.push(entry);
      return { insertedId };
    },
    updateOne: async (filter, update) => {
      const user = users.find((entry) => matchesQuery(entry, filter));
      if (user) {
        Object.assign(user, update.$set || {});
        for (const [key, increment] of Object.entries(update.$inc || {})) {
          user[key] = (user[key] || 0) + increment;
        }
      }
      return { acknowledged: true };
    }
  });

  const itemsCollection = () => ({
    find: (query = {}) => {
      let offset = 0;
      let maximum = Infinity;
      const cursor = {
        sort() { return cursor; },
        collation() { return cursor; },
        skip(value) { offset = value; return cursor; },
        limit(value) { maximum = value; return cursor; },
        toArray: async () => items.filter((item) => matchesQuery(item, query)).slice(offset, offset + maximum)
      };
      return cursor;
    },
    findOne: async (query) => items.find((item) => matchesQuery(item, query)) || null,
    countDocuments: async (query = {}) => items.filter((item) => matchesQuery(item, query)).length,
    insertOne: async (document) => {
      const insertedId = `item-${items.length + 1}`;
      const entry = { ...document, _id: insertedId };
      items.push(entry);
      return { insertedId };
    },
    updateOne: async (filter, update) => {
      const failureCount = itemUpdateFailures.get(String(filter._id)) || 0;
      if (failureCount > 0) {
        itemUpdateFailures.set(String(filter._id), failureCount - 1);
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      const item = items.find((entry) => matchesQuery(entry, filter));
      if (item) {
        Object.assign(item, update.$set || {});
        for (const key of Object.keys(update.$unset || {})) {
          delete item[key];
        }
      }
      return {
        acknowledged: true,
        matchedCount: item ? 1 : 0,
        modifiedCount: item ? 1 : 0
      };
    },
    deleteOne: async (filter) => {
      const index = items.findIndex((entry) => matchesQuery(entry, filter));
      if (index === -1) return { acknowledged: true, deletedCount: 0 };
      items.splice(index, 1);
      return { acknowledged: true, deletedCount: 1 };
    },
    updateMany: async (filter, update) => {
      const matchesToUpdate = items.filter((item) => {
        if (filter._id && filter._id.$in) {
          return filter._id.$in.some((id) => String(id) === String(item._id));
        }
        return true;
      });

      for (const item of matchesToUpdate) {
        Object.assign(item, update.$set || {});
      }

      return { acknowledged: true, matchedCount: matchesToUpdate.length };
    },
    aggregate: (pipeline = []) => ({
      toArray: async () => {
        const groupStage = pipeline.find((s) => s.$group);
        if (groupStage) {
          const key = groupStage.$group._id.replace("$", "");
          const counts = {};
          for (const item of items) {
            const k = item[key];
            counts[k] = (counts[k] || 0) + 1;
          }
          return Object.entries(counts).map(([k, count]) => ({ _id: Number(k) || k, count }));
        }
        return items;
      }
    })
  });

  const matchesCollection = () => ({
    countDocuments: async (query = {}) => matches.filter((match) => matchesQuery(match, query)).length,
    findOne: async (query) => {
      if (query && query.lostItemId && query.foundItemId) {
        return matches.find((match) =>
          String(match.lostItemId) === String(query.lostItemId)
          && String(match.foundItemId) === String(query.foundItemId)
        ) || null;
      }

      if (query && query._id) {
        return matches.find((match) => String(match._id) === String(query._id)) || null;
      }

      return null;
    },
    insertOne: async (document) => {
      const matchId = `match-${matches.length + 1}`;
      matches.push({ ...document, _id: matchId });
      return { insertedId: matchId };
    },
    updateOne: async (filter, update, options = {}) => {
      let existing = matches.find((match) => matchesQuery(match, filter));
      if (existing) {
        Object.assign(existing, update.$set || {});
        for (const key of Object.keys(update.$unset || {})) {
          delete existing[key];
        }
        for (const [key, val] of Object.entries(update.$push || {})) {
          if (!Array.isArray(existing[key])) existing[key] = [];
          existing[key].push(val);
        }
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (options.upsert) {
        const inserted = {
          ...(update.$setOnInsert || {}),
          _id: `match-${matches.length + 1}`
        };
        matches.push(inserted);
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },
    aggregate: (pipeline = []) => ({
      toArray: async () => {
        const matchStages = pipeline.filter((stage) => stage.$match);
        const matchStage = matchStages[0];
        let results = matchStage
          ? matches.filter((match) => matchesQuery(match, matchStage.$match))
          : matches;

        results = results.map((m) => {
          const lostItem = items.find((i) => String(i._id) === String(m.lostItemId));
          const foundItem = items.find((i) => String(i._id) === String(m.foundItemId));
          return { ...m, lostItem, foundItem };
        });
        return results.filter((match) =>
          matchStages.slice(1).every((stage) => matchesQuery(match, stage.$match))
        );
      }
    })
  });

  const claimsCollection = () => ({
    countDocuments: async (query = {}) => claims.filter((c) => matchesQuery(c, query)).length,
    find: (query = {}) => {
      let offset = 0;
      let maximum = Infinity;
      const cursor = {
        sort() { return cursor; },
        skip(v) { offset = v; return cursor; },
        limit(v) { maximum = v; return cursor; },
        toArray: async () => claims.filter((c) => matchesQuery(c, query)).slice(offset, offset + maximum)
      };
      return cursor;
    },
    findOne: async (query) => claims.find((c) => matchesQuery(c, query)) || null,
    insertOne: async (doc) => {
      const insertedId = `claim-${claims.length + 1}`;
      const entry = { ...doc, _id: insertedId };
      claims.push(entry);
      return { insertedId };
    },
    updateOne: async (filter, update) => {
      const claim = claims.find((c) => matchesQuery(c, filter));
      if (claim) {
        Object.assign(claim, update.$set || {});
        for (const key of Object.keys(update.$unset || {})) {
          delete claim[key];
        }
        for (const [key, increment] of Object.entries(update.$inc || {})) {
          claim[key] = (claim[key] || 0) + increment;
        }
        for (const [key, val] of Object.entries(update.$push || {})) {
          if (!Array.isArray(claim[key])) claim[key] = [];
          claim[key].push(val);
        }
      }
      return {
        acknowledged: true,
        matchedCount: claim ? 1 : 0,
        modifiedCount: claim ? 1 : 0
      };
    },
    aggregate: (pipeline = []) => ({
      toArray: async () => {
        const groupStage = pipeline.find((s) => s.$group);
        if (groupStage) {
          const key = groupStage.$group._id.replace("$", "");
          const counts = {};
          for (const c of claims) {
            const k = c[key];
            counts[k] = (counts[k] || 0) + 1;
          }
          return Object.entries(counts).map(([k, count]) => ({ _id: Number(k) || k, count }));
        }
        return claims;
      }
    })
  });

  const auditLogsCollection = () => ({
    countDocuments: async (query = {}) => auditLogs.filter((a) => matchesQuery(a, query)).length,
    find: (query = {}) => {
      let offset = 0;
      let maximum = Infinity;
      const cursor = {
        sort() { return cursor; },
        skip(v) { offset = v; return cursor; },
        limit(v) { maximum = v; return cursor; },
        toArray: async () => auditLogs.filter((a) => matchesQuery(a, query)).slice(offset, offset + maximum)
      };
      return cursor;
    },
    insertOne: async (doc) => {
      const insertedId = `audit-${auditLogs.length + 1}`;
      auditLogs.push({ ...doc, _id: insertedId });
      return { insertedId };
    }
  });

  const privateFiles = [];
  const privateFilesCollection = () => ({
    countDocuments: async (query = {}) => privateFiles.filter((f) => matchesQuery(f, query)).length,
    find: (query = {}) => ({
      toArray: async () => privateFiles.filter((f) => matchesQuery(f, query))
    }),
    findOne: async (query) => privateFiles.find((f) => matchesQuery(f, query)) || null,
    insertOne: async (doc) => {
      const insertedId = `file-${privateFiles.length + 1}`;
      privateFiles.push({ ...doc, _id: insertedId });
      return { insertedId };
    },
    deleteOne: async (query) => {
      const index = privateFiles.findIndex((file) => matchesQuery(file, query));
      if (index === -1) return { acknowledged: true, deletedCount: 0 };
      privateFiles.splice(index, 1);
      return { acknowledged: true, deletedCount: 1 };
    }
  });

  const otpRecords = [];
  const otpCollection = () => ({
    findOne: async (query) => otpRecords.find((record) => matchesQuery(record, query)) || null,
    insertOne: async (document) => {
      const insertedId = `otp-${otpRecords.length + 1}`;
      otpRecords.push({ ...document, _id: insertedId });
      return { insertedId };
    },
    updateOne: async (filter, update) => {
      const record = otpRecords.find((entry) => matchesQuery(entry, filter));
      if (record) {
        Object.assign(record, update.$set || {});
        for (const [key, increment] of Object.entries(update.$inc || {})) {
          record[key] = (record[key] || 0) + increment;
        }
      }
      return { acknowledged: true, matchedCount: record ? 1 : 0 };
    },
    deleteMany: async (query) => {
      let deletedCount = 0;
      for (let index = otpRecords.length - 1; index >= 0; index -= 1) {
        if (matchesQuery(otpRecords[index], query)) {
          otpRecords.splice(index, 1);
          deletedCount += 1;
        }
      }
      return { acknowledged: true, deletedCount };
    }
  });

  const app = createApp({
    itemsCollection,
    matchesCollection,
    usersCollection,
    claimsCollection,
    auditLogsCollection,
    privateFilesCollection,
    otpCollection
  });

  app.elevateAdmin = (studentId) => {
    const user = users.find((u) => u.studentId === studentId);
    if (user) user.role = "admin";
  };
  app.testUsers = users;
  app.testClaims = claims;
  app.testItems = items;
  app.testMatches = matches;
  app.failNextItemUpdate = (itemId) => {
    itemUpdateFailures.set(String(itemId), (itemUpdateFailures.get(String(itemId)) || 0) + 1);
  };
  app.testPrivateFiles = privateFiles;
  app.testOtpRecords = otpRecords;
  app.testAuditLogs = auditLogs;

  return app;
};

// Supertest-based request dispatcher (fixes EADDRINUSE and EACCES loopback issues)
const request = async (app, route, init = {}) => {
  const agent = supertest(app);
  const method = (init.method || "GET").toLowerCase();
  let req = agent[method](route);

  if (init.headers) {
    for (const [key, val] of Object.entries(init.headers)) {
      req = req.set(key, val);
    }
  }

  if (init.body) {
    const payload = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    req = req.send(payload);
  }

  const res = await req;
  const cookieHeader = res.headers["set-cookie"];
  const cookie = Array.isArray(cookieHeader) ? cookieHeader[0]?.split(";")[0] : cookieHeader?.split(";")[0];

  return {
    status: res.status,
    json: res.body,
    cookie
  };
};

const jsonRequest = (body, extraHeaders = {}, method = "POST") => ({
  method,
  headers: { "content-type": "application/json", ...extraHeaders },
  body: JSON.stringify(body)
});

async function createMatchConfirmationScenario(testApp, lostStudentId = 8801, foundStudentId = 8802) {
  const lostReporter = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: lostStudentId,
    name: "Match Owner",
    email: `match-owner-${lostStudentId}@campus.edu`,
    password: "password123"
  }));
  const foundReporter = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: foundStudentId,
    name: "Match Finder",
    email: `match-finder-${foundStudentId}@campus.edu`,
    password: "password123"
  }));

  const lostReport = await request(testApp, "/api/items", jsonRequest({
    itemName: "Black Water Bottle",
    category: "Bottle",
    color: "Black",
    reportType: "lost",
    location: "Block 34-512"
  }, { Cookie: lostReporter.cookie }));
  const foundReport = await request(testApp, "/api/items", jsonRequest({
    itemName: "Black Water Bottle",
    category: "Bottle",
    color: "Black",
    reportType: "found",
    location: "Block 34-512"
  }, { Cookie: foundReporter.cookie }));

  assert.equal(lostReport.status, 201);
  assert.equal(foundReport.status, 201);
  const match = testApp.testMatches.find((entry) =>
    String(entry.lostItemId) === String(lostReport.json.itemId)
    && String(entry.foundItemId) === String(foundReport.json.itemId)
  );
  assert.ok(match);

  return {
    lostReporter,
    foundReporter,
    lostReportId: lostReport.json.itemId,
    foundReportId: foundReport.json.itemId,
    match
  };
}

test("student ID parsing rejects invalid identities", () => {
  assert.equal(parseStudentId(101), 101);
  assert.equal(parseStudentId("0"), null);
  assert.equal(parseStudentId("abc"), null);
});

test("authentication rate limits are relaxed locally and configurable", () => {
  assert.deepEqual(
    getAuthRateLimitConfig({ NODE_ENV: "development", AUTH_MODE: "local" }),
    { windowMs: 15 * 60 * 1000, max: 100 }
  );
  assert.deepEqual(
    getAuthRateLimitConfig({ NODE_ENV: "production", AUTH_MODE: "oidc" }),
    { windowMs: 15 * 60 * 1000, max: 10 }
  );
  assert.deepEqual(
    getAuthRateLimitConfig({
      NODE_ENV: "development",
      AUTH_MODE: "local",
      AUTH_RATE_LIMIT_WINDOW_MS: "60000",
      AUTH_RATE_LIMIT_MAX: "25"
    }),
    { windowMs: 60000, max: 25 }
  );
  assert.throws(
    () => getAuthRateLimitConfig({ AUTH_RATE_LIMIT_MAX: "0" }),
    /AUTH_RATE_LIMIT_MAX must be a positive integer/
  );
});

test("notification email templates escape malicious user-controlled HTML", () => {
  const attack = `<img src=x onerror="alert(1)"> & '`;
  const renderedEmails = [
    renderMatchFoundEmail({
      studentName: attack,
      itemReported: { itemName: attack, color: attack, location: attack },
      matchedItem: { itemName: attack, color: attack, location: attack },
      matchScore: attack
    }),
    renderClaimUpdateEmail({
      studentName: attack,
      itemName: attack,
      updateType: attack,
      details: attack
    }),
    renderClaimStatusChangeEmail({
      claimantName: attack,
      itemName: attack,
      status: "approved",
      notes: attack,
      handoverLocation: attack
    }),
    renderClaimStatusChangeEmail({
      claimantName: attack,
      itemName: attack,
      status: "rejected",
      rejectionReason: attack
    }),
    renderAdminResolutionEmail({
      studentName: attack,
      itemName: attack,
      decision: "approve",
      handoverLocation: attack,
      notes: attack
    })
  ];

  for (const email of renderedEmails) {
    assert.ok(email.html.includes("&lt;img"));
    assert.ok(email.html.includes("&amp;"));
    assert.ok(!email.html.includes(attack));
    assert.ok(!/[\r\n]/.test(email.subject));
  }
});

test("college email OTP verification is rate-limited and blocks unverified claims", async () => {
  const previousRequirement = process.env.REQUIRE_COLLEGE_EMAIL_VERIFICATION;
  process.env.REQUIRE_COLLEGE_EMAIL_VERIFICATION = "true";
  const testApp = buildTestApp();

  const student = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 811,
    name: "OTP Student",
    email: "otp@student.edu",
    password: "password123"
  }));
  const finder = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 812,
    name: "OTP Finder",
    email: "finder@student.edu",
    password: "password123"
  }));

  const report = await request(testApp, "/api/items", jsonRequest({
    itemName: "Verified Ownership Item",
    category: "Electronics",
    color: "Black",
    reportType: "found",
    location: "Library",
    serialNumber: "SERIAL-PRIVATE-811",
    identifyingMarks: "Scratch under screen",
    brand: "Campus Brand",
    model: "Model 7",
    reportedBy: 812
  }, { Cookie: finder.cookie }));
  assert.equal(report.status, 201);

  const blocked = await request(testApp, "/api/claims", jsonRequest({
    itemId: report.json.itemId,
    verificationAnswers: [{ question: "Serial", answer: "SERIAL-PRIVATE-811" }]
  }, { Cookie: student.cookie }));
  assert.equal(blocked.status, 403);

  const requested = await request(testApp, "/api/auth/email-verification/request", jsonRequest({}, {
    Cookie: student.cookie
  }));
  assert.equal(requested.status, 200);

  const repeated = await request(testApp, "/api/auth/email-verification/request", jsonRequest({}, {
    Cookie: student.cookie
  }));
  assert.equal(repeated.status, 429);

  const otpRecord = testApp.testOtpRecords.find((record) => record.studentId === 811);
  assert.ok(otpRecord);
  otpRecord.codeHash = crypto.createHash("sha256").update("123456").digest("hex");

  const wrong = await request(testApp, "/api/auth/email-verification/verify", jsonRequest({
    code: "000000"
  }, { Cookie: student.cookie }));
  assert.equal(wrong.status, 400);

  const verified = await request(testApp, "/api/auth/email-verification/verify", jsonRequest({
    code: "123456"
  }, { Cookie: student.cookie }));
  assert.equal(verified.status, 200);
  assert.equal(verified.json.emailVerified, true);

  const allowed = await request(testApp, "/api/claims", jsonRequest({
    itemId: report.json.itemId,
    verificationAnswers: [{ question: "Serial", answer: "SERIAL-PRIVATE-811" }]
  }, { Cookie: student.cookie }));
  assert.equal(allowed.status, 201);
  assert.equal(testApp.testClaims[0].riskScore, 0);

  if (previousRequirement === undefined) delete process.env.REQUIRE_COLLEGE_EMAIL_VERIFICATION;
  else process.env.REQUIRE_COLLEGE_EMAIL_VERIFICATION = previousRequirement;
});

test("user registration creates a session-backed account", async () => {
  const testApp = buildTestApp();

  const response = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 101,
      name: "Priya Sharma",
      email: "priya@campus.edu",
      password: "password123"
    })
  );

  assert.equal(response.status, 201);
  assert.match(response.cookie || "", /^campusfind_token=/);
  assert.equal(response.json.user.studentId, 101);
});

test("login with valid credentials returns a cookie-backed session", async () => {
  const testApp = buildTestApp();

  await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 102,
      name: "Aarav Patel",
      email: "aarav@campus.edu",
      password: "password123"
    })
  );

  const loginResponse = await request(
    testApp,
    "/api/auth/login",
    jsonRequest({
      studentId: 102,
      password: "password123"
    })
  );

  assert.equal(loginResponse.status, 200);
  assert.match(loginResponse.cookie || "", /^campusfind_token=/);
  assert.equal(loginResponse.json.user.studentId, 102);
});

test("match API returns sanitized item summaries and hides moderated matches", async () => {
  const testApp = buildTestApp();
  const lostReporter = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 103,
      name: "Lost Reporter",
      email: "lost-reporter@campus.edu",
      password: "password123"
    })
  );
  const foundReporter = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 104,
      name: "Found Reporter",
      email: "found-reporter@campus.edu",
      password: "password123"
    })
  );
  const admin = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 105,
      name: "Moderation Admin",
      email: "moderation-admin@campus.edu",
      password: "password123"
    })
  );
  testApp.elevateAdmin(105);

  const lost = await request(
    testApp,
    "/api/items",
    jsonRequest({
      itemName: "Blue Campus Wallet",
      category: "Accessories",
      color: "Blue",
      reportType: "lost",
      location: "Library",
      identifyingMarks: "Private lost-side mark",
      serialNumber: "LOST-SECRET-1",
      verificationQuestion: "Private lost-side question"
    }, { Cookie: lostReporter.cookie })
  );
  const found = await request(
    testApp,
    "/api/items",
    jsonRequest({
      itemName: "Blue Campus Wallet",
      category: "Accessories",
      color: "Blue",
      reportType: "found",
      location: "Library",
      identifyingMarks: "Private found-side mark",
      serialNumber: "FOUND-SECRET-2",
      verificationQuestion: "Private found-side question"
    }, { Cookie: foundReporter.cookie })
  );
  assert.equal(lost.status, 201);
  assert.equal(found.status, 201);

  const lostMatches = await request(testApp, "/api/items/matches", {
    headers: { Cookie: lostReporter.cookie }
  });
  assert.equal(lostMatches.status, 200);
  assert.equal(lostMatches.json.matches.length, 1);
  const match = lostMatches.json.matches[0];
  assert.equal(match.isLostReporter, true);
  assert.equal(match.lostReportedBy, undefined);
  assert.equal(match.foundReportedBy, undefined);
  for (const matchedItem of [match.lostItem, match.foundItem]) {
    assert.equal(matchedItem.identifyingMarks, undefined);
    assert.equal(matchedItem.serialNumber, undefined);
    assert.equal(matchedItem.verificationQuestion, undefined);
    assert.equal(matchedItem.verificationQuestions, undefined);
    assert.equal(matchedItem.privateImages, undefined);
    assert.equal(matchedItem.contactPhone, undefined);
    assert.equal(matchedItem.reportedBy, undefined);
    assert.equal(matchedItem.hasVerificationDetails, true);
  }

  const foundMatches = await request(testApp, "/api/items/matches", {
    headers: { Cookie: foundReporter.cookie }
  });
  assert.equal(foundMatches.json.matches[0].isLostReporter, false);

  const storedMatch = testApp.testMatches.find((entry) => String(entry._id) === String(match._id));
  storedMatch.status = "confirmed";
  const confirmedMatches = await request(testApp, "/api/items/matches", {
    headers: { Cookie: lostReporter.cookie }
  });
  assert.equal(confirmedMatches.status, 200);
  assert.equal(confirmedMatches.json.totalMatches, 0);

  storedMatch.status = "pending";
  const storedLostItem = testApp.testItems.find((item) => String(item._id) === String(lost.json.itemId));
  const storedFoundItem = testApp.testItems.find((item) => String(item._id) === String(found.json.itemId));
  storedLostItem.status = "returned";
  storedFoundItem.status = "returned";
  const returnedMatches = await request(testApp, "/api/items/matches", {
    headers: { Cookie: lostReporter.cookie }
  });
  assert.equal(returnedMatches.status, 200);
  assert.equal(returnedMatches.json.totalMatches, 0);
  storedLostItem.status = "searching";
  storedFoundItem.status = "unclaimed";

  const flagged = await request(
    testApp,
    `/api/admin/items/${found.json.itemId}/moderate`,
    {
      method: "PATCH",
      ...jsonRequest({ moderationStatus: "flagged", reason: "Review pending." }, { Cookie: admin.cookie }, "PATCH")
    }
  );
  assert.equal(flagged.status, 200);

  const hiddenMatches = await request(testApp, "/api/items/matches", {
    headers: { Cookie: lostReporter.cookie }
  });
  assert.equal(hiddenMatches.json.totalMatches, 0);
  assert.equal(hiddenMatches.json.matches.length, 0);
});

test("unauthenticated report attempts are rejected", async () => {
  const testApp = buildTestApp();

  const response = await request(
    testApp,
    "/api/items",
    jsonRequest({
      itemName: "Water Bottle",
      category: "Bottle",
      color: "Blue",
      reportType: "lost",
      location: "Library",
      reportedBy: 101
    })
  );

  assert.equal(response.status, 401);
});

test("an authenticated user can report an item for their own student ID", async () => {
  const testApp = buildTestApp();

  const register = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 103,
      name: "Rohan Verma",
      email: "rohan@campus.edu",
      password: "password123"
    })
  );

  const response = await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "Notebook",
        category: "Documents",
        color: "Red",
        reportType: "lost",
        location: "Lecture Hall A",
        reportedBy: 103,
        identifyingMarks: "Has sticker on front cover" // private verification detail
      },
      { Cookie: register.cookie }
    )
  );

  assert.equal(response.status, 201);
  assert.equal(typeof response.json.itemId, "string");
});

test("profile returns only the authenticated user's reports and updates profile fields", async () => {
  const testApp = buildTestApp();

  const firstUser = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 104,
      name: "Kavya Iyer",
      email: "kavya@campus.edu",
      password: "password123"
    })
  );

  const secondUser = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 105,
      name: "Ananya Rao",
      email: "ananya@campus.edu",
      password: "password123"
    })
  );

  await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "Umbrella",
        category: "Accessories",
        color: "Black",
        reportType: "lost",
        location: "Cafeteria",
        reportedBy: 104
      },
      { Cookie: firstUser.cookie }
    )
  );

  await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "Headphones",
        category: "Electronics",
        color: "White",
        reportType: "lost",
        location: "Gym",
        reportedBy: 105
      },
      { Cookie: secondUser.cookie }
    )
  );

  const profileResponse = await request(testApp, "/api/profile", {
    headers: { Cookie: firstUser.cookie }
  });

  assert.equal(profileResponse.status, 200);
  assert.equal(profileResponse.json.reports.length, 1);
  assert.equal(profileResponse.json.reports[0].itemName, "Umbrella");

  const updateResponse = await request(testApp, "/api/profile", {
    method: "PATCH",
    ...jsonRequest(
      { name: "Kavya S. Iyer", email: "kavya.updated@campus.edu" },
      { Cookie: firstUser.cookie },
      "PATCH"
    )
  });

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.json.user.name, "Kavya S. Iyer");
  assert.equal(updateResponse.json.user.email, "kavya.updated@campus.edu");
});

test("profile API rejects demo identity headers without a real session", async () => {
  const testApp = buildTestApp();

  const response = await request(testApp, "/api/profile", {
    headers: { "x-demo-user-id": "101" }
  });

  assert.equal(response.status, 401);
});

test("public item search paginates results without exposing reporter IDs or private verification info", async () => {
  const testApp = buildTestApp();

  const user = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 106,
      name: "Dev Singh",
      email: "dev@campus.edu",
      password: "password123"
    })
  );

  await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "Calculator",
        category: "Electronics",
        color: "Silver",
        reportType: "lost",
        location: "Library Room 204",
        reportedBy: 106,
        identifyingMarks: "Serial #CALC-99432",
        verificationQuestion: "What is written on the back cover?"
      },
      { Cookie: user.cookie }
    )
  );

  const publicResponse = await request(testApp, "/api/items/search?q=calc&category=Electronics");

  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.json.total, 1);
  assert.equal(publicResponse.json.items[0].itemName, "Calculator");
  // Privacy verification (Requirement 5):
  assert.equal(publicResponse.json.items[0].reportedBy, undefined);
  assert.equal(publicResponse.json.items[0].identifyingMarks, undefined);
  assert.equal(publicResponse.json.items[0].serialNumber, undefined);
  assert.equal(publicResponse.json.items[0].verificationQuestion, undefined);
  assert.equal(publicResponse.json.items[0].hasVerificationDetails, true);
});

test("active item APIs exclude returned reports while profile history and admin access preserve them", async () => {
  const testApp = buildTestApp();
  const reporter = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 1501,
    name: "Report History Owner",
    email: "report-history-owner@campus.edu",
    password: "password123"
  }));
  const claimant = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 1502,
    name: "Report History Claimant",
    email: "report-history-claimant@campus.edu",
    password: "password123"
  }));
  const admin = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 1503,
    name: "Report History Admin",
    email: "report-history-admin@campus.edu",
    password: "password123"
  }));
  testApp.elevateAdmin(1503);

  const reportSpecs = [
    { itemName: "Active Lost Notebook", reportType: "lost", color: "Blue" },
    { itemName: "Returned Lost Notebook", reportType: "lost", color: "Red", returned: true },
    { itemName: "Active Found Umbrella", reportType: "found", color: "Green" },
    { itemName: "Returned Found Umbrella", reportType: "found", color: "Black", returned: true }
  ];
  const createdReports = [];
  for (const spec of reportSpecs) {
    const response = await request(testApp, "/api/items", jsonRequest({
      itemName: spec.itemName,
      category: "Accessories",
      color: spec.color,
      reportType: spec.reportType,
      location: "Student Center"
    }, { Cookie: reporter.cookie }));
    assert.equal(response.status, 201);
    createdReports.push({ ...spec, itemId: response.json.itemId });
  }
  for (const report of createdReports.filter((entry) => entry.returned)) {
    const item = testApp.testItems.find((entry) => String(entry._id) === String(report.itemId));
    item.status = "returned";
    item.updatedAt = new Date("2026-11-20T12:00:00.000Z");
  }

  for (const reportType of ["lost", "found"]) {
    const response = await request(testApp, `/api/items/search?reportType=${reportType}`);
    assert.equal(response.status, 200);
    assert.equal(response.json.total, 1);
    assert.equal(response.json.items[0].reportType, reportType);
    assert.notEqual(response.json.items[0].status, "returned");
  }
  const publicItemsAlias = await request(testApp, "/api/items?reportType=found");
  assert.equal(publicItemsAlias.status, 200);
  assert.equal(publicItemsAlias.json.total, 1);
  assert.notEqual(publicItemsAlias.json.items[0].status, "returned");

  const firstPage = await request(testApp, "/api/items/search?page=1&pageSize=1");
  const secondPage = await request(testApp, "/api/items/search?page=2&pageSize=1");
  assert.equal(firstPage.json.total, 2);
  assert.equal(firstPage.json.totalPages, 2);
  assert.equal(secondPage.json.total, 2);
  assert.equal(secondPage.json.totalPages, 2);
  assert.notEqual(firstPage.json.items[0].status, "returned");
  assert.notEqual(secondPage.json.items[0].status, "returned");

  const profile = await request(testApp, "/api/profile", {
    headers: { Cookie: reporter.cookie }
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.json.reports.length, 4);
  assert.equal(profile.json.reports.filter((item) => item.status === "returned").length, 2);

  const returnedFound = createdReports.find((entry) => entry.reportType === "found" && entry.returned);
  const claimResponse = await request(testApp, "/api/claims", jsonRequest({
    itemId: returnedFound.itemId,
    additionalDetails: "This was my umbrella."
  }, { Cookie: claimant.cookie }));
  assert.equal(claimResponse.status, 400);
  assert.match(claimResponse.json.message, /already been marked as returned/i);
  const claimDetails = await request(testApp, `/api/claims/item/${returnedFound.itemId}`);
  assert.equal(claimDetails.status, 404);

  const adminReturned = await request(testApp, "/api/admin/items?status=returned", {
    headers: { Cookie: admin.cookie }
  });
  assert.equal(adminReturned.status, 200);
  assert.equal(adminReturned.json.total, 2);
  assert.equal(adminReturned.json.items.filter((item) => item.status === "returned").length, 2);
});

test("logout revokes the existing session cookie", async () => {
  const testApp = buildTestApp();

  const user = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 107,
      name: "Siddharth Sen",
      email: "siddharth@campus.edu",
      password: "password123"
    })
  );

  const logoutResponse = await request(testApp, "/api/auth/logout", {
    method: "POST",
    headers: { Cookie: user.cookie }
  });

  assert.equal(logoutResponse.status, 200);
  assert.match(logoutResponse.cookie || "", /^campusfind_token=/);

  const profileAfterLogout = await request(testApp, "/api/profile", {
    headers: { Cookie: user.cookie }
  });

  assert.equal(profileAfterLogout.status, 401);
});

test("matching engine uses tokenized keywords and fuzzy similarity for flexible matches", async () => {
  const testApp = buildTestApp();

  const userA = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 201,
      name: "Student A",
      email: "studentA@campus.edu",
      password: "password123"
    })
  );

  const userB = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 202,
      name: "Student B",
      email: "studentB@campus.edu",
      password: "password123"
    })
  );

  // Lost report: "iPhone 13" in Blue
  await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "iPhone 13",
        category: "Electronics",
        color: "Blue",
        reportType: "lost",
        location: "Main Library",
        reportedBy: 201
      },
      { Cookie: userA.cookie }
    )
  );

  // Found report: "iPhone 13 Pro (Blue)" in Navy Blue (Flexible match!)
  const foundResponse = await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "iPhone 13 Pro (Blue)",
        category: "Electronics",
        color: "Navy Blue",
        reportType: "found",
        location: "Library 2nd Floor",
        reportedBy: 202
      },
      { Cookie: userB.cookie }
    )
  );

  assert.equal(foundResponse.status, 201);
  assert.equal(foundResponse.json.matchesCreated, 1);

  const matchesResponse = await request(testApp, "/api/items/matches", {
    headers: { Cookie: userA.cookie }
  });

  assert.equal(matchesResponse.status, 200);
  assert.equal(matchesResponse.json.totalMatches, 1);
  assert.ok(matchesResponse.json.matches[0].matchScore >= 60);
  // Audit history check (Requirement 6)
  assert.ok(Array.isArray(matchesResponse.json.matches[0].claimHistory));
  assert.equal(matchesResponse.json.matches[0].claimHistory[0].action, "match_created");
});

test("concurrent match confirmations allow exactly one successful resolution", async () => {
  const testApp = buildTestApp();

  const lostReporter = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 205,
    name: "Concurrent Lost Owner",
    email: "concurrent-lost@campus.edu",
    password: "password123"
  }));
  const foundReporter = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 206,
    name: "Concurrent Finder",
    email: "concurrent-found@campus.edu",
    password: "password123"
  }));

  await request(testApp, "/api/items", jsonRequest({
    itemName: "Concurrent Blue Phone",
    category: "Electronics",
    color: "Blue",
    reportType: "lost",
    location: "Library",
    reportedBy: 205
  }, { Cookie: lostReporter.cookie }));

  await request(testApp, "/api/items", jsonRequest({
    itemName: "Concurrent Blue Phone",
    category: "Electronics",
    color: "Blue",
    reportType: "found",
    location: "Library",
    reportedBy: 206
  }, { Cookie: foundReporter.cookie }));

  const matchesResponse = await request(testApp, "/api/items/matches", {
    headers: { Cookie: lostReporter.cookie }
  });
  assert.equal(matchesResponse.status, 200);
  assert.equal(matchesResponse.json.matches.length, 1);
  const matchId = matchesResponse.json.matches[0]._id;

  const confirmations = await Promise.all([
    request(testApp, `/api/items/matches/${matchId}/confirm`, {
      method: "PATCH",
      ...jsonRequest({ userId: 205 }, { Cookie: lostReporter.cookie }, "PATCH")
    }),
    request(testApp, `/api/items/matches/${matchId}/confirm`, {
      method: "PATCH",
      ...jsonRequest({ userId: 205 }, { Cookie: lostReporter.cookie }, "PATCH")
    })
  ]);

  assert.deepEqual(confirmations.map((response) => response.status).sort(), [200, 409]);

  const finalMatch = testApp.testMatches?.find?.((match) => String(match._id) === String(matchId));
  if (finalMatch) assert.equal(finalMatch.status, "confirmed");
  assert.equal(testApp.testItems.filter((item) =>
    item.itemName === "Concurrent Blue Phone"
  ).every((item) => item.status === "returned"), true);
  assert.equal(finalMatch.claimHistory.filter((entry) => entry.action === "confirmed").length, 1);
});

test("match confirmation resumes after the lost report updates but the found report update fails", async () => {
  const testApp = buildTestApp();
  const scenario = await createMatchConfirmationScenario(testApp);
  testApp.failNextItemUpdate(scenario.foundReportId);

  const firstAttempt = await request(
    testApp,
    `/api/items/matches/${scenario.match._id}/confirm`,
    { method: "PATCH", headers: { Cookie: scenario.lostReporter.cookie } }
  );
  assert.equal(firstAttempt.status, 409);
  assert.equal(testApp.testItems.find((item) => item._id === scenario.lostReportId).status, "returned");
  assert.equal(testApp.testItems.find((item) => item._id === scenario.foundReportId).status, "unclaimed");
  assert.equal(scenario.match.status, "confirming");

  const retry = await request(
    testApp,
    `/api/items/matches/${scenario.match._id}/confirm`,
    { method: "PATCH", headers: { Cookie: scenario.lostReporter.cookie } }
  );
  assert.equal(retry.status, 200);
  assert.equal(scenario.match.status, "confirmed");
  assert.equal(testApp.testItems.find((item) => item._id === scenario.lostReportId).status, "returned");
  assert.equal(testApp.testItems.find((item) => item._id === scenario.foundReportId).status, "returned");
  assert.equal(scenario.match.claimHistory.filter((entry) => entry.action === "confirmed").length, 1);
  assert.equal(scenario.match.claimHistory.filter((entry) => entry.action === "claim_initiated").length, 1);
});

test("match confirmation preserves a completed handover claim while recovering the other report", async () => {
  const testApp = buildTestApp();
  const scenario = await createMatchConfirmationScenario(testApp, 8811, 8812);
  const handoverDate = new Date("2025-01-02T03:04:05.000Z");
  const completedClaim = {
    _id: "claim-completed-handover",
    itemId: scenario.foundReportId,
    claimantId: 8811,
    status: "returned",
    handoverDate,
    handoverConfirmedBy: 8811
  };
  testApp.testClaims.push(completedClaim);
  Object.assign(testApp.testItems.find((item) => item._id === scenario.foundReportId), {
    status: "returned",
    approvedClaimId: completedClaim._id
  });
  testApp.failNextItemUpdate(scenario.lostReportId);

  const failedAttempt = await request(
    testApp,
    `/api/items/matches/${scenario.match._id}/confirm`,
    { method: "PATCH", headers: { Cookie: scenario.lostReporter.cookie } }
  );
  assert.equal(failedAttempt.status, 409);
  assert.equal(scenario.match.status, "confirming");

  const retry = await request(
    testApp,
    `/api/items/matches/${scenario.match._id}/confirm`,
    { method: "PATCH", headers: { Cookie: scenario.lostReporter.cookie } }
  );
  assert.equal(retry.status, 200);
  assert.equal(scenario.match.status, "confirmed");
  assert.equal(testApp.testItems.find((item) => item._id === scenario.lostReportId).status, "returned");
  assert.deepEqual(completedClaim, {
    _id: "claim-completed-handover",
    itemId: scenario.foundReportId,
    claimantId: 8811,
    status: "returned",
    handoverDate,
    handoverConfirmedBy: 8811
  });
  assert.equal(scenario.match.claimHistory.filter((entry) => entry.action === "confirmed").length, 1);
});

test("match confirmation resumes when the found report was resolved before the lost report update failed", async () => {
  const testApp = buildTestApp();
  const scenario = await createMatchConfirmationScenario(testApp, 8815, 8816);
  Object.assign(testApp.testItems.find((item) => item._id === scenario.foundReportId), {
    status: "returned",
    approvedMatchId: scenario.match._id
  });
  testApp.failNextItemUpdate(scenario.lostReportId);

  const firstAttempt = await request(
    testApp,
    `/api/items/matches/${scenario.match._id}/confirm`,
    { method: "PATCH", headers: { Cookie: scenario.lostReporter.cookie } }
  );
  assert.equal(firstAttempt.status, 409);

  const retry = await request(
    testApp,
    `/api/items/matches/${scenario.match._id}/confirm`,
    { method: "PATCH", headers: { Cookie: scenario.lostReporter.cookie } }
  );
  assert.equal(retry.status, 200);
  assert.equal(scenario.match.status, "confirmed");
  assert.equal(testApp.testItems.find((item) => item._id === scenario.lostReportId).status, "returned");
  assert.equal(testApp.testItems.find((item) => item._id === scenario.foundReportId).approvedMatchId, scenario.match._id);
  assert.equal(scenario.match.claimHistory.filter((entry) => entry.action === "confirmed").length, 1);
});

test("confirmation retry completes when both linked reports were already resolved by this match", async () => {
  const testApp = buildTestApp();
  const scenario = await createMatchConfirmationScenario(testApp, 8821, 8822);
  for (const itemId of [scenario.lostReportId, scenario.foundReportId]) {
    Object.assign(testApp.testItems.find((item) => item._id === itemId), {
      status: "returned",
      approvedMatchId: scenario.match._id
    });
  }

  const response = await request(
    testApp,
    `/api/items/matches/${scenario.match._id}/confirm`,
    { method: "PATCH", headers: { Cookie: scenario.lostReporter.cookie } }
  );
  assert.equal(response.status, 200);
  assert.equal(scenario.match.status, "confirmed");
  assert.equal(scenario.match.claimHistory.filter((entry) => entry.action === "confirmed").length, 1);
});

test("match confirmation safely rejects missing or invalid linked reports and unauthorized users", async () => {
  for (const missingReportType of ["lost", "found"]) {
    const testApp = buildTestApp();
    const scenario = await createMatchConfirmationScenario(
      testApp,
      missingReportType === "lost" ? 8831 : 8841,
      missingReportType === "lost" ? 8832 : 8842
    );
    const missingId = missingReportType === "lost" ? scenario.lostReportId : scenario.foundReportId;
    testApp.testItems.splice(testApp.testItems.findIndex((item) => item._id === missingId), 1);

    const response = await request(
      testApp,
      `/api/items/matches/${scenario.match._id}/confirm`,
      { method: "PATCH", headers: { Cookie: scenario.lostReporter.cookie } }
    );
    assert.equal(response.status, 409);
    assert.equal(scenario.match.status, "confirming");
  }

  const invalidApp = buildTestApp();
  const invalidScenario = await createMatchConfirmationScenario(invalidApp, 8851, 8852);
  invalidScenario.match.lostItemId = "not-a-valid-item-id";
  const invalidResponse = await request(
    invalidApp,
    `/api/items/matches/${invalidScenario.match._id}/confirm`,
    { method: "PATCH", headers: { Cookie: invalidScenario.lostReporter.cookie } }
  );
  assert.equal(invalidResponse.status, 409);
  assert.equal(invalidScenario.match.status, "confirming");

  const unauthorizedApp = buildTestApp();
  const unauthorizedScenario = await createMatchConfirmationScenario(unauthorizedApp, 8861, 8862);
  const unauthorizedResponse = await request(
    unauthorizedApp,
    `/api/items/matches/${unauthorizedScenario.match._id}/confirm`,
    { method: "PATCH", headers: { Cookie: unauthorizedScenario.foundReporter.cookie } }
  );
  assert.equal(unauthorizedResponse.status, 403);
  assert.equal(unauthorizedScenario.match.status, "pending");
});

test("duplicate matches are prevented atomically", async () => {
  const testApp = buildTestApp();

  const user = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 203,
      name: "Student Duplicate Test",
      email: "duplicate@campus.edu",
      password: "password123"
    })
  );

  const user2 = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 204,
      name: "Student Finder",
      email: "finder@campus.edu",
      password: "password123"
    })
  );

  await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "Blue Hydroflask 32oz",
        category: "Bottle",
        color: "Blue",
        reportType: "lost",
        location: "Science Quad",
        reportedBy: 203
      },
      { Cookie: user.cookie }
    )
  );

  const reportFound = await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "Hydroflask Blue",
        category: "Bottle",
        color: "Blue",
        reportType: "found",
        location: "Science Quad Lawn",
        reportedBy: 204
      },
      { Cookie: user2.cookie }
    )
  );

  assert.equal(reportFound.json.matchesCreated, 1);

  const matchCheck = await request(testApp, "/api/items/matches", {
    headers: { Cookie: user.cookie }
  });

  assert.equal(matchCheck.json.totalMatches, 1);
});

test("ownership verification submission, dispute, and admin verification workflow", async () => {
  const testApp = buildTestApp();

  const owner = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 301,
      name: "Owner Student",
      email: "owner@campus.edu",
      password: "password123"
    })
  );

  const finder = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 302,
      name: "Finder Student",
      email: "finder302@campus.edu",
      password: "password123"
    })
  );

  const admin = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 999,
      name: "Campus Security Admin",
      email: "admin@campus.edu",
      password: "password123"
    })
  );

  // Manually elevate admin user role in in-memory test database
  const profileAdmin = await request(testApp, "/api/profile", { headers: { Cookie: admin.cookie } });
  profileAdmin.json.user.role = "admin";

  await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "MacBook Pro M2",
        category: "Electronics",
        color: "Space Gray",
        reportType: "lost",
        location: "Computer Lab",
        reportedBy: 301
      },
      { Cookie: owner.cookie }
    )
  );

  await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "Apple MacBook Pro",
        category: "Electronics",
        color: "Gray",
        reportType: "found",
        location: "Computer Lab Desk 12",
        reportedBy: 302
      },
      { Cookie: finder.cookie }
    )
  );

  const matchesRes = await request(testApp, "/api/items/matches", {
    headers: { Cookie: owner.cookie }
  });

  assert.equal(matchesRes.json.totalMatches, 1);
  const matchId = matchesRes.json.matches[0]._id;

  // 1. Submit verification proof (Requirement 6)
  const verifyRes = await request(
    testApp,
    `/api/items/matches/${matchId}/verify`,
    jsonRequest({ proofDetails: "Wallpaper is a NASA James Webb telescope photo." }, { Cookie: owner.cookie })
  );
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.json.claimStatus, "confirming");

  // 2. Dispute claim (Requirement 6 & 7)
  const disputeRes = await request(
    testApp,
    `/api/items/matches/${matchId}/dispute`,
    jsonRequest({ reason: "Finder states the wallpaper doesn't match." }, { Cookie: finder.cookie })
  );
  assert.equal(disputeRes.status, 200);
  assert.equal(disputeRes.json.status, "disputed");

  // 3. Non-admin cannot access admin disputed queue
  const unauthorizedAdminAccess = await request(testApp, "/api/admin/matches/disputed", {
    headers: { Cookie: owner.cookie }
  });
  assert.equal(unauthorizedAdminAccess.status, 403);
});

test("reporting as a different student is forbidden", async () => {
  const testApp = buildTestApp();

  const user = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 108,
      name: "Tanya Sen",
      email: "tanya@campus.edu",
      password: "password123"
    })
  );

  const response = await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "Keys",
        category: "Other",
        color: "Silver",
        reportType: "lost",
        location: "Campus Gate",
        reportedBy: 999
      },
      { Cookie: user.cookie }
    )
  );

  assert.equal(response.status, 403);
});

test("direct image upload endpoint validates files and returns storage URLs", async () => {
  const testApp = buildTestApp();

  const user = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 401,
      name: "Photo Student",
      email: "photo@campus.edu",
      password: "password123"
    })
  );

  // Upload valid image with genuine JPEG magic bytes
  const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xff, 0xd9]);
  const uploadRes = await supertest(testApp)
    .post("/api/upload")
    .set("Cookie", user.cookie)
    .attach("images", validJpeg, "photo.jpg");

  assert.equal(uploadRes.status, 200);
  assert.ok(Array.isArray(uploadRes.body.urls));
  assert.equal(uploadRes.body.urls.length, 1);
  assert.ok(uploadRes.body.urls[0].includes("photo") || uploadRes.body.urls[0].includes("/uploads/"));
});

test("admin stats API computes counts across reports, matches, and disputes", async () => {
  const testApp = buildTestApp();

  const admin = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 888,
      name: "Campus Security Desk",
      email: "security@campus.edu",
      password: "password123",
      role: "admin"
    })
  );
  testApp.elevateAdmin(888);

  const statsRes = await request(testApp, "/api/admin/stats", {
    headers: { Cookie: admin.cookie }
  });

  assert.equal(statsRes.status, 200);
  assert.equal(typeof statsRes.json.totalItems, "number");
  assert.equal(typeof statsRes.json.totalMatches, "number");
  assert.equal(typeof statsRes.json.activeDisputes, "number");
});

test("complete end-to-end multi-user workflow with two students and one admin", async () => {
  const testApp = buildTestApp();

  // 1. Create Student 1 (Loser), Student 2 (Finder), and Campus Admin
  const student1 = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 501,
      name: "Amit Kumar",
      email: "amit@campus.edu",
      password: "password123"
    })
  );

  const student2 = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 502,
      name: "Pooja Hegde",
      email: "pooja@campus.edu",
      password: "password123"
    })
  );

  const admin = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 777,
      name: "Officer Vikram",
      email: "vikram.admin@campus.edu",
      password: "password123",
      role: "admin"
    })
  );
  testApp.elevateAdmin(777);

  // 2. Student 1 reports lost Dell XPS Laptop with photo and private serial number
  const lostRes = await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "Dell XPS 15 Laptop",
        category: "Electronics",
        color: "Silver",
        reportType: "lost",
        location: "Library Study Room 3",
        reportedBy: 501,
        publicImages: ["https://res.cloudinary.com/demo/image/upload/sample.jpg"],
        identifyingMarks: "Sticker of Python Software Foundation on top cover",
        serialNumber: "DELL-SN-8849204"
      },
      { Cookie: student1.cookie }
    )
  );
  assert.equal(lostRes.status, 201);

  // 3. Verify public search DOES NOT leak private serial number or identifying marks
  const publicCheck = await request(testApp, "/api/items/search?q=Dell");
  assert.equal(publicCheck.status, 200);
  assert.equal(publicCheck.json.total, 1);
  assert.equal(publicCheck.json.items[0].serialNumber, undefined);
  assert.equal(publicCheck.json.items[0].identifyingMarks, undefined);
  assert.equal(publicCheck.json.items[0].hasVerificationDetails, true);

  // 4. Student 2 reports found Silver Laptop in Library
  const foundRes = await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "Silver Dell XPS Laptop",
        category: "Electronics",
        color: "Silver",
        reportType: "found",
        location: "Library 1st Floor Desk",
        reportedBy: 502,
        publicImages: ["https://res.cloudinary.com/demo/image/upload/sample2.jpg"]
      },
      { Cookie: student2.cookie }
    )
  );
  assert.equal(foundRes.status, 201);
  assert.equal(foundRes.json.matchesCreated, 1);

  // 5. Check match created with audit trail
  const matchesRes = await request(testApp, "/api/items/matches", {
    headers: { Cookie: student1.cookie }
  });
  assert.equal(matchesRes.status, 200);
  assert.equal(matchesRes.json.totalMatches, 1);
  const match = matchesRes.json.matches[0];
  assert.ok(match.matchScore >= 70);

  // 6. Student 1 initiates verification proof
  const verifyRes = await request(
    testApp,
    `/api/items/matches/${match._id}/verify`,
    jsonRequest(
      { proofDetails: "I can enter the BIOS password and show matching invoice for DELL-SN-8849204." },
      { Cookie: student1.cookie }
    )
  );
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.json.claimStatus, "confirming");

  // 7. Student 2 flags a dispute ("Another person also claimed this laptop")
  const disputeRes = await request(
    testApp,
    `/api/items/matches/${match._id}/dispute`,
    jsonRequest(
      { reason: "Another claimant also reported a lost Dell laptop. Handed item over to Security Desk for review." },
      { Cookie: student2.cookie }
    )
  );
  assert.equal(disputeRes.status, 200);
  assert.equal(disputeRes.json.status, "disputed");

  // 8. Admin reviews disputed queue
  const adminQueueRes = await request(testApp, "/api/admin/matches/disputed", {
    headers: { Cookie: admin.cookie }
  });
  assert.equal(adminQueueRes.status, 200);
  assert.equal(adminQueueRes.json.count, 1);
  assert.equal(adminQueueRes.json.disputes[0]._id, match._id);

  // 9. Admin resolves dispute, marks handover location, approves claim
  const resolveRes = await request(
    testApp,
    `/api/admin/matches/${match._id}/resolve`,
    {
      method: "PATCH",
      ...jsonRequest(
        {
          decision: "approve",
          resolutionNotes: "Amit presented invoice matching serial number DELL-SN-8849204.",
          handoverLocation: "Campus Security Central Desk"
        },
        { Cookie: admin.cookie },
        "PATCH"
      )
    }
  );
  assert.equal(resolveRes.status, 200);
  assert.equal(resolveRes.json.message, "Claim approved and item marked as returned.");

  // 10. Verify item status has transitioned to 'returned'
  const finalPublicCheck = await request(testApp, "/api/items/search?q=Dell");
  assert.equal(finalPublicCheck.json.total, 0);
  assert.equal(finalPublicCheck.json.items.length, 0);
});

test("account status enforcement blocks suspended and deactivated users", async () => {
  const testApp = buildTestApp();

  const user = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 701,
      name: "Rahul Verma",
      email: "rahul@campus.edu",
      password: "password123"
    })
  );

  const admin = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 999,
      name: "Super Admin",
      email: "admin@campus.edu",
      password: "password123",
      role: "admin"
    })
  );
  testApp.elevateAdmin(999);

  // Admin suspends user
  const suspendRes = await request(
    testApp,
    "/api/admin/users/701/status",
    {
      method: "PATCH",
      ...jsonRequest(
        { status: "suspended", reason: "Multiple suspicious claim reports." },
        { Cookie: admin.cookie },
        "PATCH"
      )
    }
  );
  assert.equal(suspendRes.status, 200);
  assert.equal(suspendRes.json.accountStatus, "suspended");

  // Attempting to report item while suspended must return 403
  const reportRes = await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "Keys",
        category: "Other",
        color: "Silver",
        reportType: "lost",
        location: "Gate",
        reportedBy: 701
      },
      { Cookie: user.cookie }
    )
  );
  assert.equal(reportRes.status, 403);
  assert.ok(reportRes.json.message.includes("suspended"));

  // Logging in while suspended must return 403
  const loginRes = await request(
    testApp,
    "/api/auth/login",
    jsonRequest({
      studentId: 701,
      password: "password123"
    })
  );
  assert.equal(loginRes.status, 403);
  assert.ok(loginRes.json.message.includes("suspended"));

  // Admin reactivates account
  const reactivateRes = await request(
    testApp,
    "/api/admin/users/701/status",
    {
      method: "PATCH",
      ...jsonRequest(
        { status: "active", reason: "Investigation cleared user." },
        { Cookie: admin.cookie },
        "PATCH"
      )
    }
  );
  assert.equal(reactivateRes.status, 200);

  // User can now log in again
  const newLoginRes = await request(
    testApp,
    "/api/auth/login",
    jsonRequest({
      studentId: 701,
      password: "password123"
    })
  );
  assert.equal(newLoginRes.status, 200);
});

test("claim reporter comparison handles student IDs, ObjectIds, missing IDs, and authentication", async () => {
  const testApp = buildTestApp();
  const reporter = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 590,
    name: "Reporter",
    email: "reporter-590@campus.edu",
    password: "password123"
  }));
  const otherStudent = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 591,
    name: "Other Student",
    email: "other-591@campus.edu",
    password: "password123"
  }));

  const reporterUser = testApp.testUsers.find((user) => user.studentId === 590);
  reporterUser._id = new mongoose.Types.ObjectId();
  const reporterToken = jwt.sign(
    {
      userId: reporterUser._id.toString(),
      studentId: reporterUser.studentId,
      role: "student",
      sessionVersion: reporterUser.sessionVersion || 0
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d", issuer: "campusfind", audience: "campusfind-web" }
  );
  const reporterCookie = `campusfind_token=${reporterToken}`;

  const report = await request(testApp, "/api/items", jsonRequest({
    itemName: "Reporter Ownership Test",
    category: "Electronics",
    color: "Black",
    reportType: "found",
    location: "Library"
  }, { Cookie: reporterCookie }));
  assert.equal(report.status, 201);

  const unauthenticated = await request(testApp, "/api/claims", jsonRequest({
    itemId: report.json.itemId
  }));
  assert.equal(unauthenticated.status, 401);

  const item = testApp.testItems.find((entry) => String(entry._id) === String(report.json.itemId));
  item.reportedBy = reporterUser._id;
  const objectIdSelfClaim = await request(testApp, "/api/claims", jsonRequest({
    itemId: report.json.itemId
  }, { Cookie: reporterCookie }));
  assert.equal(objectIdSelfClaim.status, 400);

  item.reportedBy = String(reporterUser.studentId);
  const numericStringSelfClaim = await request(testApp, "/api/claims", jsonRequest({
    itemId: report.json.itemId
  }, { Cookie: reporterCookie }));
  assert.equal(numericStringSelfClaim.status, 400);

  item.reportedBy = undefined;
  const missingReporter = await request(testApp, "/api/claims", jsonRequest({
    itemId: report.json.itemId
  }, { Cookie: otherStudent.cookie }));
  assert.equal(missingReporter.status, 409);

  item.reportedBy = "invalid-reporter-id";
  const invalidReporter = await request(testApp, "/api/claims", jsonRequest({
    itemId: report.json.itemId
  }, { Cookie: otherStudent.cookie }));
  assert.equal(invalidReporter.status, 409);

  item.reportedBy = reporterUser.studentId;
  const otherStudentClaim = await request(testApp, "/api/claims", jsonRequest({
    itemId: report.json.itemId,
    verificationAnswers: "I can describe the item."
  }, { Cookie: otherStudent.cookie }));
  assert.equal(otherStudentClaim.status, 201);
});

test("exact regression: self-claim detection between Student A (12306500) and Student B (12305160)", async () => {
  const testApp = buildTestApp();

  // Register Student A (12306500)
  const studentAReg = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 12306500,
    name: "Student A",
    email: "studentA-12306500@campus.edu",
    password: "password123"
  }));
  assert.equal(studentAReg.status, 201);

  // Register Student B (12305160)
  const studentBReg = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 12305160,
    name: "Student B",
    email: "studentB-12305160@campus.edu",
    password: "password123"
  }));
  assert.equal(studentBReg.status, 201);

  // 1. Student A creates a LOST report
  const lostReportRes = await request(testApp, "/api/items", jsonRequest({
    itemName: "Black water bottle",
    category: "Bottle",
    color: "Black",
    reportType: "lost",
    location: "Library"
  }, { Cookie: studentAReg.cookie }));
  assert.equal(lostReportRes.status, 201);
  const lostItemId = lostReportRes.json.itemId;

  // 2. Student B creates a FOUND report
  const foundReportRes = await request(testApp, "/api/items", jsonRequest({
    itemName: "Black water bottle",
    category: "Bottle",
    color: "Black",
    reportType: "found",
    location: "Library"
  }, { Cookie: studentBReg.cookie }));
  assert.equal(foundReportRes.status, 201);
  const foundItemId = foundReportRes.json.itemId;

  // Verify actual database records
  const dbLostItem = testApp.testItems.find((item) => String(item._id) === String(lostItemId));
  const dbFoundItem = testApp.testItems.find((item) => String(item._id) === String(foundItemId));
  assert.ok(dbLostItem, "Lost item must exist in database");
  assert.ok(dbFoundItem, "Found item must exist in database");
  assert.equal(dbLostItem.reportedBy, 12306500);
  assert.equal(typeof dbLostItem.reportedBy, "number");
  assert.equal(dbFoundItem.reportedBy, 12305160);
  assert.equal(typeof dbFoundItem.reportedBy, "number");

  // 3. Student A claims Student B's FOUND report — MUST SUCCEED
  const claimRes1 = await request(testApp, "/api/claims", jsonRequest({
    itemId: foundItemId,
    verificationAnswers: "Lost near reading desk on second floor"
  }, { Cookie: studentAReg.cookie }));
  assert.equal(claimRes1.status, 201);
  assert.equal(claimRes1.json.claim.claimantId, 12306500);
  assert.equal(String(claimRes1.json.claim.itemId), String(foundItemId));

  // 4. Student B claims their own FOUND report — MUST BE REJECTED
  const claimRes2 = await request(testApp, "/api/claims", jsonRequest({
    itemId: foundItemId,
    verificationAnswers: "Self claim attempt"
  }, { Cookie: studentBReg.cookie }));
  assert.equal(claimRes2.status, 400);
  assert.equal(claimRes2.json.message, "You cannot submit an ownership claim for an item you reported yourself.");

  // 5. An unauthenticated user tries to claim — MUST BE REJECTED
  const claimRes3 = await request(testApp, "/api/claims", jsonRequest({
    itemId: foundItemId,
    verificationAnswers: "Unauth attempt"
  }));
  assert.equal(claimRes3.status, 401);
  assert.equal(claimRes3.json.message, "Authentication required.");

  // 6. Student A claims a FOUND report created by Student A — MUST BE REJECTED
  const foundByARes = await request(testApp, "/api/items", jsonRequest({
    itemName: "Blue water bottle",
    category: "Bottle",
    color: "Blue",
    reportType: "found",
    location: "Cafeteria"
  }, { Cookie: studentAReg.cookie }));
  assert.equal(foundByARes.status, 201);
  const foundByAId = foundByARes.json.itemId;

  const dbFoundByA = testApp.testItems.find((item) => String(item._id) === String(foundByAId));
  assert.equal(dbFoundByA.reportedBy, 12306500);

  const claimRes4 = await request(testApp, "/api/claims", jsonRequest({
    itemId: foundByAId,
    verificationAnswers: "Self claim on found bottle"
  }, { Cookie: studentAReg.cookie }));
  assert.equal(claimRes4.status, 400);
  assert.equal(claimRes4.json.message, "You cannot submit an ownership claim for an item you reported yourself.");

  // Extra check: Attempting to claim a LOST report is rejected
  const claimLostRes = await request(testApp, "/api/claims", jsonRequest({
    itemId: lostItemId,
    verificationAnswers: "Cannot claim lost report"
  }, { Cookie: studentAReg.cookie }));
  assert.equal(claimLostRes.status, 400);
  assert.equal(claimLostRes.json.message, "Ownership claims can only be submitted for found items.");
});

test("claim verification system: submission, duplicate prevention, and admin arbitration", async () => {
  const testApp = buildTestApp();

  const finder = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 601,
      name: "Sneha Patel",
      email: "sneha@campus.edu",
      password: "password123"
    })
  );

  const claimant = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 602,
      name: "Vikas Reddy",
      email: "vikas@campus.edu",
      password: "password123"
    })
  );

  const admin = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 998,
      name: "Admin Officer",
      email: "officer@campus.edu",
      password: "password123",
      role: "admin"
    })
  );
  testApp.elevateAdmin(998);

  // 1. Finder reports found wallet with private verification question
  const reportRes = await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "Brown Leather Wallet",
        category: "Accessories",
        color: "Brown",
        reportType: "found",
        location: "Cafeteria Table 4",
        reportedBy: 601,
        verificationQuestion: "What card is visible inside the front slot?",
        identifyingMarks: "Initials VR embossed on inner pocket"
      },
      { Cookie: finder.cookie }
    )
  );
  assert.equal(reportRes.status, 201);
  const itemId = reportRes.json.itemId;

  // 2. Claimant inspects item verification questions (private marks must NOT be exposed)
  const questionRes = await request(testApp, `/api/claims/item/${itemId}`);
  assert.equal(questionRes.status, 200);
  assert.equal(questionRes.json.hasVerificationQuestions, true);
  assert.equal(questionRes.json.item.identifyingMarks, undefined); // Protected!

  // 3. Claimant cannot claim their own reported item (test negative case)
  const reportedItem = testApp.testItems.find((item) => String(item._id) === String(itemId));
  reportedItem.reportedBy = String(601);
  const selfClaim = await request(
    testApp,
    "/api/claims",
    jsonRequest(
      {
        itemId,
        verificationAnswers: "My wallet",
        additionalDetails: "I found it"
      },
      { Cookie: finder.cookie }
    )
  );
  assert.equal(selfClaim.status, 400);
  reportedItem.reportedBy = 601;

  // 4. Claimant submits ownership claim with answers and proof files
  const proofUpload = await supertest(testApp)
    .post("/api/claims/proof/upload")
    .set("Cookie", claimant.cookie)
    .attach("images", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "receipt.jpg");
  assert.equal(proofUpload.status, 201);
  const proofFilename = proofUpload.body.files[0].filename;

  const claimRes = await request(
    testApp,
    "/api/claims",
    jsonRequest(
      {
        itemId,
        verificationAnswers: [{ question: "Card in front slot", answer: "HDFC Student Debit Card" }],
        additionalDetails: "It has my initials VR engraved inside.",
        proofFiles: [proofFilename]
      },
      { Cookie: claimant.cookie }
    )
  );
  assert.equal(claimRes.status, 201);
  const claimId = claimRes.json.claim._id;

  // 5. Duplicate active claim by same student must be rejected
  const dupClaim = await request(
    testApp,
    "/api/claims",
    jsonRequest(
      {
        itemId,
        verificationAnswers: "Second attempt",
        additionalDetails: "Duplicate"
      },
      { Cookie: claimant.cookie }
    )
  );
  assert.equal(dupClaim.status, 409);

  // 6. Admin inspects claims list and claim details
  const adminClaimsList = await request(testApp, "/api/admin/claims?status=pending", {
    headers: { Cookie: admin.cookie }
  });
  assert.equal(adminClaimsList.status, 200);
  assert.equal(adminClaimsList.json.claims.length, 1);

  const claimDetail = await request(testApp, `/api/admin/claims/${claimId}`, {
    headers: { Cookie: admin.cookie }
  });
  assert.equal(claimDetail.status, 200);
  assert.equal(claimDetail.json.item.identifyingMarks, "Initials VR embossed on inner pocket"); // Admin can see private marks!
  assert.ok(claimDetail.json.claim.riskScore >= 25);

  // 7. Admin marks claim under review
  const underReviewRes = await request(
    testApp,
    `/api/admin/claims/${claimId}/status`,
    {
      method: "PATCH",
      ...jsonRequest(
        { status: "under_review", reviewNotes: "Checking claimant card photo against student registry." },
        { Cookie: admin.cookie },
        "PATCH"
      )
    }
  );
  assert.equal(underReviewRes.status, 200);

  // 8. Admin approves claim with handover desk
  const approveRes = await request(
    testApp,
    `/api/admin/claims/${claimId}/status`,
    {
      method: "PATCH",
      ...jsonRequest(
        {
          status: "approved",
          reviewNotes: "Initials and debit card verified.",
          handoverLocation: "Main Administration Building, Room 102"
        },
        { Cookie: admin.cookie },
        "PATCH"
      )
    }
  );
  assert.equal(approveRes.status, 200);
  assert.ok(["sent", "smtp_not_configured", "failed"].includes(approveRes.json.handover.otpEmailStatus));
  assert.ok(
    approveRes.json.message.includes("could not be delivered") ||
    approveRes.json.message.includes("email delivery is unavailable") ||
    approveRes.json.message.includes("emailed to claimant")
  );

  // 9. The item remains unresolved until the claimant verifies the handover OTP
  const updatedItemRes = await request(testApp, `/api/claims/item/${itemId}`);
  assert.notEqual(updatedItemRes.json.item.status, "returned");

  const approvedClaim = testApp.testClaims.find((claim) => String(claim._id) === String(claimId));
  approvedClaim.handoverOtpHash = crypto.createHash("sha256").update("654321").digest("hex");
  approvedClaim.handoverOtpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  approvedClaim.handoverOtpAttempts = 0;

  const handoverRes = await request(testApp, `/api/claims/${claimId}/handover/verify`, {
    method: "POST",
    ...jsonRequest({ otp: "654321" }, { Cookie: claimant.cookie }, "POST")
  });
  assert.equal(handoverRes.status, 200);

  const returnedItemRes = await request(testApp, `/api/claims/item/${itemId}`);
  assert.equal(returnedItemRes.status, 404);

  const reuseRes = await request(testApp, `/api/claims/${claimId}/handover/verify`, {
    method: "POST",
    ...jsonRequest({ otp: "654321" }, { Cookie: claimant.cookie }, "POST")
  });
  assert.equal(reuseRes.status, 409);

  // 10. Audit log recorded
  const auditRes = await request(testApp, "/api/admin/audit-logs", {
    headers: { Cookie: admin.cookie }
  });
  assert.equal(auditRes.status, 200);
  assert.ok(auditRes.json.logs.some((l) => l.action === "CLAIM_APPROVED"));
  await fs.unlink(path.join(PRIVATE_UPLOAD_DIR, proofFilename));
});

test("only one concurrent admin claim approval can return an item", async () => {
  const testApp = buildTestApp();
  const reporter = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 710,
      name: "Found Item Reporter",
      email: "approval-reporter@campus.edu",
      password: "password123"
    })
  );
  const claimantOne = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 711,
      name: "Claimant One",
      email: "claimant-one@campus.edu",
      password: "password123"
    })
  );
  const claimantTwo = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 712,
      name: "Claimant Two",
      email: "claimant-two@campus.edu",
      password: "password123"
    })
  );
  const admin = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 713,
      name: "Claims Admin",
      email: "claims-admin@campus.edu",
      password: "password123"
    })
  );
  testApp.elevateAdmin(713);

  const report = await request(
    testApp,
    "/api/items",
    jsonRequest({
      itemName: "Found Blue Backpack",
      category: "Accessories",
      color: "Blue",
      reportType: "found",
      location: "Library"
    }, { Cookie: reporter.cookie })
  );
  assert.equal(report.status, 201);

  const claims = [];
  for (const claimant of [claimantOne, claimantTwo]) {
    const response = await request(
      testApp,
      "/api/claims",
      jsonRequest({ itemId: report.json.itemId }, { Cookie: claimant.cookie })
    );
    assert.equal(response.status, 201);
    claims.push(response.json.claim);
  }

  const approvals = await Promise.all(
    claims.map((claim) => request(
      testApp,
      `/api/admin/claims/${claim._id}/status`,
      {
        method: "PATCH",
        ...jsonRequest(
          { status: "approved", handoverLocation: "Campus Desk" },
          { Cookie: admin.cookie },
          "PATCH"
        )
      }
    ))
  );
  assert.deepEqual(approvals.map((response) => response.status).sort(), [200, 409]);

  const approvedIndex = approvals.findIndex((response) => response.status === 200);
  const approvedClaimId = claims[approvedIndex]._id;
  const item = await request(testApp, `/api/claims/item/${report.json.itemId}`);
  assert.notEqual(item.json.item.status, "returned");
  assert.equal(item.json.item.approvedClaimId, undefined);

  const approvedClaims = await request(testApp, "/api/admin/claims?status=approved", {
    headers: { Cookie: admin.cookie }
  });
  assert.equal(approvedClaims.json.claims.length, 1);
  assert.equal(String(approvedClaims.json.claims[0]._id), String(approvedClaimId));

  const approvedClaim = testApp.testClaims.find((claim) => String(claim._id) === String(approvedClaimId));
  approvedClaim.handoverOtpHash = crypto.createHash("sha256").update("123456").digest("hex");
  approvedClaim.handoverOtpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  approvedClaim.handoverOtpAttempts = 0;
  const approvedClaimant = [claimantOne, claimantTwo][approvedIndex];

  const wrongOtp = await request(testApp, `/api/claims/${approvedClaimId}/handover/verify`, {
    method: "POST",
    ...jsonRequest({ otp: "000000" }, { Cookie: approvedClaimant.cookie }, "POST")
  });
  assert.equal(wrongOtp.status, 400);

  const concurrentOtpRequests = await Promise.all([
    request(testApp, `/api/claims/${approvedClaimId}/handover/verify`, {
      method: "POST",
      ...jsonRequest({ otp: "123456" }, { Cookie: approvedClaimant.cookie }, "POST")
    }),
    request(testApp, `/api/claims/${approvedClaimId}/handover/verify`, {
      method: "POST",
      ...jsonRequest({ otp: "123456" }, { Cookie: approvedClaimant.cookie }, "POST")
    })
  ]);
  assert.deepEqual(concurrentOtpRequests.map((response) => response.status).sort(), [200, 409]);

  const handedOverItem = await request(testApp, `/api/claims/item/${report.json.itemId}`);
  assert.equal(handedOverItem.status, 404);

  const reusedOtp = await request(testApp, `/api/claims/${approvedClaimId}/handover/verify`, {
    method: "POST",
    ...jsonRequest({ otp: "123456" }, { Cookie: approvedClaimant.cookie }, "POST")
  });
  assert.equal(reusedOtp.status, 409);

  const repeatApproval = await request(
    testApp,
    `/api/admin/claims/${approvedClaimId}/status`,
    {
      method: "PATCH",
      ...jsonRequest({ status: "approved" }, { Cookie: admin.cookie }, "PATCH")
    }
  );
  assert.equal(repeatApproval.status, 409);
});

test("handover OTP rejects unauthorized users and enforces five incorrect attempts", async () => {
  const testApp = buildTestApp();
  const owner = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 821,
    name: "Handover Owner",
    email: "handover-owner@campus.edu",
    password: "password123"
  }));
  const claimant = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 822,
    name: "Approved Claimant",
    email: "approved-claimant@campus.edu",
    password: "password123"
  }));
  const unauthorized = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 823,
    name: "Unauthorized Student",
    email: "unauthorized@campus.edu",
    password: "password123"
  }));
  const admin = await request(testApp, "/api/auth/register", jsonRequest({
    studentId: 824,
    name: "Handover Admin",
    email: "handover-admin@campus.edu",
    password: "password123"
  }));
  testApp.elevateAdmin(824);

  const report = await request(testApp, "/api/items", jsonRequest({
    itemName: "Handover Laptop",
    category: "Electronics",
    color: "Silver",
    reportType: "found",
    location: "Lab",
    reportedBy: 821
  }, { Cookie: owner.cookie }));
  assert.equal(report.status, 201);

  const claim = await request(testApp, "/api/claims", jsonRequest({
    itemId: report.json.itemId,
    verificationAnswers: [{ question: "Serial", answer: "Any answer" }]
  }, { Cookie: claimant.cookie }));
  assert.equal(claim.status, 201);
  const claimId = claim.json.claim._id;

  const approval = await request(testApp, `/api/admin/claims/${claimId}/status`, {
    method: "PATCH",
    ...jsonRequest(
      { status: "approved", handoverLocation: "Security Desk" },
      { Cookie: admin.cookie },
      "PATCH"
    )
  });
  assert.equal(approval.status, 200);

  const approvedClaim = testApp.testClaims.find((entry) => String(entry._id) === String(claimId));
  approvedClaim.handoverOtpHash = crypto.createHash("sha256").update("999999").digest("hex");
  approvedClaim.handoverOtpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  approvedClaim.handoverOtpAttempts = 0;

  const unauthorizedResult = await request(testApp, `/api/claims/${claimId}/handover/verify`, {
    method: "POST",
    ...jsonRequest({ otp: "999999" }, { Cookie: unauthorized.cookie }, "POST")
  });
  assert.equal(unauthorizedResult.status, 403);

  approvedClaim.handoverOtpExpiresAt = new Date(Date.now() - 60 * 1000);
  const expired = await request(testApp, `/api/claims/${claimId}/handover/verify`, {
    method: "POST",
    ...jsonRequest({ otp: "999999" }, { Cookie: claimant.cookie }, "POST")
  });
  assert.equal(expired.status, 410);
  approvedClaim.handoverOtpHash = crypto.createHash("sha256").update("999999").digest("hex");
  approvedClaim.handoverOtpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrong = await request(testApp, `/api/claims/${claimId}/handover/verify`, {
      method: "POST",
      ...jsonRequest({ otp: "000000" }, { Cookie: claimant.cookie }, "POST")
    });
    assert.equal(wrong.status, 400);
  }

  const locked = await request(testApp, `/api/claims/${claimId}/handover/verify`, {
    method: "POST",
    ...jsonRequest({ otp: "999999" }, { Cookie: claimant.cookie }, "POST")
  });
  assert.equal(locked.status, 429);

  const itemBefore = await request(testApp, `/api/claims/item/${report.json.itemId}`);
  assert.notEqual(itemBefore.json.item.status, "returned");
});

test("item moderation hides flagged and removed reports from public APIs", async () => {
  const testApp = buildTestApp();

  const user = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 705,
      name: "Tanya Sharma",
      email: "tanya@campus.edu",
      password: "password123"
    })
  );

  const admin = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 997,
      name: "Admin Mod",
      email: "mod@campus.edu",
      password: "password123",
      role: "admin"
    })
  );
  testApp.elevateAdmin(997);

  // Report an item
  const itemRes = await request(
    testApp,
    "/api/items",
    jsonRequest(
      {
        itemName: "Suspicious Flash Drive",
        category: "Electronics",
        color: "Black",
        reportType: "found",
        location: "Lab 3",
        reportedBy: 705
      },
      { Cookie: user.cookie }
    )
  );
  assert.equal(itemRes.status, 201);
  const itemId = itemRes.json.itemId;

  // Item is visible in search
  const search1 = await request(testApp, "/api/items/search?q=Flash");
  assert.equal(search1.json.items.length, 1);

  // Admin moderates item to 'flagged'
  const modRes = await request(
    testApp,
    `/api/admin/items/${itemId}/moderate`,
    {
      method: "PATCH",
      ...jsonRequest(
        { moderationStatus: "flagged", reason: "Potential security policy violation." },
        { Cookie: admin.cookie },
        "PATCH"
      )
    }
  );
  assert.equal(modRes.status, 200);
  assert.equal(modRes.json.moderationStatus, "flagged");

  // Item must now be hidden from public search
  const search2 = await request(testApp, "/api/items/search?q=Flash");
  assert.equal(search2.json.items.length, 0);
  const flaggedDetail = await request(testApp, `/api/claims/item/${itemId}`);
  assert.equal(flaggedDetail.status, 404);

  // Admin restores item
  const restoreRes = await request(
    testApp,
    `/api/admin/items/${itemId}/moderate`,
    {
      method: "PATCH",
      ...jsonRequest(
        { moderationStatus: "active", reason: "Reviewed and approved." },
        { Cookie: admin.cookie },
        "PATCH"
      )
    }
  );
  assert.equal(restoreRes.status, 200);

  // Item is visible again
  const search3 = await request(testApp, "/api/items/search?q=Flash");
  assert.equal(search3.json.items.length, 1);
  const activeDetail = await request(testApp, `/api/claims/item/${itemId}`);
  assert.equal(activeDetail.status, 200);

  const removeRes = await request(
    testApp,
    `/api/admin/items/${itemId}/moderate`,
    {
      method: "PATCH",
      ...jsonRequest(
        { moderationStatus: "removed", reason: "Duplicate report." },
        { Cookie: admin.cookie },
        "PATCH"
      )
    }
  );
  assert.equal(removeRes.status, 200);

  const removedSearch = await request(testApp, "/api/items?q=Flash");
  assert.equal(removedSearch.json.items.length, 0);
  const removedDetail = await request(testApp, `/api/claims/item/${itemId}`);
  assert.equal(removedDetail.status, 404);
  const adminRemovedItems = await request(testApp, "/api/admin/items?moderationStatus=removed", {
    headers: { Cookie: admin.cookie }
  });
  assert.equal(adminRemovedItems.json.items.length, 1);
});

test("public registration strictly assigns role: student even if payload requests role: admin", async () => {
  const testApp = buildTestApp();

  const regRes = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 555,
      name: "Sneaky User",
      email: "sneaky@campus.edu",
      password: "password123",
      role: "admin"
    })
  );

  assert.equal(regRes.status, 201);
  const profileRes = await request(testApp, "/api/profile", { headers: { Cookie: regRes.cookie } });
  assert.equal(profileRes.json.user.role, "student");
});

test("unauthenticated attempt to upload private claim evidence is rejected with 401", async () => {
  const testApp = buildTestApp();

  const uploadRes = await supertest(testApp)
    .post("/api/claims/proof/upload")
    .attach("images", Buffer.from("%PDF-1.4 test"), "receipt.pdf");

  assert.equal(uploadRes.status, 401);
});

test("private evidence upload rejects disguised files without valid magic bytes with 400", async () => {
  const testApp = buildTestApp();

  const user = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 556,
      name: "Test Uploader",
      email: "uploader@campus.edu",
      password: "password123"
    })
  );

  // Text file disguised as a JPEG
  const disguisedJpg = Buffer.from("THIS IS PLAIN TEXT, NOT A JPEG FILE");
  const uploadRes = await supertest(testApp)
    .post("/api/claims/proof/upload")
    .set("Cookie", user.cookie)
    .attach("images", disguisedJpg, "exploit.jpg");

  assert.equal(uploadRes.status, 400);
  assert.ok(uploadRes.body.message.includes("content signature"));
});

test("public item photo upload endpoint /api/upload rejects PDF files", async () => {
  const testApp = buildTestApp();

  const user = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 557,
      name: "Public Reporter",
      email: "pubrep@campus.edu",
      password: "password123"
    })
  );

  const pdfBuffer = Buffer.from("%PDF-1.5 \n%âãÏÓ\n1 0 obj\n<<>>\nendobj");
  const uploadRes = await supertest(testApp)
    .post("/api/upload")
    .set("Cookie", user.cookie)
    .attach("images", pdfBuffer, "document.pdf");

  assert.equal(uploadRes.status, 400);
  assert.ok(uploadRes.body.message.includes("Public item photos must be images"));
});

test("upload exceeding 5MB size limit is rejected with 400", async () => {
  const testApp = buildTestApp();

  const user = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 558,
      name: "Large Uploader",
      email: "large@campus.edu",
      password: "password123"
    })
  );

  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1024, 0xff);
  oversized[0] = 0xff; oversized[1] = 0xd8; oversized[2] = 0xff; // fake jpeg magic start

  const uploadRes = await supertest(testApp)
    .post("/api/claims/proof/upload")
    .set("Cookie", user.cookie)
    .attach("images", oversized, "heavy.jpg");

  assert.equal(uploadRes.status, 400);
});

test("authenticated private claim evidence upload with PDF succeeds and protects file from unauthorized access", async () => {
  const testApp = buildTestApp();

  // Student 1 (Claimant)
  const claimant = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 560,
      name: "Genuine Owner",
      email: "owner@campus.edu",
      password: "password123"
    })
  );

  // Student 2 (Unrelated student)
  const stranger = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 561,
      name: "Stranger Student",
      email: "stranger@campus.edu",
      password: "password123"
    })
  );

  // Admin user
  const admin = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 995,
      name: "Verification Dean",
      email: "dean.verif@campus.edu",
      password: "password123",
      role: "admin"
    })
  );
  testApp.elevateAdmin(995);

  // Valid PDF header
  const validPdf = Buffer.from("%PDF-1.4\n%âãÏÓ\n1 0 obj\n<< /Title (Receipt) >>\nendobj\ntrailer\n<<>>\n%%EOF");

  const uploadRes = await supertest(testApp)
    .post("/api/claims/proof/upload")
    .set("Cookie", claimant.cookie)
    .attach("images", validPdf, "purchase_receipt.pdf");

  assert.equal(uploadRes.status, 201);
  assert.ok(Array.isArray(uploadRes.body.urls));
  assert.equal(uploadRes.body.urls.length, 1);

  const proofUrl = uploadRes.body.urls[0];
  const filename = proofUrl.split("/").pop();

  // 1. Verify that accessing via public static /uploads/:filename returns 404
  const publicStaticRes = await supertest(testApp).get(`/uploads/${filename}`);
  assert.equal(publicStaticRes.status, 404);

  // 2. Unauthenticated access to /api/claims/proof/:filename is rejected with 401
  const unauthRes = await supertest(testApp).get(`/api/claims/proof/${filename}`);
  assert.equal(unauthRes.status, 401);

  // 3. Unauthorized stranger student access to /api/claims/proof/:filename is rejected with 403
  const strangerRes = await supertest(testApp)
    .get(`/api/claims/proof/${filename}`)
    .set("Cookie", stranger.cookie);
  assert.equal(strangerRes.status, 403);

  // 4. Uploader / Claimant access to /api/claims/proof/:filename succeeds (200) with security headers
  const claimantRes = await supertest(testApp)
    .get(`/api/claims/proof/${filename}`)
    .set("Cookie", claimant.cookie);
  assert.equal(claimantRes.status, 200);
  assert.equal(claimantRes.headers["x-content-type-options"], "nosniff");
  assert.equal(claimantRes.headers["content-type"], "application/pdf");

  // 5. Admin access to /api/claims/proof/:filename succeeds (200)
  const adminRes = await supertest(testApp)
    .get(`/api/claims/proof/${filename}`)
    .set("Cookie", admin.cookie);
  assert.equal(adminRes.status, 200);
  assert.equal(adminRes.headers["content-type"], "application/pdf");

  // 6. Path traversal attempt is rejected with 400
  const traversalRes = await supertest(testApp)
    .get("/api/claims/proof/..%2F..%2Fserver.js")
    .set("Cookie", claimant.cookie);
  assert.equal(traversalRes.status, 400);
});

test("private item verification photos are stored outside public storage and admin-only", async () => {
  const testApp = buildTestApp();
  const owner = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 562,
      name: "Photo Owner",
      email: "photo-owner@campus.edu",
      password: "password123"
    })
  );
  const otherStudent = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 563,
      name: "Other Student",
      email: "other-photo@campus.edu",
      password: "password123"
    })
  );
  const admin = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 996,
      name: "Photo Admin",
      email: "photo-admin@campus.edu",
      password: "password123"
    })
  );
  testApp.elevateAdmin(996);

  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const unauthenticatedUpload = await supertest(testApp)
    .post("/api/upload?isPrivate=true")
    .attach("images", image, "private.jpg");
  assert.equal(unauthenticatedUpload.status, 401);

  const uploadResponse = await supertest(testApp)
    .post("/api/upload?isPrivate=true")
    .set("Cookie", owner.cookie)
    .attach("images", image, "private.jpg");
  assert.equal(uploadResponse.status, 201);
  assert.equal(uploadResponse.body.urls, undefined);
  assert.equal(uploadResponse.body.files.length, 1);
  const filename = uploadResponse.body.files[0].filename;
  assert.equal(uploadResponse.body.files[0].url, undefined);

  const wrongOwnerReport = await request(
    testApp,
    "/api/items",
    jsonRequest({
      itemName: "Private Photo Item",
      category: "Accessories",
      color: "Blue",
      reportType: "lost",
      location: "Library",
      privateImages: [filename]
    }, { Cookie: otherStudent.cookie })
  );
  assert.equal(wrongOwnerReport.status, 403);

  const reportResponse = await request(
    testApp,
    "/api/items",
    jsonRequest({
      itemName: "Private Photo Item",
      category: "Accessories",
      color: "Blue",
      reportType: "lost",
      location: "Library",
      identifyingMarks: "Secret scratch on the back",
      privateImages: [filename]
    }, { Cookie: owner.cookie })
  );
  assert.equal(reportResponse.status, 201);
  const itemId = reportResponse.json.itemId;

  const ownerAccess = await supertest(testApp)
    .get(`/api/admin/items/${itemId}/private-images/${filename}`)
    .set("Cookie", owner.cookie);
  assert.equal(ownerAccess.status, 403);

  const adminAccess = await supertest(testApp)
    .get(`/api/admin/items/${itemId}/private-images/${filename}`)
    .set("Cookie", admin.cookie);
  assert.equal(adminAccess.status, 200);
  assert.equal(adminAccess.headers["cache-control"], "private, no-store");
  assert.equal(adminAccess.headers["x-content-type-options"], "nosniff");

  const publicFileAccess = await supertest(testApp).get(`/uploads/${filename}`);
  assert.equal(publicFileAccess.status, 404);
  const publicItem = await request(testApp, `/api/claims/item/${itemId}`);
  assert.equal(publicItem.status, 200);
  assert.equal(publicItem.json.item.privateImages, undefined);

  const removeReport = await request(
    testApp,
    `/api/admin/items/${itemId}/moderate`,
    {
      method: "PATCH",
      ...jsonRequest(
        { moderationStatus: "removed", reason: "Reporter evidence cleanup verification." },
        { Cookie: admin.cookie },
        "PATCH"
      )
    }
  );
  assert.equal(removeReport.status, 200);
  await assert.rejects(fs.access(path.join(PRIVATE_UPLOAD_DIR, filename)));
  assert.equal(testApp.testPrivateFiles.some((file) => file.filename === filename), false);
});

test("claimants cannot attach or retrieve another uploader's private proof", async () => {
  const testApp = buildTestApp();
  const reporter = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 564,
      name: "Item Reporter",
      email: "item-reporter@campus.edu",
      password: "password123"
    })
  );
  const uploader = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 565,
      name: "Evidence Uploader",
      email: "evidence-uploader@campus.edu",
      password: "password123"
    })
  );
  const otherClaimant = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 566,
      name: "Other Claimant",
      email: "other-claimant@campus.edu",
      password: "password123"
    })
  );

  const report = await request(
    testApp,
    "/api/items",
    jsonRequest({
      itemName: "Found Silver Watch",
      category: "Accessories",
      color: "Silver",
      reportType: "found",
      location: "Library"
    }, { Cookie: reporter.cookie })
  );
  assert.equal(report.status, 201);

  const evidence = await supertest(testApp)
    .post("/api/claims/proof/upload")
    .set("Cookie", uploader.cookie)
    .attach("images", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "proof.jpg");
  assert.equal(evidence.status, 201);
  const filename = evidence.body.files[0].filename;

  const substitutedClaim = await request(
    testApp,
    "/api/claims",
    jsonRequest({
      itemId: report.json.itemId,
      proofFiles: [filename]
    }, { Cookie: otherClaimant.cookie })
  );
  assert.equal(substitutedClaim.status, 403);

  const substitutedRetrieval = await supertest(testApp)
    .get(`/api/claims/proof/${filename}`)
    .set("Cookie", otherClaimant.cookie);
  assert.equal(substitutedRetrieval.status, 403);

  await fs.unlink(path.join(PRIVATE_UPLOAD_DIR, filename));
});

test("audit logs are strictly append-only and reject modification or deletion with 405", async () => {
  const testApp = buildTestApp();

  const admin = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 994,
      name: "Audit Administrator",
      email: "auditadmin@campus.edu",
      password: "password123",
      role: "admin"
    })
  );
  testApp.elevateAdmin(994);

  // GET audit logs succeeds
  const getRes = await supertest(testApp)
    .get("/api/admin/audit-logs")
    .set("Cookie", admin.cookie);
  assert.equal(getRes.status, 200);

  // DELETE attempt to clear logs returns 405 Method Not Allowed
  const deleteRes = await supertest(testApp)
    .delete("/api/admin/audit-logs")
    .set("Cookie", admin.cookie);
  assert.equal(deleteRes.status, 405);
  assert.ok(deleteRes.body.message.includes("strictly append-only"));

  // PUT attempt returns 405 Method Not Allowed
  const putRes = await supertest(testApp)
    .put("/api/admin/audit-logs")
    .set("Cookie", admin.cookie)
    .send({ details: "tampered" });
  assert.equal(putRes.status, 405);
});

test("seedAdmin script fails with exit code 1 when required environment variables are missing", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "scripts/seedAdmin.js")], {
    env: { ...process.env, ADMIN_EMAIL: "", ADMIN_PASSWORD: "", ADMIN_STUDENT_ID: "" }
  });
  assert.equal(result.status, 1);
  const output = (result.stderr?.toString() || "") + (result.stdout?.toString() || "");
  assert.ok(output.includes("Missing required administrator seed credentials"));
});

test("SMTP & Handover OTP end-to-end verification (13 requirements)", async (t) => {
  t.afterEach(() => {
    resetTransporter();
  });

  // 1. SMTP configuration missing
  await t.test("1. SMTP configuration missing is clearly reported", async () => {
    const config = getSmtpConfig({});
    assert.equal(config.isConfigured, false);
    assert.deepEqual(config.missingFields, ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]);

    const verifyResult = await verifySmtpConnection(null, {});
    assert.equal(verifyResult.success, false);
    assert.equal(verifyResult.status, "smtp_not_configured");
    assert.ok(verifyResult.errorReason.includes("missing"));
  });

  // 2. SMTP authentication failure
  await t.test("2. SMTP authentication failure is sanitized and reported accurately", async () => {
    const mockTransport = {
      sendMail: async () => {
        const err = new Error("Invalid login: 535-5.7.8 Username and Password not accepted");
        err.code = "EAUTH";
        err.responseCode = 535;
        throw err;
      },
      verify: async () => {
        const err = new Error("535 5.7.8 Authentication credentials invalid for user secret@example.com with password secretPass123");
        err.code = "EAUTH";
        throw err;
      }
    };
    setTransporter(mockTransport);

    const verifyRes = await verifySmtpConnection(mockTransport);
    assert.equal(verifyRes.success, false);
    assert.equal(verifyRes.status, "failed");
    assert.ok(verifyRes.errorReason.includes("SMTP authentication failed"));
    assert.ok(!verifyRes.errorReason.includes("secretPass123"));

    const result = await sendHandoverOtp({
      recipientEmail: "claimant@campus.edu",
      studentName: "Claimant Student",
      itemName: "Water Bottle",
      handoverLocation: "Security Desk",
      otp: "123456",
      expiresMinutes: 10
    });
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.ok(result.errorReason.includes("authentication failed"));
  });

  // 3. Successful SMTP delivery
  await t.test("3. Successful SMTP delivery updates delivery status to sent", async () => {
    let sentEmail = null;
    const mockTransport = {
      sendMail: async (mailOptions) => {
        sentEmail = mailOptions;
        return { messageId: "<msg-101@campusfind>" };
      }
    };
    setTransporter(mockTransport);

    const result = await sendHandoverOtp({
      recipientEmail: "claimant@campus.edu",
      studentName: "Claimant Student",
      itemName: "Blue Hydro Flask",
      handoverLocation: "Security Desk",
      otp: "847291",
      expiresMinutes: 10
    });

    assert.equal(result.success, true);
    assert.equal(result.status, "sent");
    assert.equal(result.messageId, "<msg-101@campusfind>");
    assert.ok(sentEmail.html.includes("847291"));
    assert.ok(sentEmail.html.includes("Blue Hydro Flask"));
    assert.equal(sentEmail.to, "claimant@campus.edu");
  });

  // 4. SMTP connection timeout
  await t.test("4. SMTP connection timeout is caught and sanitized", async () => {
    const mockTransport = {
      sendMail: async () => {
        const err = new Error("Connection timed out after 10000ms to smtp.gmail.com:587");
        err.code = "ETIMEDOUT";
        throw err;
      }
    };
    setTransporter(mockTransport);

    const result = await sendHandoverOtp({
      recipientEmail: "claimant@campus.edu",
      studentName: "Claimant Student",
      itemName: "Keys",
      handoverLocation: "Security Desk",
      otp: "654321",
      expiresMinutes: 10
    });

    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.ok(result.errorReason.includes("timed out"));
  });

  // 5-13. Comprehensive end-to-end integration
  await t.test("5-13. Complete end-to-end admin approval, recipient isolation, hash security, retry, and handover verification", async () => {
    const testApp = buildTestApp();

    // 1. Create Finder (Student B: 12305160)
    const finder = await request(
      testApp,
      "/api/auth/register",
      jsonRequest({
        studentId: 12305160,
        name: "Student B",
        email: "studentB.finder@campus.edu",
        password: "password123"
      })
    );
    assert.equal(finder.status, 201);

    // 2. Create Claimant (Student A: 12306500)
    const claimant = await request(
      testApp,
      "/api/auth/register",
      jsonRequest({
        studentId: 12306500,
        name: "Student A",
        email: "studentA.claimant@campus.edu",
        password: "password123"
      })
    );
    assert.equal(claimant.status, 201);

    // 3. Create Admin
    const admin = await request(
      testApp,
      "/api/auth/register",
      jsonRequest({
        studentId: 99999999,
        name: "Campus Security Admin",
        email: "admin@campus.edu",
        password: "password123",
        role: "admin"
      })
    );
    assert.equal(admin.status, 201);
    testApp.elevateAdmin(99999999);

    // 4. Finder reports FOUND item
    const foundItemRes = await request(
      testApp,
      "/api/items",
      jsonRequest(
        {
          itemName: "Titan Black Watch",
          category: "Accessories",
          color: "Black",
          reportType: "found",
          location: "Library 2nd Floor",
          serialNumber: "TITAN-SN-9981"
        },
        { Cookie: finder.cookie }
      )
    );
    assert.equal(foundItemRes.status, 201);
    const itemId = foundItemRes.json.itemId;

    // 5. Claimant submits claim on found item
    const claimRes = await request(
      testApp,
      "/api/claims",
      jsonRequest(
        {
          itemId,
          verificationAnswers: [{ question: "Serial Number", answer: "TITAN-SN-9981" }],
          additionalDetails: "Lost my watch while studying at the library."
        },
        { Cookie: claimant.cookie }
      )
    );
    assert.equal(claimRes.status, 201);
    const claimId = claimRes.json.claim._id;

    // --- TEST 5 & 6: Recipient isolation & Successful Mock SMTP Delivery ---
    const capturedEmails = [];
    let shouldSucceed = true;
    const mockTransport = {
      sendMail: async (mailOptions) => {
        capturedEmails.push(mailOptions);
        if (!shouldSucceed) {
          const err = new Error("SMTP server connection dropped");
          err.code = "ECONNRESET";
          throw err;
        }
        return { messageId: `<otp-${Date.now()}@campusfind>` };
      }
    };
    setTransporter(mockTransport);

    // Admin approves claim
    const approveRes = await request(
      testApp,
      `/api/admin/claims/${claimId}/status`,
      {
        method: "PATCH",
        ...jsonRequest(
          {
            status: "approved",
            reviewNotes: "Serial number matched perfectly.",
            handoverLocation: "Security Central Desk"
          },
          { Cookie: admin.cookie },
          "PATCH"
        )
      }
    );
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.json.status, "approved");
    assert.equal(approveRes.json.handover.otpEmailStatus, "sent");

    // Check Test 5: Correct claimant email recipient
    const otpEmail = capturedEmails.find((e) => e.subject?.includes("Handover") || e.subject?.includes("OTP"));
    assert.ok(otpEmail, "Handover OTP email must be delivered");
    assert.equal(otpEmail.to, "studenta.claimant@campus.edu");
    assert.ok(capturedEmails.every((e) => e.to === "studenta.claimant@campus.edu"));

    // Check Test 6: Finder never receives claimant OTP
    assert.ok(!capturedEmails.some((e) => e.to.includes("studentB") || e.to.includes("finder")));
    assert.ok(!capturedEmails.some((e) => e.html?.includes("12305160")));

    // Extract the plaintext OTP that was delivered via email
    const otpMatch = otpEmail.text.match(/\b\d{6}\b/) || otpEmail.html.match(/\b\d{6}\b/);
    assert.ok(otpMatch, "Email must contain the 6-digit OTP");
    const issuedOtp = otpMatch[0];

    // --- TEST 7: OTP remains hashed in database (never plaintext) ---
    const savedClaim = testApp.testClaims.find((c) => String(c._id) === String(claimId));
    assert.ok(savedClaim.handoverOtpHash, "handoverOtpHash must be stored");
    assert.equal(savedClaim.handoverOtpHash.length, 64, "handoverOtpHash must be 64-char SHA-256");
    assert.equal(savedClaim.handoverOtpHash, crypto.createHash("sha256").update(issuedOtp).digest("hex"));
    assert.ok(savedClaim.handoverOtpEncrypted, "handoverOtpEncrypted must be stored");
    assert.equal(savedClaim.otp, undefined, "Plaintext otp field must not exist in DB");
    assert.equal(savedClaim.handoverOtp, undefined, "Plaintext handoverOtp field must not exist in DB");

    // Ensure raw 6-digit OTP is not present in serialized claim JSON outside of hash/ciphertext
    const serializedClaim = JSON.stringify(savedClaim);
    assert.ok(
      !serializedClaim.includes(`"${issuedOtp}"`),
      "Plaintext OTP must never appear as a value in DB record"
    );

    // Claimant profile API must never expose OTP or ciphertext
    const claimantProfileClaims = await request(
      testApp,
      "/api/claims/my",
      { headers: { Cookie: claimant.cookie } }
    );
    assert.equal(claimantProfileClaims.status, 200);
    const profileClaim = claimantProfileClaims.json.claims.find((c) => String(c._id) === String(claimId));
    assert.equal(profileClaim.handoverOtpHash, undefined);
    assert.equal(profileClaim.handoverOtpEncrypted, undefined);
    assert.equal(profileClaim.handoverOtp, undefined);
    assert.equal(profileClaim.handoverOtpEmailStatus, "sent");

    // --- TEST 8: Email failure is accurately reported ---
    // Simulate failure on retry
    shouldSucceed = false;
    const retryFailRes = await request(
      testApp,
      `/api/admin/claims/${claimId}/handover/retry-email`,
      { method: "POST", headers: { Cookie: admin.cookie } }
    );
    assert.equal(retryFailRes.status, 502);
    assert.equal(retryFailRes.json.handoverOtpEmailStatus, "failed");
    assert.ok(retryFailRes.json.errorReason);

    // Verify DB accurately reflects failure
    const claimAfterFail = testApp.testClaims.find((c) => String(c._id) === String(claimId));
    assert.equal(claimAfterFail.handoverOtpEmailStatus, "failed");
    assert.ok(claimAfterFail.handoverOtpEmailError);

    // --- TEST 9: Retry does not generate a new OTP ---
    shouldSucceed = true;
    capturedEmails.length = 0; // Clear
    const originalHash = savedClaim.handoverOtpHash;

    const retrySuccessRes = await request(
      testApp,
      `/api/admin/claims/${claimId}/handover/retry-email`,
      { method: "POST", headers: { Cookie: admin.cookie } }
    );
    assert.equal(retrySuccessRes.status, 200);
    assert.equal(retrySuccessRes.json.handoverOtpEmailStatus, "sent");

    // Hash must remain identical
    const claimAfterRetry = testApp.testClaims.find((c) => String(c._id) === String(claimId));
    assert.equal(claimAfterRetry.handoverOtpHash, originalHash, "Hash must not change on retry");

    // The emailed OTP in the retry must match the original OTP
    assert.equal(capturedEmails.length, 1);
    const retryOtpMatch = capturedEmails[0].text.match(/\b\d{6}\b/) || capturedEmails[0].html.match(/\b\d{6}\b/);
    assert.equal(retryOtpMatch[0], issuedOtp, "Retry must deliver the SAME unexpired OTP");

    // --- TEST 10: Retry does not expose OTP or hash ---
    assert.equal(retrySuccessRes.json.otp, undefined);
    assert.equal(retrySuccessRes.json.handoverOtp, undefined);
    assert.equal(retrySuccessRes.json.handoverOtpHash, undefined);
    assert.equal(retrySuccessRes.json.handoverOtpEncrypted, undefined);

    // --- TEST 11: Expired OTP cannot be used ---
    // Temporarily expire the OTP in DB
    const realExpiry = claimAfterRetry.handoverOtpExpiresAt;
    claimAfterRetry.handoverOtpExpiresAt = new Date(Date.now() - 5000);

    const expiredVerifyRes = await request(
      testApp,
      `/api/claims/${claimId}/handover/verify`,
      jsonRequest({ otp: issuedOtp }, { Cookie: claimant.cookie })
    );
    assert.equal(expiredVerifyRes.status, 410);
    assert.ok(expiredVerifyRes.json.message.includes("expired"));

    // Item must remain unreturned
    const itemStillPending = testApp.testItems.find((i) => String(i._id) === String(itemId));
    assert.notEqual(itemStillPending.status, "returned");

    // Restore unexpired status for completion test
    claimAfterRetry.handoverOtpExpiresAt = realExpiry;
    claimAfterRetry.handoverOtpHash = originalHash;
    claimAfterRetry.handoverOtpEncrypted = encryptOtp(issuedOtp);

    // --- TEST 12: Correct OTP completes handover ---
    const successfulVerifyRes = await request(
      testApp,
      `/api/claims/${claimId}/handover/verify`,
      jsonRequest({ otp: issuedOtp }, { Cookie: claimant.cookie })
    );
    assert.equal(successfulVerifyRes.status, 200);
    assert.ok(successfulVerifyRes.json.message.includes("marked returned"));

    // Verify claim and item in database
    const completedClaim = testApp.testClaims.find((c) => String(c._id) === String(claimId));
    assert.equal(completedClaim.status, "returned");
    assert.ok(completedClaim.handoverDate);
    assert.equal(completedClaim.handoverOtpHash, undefined, "Hash must be cleared upon handover completion");
    assert.equal(completedClaim.handoverOtpEncrypted, undefined, "Ciphertext must be cleared upon handover completion");

    const completedItem = testApp.testItems.find((i) => String(i._id) === String(itemId));
    assert.equal(completedItem.status, "returned");

    // --- TEST 13: OTP cannot be reused ---
    const reuseVerifyRes = await request(
      testApp,
      `/api/claims/${claimId}/handover/verify`,
      jsonRequest({ otp: issuedOtp }, { Cookie: claimant.cookie })
    );
    assert.equal(reuseVerifyRes.status, 409);
    assert.ok(
      reuseVerifyRes.json.message.includes("not approved for handover") ||
      reuseVerifyRes.json.message.includes("not awaiting handover")
    );
  });
});

test("Match confirmation workflow: fixes 'Cannot read properties of undefined (reading userId)'", async () => {
  const testApp = buildTestApp();

  // 1. Register Student A (Lost Reporter / Owner)
  const studentA = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 12306500,
      name: "Student A",
      email: "studentA@campus.edu",
      password: "password123"
    })
  );
  assert.equal(studentA.status, 201);

  // 2. Register Student B (Found Reporter / Finder)
  const studentB = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 12305160,
      name: "Student B",
      email: "studentB@campus.edu",
      password: "password123"
    })
  );
  assert.equal(studentB.status, 201);

  // 3. Register Unauthorized Student C
  const studentC = await request(
    testApp,
    "/api/auth/register",
    jsonRequest({
      studentId: 12309999,
      name: "Student C",
      email: "studentC@campus.edu",
      password: "password123"
    })
  );
  assert.equal(studentC.status, 201);

  // Student A reports LOST item
  const lostRes = await request(
    testApp,
    "/api/items",
    jsonRequest({
      itemName: "Navy Blue Laptop Sleeve",
      category: "Electronics",
      color: "Blue",
      reportType: "lost",
      location: "Computer Lab 3"
    }, { Cookie: studentA.cookie })
  );
  assert.equal(lostRes.status, 201);

  // Student B reports FOUND item
  const foundRes = await request(
    testApp,
    "/api/items",
    jsonRequest({
      itemName: "Navy Blue Laptop Sleeve",
      category: "Electronics",
      color: "Blue",
      reportType: "found",
      location: "Computer Lab 3"
    }, { Cookie: studentB.cookie })
  );
  assert.equal(foundRes.status, 201);

  // Fetch matches for Student A
  const matchRes = await request(testApp, "/api/items/matches", {
    headers: { Cookie: studentA.cookie }
  });
  assert.equal(matchRes.status, 200);
  assert.equal(matchRes.json.matches.length, 1);
  const match = matchRes.json.matches[0];
  assert.equal(match.status, "pending");

  // Case 1: Unauthenticated request must be rejected with 401
  const unauthRes = await request(testApp, `/api/items/matches/${match._id}/confirm`, {
    method: "PATCH"
  });
  assert.equal(unauthRes.status, 401);

  // Case 2: Unauthorized participant (Student C) must be rejected with 403
  const unauthStudentRes = await request(testApp, `/api/items/matches/${match._id}/confirm`, {
    method: "PATCH",
    headers: { Cookie: studentC.cookie }
  });
  assert.equal(unauthStudentRes.status, 403);
  assert.ok(unauthStudentRes.json.message.includes("Only the owner"));

  // Case 3: Finder (Student B) cannot confirm on behalf of owner -> 403
  const finderRes = await request(testApp, `/api/items/matches/${match._id}/confirm`, {
    method: "PATCH",
    headers: { Cookie: studentB.cookie }
  });
  assert.equal(finderRes.status, 403);
  assert.ok(finderRes.json.message.includes("Only the owner"));

  // Case 4: Forged userId in payload rejected if it does not match session
  const forgedRes = await request(testApp, `/api/items/matches/${match._id}/confirm`, {
    method: "PATCH",
    ...jsonRequest({ userId: 12309999 }, { Cookie: studentA.cookie }, "PATCH")
  });
  assert.equal(forgedRes.status, 403);
  assert.ok(forgedRes.json.message.includes("own match"));

  // Case 5: Student A confirms return without any body (EXACT frontend button click)
  // This previously crashed with TypeError: Cannot read properties of undefined (reading 'userId')
  const confirmNoBody = await request(testApp, `/api/items/matches/${match._id}/confirm`, {
    method: "PATCH",
    headers: { Cookie: studentA.cookie }
  });
  assert.equal(confirmNoBody.status, 200);
  assert.ok(confirmNoBody.json.message.includes("RETURNED"));

  // Verify match in DB is confirmed
  const confirmedMatch = testApp.testMatches.find((m) => String(m._id) === String(match._id));
  assert.equal(confirmedMatch.status, "confirmed");

  // Verify both linked reports are marked returned
  const lostItem = testApp.testItems.find((i) => String(i._id) === String(lostRes.json.itemId));
  const foundItem = testApp.testItems.find((i) => String(i._id) === String(foundRes.json.itemId));
  assert.equal(lostItem.status, "returned");
  assert.equal(foundItem.status, "returned");

  // Case 6: Duplicate confirmation attempt returns 409
  const duplicateConfirm = await request(testApp, `/api/items/matches/${match._id}/confirm`, {
    method: "PATCH",
    headers: { Cookie: studentA.cookie }
  });
  assert.equal(duplicateConfirm.status, 409);
  assert.ok(duplicateConfirm.json.message.includes("already been resolved"));
});
