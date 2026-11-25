import mongoose from "mongoose";

const claimAuditSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      enum: [
        "claim_submitted",
        "under_review",
        "approved",
        "rejected",
        "withdrawn",
        "returned",
        "additional_evidence_required",
        "flagged",
        "note_added",
        "handover_confirmed"
      ]
    },
    performedBy: {
      type: mongoose.Schema.Types.Mixed,
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

const claimSchema = new mongoose.Schema(
  {
    itemId: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      index: true
    },
    matchId: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      index: true
    },
    claimantId: {
      type: Number,
      required: true,
      index: true
    },
    claimantName: {
      type: String,
      required: true,
      trim: true
    },
    claimantEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    additionalDetails: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: ""
    },
    verificationAnswers: {
      type: mongoose.Schema.Types.Mixed,
      default: []
    },
    proofFiles: {
      type: [String],
      default: []
    },
    evidenceFiles: {
      type: [String],
      default: []
    },
    riskScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    riskCategory: {
      type: String,
      enum: ["normal", "additional_review", "investigation"],
      default: "normal"
    },
    riskFactors: {
      type: [String],
      default: []
    },
    riskHistory: {
      type: mongoose.Schema.Types.Mixed,
      default: []
    },
    verificationAttemptCount: {
      type: Number,
      default: 0
    },
    verificationMatchScore: {
      type: Number,
      default: null
    },
    adminReviewedBy: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    adminRemarks: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: ""
    },
    reviewedAt: {
      type: Date,
      default: null
    },
    handoverOtpHash: {
      type: String,
      default: null
    },
    handoverOtpExpiresAt: {
      type: Date,
      default: null
    },
    handoverOtpAttempts: {
      type: Number,
      default: 0
    },
    handoverOtpIssuedAt: {
      type: Date,
      default: null
    },
    handoverOtpEmailStatus: {
      type: String,
      enum: ["pending", "sent", "failed", "smtp_not_configured"],
      default: "pending"
    },
    handoverOtpEmailError: {
      type: String,
      default: ""
    },
    handoverOtpEncrypted: {
      type: String,
      default: null
    },
    handoverConfirmedBy: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    status: {
      type: String,
      enum: ["pending", "under_review", "additional_evidence_required", "approved", "rejected", "withdrawn", "flagged", "returned"],
      default: "pending",
      index: true
    },
    reviewedBy: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    reviewDate: {
      type: Date,
      default: null
    },
    reviewNotes: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: ""
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: ""
    },
    handoverLocation: {
      type: String,
      trim: true,
      default: ""
    },
    handoverDate: {
      type: Date,
      default: null
    },
    claimHistory: {
      type: [claimAuditSchema],
      default: []
    }
  },
  {
    timestamps: true,
    collection: "claims"
  }
);

export const Claim = mongoose.models.Claim || mongoose.model("Claim", claimSchema);
export default Claim;
