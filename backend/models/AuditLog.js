import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      index: true
    },
    adminName: {
      type: String,
      default: "Administrator"
    },
    adminRole: {
      type: String,
      default: "admin"
    },
    action: {
      type: String,
      required: true,
      index: true
    },
    targetUserId: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      index: true
    },
    targetClaimId: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      index: true
    },
    targetItemId: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      index: true
    },
    previousStatus: {
      type: String,
      default: null
    },
    newStatus: {
      type: String,
      default: null
    },
    reason: {
      type: String,
      trim: true,
      default: ""
    },
    details: {
      type: String,
      trim: true,
      default: ""
    },
    ipAddress: {
      type: String,
      default: ""
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: "auditLogs"
  }
);

export const AuditLog = mongoose.models.AuditLog || mongoose.model("AuditLog", auditLogSchema);
export default AuditLog;
