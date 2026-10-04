/** Bid checkpoints measured from the moment a job is posted. */
export const BID_WINDOWS_MIN = [1, 3, 5, 10, 20, 30] as const;

export type BidWindowMin = (typeof BID_WINDOWS_MIN)[number];

export interface CheckpointDraft {
  minute: BidWindowMin;
  dueAt: Date;
  checkedAt: Date | null;
  bidCount: number | null;
  missed: boolean;
  attempts: number;
}

const BID_COUNT_KEYS = new Set([
  "number_of_proposals",
  "num_proposals",
  "proposal_count",
  "proposals_count",
  "proposal_num",
  "num_proposal",
  "entry_count",
  "entries_count",
  "number_of_entries",
  "num_entries",
  "application_count",
  "applications_count",
  "number_of_applications",
  "num_applications",
  "applicant_count",
  "applicants_count",
]);

/** "1,2,5,10" → sorted unique minutes. Empty or invalid input falls back. */
export function parseMinuteList(raw: string | undefined, fallback: number[]): number[] {
  const source = raw != null && raw.trim() !== "" ? raw : fallback.join(",");
  const nums = source
    .split(/[^0-9]+/)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 24 * 60)
    .map((n) => Math.floor(n));
  const unique = nums.filter((n, i) => nums.indexOf(n) === i).sort((a, b) => a - b);
  return unique.length ? unique : fallback;
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function parsePostedAt(raw: unknown): Date | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const withSeconds = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(s) ? `${s}:00` : s;
    const d = new Date(`${withSeconds.replace(" ", "T")}+09:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `YYYY-MM-DD HH:mm:ss` in Asia/Tokyo. */
export function formatTokyo(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

export function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Bids visible at the 3-minute mark are treated as bot bids (placed within 1–3 minutes).
 * `approx` is the median of the busiest 20% of those jobs (each bot bids at most once).
 * `atLeast` is the busiest single job, a lower bound on bots that raced the same posting.
 */
export function estimateActiveBots(counts: number[]): {
  approx: number | null;
  atLeast: number | null;
  sampleJobs: number;
} {
  if (!counts.length) return { approx: null, atLeast: null, sampleJobs: 0 };
  const sorted = [...counts].sort((a, b) => b - a);
  const topN = Math.max(1, Math.min(sorted.length, Math.ceil(sorted.length * 0.2)));
  const mid = median(sorted.slice(0, topN));
  return {
    approx: mid == null ? null : Math.round(mid),
    atLeast: sorted[0],
    sampleJobs: counts.length,
  };
}

export function buildCheckpoints(postedAt: Date, seenAt: Date, toleranceMs: number): CheckpointDraft[] {
  return BID_WINDOWS_MIN.map((minute) => {
    const dueAt = new Date(postedAt.getTime() + minute * 60_000);
    const missed = dueAt.getTime() + toleranceMs < seenAt.getTime();
    return { minute, dueAt, checkedAt: null, bidCount: null, missed, attempts: 0 };
  });
}

export function nextCheckpointAt(checkpoints: { dueAt: Date; checkedAt: Date | null; missed: boolean }[]): Date | null {
  let next: Date | null = null;
  for (const cp of checkpoints) {
    if (cp.checkedAt || cp.missed) continue;
    if (!next || cp.dueAt < next) next = cp.dueAt;
  }
  return next;
}

export function watchStatusOf(checkpoints: { checkedAt: Date | null; missed: boolean }[]): "scheduled" | "complete" | "historical" {
  if (checkpoints.some((cp) => !cp.checkedAt && !cp.missed)) return "scheduled";
  if (checkpoints.some((cp) => cp.checkedAt)) return "complete";
  return "historical";
}

export function decodeHtmlAttr(encoded: string): string {
  return encoded
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x5C;/g, "\\")
    .replace(/&#x60;/g, "`")
    .replace(/&#x3D;/g, "=");
}

function asCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 100_000) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    if (n >= 0 && n < 100_000) return n;
  }
  return null;
}

function findBidCountInJson(node: unknown, depth = 0): number | null {
  if (depth > 8 || node == null) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findBidCountInJson(item, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (!BID_COUNT_KEYS.has(key.toLowerCase())) continue;
    const count = asCount(value);
    if (count != null) return count;
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const found = findBidCountInJson(value, depth + 1);
      if (found != null) return found;
    }
  }
  return null;
}

/** Reads the public proposal count from a CrowdWorks job HTML page. */
export function parseBidCount(html: string): number | null {
  if (/この仕事への応募はまだありません|応募した人はいません|まだ応募はありません/.test(html)) return 0;

  const attr = html.match(/id="vue-container"[^>]*\sdata="([^"]+)"/) || html.match(/\sdata="([^"]+)"[^>]*id="vue-container"/);
  if (attr?.[1]) {
    try {
      const json = JSON.parse(decodeHtmlAttr(attr[1]));
      const fromJson = findBidCountInJson(json);
      if (fromJson != null) return fromJson;
    } catch {
      // Fall through to visible text.
    }
  }

  const patterns = [
    /応募した人(?:は|：|:)?\s*(\d+)\s*人/,
    /(\d+)\s*人が応募/,
    /応募数\s*(?:[:：]|は)?\s*(\d+)/,
    /"(?:number_of_proposals|proposal_count|num_proposals)"\s*:\s*(\d+)/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

export function bidCountFromSearchItem(item: any): number | null {
  const candidates = [
    item?.entry?.project_entry?.num_proposals,
    item?.entry?.project_entry?.proposal_count,
    item?.entry?.num_proposals,
    item?.entry?.proposal_count,
    item?.job_offer?.proposal_count,
    item?.job_offer?.number_of_proposals,
    item?.proposal_count,
    item?.number_of_proposals,
  ];
  for (const candidate of candidates) {
    const count = asCount(candidate);
    if (count != null) return count;
  }
  return findBidCountInJson(item?.entry) ?? findBidCountInJson(item?.job_offer);
}

export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
