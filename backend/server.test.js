import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-characters";

const { createApp, parseStudentId } = await import("./server.js");

function matchesValue(actual, expected) {
  if (expected && typeof expected === "object" && !(expected instanceof RegExp)) {
    if (expected.$regex !== undefined) {
      return new RegExp(expected.$regex, expected.$options).test(String(actual || ""));
    }
    if (expected.$in) return expected.$in.includes(actual);
    if (expected.$nin) return !expected.$nin.includes(actual);
    if (expected.$ne !== undefined) return String(actual) !== String(expected.$ne);
  }
  return String(actual) === String(expected);
}

function matchesQuery(document, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$and") return expected.every((part) => matchesQuery(document, part));
    if (key === "$or") return expected.some((part) => matchesQuery(document, part));
    return matchesValue(document[key], expected);
  });
}

const buildTestApp = () => {
  const items = [];
  const matches = [];
  const users = [];

  const usersCollection = () => ({
    findOne: async (query) => {
      if (query && query.$or) {
        return users.find((user) =>
          user.studentId === query.$or[0].studentId || user.email === query.$or[1].email
        ) || null;
      }

      if (query && query.studentId !== undefined) {
        return users.find((user) => user.studentId === query.studentId) || null;
      }

      if (query && query.email !== undefined) {
        return users.find((user) => user.email === query.email) || null;
      }

      return null;
    },
    insertOne: async (document) => {
      const insertedId = `user-${users.length + 1}`;
      const entry = { ...document, _id: insertedId };
      users.push(entry);
      return { insertedId };
    },
    updateOne: async (filter, update) => {
      const user = users.find((entry) => String(entry._id) === String(filter._id));
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
    countDocuments: async (query = {}) => items.filter((item) => matchesQuery(item, query)).length,
    insertOne: async (document) => {
      const insertedId = `item-${items.length + 1}`;
      const entry = { ...document, _id: insertedId };
      items.push(entry);
      return { insertedId };
    },
    updateMany: async (filter, update) => {
      const matchesToUpdate = items.filter((item) => {
        if (filter._id && filter._id.$in) {
          return filter._id.$in.some((id) => String(id) === String(item._id));
        }
        return true;
      });

      for (const item of matchesToUpdate) {
        item.status = update.$set.status;
      }

      return { acknowledged: true, matchedCount: matchesToUpdate.length };
    }
  });

  const matchesCollection = () => ({
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
        const matchStage = pipeline.find((stage) => stage.$match);
        return matchStage
          ? matches.filter((match) => matchesQuery(match, matchStage.$match))
          : matches;
      }
    })
  });

  return createApp({ itemsCollection, matchesCollection, usersCollection });
};

const request = async (baseUrl, route, init = {}) => {
  const response = await fetch(`${baseUrl}${route}`, init);
  return {
    status: response.status,
    json: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0]
  };
};

const jsonRequest = (body, extraHeaders = {}) => ({
  headers: { "content-type": "application/json", ...extraHeaders },
  body: JSON.stringify(body)
});

test("student ID parsing rejects invalid identities", () => {
  assert.equal(parseStudentId(101), 101);
  assert.equal(parseStudentId("0"), null);
  assert.equal(parseStudentId("abc"), null);
});

test("user registration creates a session-backed account", async (t) => {
  const testApp = buildTestApp();
  const server = testApp.listen(0);
  t.after(() => server.close());

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const result = await request(baseUrl, "/api/auth/register", {
    method: "POST",
    ...jsonRequest({
      studentId: 201,
      name: "Meera Kumar",
      email: "meera@example.com",
      password: "securepass123"
    })
  });

  assert.equal(result.status, 201);
  assert.equal(result.json.user.studentId, 201);
});

test("login with valid credentials returns a cookie-backed session", async (t) => {
  const testApp = buildTestApp();
  const server = testApp.listen(0);
  t.after(() => server.close());

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  await request(baseUrl, "/api/auth/register", {
    method: "POST",
    ...jsonRequest({
      studentId: 202,
      name: "Aarav Mehta",
      email: "aarav@example.com",
      password: "securepass123"
    })
  });

  const result = await request(baseUrl, "/api/auth/login", {
    method: "POST",
    ...jsonRequest({
      studentId: 202,
      password: "securepass123"
    })
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.user.studentId, 202);
});

test("unauthenticated report attempts are rejected", async (t) => {
  const testApp = buildTestApp();
  const server = testApp.listen(0);
  t.after(() => server.close());

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const result = await request(baseUrl, "/api/items", {
    method: "POST",
    ...jsonRequest({
      itemName: "Blue water bottle",
      category: "Accessories",
      color: "Blue",
      reportType: "lost",
      location: "Library",
      reportedBy: 101
    })
  });

  assert.equal(result.status, 401);
  assert.equal(result.json.message, "Authentication required.");
});

test("an authenticated user can report an item for their own student ID", async (t) => {
  const testApp = buildTestApp();
  const server = testApp.listen(0);
  t.after(() => server.close());

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const registration = await request(baseUrl, "/api/auth/register", {
    method: "POST",
    ...jsonRequest({
      studentId: 101,
      name: "Sam Lee",
      email: "sam@example.com",
      password: "securepass123"
    })
  });
  const result = await request(baseUrl, "/api/items", {
    method: "POST",
    ...jsonRequest({
      itemName: "Black wallet",
      category: "Accessories",
      color: "Black",
      reportType: "lost",
      location: "Library",
      reportedBy: 101
    }, { cookie: registration.cookie })
  });

  assert.equal(result.status, 201);
  assert.equal(typeof result.json.itemId, "string");

  const oversizedReport = await request(baseUrl, "/api/items", {
    method: "POST",
    ...jsonRequest({
      itemName: "x".repeat(101),
      category: "Accessories",
      color: "Black",
      reportType: "lost",
      location: "Library"
    }, { cookie: registration.cookie })
  });
  assert.equal(oversizedReport.status, 400);
});

test("profile returns only the authenticated user's reports and updates profile fields", async (t) => {
  const testApp = buildTestApp();
  const server = testApp.listen(0);
  t.after(() => server.close());

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const registration = await request(baseUrl, "/api/auth/register", {
    method: "POST",
    ...jsonRequest({
      studentId: 303,
      name: "Riya Shah",
      email: "riya@example.com",
      password: "securepass123"
    })
  });
  const authCookie = { cookie: registration.cookie };

  const report = await request(baseUrl, "/api/items", {
    method: "POST",
    ...jsonRequest({
      itemName: "Red notebook",
      category: "Documents",
      color: "Red",
      reportType: "lost",
      location: "Library",
      reportedBy: 303
    }, authCookie)
  });
  assert.equal(report.status, 201);

  const profile = await request(baseUrl, "/api/profile", {
    headers: authCookie
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.json.user.studentId, 303);
  assert.equal(profile.json.reports.length, 1);
  assert.equal(profile.json.reports[0].itemName, "Red notebook");

  const update = await request(baseUrl, "/api/profile", {
    method: "PATCH",
    ...jsonRequest({
      name: "Riya Patel",
      email: "RIYA.PATEL@example.com"
    }, authCookie)
  });
  assert.equal(update.status, 200);
  assert.equal(update.json.user.name, "Riya Patel");
  assert.equal(update.json.user.email, "riya.patel@example.com");
});

test("profile API rejects demo identity headers without a real session", async (t) => {
  const testApp = buildTestApp();
  const server = testApp.listen(0);
  t.after(() => server.close());

  const result = await request(
    `http://127.0.0.1:${server.address().port}`,
    "/api/profile",
    { headers: { "x-student-id": "303" } }
  );
  assert.equal(result.status, 401);
});

test("public item search paginates results without exposing reporter IDs", async (t) => {
  const testApp = buildTestApp();
  const server = testApp.listen(0);
  t.after(() => server.close());

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const registration = await request(baseUrl, "/api/auth/register", {
    method: "POST",
    ...jsonRequest({
      studentId: 404,
      name: "Alex Kim",
      email: "alex@example.com",
      password: "securepass123"
    })
  });
  const authCookie = { cookie: registration.cookie };

  for (const itemName of ["Blue backpack", "Green notebook"]) {
    const report = await request(baseUrl, "/api/items", {
      method: "POST",
      ...jsonRequest({
        itemName,
        category: "Accessories",
        color: "Blue",
        reportType: "lost",
        location: "Library",
        reportedBy: 404
      }, authCookie)
    });
    assert.equal(report.status, 201);
  }

  const firstPage = await request(baseUrl, "/api/items/search?page=1&pageSize=1");
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.json.total, 2);
  assert.equal(firstPage.json.totalPages, 2);
  assert.equal(firstPage.json.items.length, 1);
  assert.equal("reportedBy" in firstPage.json.items[0], false);

  const secondPage = await request(baseUrl, "/api/items/search?page=2&pageSize=1");
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.json.items.length, 1);
  assert.notEqual(firstPage.json.items[0]._id, secondPage.json.items[0]._id);

  const invalidPage = await request(baseUrl, "/api/items/search?page=0");
  assert.equal(invalidPage.status, 400);
});

test("logout revokes the existing session cookie", async (t) => {
  const testApp = buildTestApp();
  const server = testApp.listen(0);
  t.after(() => server.close());

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const registration = await request(baseUrl, "/api/auth/register", {
    method: "POST",
    ...jsonRequest({
      studentId: 505,
      name: "Jamie Fox",
      email: "jamie@example.com",
      password: "securepass123"
    })
  });
  const logout = await request(baseUrl, "/api/auth/logout", {
    method: "POST",
    headers: { cookie: registration.cookie }
  });
  assert.equal(logout.status, 200);

  const profile = await request(baseUrl, "/api/profile", {
    headers: { cookie: registration.cookie }
  });
  assert.equal(profile.status, 401);
});

test("matching reports create one authenticated-user notification", async (t) => {
  const testApp = buildTestApp();
  const server = testApp.listen(0);
  t.after(() => server.close());

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const registration = await request(baseUrl, "/api/auth/register", {
    method: "POST",
    ...jsonRequest({
      studentId: 606,
      name: "Taylor Reed",
      email: "taylor@example.com",
      password: "securepass123"
    })
  });
  const authCookie = { cookie: registration.cookie };

  const lostReport = await request(baseUrl, "/api/items", {
    method: "POST",
    ...jsonRequest({
      itemName: "Black wallet",
      category: "Accessories",
      color: "Black",
      reportType: "lost",
      location: "Library"
    }, authCookie)
  });
  const foundReport = await request(baseUrl, "/api/items", {
    method: "POST",
    ...jsonRequest({
      itemName: "Black wallet",
      category: "Accessories",
      color: "Black",
      reportType: "found",
      location: "Library"
    }, authCookie)
  });
  assert.equal(lostReport.status, 201);
  assert.equal(foundReport.status, 201);
  assert.equal(foundReport.json.matchesCreated, 1);

  const profileMatches = await request(baseUrl, "/api/items/matches", {
    headers: authCookie
  });
  assert.equal(profileMatches.status, 200);
  assert.equal(profileMatches.json.totalMatches, 1);
  assert.equal(profileMatches.json.matches[0].matchScore, 100);
});

test("match confirmation accepts string-backed IDs from the in-memory test app", async (t) => {
  const testApp = buildTestApp();
  const server = testApp.listen(0);
  t.after(() => server.close());

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const registration = await request(baseUrl, "/api/auth/register", {
    method: "POST",
    ...jsonRequest({
      studentId: 707,
      name: "Jordan Lee",
      email: "jordan@example.com",
      password: "securepass123"
    })
  });
  const authCookie = { cookie: registration.cookie };

  await request(baseUrl, "/api/items", {
    method: "POST",
    ...jsonRequest({
      itemName: "Silver keychain",
      category: "Accessories",
      color: "Silver",
      reportType: "lost",
      location: "Cafe"
    }, authCookie)
  });
  await request(baseUrl, "/api/items", {
    method: "POST",
    ...jsonRequest({
      itemName: "Silver keychain",
      category: "Accessories",
      color: "Silver",
      reportType: "found",
      location: "Cafe"
    }, authCookie)
  });

  const matchList = await request(baseUrl, "/api/items/matches", {
    headers: authCookie
  });
  const matchId = matchList.json.matches[0]._id;
  const result = await request(baseUrl, `/api/items/matches/${matchId}/confirm`, {
    method: "PATCH",
    headers: { ...authCookie, "content-type": "application/json" },
    body: JSON.stringify({ userId: 707 })
  });

  assert.equal(result.status, 200);
  assert.match(result.json.message, /verified/i);
});

test("reporting as a different student is forbidden", async (t) => {
  const testApp = buildTestApp();
  const server = testApp.listen(0);
  t.after(() => server.close());

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const registration = await request(baseUrl, "/api/auth/register", {
    method: "POST",
    ...jsonRequest({
      studentId: 101,
      name: "Sam Lee",
      email: "sam@example.com",
      password: "securepass123"
    })
  });
  const result = await request(baseUrl, "/api/items", {
    method: "POST",
    ...jsonRequest({
      itemName: "Black wallet",
      category: "Accessories",
      color: "Black",
      reportType: "lost",
      location: "Library",
      reportedBy: 202
    }, { cookie: registration.cookie })
  });

  assert.equal(result.status, 403);
  assert.equal(result.json.message, "You can only report items for your own student ID.");
});
