import mongoose from "mongoose";

const itemSchema = new mongoose.Schema(
  {
    itemName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },
    category: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      index: true
    },
    color: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50
    },
    reportType: {
      type: String,
      enum: ["lost", "found"],
      required: true,
      index: true
    },
    location: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150
    },
    reportedBy: {
      type: Number,
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: ["searching", "unclaimed", "pending", "returned", "closed"],
      default: function () {
        return this.reportType === "lost" ? "searching" : "unclaimed";
      },
      index: true
    },
    dateReported: {
      type: Date,
      default: Date.now,
      index: true
    },
    // Public display information
    publicImages: {
      type: [String],
      default: []
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: ""
    },
    // Private ownership verification fields - protected from public APIs
    identifyingMarks: {
      type: String,
      trim: true,
      maxlength: 500,
      default: ""
    },
    serialNumber: {
      type: String,
      trim: true,
      maxlength: 100,
      default: ""
    },
    verificationQuestion: {
      type: String,
      trim: true,
      maxlength: 250,
      default: ""
    },
    verificationQuestions: {
      type: [String],
      default: []
    },
    brand: {
      type: String,
      trim: true,
      maxlength: 100,
      default: ""
    },
    model: {
      type: String,
      trim: true,
      maxlength: 100,
      default: ""
    },
    accessories: {
      type: String,
      trim: true,
      maxlength: 500,
      default: ""
    },
    physicalDamage: {
      type: String,
      trim: true,
      maxlength: 500,
      default: ""
    },
    moderationStatus: {
      type: String,
      enum: ["active", "flagged", "removed"],
      default: "active",
      index: true
    },
    moderationReason: {
      type: String,
      default: "",
      maxlength: 500
    },
    privateImages: {
      type: [String],
      default: []
    },
    approvedClaimId: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    contactPhone: {
      type: String,
      trim: true,
      maxlength: 30,
      default: ""
    }
  },
  {
    timestamps: true,
    collection: "items"
  }
);

export const Item = mongoose.models.Item || mongoose.model("Item", itemSchema);
export default Item;
