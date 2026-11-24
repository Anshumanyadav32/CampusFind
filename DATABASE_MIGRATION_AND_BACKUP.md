# CampusFind: Database Migration & Backup Guide

This document outlines the data schema evolution, indexing strategy, backward compatibility guarantees, and backup & recovery procedures for **CampusFind**.

---

## 1. Schema Architecture & Evolution

CampusFind stores lost and found reports, user identities, and match correlations across three primary MongoDB collections:

### 1.1 `users` Collection
* **`studentId`** *(Number, Unique)*: Positive campus student identifier.
* **`name`** *(String)*: Full student name.
* **`email`** *(String, Unique)*: Verified campus email address.
* **`passwordHash`** *(String, Optional)*: Bcrypt hash (local authentication mode only).
* **`role`** *(String, Default: `"student"`)*: Role-based access control (`"student"` or `"admin"`).
* **`sessionVersion`** *(Number, Default: 0)*: Incremented on logout to atomically invalidate active JWT tokens.
* **`oidcIssuer` / `oidcSubject`** *(String, Optional)*: OpenID Connect identity provider claims for SSO.

### 1.2 `items` Collection
* **`itemName`** *(String, Max 100)*: Title of the reported item.
* **`category`** *(String)*: Normalized classification (Electronics, Accessories, Documents, Bottle, Clothing, Other).
* **`color`** *(String, Max 50)*: Primary item color.
* **`reportType`** *(String)*: Enum `["lost", "found"]`.
* **`location`** *(String, Max 150)*: Campus location where lost or found.
* **`reportedBy`** *(Number)*: Student ID of reporter. **Private: Excluded from public APIs.**
* **`status`** *(String)*: `["searching", "unclaimed", "pending", "returned", "closed"]`.
* **`dateReported`** *(Date)*: Timestamp when report was filed.
* **`publicImages`** *(Array of Strings)*: URLs to public item photos.
* **`identifyingMarks`** *(String, Max 500, Optional)*: **Private verification field.** Identifying scratches, engravings, or details kept hidden from the public to prevent fraudulent claims.
* **`serialNumber`** *(String, Max 100, Optional)*: **Private verification field.**
* **`verificationQuestion`** *(String, Max 250, Optional)*: Question that a claimant must answer to verify ownership.

### 1.3 `matches` Collection
* **`lostItemId` / `foundItemId`** *(Mixed: ObjectId or String)*: References to the correlated item pair.
* **`lostReportedBy` / `foundReportedBy`** *(Number)*: Student IDs of the two parties.
* **`matchScore`** *(Number 0–100)*: Confidence score calculated by the tokenized fuzzy matching engine.
* **`status`** *(String)*: Enum `["pending", "confirming", "confirmed", "disputed", "rejected", "duplicate"]`.
* **`claimHistory`** *(Array of Objects)*: Audit trail tracking every state transition:
  * `action`: `"match_created" | "claim_initiated" | "proof_submitted" | "confirmed" | "disputed" | "admin_resolved" | "rejected"`
  * `performedBy`: Student ID, Admin ID, or `"system"`
  * `role`: `"student" | "admin" | "system"`
  * `details`: Explanatory log or dispute note
  * `timestamp`: Date of action
* **`disputeReason` / `disputedBy` / `disputedAt`**: Populated when a user flags a dispute.
* **`resolvedBy` / `resolutionNotes` / `handoverLocation`**: Populated when an admin arbitrates a disputed claim.

---

## 2. Backward Compatibility Guarantees

* **Missing `role` field:** Existing user records without a `role` field automatically default to `"student"`.
* **Missing private verification fields:** Existing items without `identifyingMarks` or `verificationQuestion` function as standard public reports.
* **Missing `claimHistory`:** Existing match records without audit history default to `[]`.
* **String vs ObjectId:** Selectors and query builders accommodate both legacy string IDs (`"item-1"`) and standard MongoDB `ObjectId` types.

---

## 3. MongoDB Indexes Strategy

All indexes are created idempotently on server startup in `server.js`:

```javascript
// Users
db.users.createIndex({ studentId: 1 }, { unique: true, partialFilterExpression: { studentId: { $type: "number" } } });
db.users.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });
db.users.createIndex({ oidcIssuer: 1, oidcSubject: 1 }, { unique: true, partialFilterExpression: { oidcIssuer: { $type: "string" }, oidcSubject: { $type: "string" } } });
db.users.createIndex({ role: 1 });

// Items
db.items.createIndex({ reportType: 1, dateReported: -1 });
db.items.createIndex({ reportedBy: 1, dateReported: -1 });
db.items.createIndex({ category: 1, reportType: 1, status: 1 });
db.items.createIndex({ status: 1 });

// Matches (Atomic Uniqueness for Active Matches)
db.matches.createIndex(
  { lostItemId: 1, foundItemId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["pending", "confirming", "confirmed", "disputed"] }
    }
  }
);
db.matches.createIndex({ lostReportedBy: 1, status: 1 });
db.matches.createIndex({ foundReportedBy: 1, status: 1 });
db.matches.createIndex({ status: 1 });
```

### Search Indexing: Preservation of Partial Search
Blindly migrating to MongoDB Text Indexes (`$text`) was rejected because `$text` indexes strictly match whole words and stemmed tokens, which breaks partial searches (e.g., searching `"calc"` fails to find `"Calculator"`, or `"airp"` fails to find `"AirPods"`). 

CampusFind preserves partial substring search by pairing bounded, escaped regex queries with compound indexes (`reportType`, `status`, `category`) to ensure fast and flexible search without full-table scan degradation.

---

## 4. Automated Startup Cleanup & Handshake Recovery

1. **Duplicate Archive:** The server automatically scans for duplicate `(lostItemId, foundItemId)` match pairs created under earlier code versions, keeping the primary match and marking extra entries as `{ status: "duplicate", duplicateOf: primaryId }`.
2. **Interrupted Confirmation Recovery:** If a match was in the middle of confirmation when a crash or restart occurred, `server.js` verifies both linked item reports and safely resumes the confirmation.

---

## 5. Database Backup and Recovery Procedure

### 5.1 Manual Backup (`mongodump`)

To generate a compressed archive backup of the CampusFind database:

```bash
# Backup with gzip archive
mongodump --uri="mongodb://127.0.0.1:27017/CampusFind" --archive="campusfind_backup_$(date +%Y%m%d_%H%M%S).gz" --gzip

# Windows PowerShell:
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
mongodump --uri="mongodb://127.0.0.1:27017/CampusFind" --archive="campusfind_backup_$timestamp.gz" --gzip
```

### 5.2 Manual Restore (`mongorestore`)

To restore from an archive backup:

```bash
# Restore with replacement of existing collections
mongorestore --uri="mongodb://127.0.0.1:27017/CampusFind" --archive="campusfind_backup_YYYYMMDD_HHMMSS.gz" --gzip --drop
```

### 5.3 Automated Nightly Backup Script

#### Linux / macOS (`cron`):
Create a script `/opt/campusfind/backup.sh`:
```bash
#!/bin/bash
BACKUP_DIR="/var/backups/campusfind"
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
FILENAME="$BACKUP_DIR/campusfind_$TIMESTAMP.gz"

mongodump --uri="mongodb://127.0.0.1:27017/CampusFind" --archive="$FILENAME" --gzip

# Retain backups for 14 days
find "$BACKUP_DIR" -type f -name "campusfind_*.gz" -mtime +14 -delete
```
Add to `crontab -e`:
```
0 2 * * * /opt/campusfind/backup.sh > /dev/null 2>&1
```

#### Windows (Task Scheduler):
Save `backup.ps1`:
```powershell
$BackupDir = "C:\CampusFindBackups"
if (!(Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir }
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$ArchiveFile = "$BackupDir\campusfind_$Timestamp.gz"

& mongodump --uri="mongodb://127.0.0.1:27017/CampusFind" --archive="$ArchiveFile" --gzip

# Clean up backups older than 14 days
Get-ChildItem -Path $BackupDir -Filter "campusfind_*.gz" | Where-Object { $_.CreationTime -lt (Get-Date).AddDays(-14) } | Remove-Item
```
Schedule `backup.ps1` to run daily in Windows Task Scheduler.

---

## 6. Private Evidence Storage & Audit Security Architecture

### 6.1 Private Evidence Directory Isolation
* **Public Directory (`backend/uploads/`):** Mounted statically on `/uploads`. Strictly restricted to public item photographs (`savePublicImages`). Magic byte verification ensures only JPEG, PNG, WebP, and GIF images are stored. PDFs are rejected.
* **Private Directory (`backend/uploads_private/`):** **NEVER** mounted on Express static routes. Used exclusively for sensitive ownership verification evidence (`savePrivateEvidence`): receipts, serial number cards, and private ID proof.
* **Unguessable Filenames:** Stored using 128-bit cryptographic random hexadecimal strings: `proof-<timestamp>-<randomHex>.<ext>`.
* **Access Control:** Streaming endpoint `GET /api/claims/proof/:filename` verifies:
  1. Valid student session cookie/token.
  2. Path traversal sanitization via `path.basename`.
  3. Authorization: Caller must be an authorized administrator or the genuine claimant/uploader recorded in `privateFiles` / `claims`. Unauthorized callers receive `403 Forbidden`.
  4. Security headers: `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'`.

### 6.2 Audit Log Immutability Note
* **Append-Only Operations:** The `auditLogs` collection only supports insert and read operations.
* **Route-Level Enforcement:** Any HTTP `POST`, `PUT`, `PATCH`, or `DELETE` attempt targeting `/api/admin/audit-logs` is explicitly intercepted and rejected with `405 Method Not Allowed`.
* **Honesty Statement:** Application-level append-only enforcement prevents modification or deletion through API routes. Database-level read-only permissions can be configured for deeper operational auditing.

### 6.3 Admin Seed Security
* Hardcoded fallback credentials have been completely removed from `backend/scripts/seedAdmin.js`.
* Explicit environment variables (`ADMIN_EMAIL`, `ADMIN_STUDENT_ID`, `ADMIN_PASSWORD`) are strictly required. Missing credentials result in an immediate fatal exit with code 1.
* Existing students are not automatically elevated to admin unless `PROMOTE_EXISTING_STUDENT=true` is set.
* Public registration (`/api/auth/register`) strictly assigns `role: "student"` without exceptions.

