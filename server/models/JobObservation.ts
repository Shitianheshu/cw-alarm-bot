import mongoose, { Document } from "mongoose";
import type { BidWindowMin } from "@Server/service/marketStats";

export interface CheckpointRecord {
  minute: BidWindowMin;
  dueAt: Date;
  checkedAt: Date | null;
  bidCount: number | null;
  missed: boolean;
  attempts: number;
}

export interface JobObservationDocument extends Document {
  source: "crowdworks" | "coconala" | "lancers";
  jobId: number;
  title: string;
  categoryId: number;
  clientId: number;
  clientName: string;
  clientUrl: string;
  clientRating: number | null;
  clientReviewCount: number | null;
  clientReview: string;
  clientFetchedAt: Date | null;
  clientFetchAttempts: number;
  postedAt: Date;
  postedClock: string;
  firstSeenAt: Date;
  bidCountAtFirstSeen: number | null;
  bidCount: number | null;
  bidFetchedAt: Date | null;
  bidCheckedAt: Date | null;
  bidFetchAttempts: number;
  bidNotifiedAt: Date | null;
  newAlertAt: Date | null;
  jobKind: string;
  description: string;
  descriptionFetchedAt: Date | null;
  descriptionAttempts: number;
  bidDraft: string;
  bidDraftAt: Date | null;
  bidDraftEngine: string;
  contractCount: number | null;
  contractStatus: string;
  payType: string;
  priceMin: number | null;
  priceMax: number | null;
  checkpoints: CheckpointRecord[];
  nextCheckpointAt: Date | null;
  watchStatus: "scheduled" | "complete" | "historical";
}

const CheckpointSchema = new mongoose.Schema<CheckpointRecord>(
  {
    minute: { type: Number, required: true },
    dueAt: { type: Date, required: true },
    checkedAt: { type: Date, default: null },
    bidCount: { type: Number, default: null },
    missed: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
  },
  { _id: false }
);

const JobObservationSchema = new mongoose.Schema<JobObservationDocument>(
  {
    source: { type: String, default: "crowdworks", index: true },
    jobId: { type: Number, required: true, index: true },
    title: { type: String, default: "" },
    categoryId: { type: Number, default: 0 },
    clientId: { type: Number, default: 0 },
    clientName: { type: String, default: "" },
    clientUrl: { type: String, default: "" },
    clientRating: { type: Number, default: null },
    clientReviewCount: { type: Number, default: null },
    clientReview: { type: String, default: "" },
    clientFetchedAt: { type: Date, default: null },
    clientFetchAttempts: { type: Number, default: 0 },
    postedAt: { type: Date, required: true, index: true },
    postedClock: { type: String, default: "" },
    firstSeenAt: { type: Date, default: () => new Date() },
    bidCountAtFirstSeen: { type: Number, default: null },
    bidCount: { type: Number, default: null },
    bidFetchedAt: { type: Date, default: null },
    bidCheckedAt: { type: Date, default: null },
    bidFetchAttempts: { type: Number, default: 0 },
    bidNotifiedAt: { type: Date, default: null },
    newAlertAt: { type: Date, default: null, index: true },
    jobKind: { type: String, default: "" },
    description: { type: String, default: "" },
    descriptionFetchedAt: { type: Date, default: null },
    descriptionAttempts: { type: Number, default: 0 },
    bidDraft: { type: String, default: "" },
    bidDraftAt: { type: Date, default: null },
    bidDraftEngine: { type: String, default: "" },
    contractCount: { type: Number, default: null },
    contractStatus: { type: String, default: "unknown" },
    payType: { type: String, default: "" },
    priceMin: { type: Number, default: null },
    priceMax: { type: Number, default: null },
    checkpoints: { type: [CheckpointSchema], default: [] },
    nextCheckpointAt: { type: Date, default: null, index: true },
    watchStatus: {
      type: String,
      enum: ["scheduled", "complete", "historical"],
      default: "historical",
      index: true,
    },
  },
  { timestamps: true }
);

JobObservationSchema.index({ source: 1, jobId: 1 }, { unique: true });

const JobObservation = mongoose.model<JobObservationDocument>("job_observations", JobObservationSchema);

export async function ensureObservationIndexes(): Promise<void> {
  await JobObservation.updateMany({ source: { $exists: false } }, { $set: { source: "crowdworks" } });
  const groups = await JobObservation.aggregate<{ _id: { source: string; jobId: number }; n: number }>([
    { $group: { _id: { source: "$source", jobId: "$jobId" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  for (const group of groups) {
    const docs = await JobObservation.find({ source: group._id.source, jobId: group._id.jobId }).sort({ updatedAt: -1 }).select("_id");
    const extra = docs.slice(1).map((doc) => doc._id);
    if (extra.length) await JobObservation.deleteMany({ _id: { $in: extra } });
  }
  const indexes = await JobObservation.collection.indexes();
  const legacy = indexes.find((index) => index.name === "jobId_1" && index.unique);
  if (legacy) await JobObservation.collection.dropIndex("jobId_1");
  await JobObservation.syncIndexes();
}

export default JobObservation;
