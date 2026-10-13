/** Bid checkpoints measured from the moment a job is posted. */
export const BID_WINDOWS_MIN = [1, 2, 5, 10, 20, 30] as const;

/** Bids already visible at this minute are treated as bot bids. */
export const BOT_SAMPLE_MINUTE = 2;

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
 * Bids visible at the 2-minute mark are treated as bot bids (placed within 1–2 minutes).
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

/** `応募した人` / `契約した人` cells in the public job page status table. */
function applicationTableCount(html: string, label: string): number | null {
  const match = html.match(new RegExp(`${label}</th>\\s*<td>\\s*(\\d+)\\s*人`));
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isFinite(count) ? count : null;
}

/** Reads the public proposal count from a CrowdWorks job HTML page. */
export function parseBidCount(html: string): number | null {
  const fromTable = applicationTableCount(html, "応募した人");
  if (fromTable != null) return fromTable;
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

export function contractStatusFrom(text: string, contractCount: number | null): string {
  const value = text.toLowerCase();
  if (/contracted|契約済|契約済み/.test(value) || (contractCount != null && contractCount > 0)) return "contracted";
  if (/closed|expired|募集終了|終了/.test(value)) return "closed";
  if (/open|published|recruiting|募集中/.test(value) || contractCount === 0) return "open";
  return "unknown";
}

export function contractFromSearchItem(item: any): { contractCount: number | null; contractStatus: string } {
  const contractCount = asCount(item?.entry?.project_entry?.num_contracts)
    ?? asCount(item?.job_offer?.num_contracts)
    ?? asCount(item?.entry?.num_contracts);
  const statusText = String(
    item?.job_offer?.status
    ?? item?.job_offer?.job_offer_status
    ?? item?.entry?.project_entry?.status
    ?? "",
  );
  return { contractCount, contractStatus: contractStatusFrom(statusText, contractCount) };
}

/** Current bid count plus whether the job is still open or already contracted. */
/** Task-format jobs (アンケート etc.) show "完了件数 83 件 / 300 件 (作業中 34件)" instead of an applicant table. */
export function parseTaskCount(html: string): number | null {
  const at = html.indexOf("num_completed_tasks");
  if (at < 0) return null;
  const text = html.slice(at, at + 600).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const match = text.match(/(\d[\d,]*)\s*件\s*\/\s*\d[\d,]*\s*件(?:\s*[(（]\s*作業中\s*(\d[\d,]*)\s*件)?/);
  if (!match) return null;
  const done = Number(match[1].replace(/,/g, ""));
  const working = match[2] ? Number(match[2].replace(/,/g, "")) : 0;
  return done + working;
}

export function parseJobFacts(html: string): { bidCount: number | null; contractCount: number | null; contractStatus: string; taskJob?: boolean } {
  let contractCount: number | null = null;
  let statusText = "";
  const attr = html.match(/id="vue-container"[^>]*\sdata="([^"]+)"/) || html.match(/\sdata="([^"]+)"[^>]*id="vue-container"/);
  if (attr?.[1]) {
    try {
      const json = JSON.parse(decodeHtmlAttr(attr[1]));
      contractCount = findNamedCount(json, new Set(["num_contracts", "contract_count", "contracts_count"]));
      statusText = findStatusText(json);
    } catch {
      // Visible text below still applies.
    }
  }
  const contractedPeople = applicationTableCount(html, "契約した人");
  if (contractedPeople != null) contractCount = contractedPeople;
  if (/契約済|契約済み/.test(html)) statusText = statusText || "契約済み";
  else if (/募集終了|この仕事の募集は終了/.test(html)) statusText = statusText || "募集終了";
  else if (/募集中/.test(html)) statusText = statusText || "募集中";
  const bidCount = parseBidCount(html);
  const taskCount = bidCount == null ? parseTaskCount(html) : null;
  return {
    bidCount: bidCount ?? taskCount,
    contractCount,
    contractStatus: contractStatusFrom(statusText, contractCount),
    ...(taskCount != null ? { taskJob: true } : {}),
  };
}

function findNamedCount(node: unknown, keys: Set<string>, depth = 0): number | null {
  if (depth > 8 || node == null) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findNamedCount(item, keys, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(key.toLowerCase())) continue;
    const count = asCount(value);
    if (count != null) return count;
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const found = findNamedCount(value, keys, depth + 1);
      if (found != null) return found;
    }
  }
  return null;
}

function findStatusText(node: unknown, depth = 0): string {
  if (depth > 6 || node == null || typeof node !== "object") return "";
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findStatusText(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  const record = node as Record<string, unknown>;
  for (const key of ["status", "job_offer_status", "recruitment_status"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
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
