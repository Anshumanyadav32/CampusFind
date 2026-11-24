import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    studentId: {
      type: Number,
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254
    },
    passwordHash: {
      type: String,
      default: null
    },
    role: {
      type: String,
      enum: ["student", "admin"],
      default: "student",
      index: true
    },
    accountStatus: {
      type: String,
      enum: ["active", "pending", "suspended", "deactivated"],
      default: "active",
      index: true
    },
    statusReason: {
      type: String,
      default: "",
      maxlength: 500
    },
    emailVerified: {
      type: Boolean,
      default: false
    },
    emailVerifiedAt: {
      type: Date,
      default: null
    },
    collegeEmailDomain: {
      type: String,
      default: null
    },
    suspendedAt: {
      type: Date,
      default: null
    },
    deactivatedAt: {
      type: Date,
      default: null
    },
    sessionVersion: {
      type: Number,
      default: 0
    },
    oidcIssuer: {
      type: String,
      default: null
    },
    oidcSubject: {
      type: String,
      default: null
    }
  },
  {
    timestamps: true,
    collection: "users"
  }
);

export const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
