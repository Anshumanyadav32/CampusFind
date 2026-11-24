import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { User } from "../models/User.js";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/CampusFind";

async function seedAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase().trim() : null;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminStudentIdRaw = process.env.ADMIN_STUDENT_ID;
  const adminName = process.env.ADMIN_NAME ? process.env.ADMIN_NAME.trim() : "System Administrator";

  // Enforce mandatory explicit environment variables without hardcoded fallbacks
  if (!adminEmail || !adminPassword || !adminStudentIdRaw) {
    console.error(
      "[SeedAdmin] ✕ Fatal Security Error: Missing required administrator seed credentials.\n" +
      "You must explicitly provide the following environment variables:\n" +
      "  - ADMIN_EMAIL (e.g. admin@campusfind.edu)\n" +
      "  - ADMIN_STUDENT_ID (e.g. 9999)\n" +
      "  - ADMIN_PASSWORD (min 8 chars with letters and numbers)\n" +
      "Refusing to execute with insecure defaults."
    );
    process.exit(1);
  }

  const adminStudentId = Number(adminStudentIdRaw);
  if (!Number.isInteger(adminStudentId) || adminStudentId <= 0) {
    console.error("[SeedAdmin] ✕ Fatal Error: ADMIN_STUDENT_ID must be a positive integer.");
    process.exit(1);
  }

  if (adminPassword.length < 8 || !/[a-zA-Z]/.test(adminPassword) || !/\d/.test(adminPassword)) {
    console.error("[SeedAdmin] ✕ Fatal Error: ADMIN_PASSWORD must be at least 8 characters long and contain both letters and digits.");
    process.exit(1);
  }

  console.log(`[SeedAdmin] Connecting to MongoDB: ${MONGO_URI}...`);
  await mongoose.connect(MONGO_URI);

  try {
    // Check if any administrator account already exists to prevent multiple unintended admin accounts
    const existingAdmins = await User.find({ role: "admin" });
    const isTargetAdmin = existingAdmins.some(
      (a) => a.studentId === adminStudentId || a.email.toLowerCase() === adminEmail
    );

    if (existingAdmins.length > 0 && !isTargetAdmin && process.env.ALLOW_MULTIPLE_ADMINS !== "true") {
      console.error(
        `[SeedAdmin] ✕ Safety Lock: An administrator account already exists (${existingAdmins[0].email}). ` +
        `Multiple administrator creation is blocked unless ALLOW_MULTIPLE_ADMINS=true is specified.`
      );
      process.exit(1);
    }

    // Check if an existing account matches the specified credentials
    const existingUser = await User.findOne({
      $or: [{ email: adminEmail }, { studentId: adminStudentId }]
    });

    const passwordHash = await bcrypt.hash(adminPassword, 10);

    if (existingUser) {
      // If user exists as a student, do not silently promote without explicit confirmation
      if (existingUser.role === "student" && process.env.PROMOTE_EXISTING_STUDENT !== "true") {
        console.error(
          `[SeedAdmin] ✕ Verification Required: User #${existingUser.studentId} (${existingUser.email}) exists as a student. ` +
          `Refusing to silently elevate student role to admin without verification. ` +
          `Set PROMOTE_EXISTING_STUDENT=true to confirm promotion.`
        );
        process.exit(1);
      }

      existingUser.role = "admin";
      existingUser.accountStatus = "active";
      existingUser.emailVerified = true;
      existingUser.name = adminName;
      existingUser.passwordHash = passwordHash;
      await existingUser.save();
      console.log(`[SeedAdmin] ✓ Administrator account #${existingUser.studentId} (${existingUser.email}) updated successfully.`);
    } else {
      const newAdmin = new User({
        studentId: adminStudentId,
        name: adminName,
        email: adminEmail,
        passwordHash,
        role: "admin",
        accountStatus: "active",
        emailVerified: true,
        sessionVersion: 0
      });
      await newAdmin.save();
      console.log(`[SeedAdmin] ✓ Initial Administrator created successfully: #${adminStudentId} (${adminEmail})`);
    }
  } catch (error) {
    console.error(`[SeedAdmin] ✕ Execution failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("[SeedAdmin] Disconnected.");
  }
}

// Only auto-run if executed directly via CLI
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("seedAdmin.js")) {
  seedAdmin().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { seedAdmin };
