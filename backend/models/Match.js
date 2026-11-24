import mongoose from "mongoose";

const claimAuditSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      enum: [
        "match_created",
        "claim_initiated",
        "proof_submitted",
        "confirmed",
        "disputed",
        "admin_resolved",
        "rejected"
      ]
    },
    performedBy: {
      type: mongoose.Schema.Types.Mixed, // studentId (Number) or "system"
      required: true
    },
    role: {
      type: String,
      enum: ["student", "admin", "system"],
      default: "student"
    },
    details: {
      type: String,
      default: ""
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  },
  { _id: false }
);

const matchSchema = new mongoose.Schema(
  {
    lostItemId: {
      type: mongoose.Schema.Types.Mixed, // ObjectId or String for flexible environments
      required: true,
      index: true
    },
    foundItemId: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      index: true
    },
    lostReportedBy: {
      type: Number,
      required: true,
      index: true
    },
    foundReportedBy: {
      type: Number,
      required: true,
      index: true
    },
    matchScore: {
      type: Number,
      required: true,
      min: 0,
      max: 100
    },
    status: {
      type: String,
      enum: ["pending", "confirming", "confirmed", "disputed", "rejected", "duplicate"],
      default: "pending",
      index: true
    },
    confirmedBy: {
      type: Number,
      default: null
    },
    confirmedAt: {
      type: Date,
      default: null
    },
    confirmationStartedAt: {
      type: Date,
      default: null
    },
    disputeReason: {
      type: String,
      default: ""
    },
    disputedBy: {
      type: Number,
      default: null
    },
    disputedAt: {
      type: Date,
      default: null
    },
    resolvedBy: {
      type: Number,
      default: null
    },
    resolutionNotes: {
      type: String,
      default: ""
    },
    handoverLocation: {
      type: String,
      default: ""
    },
    duplicateOf: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    claimHistory: {
      type: [claimAuditSchema],
      default: []
    }
  },
  {
    timestamps: true,
    collection: "matches"
  }
);

export const Match = mongoose.models.Match || mongoose.model("Match", matchSchema);
export default Match;
