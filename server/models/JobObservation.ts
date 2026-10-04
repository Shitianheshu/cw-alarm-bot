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
  jobId: number;
  title: string;
  categoryId: number;
  clientId: number;
  postedAt: Date;
  postedClock: string;
  firstSeenAt: Date;
  bidCountAtFirstSeen: number | null;
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
    jobId: { type: Number, required: true, unique: true, index: true },
    title: { type: String, default: "" },
    categoryId: { type: Number, default: 0 },
    clientId: { type: Number, default: 0 },
    postedAt: { type: Date, required: true, index: true },
    postedClock: { type: String, default: "" },
    firstSeenAt: { type: Date, default: () => new Date() },
    bidCountAtFirstSeen: { type: Number, default: null },
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

export default mongoose.model<JobObservationDocument>("job_observations", JobObservationSchema);
