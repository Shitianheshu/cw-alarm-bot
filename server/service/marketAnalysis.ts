import JobObservation, { ensureObservationIndexes } from "@Server/models/JobObservation";
import {
  fetchCoconalaJobs,
  fetchJobContent,
  fetchLancersJobs,
  fetchSourceFacts,
  isScamClient,
  jobUrl,
  parseCrowdworksContent,
  sourceLabel,
  type ListedJob,
} from "@Server/service/marketSources";
import { cwGet, cwProxyLabel } from "@Server/utils/cwHttp";
import { sendMessage } from "@Server/telegram";
import { delay } from "@Server/utils";
import { getClientInfo } from "@Server/service/clientScraper";
import {
  BID_WINDOWS_MIN,
  BOT_SAMPLE_MINUTE,
  contractFromSearchItem,
  parseJobFacts,
  buildCheckpoints,
  csvEscape,
  decodeHtmlAttr,
  escapeHtml,
  estimateActiveBots,
  formatTokyo,
  intEnv,
  nextCheckpointAt,
  parseMinuteList,
  parsePostedAt,
  watchStatusOf,
  type CheckpointDraft,
} from "@Server/service/marketStats";

const SEARCH_URL = "https://crowdworks.jp/public/jobs/search";

export interface ObservedJobInput {
  source?: "crowdworks" | "coconala" | "lancers";
  id: number;
  title?: string;
  categoryId?: number;
  clientId?: number;
  clientName?: string;
  clientUrl?: string;
  clientRating?: number | null;
  postedDate?: string;
  postedAt?: Date | null;
  historical?: boolean;
  bidCount?: number | null;
  contractCount?: number | null;
  contractStatus?: string;
  payType?: string;
  priceMin?: number | null;
  priceMax?: number | null;
}

export interface MarketReport {
  generatedAt: string;
  lookbackHours: number;
  maxJobs: number;
  from: string;
  to: string;
  totalJobs: number;
  truncated: boolean;
  contracts: { status: string; count: number }[];
  knownBids: { jobs: number; average: number | null };
  byHour: { hour: string; count: number }[];
  checkpoints: { minute: number; jobs: number; totalBids: number; avgBids: number }[];
  bots: {
    sampleJobs: number;
    approx: number | null;
    atLeast: number | null;
    windowMinutes: number;
    definition: string;
  };
  recent: {
    source: string;
    jobId: number;
    title: string;
    postedClock: string;
    jobUrl: string;
    clientId: number;
    clientName: string;
    clientUrl: string;
    clientRating: number | null;
    clientReviewCount: number | null;
    clientReview: string;
    bidCount: number | null;
    contractCount: number | null;
    contractStatus: string;
    payType: string;
    priceMin: number | null;
    priceMax: number | null;
    scam: boolean;
    bidUpdatedAt: string | null;
    jobKind: string;
    bids: Record<string, number | "missed" | null>;
    missReasons: Record<string, string>;
  }[];
  watching: boolean;
  scanning: boolean;
  alarm: boolean;
  alarmMinutes: number[];
  lastError: string | null;
}

let scanRunning = false;
let lastTruncated = false;
let lastError: string | null = null;
let watchTimer: NodeJS.Timeout | null = null;
let checkpointTimer: NodeJS.Timeout | null = null;
let alarmTimer: NodeJS.Timeout | null = null;
let alarmBusy = false;
const alarmLastSent = new Map<number, number>();
let checkpointBusy = false;
let clientBusy = false;
let bidBusy = false;
let loggedSearchShape = false;
const clientCache = new Map<number, { name: string; rating: number | null; reviewCount: number | null; review: string }>();

function jobLink(jobId: number, source = "crowdworks"): string {
  return jobUrl(source, jobId);
}

function employerLink(clientId: number): string {
  return clientId > 0 ? `https://crowdworks.jp/public/employers/${clientId}` : "";
}

function bidLabel(checkpoints: { minute: number; missed?: boolean; bidCount?: number | null; checkedAt?: Date | null }[] | undefined): string {
  return BID_WINDOWS_MIN.map((minute) => {
    const cp = (checkpoints || []).find((item) => item.minute === minute);
    if (!cp) return `${minute}m pending`;
    if (cp.missed) return `${minute}m missed`;
    if (cp.bidCount == null || !cp.checkedAt) return `${minute}m pending`;
    return `${minute}m ${cp.bidCount}`;
  }).join(", ");
}

function settings() {
  return {
    lookbackHours: intEnv("ANALYSIS_LOOKBACK_HOURS", 24),
    maxJobs: intEnv("ANALYSIS_MAX_JOBS", 100_000),
    pageDelayMs: intEnv("ANALYSIS_PAGE_DELAY_MS", 350),
    pollMs: intEnv("ANALYSIS_POLL_MS", 20_000),
    concurrency: intEnv("ANALYSIS_CHECKPOINT_CONCURRENCY", 5),
    toleranceMs: intEnv("ANALYSIS_CHECKPOINT_TOLERANCE_SEC", 50) * 1000,
    botWindowMinutes: intEnv("ANALYSIS_BOT_WINDOW_MINUTES", 60),
    watchLimit: intEnv("ANALYSIS_WATCH_LIMIT", 2000),
    alarmMinutes: parseMinuteList(process.env.ANALYSIS_ALARM_MINUTES, [1, 2, 5, 10, 20, 30]),
  };
}

function notifyChatId(): number {
  const raw = process.env.ANALYSIS_CHAT_ID || process.env.ADMIN_ID || "";
  const id = Number(raw);
  return Number.isFinite(id) ? id : 0;
}

async function notify(text: string): Promise<void> {
  const id = notifyChatId();
  if (!id) return;
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > 3500) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  for (const chunk of chunks) {
    await sendMessage(id, chunk);
    await delay(400);
  }
}

function parseSearchHtml(html: string): any[] {
  const attr = html.match(/id="vue-container"[^>]*\sdata="([^"]+)"/);
  if (!attr?.[1]) throw new Error("CrowdWorks search page has no job list");
  const json = JSON.parse(decodeHtmlAttr(attr[1]));
  const jobs = json?.searchResult?.job_offers;
  if (!Array.isArray(jobs)) throw new Error("CrowdWorks search JSON has no job_offers");
  if (!loggedSearchShape && jobs[0]) {
    loggedSearchShape = true;
    const sample = jobs[0];
    console.log("[market] search job_offer keys", Object.keys(sample.job_offer || {}));
    console.log("[market] search entry", JSON.stringify(sample.entry || {}).slice(0, 600));
  }
  return jobs;
}

function yen(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function priceFromSearchItem(item: any): { payType: string; priceMin: number | null; priceMax: number | null } {
  const fixed = item?.payment?.fixed_price_payment;
  const hourly = item?.payment?.hourly_payment;
  if (fixed) {
    const priceMin = yen(fixed.min_budget);
    const priceMax = yen(fixed.max_budget) ?? priceMin;
    return { payType: "fixed", priceMin, priceMax };
  }
  if (hourly) {
    const priceMin = yen(hourly.min_hourly_wage);
    const priceMax = yen(hourly.max_hourly_wage) ?? priceMin;
    return { payType: "hourly", priceMin, priceMax };
  }
  return { payType: "", priceMin: null, priceMax: null };
}

function toObserved(item: any): ObservedJobInput | null {
  const job = item?.job_offer || {};
  const id = Number(job.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    title: String(job.title || ""),
    categoryId: Number(job.category_id ?? 0) || 0,
    clientId: Number(item?.client?.user_id ?? 0) || 0,
    clientName: String(item?.client?.username || item?.client?.display_name || ""),
    postedDate: String(job.last_released_at || ""),
    bidCount: null,
    ...contractFromSearchItem(item),
    ...priceFromSearchItem(item),
  };
}

async function fetchSearchPage(page: number): Promise<ObservedJobInput[]> {
  const response = await cwGet(SEARCH_URL, {
    params: { order: "new", page },
  });
  if (response.status === 403) {
    throw new Error(`CrowdWorks returned 403 (${cwProxyLabel()}). The scan could not read public job listings.`);
  }
  if (response.status !== 200) throw new Error(`CrowdWorks search failed with status ${response.status}`);
  return parseSearchHtml(String(response.data)).map(toObserved).filter((job): job is ObservedJobInput => job != null);
}

function missReason(cp: { dueAt: Date; attempts?: number }, firstSeenMs: number, toleranceMs: number): string {
  const dueMs = new Date(cp.dueAt).getTime();
  if (firstSeenMs && dueMs + toleranceMs < firstSeenMs) return "The job was found after this minute had passed.";
  if ((cp.attempts || 0) > 0) return `The job page could not be read in time (${cp.attempts} tries; proxy or site error).`;
  return "The check started too late (server busy or restarting).";
}

/** Latest listing bid count per Lancers/Coconala job, so minute checks can use it without a page read. */
const listingSnapshots = new Map<string, { bidCount: number; seenAt: number }>();
const LISTING_WAIT_MS = 25_000;
const CHECKPOINT_RETRY_MS = 5_000;

function rememberListing(source: string, jobs: Array<ObservedJobInput | ListedJob>, seenAt: Date) {
  if (source === "crowdworks") return;
  for (const job of jobs) {
    if (job.bidCount != null) listingSnapshots.set(`${source}:${job.id}`, { bidCount: job.bidCount, seenAt: seenAt.getTime() });
  }
  if (listingSnapshots.size > 5000) {
    const cutoff = Date.now() - 60 * 60_000;
    listingSnapshots.forEach((snap, key) => {
      if (snap.seenAt < cutoff) listingSnapshots.delete(key);
    });
  }
}

async function saveObservedJobs(jobs: Array<ObservedJobInput | ListedJob>, seenAt: Date, opts?: { notifyNew?: boolean }): Promise<number> {
  if (!jobs.length) return 0;
  const cfg = settings();
  const source = jobs[0]?.source || "crowdworks";
  rememberListing(source, jobs, seenAt);
  const ids = jobs.map((job) => job.id);
  const existingDocs = await JobObservation.find({ source, jobId: { $in: ids } }).select("jobId").lean();
  const existingIds = new Set(existingDocs.map((doc) => doc.jobId));
  const scheduledCount = await JobObservation.countDocuments({ watchStatus: "scheduled" });
  let scheduledRoom = Math.max(0, cfg.watchLimit - scheduledCount);

  const inserts: Record<string, unknown>[] = [];
  const freshAlarms: Record<string, unknown>[] = [];
  const updates: { updateOne: { filter: { source: string; jobId: number }; update: { $set: Record<string, unknown> } } }[] = [];

  for (const job of jobs) {
    const postedAt = job.postedAt ?? parsePostedAt(job.postedDate) ?? seenAt;
    const postedClock = formatTokyo(postedAt);
    if (existingIds.has(job.id)) {
      updates.push({
        updateOne: {
          filter: { source, jobId: job.id },
          update: {
            $set: {
              title: job.title || "",
              categoryId: job.categoryId || 0,
              clientId: job.clientId || 0,
              ...(job.clientName ? { clientName: job.clientName } : {}),
              ...(job.clientUrl ? { clientUrl: job.clientUrl } : job.clientId ? { clientUrl: employerLink(job.clientId) } : {}),
              ...(job.clientRating != null ? { clientRating: job.clientRating, clientFetchedAt: seenAt } : {}),
              ...(job.postedAt || job.postedDate ? { postedAt, postedClock } : {}),
              ...(source !== "crowdworks" && job.bidCount != null ? { bidCount: job.bidCount, bidFetchedAt: seenAt, bidCheckedAt: seenAt } : {}),
              ...(job.contractCount != null ? { contractCount: job.contractCount } : {}),
              ...(job.contractStatus && job.contractStatus !== "unknown" ? { contractStatus: job.contractStatus } : {}),
              ...(job.payType ? { payType: job.payType, priceMin: job.priceMin ?? null, priceMax: job.priceMax ?? null } : {}),
            },
          },
        },
      });
      continue;
    }

    let checkpoints = buildCheckpoints(postedAt, seenAt, cfg.toleranceMs);
    if (job.historical || scheduledRoom <= 0) {
      checkpoints = checkpoints.map((cp) => ({ ...cp, missed: true }));
    } else if (watchStatusOf(checkpoints) === "scheduled") {
      scheduledRoom -= 1;
    }
    const status = watchStatusOf(checkpoints);
    const alarm = Boolean(opts?.notifyNew && !job.historical);
    inserts.push({
      source,
      jobId: job.id,
      title: job.title || "",
      categoryId: job.categoryId || 0,
      clientId: job.clientId || 0,
      clientName: job.clientName || "",
      clientUrl: job.clientUrl || employerLink(job.clientId || 0),
      clientRating: job.clientRating ?? null,
      clientFetchedAt: source === "crowdworks" ? null : seenAt,
      postedAt,
      postedClock,
      firstSeenAt: seenAt,
      bidCountAtFirstSeen: source === "crowdworks" ? null : job.bidCount ?? null,
      bidCount: source === "crowdworks" ? null : job.bidCount ?? null,
      bidFetchedAt: source !== "crowdworks" && job.bidCount != null ? seenAt : null,
      bidCheckedAt: source !== "crowdworks" && job.bidCount != null ? seenAt : null,
      bidFetchAttempts: 0,
      bidNotifiedAt: job.historical || job.bidCount != null ? seenAt : null,
      contractCount: job.contractCount ?? null,
      contractStatus: job.contractStatus || "unknown",
      payType: job.payType || "",
      priceMin: job.priceMin ?? null,
      priceMax: job.priceMax ?? null,
      checkpoints,
      nextCheckpointAt: nextCheckpointAt(checkpoints),
      watchStatus: status,
      newAlertAt: alarm ? seenAt : null,
    });
    if (alarm) freshAlarms.push(inserts[inserts.length - 1]);
  }

  if (inserts.length) {
    try {
      await JobObservation.insertMany(inserts, { ordered: false });
    } catch (error: any) {
      const message = String(error?.message || "");
      if (error?.code !== 11000 && error?.name !== "MongoBulkWriteError" && !message.includes("E11000")) throw error;
    }
    for (const row of freshAlarms) {
      enqueueProjectNotice(formatProjectNotice(row, "New job"));
      console.log(`[market] new job ${row.source} ${row.jobId}`);
    }
  }
  if (updates.length) await JobObservation.bulkWrite(updates, { ordered: false });
  return inserts.length;
}

export async function recordLiveJob(job: ObservedJobInput): Promise<void> {
  if (!job?.id) return;
  await saveObservedJobs([job], new Date(), { notifyNew: true });
}

export interface NewJobAlert {
  source: string;
  jobId: number;
  title: string;
  jobUrl: string;
  postedClock: string;
  alertAt: string;
  clientName: string;
  clientUrl: string;
  bidCount: number | null;
  payType: string;
  priceMin: number | null;
  priceMax: number | null;
  scam: boolean;
}

export async function listNewJobAlerts(opts: { since?: Date | null; limit?: number } = {}): Promise<{ now: string; alerts: NewJobAlert[] }> {
  const now = new Date();
  const limit = Math.min(Math.max(opts.limit || 30, 1), 100);
  const filter: Record<string, unknown> = opts.since && !Number.isNaN(opts.since.getTime())
    ? { newAlertAt: { $gt: opts.since } }
    : { newAlertAt: { $ne: null } };
  const docs = await JobObservation.find(filter)
    .sort({ newAlertAt: -1 })
    .limit(limit)
    .select("source jobId title postedClock newAlertAt clientName clientUrl bidCount payType priceMin priceMax")
    .lean();
  return {
    now: now.toISOString(),
    alerts: docs.map((doc: any) => ({
      source: doc.source || "crowdworks",
      jobId: doc.jobId,
      title: doc.title || "",
      jobUrl: jobLink(doc.jobId, doc.source || "crowdworks"),
      postedClock: doc.postedClock || "",
      alertAt: new Date(doc.newAlertAt).toISOString(),
      clientName: doc.clientName || "",
      clientUrl: doc.clientUrl || "",
      bidCount: doc.bidCount ?? null,
      payType: doc.payType || "",
      priceMin: doc.priceMin ?? null,
      priceMax: doc.priceMax ?? null,
      scam: isScamClient(doc.clientName, doc.clientUrl),
    })),
  };
}

const primedSources = new Set<string>();

async function ingestListed(source: "lancers" | "coconala", load: () => Promise<ListedJob[]>): Promise<void> {
  const jobs = await load();
  const historical = !primedSources.has(source);
  primedSources.add(source);
  const seenAt = new Date();
  await saveObservedJobs(historical ? jobs.map((job) => ({ ...job, historical: true })) : jobs, seenAt, { notifyNew: true });
  console.log(`[market] ${sourceLabel(source)} page kept ${jobs.length}${historical ? " (first read, minute checks skipped)" : ""}`);
}

async function ingestFirstPage(): Promise<void> {
  const extras = Promise.allSettled([
    ingestListed("lancers", fetchLancersJobs),
    ingestListed("coconala", fetchCoconalaJobs),
  ]);
  try {
    const jobs = await fetchSearchPage(1);
    await saveObservedJobs(jobs, new Date(), { notifyNew: true });
  } finally {
    const settled = await extras;
    for (const item of settled) {
      if (item.status === "rejected") console.error("[market] listing:", item.reason?.message || item.reason);
    }
  }
}

function watchErrorMessage(error: any): string {
  const raw = String(error?.message || "Watch poll failed");
  if (/aborted|socket hang up|ECONNRESET/i.test(raw)) {
    return `Proxy ${cwProxyLabel()} closed the CrowdWorks connection. The next check will try again.`;
  }
  if (/ETIMEDOUT|ECONNREFUSED/.test(raw)) {
    return `Proxy ${cwProxyLabel()} did not answer (${raw}). CrowdWorks was not requested.`;
  }
  return raw;
}

function isTransientWatchError(error: any): boolean {
  return /aborted|socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(String(error?.message || ""));
}

export function startMarketWatch(): { started: boolean; message: string } {
  if (watchTimer) return { started: false, message: "Market watch is already running." };
  const pollMs = settings().pollMs;
  const tick = () => {
    void (async () => {
      try {
        await ingestFirstPage();
        lastError = null;
        return;
      } catch (error: any) {
        if (!isTransientWatchError(error)) {
          const message = watchErrorMessage(error);
          if (message !== lastError) console.error("[market] watch poll failed:", message);
          lastError = message;
          return;
        }
      }
      try {
        await delay(1500);
        await ingestFirstPage();
        lastError = null;
      } catch (error: any) {
        const message = watchErrorMessage(error);
        if (message !== lastError) console.error("[market] watch poll failed:", message);
        lastError = message;
      }
    })();
  };
  tick();
  watchTimer = setInterval(tick, pollMs);
  return { started: true, message: `Market watch started. New jobs are checked every ${Math.round(pollMs / 1000)} seconds.` };
}

export function stopMarketWatch(): { stopped: boolean; message: string } {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  return { stopped: true, message: "Market watch stopped. Bid checks already scheduled will continue." };
}

export function getMarketStatus() {
  const cfg = settings();
  return {
    watching: watchTimer != null,
    scanning: scanRunning,
    lastError,
    lastTruncated,
    lookbackHours: cfg.lookbackHours,
    maxJobs: cfg.maxJobs,
    botWindowMinutes: cfg.botWindowMinutes,
    watchLimit: cfg.watchLimit,
    alarm: alarmTimer != null,
    alarmMinutes: cfg.alarmMinutes,
  };
}

function resolveReportRange(input?: number | { hours?: number; from?: string; to?: string }): {
  since: Date;
  now: Date;
  lookbackHours: number;
} {
  const cfg = settings();
  const hours = typeof input === "number" ? input : input?.hours;
  let from = typeof input === "object" && input?.from ? parsePostedAt(input.from) : null;
  let to = typeof input === "object" && input?.to ? parsePostedAt(input.to) : null;
  if (to && typeof input === "object" && input?.to && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(input.to.trim())) {
    to = new Date(to.getTime() + 59_999);
  }
  if (from && to && from.getTime() > to.getTime()) {
    const swap = from;
    from = to;
    to = swap;
  }
  const now = to ?? new Date();
  if (from && from.getTime() <= now.getTime()) {
    const spanHours = Math.max(1, Math.ceil((now.getTime() - from.getTime()) / 3_600_000));
    return { since: from, now, lookbackHours: spanHours };
  }
  const lookbackHours = hours && hours > 0 ? Math.floor(hours) : cfg.lookbackHours;
  return { since: new Date(now.getTime() - lookbackHours * 60 * 60 * 1000), now, lookbackHours };
}

export async function buildMarketReport(hours?: number | { hours?: number; from?: string; to?: string }): Promise<MarketReport> {
  const cfg = settings();
  const { since, now, lookbackHours } = resolveReportRange(hours);

  const [totalJobs, byHourRows, checkpointRows, recentDocs, contractRows, bidRows, botDocs] = await Promise.all([
    JobObservation.countDocuments({ postedAt: { $gte: since, $lte: now } }),
    JobObservation.aggregate<{ _id: string; count: number }>([
      { $match: { postedAt: { $gte: since, $lte: now } } },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d %H:00", date: "$postedAt", timezone: "Asia/Tokyo" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    JobObservation.aggregate<{ _id: number; jobs: number; totalBids: number; avgBids: number }>([
      { $match: { postedAt: { $gte: since, $lte: now }, jobKind: { $ne: "task" } } },
      { $unwind: "$checkpoints" },
      { $match: { "checkpoints.missed": false, "checkpoints.bidCount": { $ne: null } } },
      {
        $group: {
          _id: "$checkpoints.minute",
          jobs: { $sum: 1 },
          totalBids: { $sum: "$checkpoints.bidCount" },
          avgBids: { $avg: "$checkpoints.bidCount" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    JobObservation.find({ postedAt: { $gte: since, $lte: now } })
      .sort({ postedAt: -1 })
      .limit(5000)
      .select("source jobId title postedClock firstSeenAt checkpoints clientId clientName clientUrl clientRating clientReviewCount clientReview bidCount bidFetchedAt jobKind contractCount contractStatus payType priceMin priceMax")
      .lean(),
    JobObservation.aggregate<{ _id: string; count: number }>([
      { $match: { postedAt: { $gte: since, $lte: now } } },
      { $group: { _id: { $ifNull: ["$contractStatus", "unknown"] }, count: { $sum: 1 } } },
    ]),
    JobObservation.aggregate<{ jobs: number; average: number | null }>([
      { $match: { postedAt: { $gte: since, $lte: now }, bidCount: { $ne: null } } },
      { $group: { _id: null, jobs: { $sum: 1 }, average: { $avg: "$bidCount" } } },
    ]),
    JobObservation.find({
      postedAt: { $gte: new Date(now.getTime() - cfg.botWindowMinutes * 60_000), $lte: now },
      jobKind: { $ne: "task" },
      checkpoints: { $elemMatch: { minute: BOT_SAMPLE_MINUTE, missed: false, bidCount: { $ne: null } } },
    })
      .select("checkpoints")
      .lean(),
  ]);

  const botCounts = botDocs.map((doc) => {
    const cp = (doc.checkpoints || []).find((item) => item.minute === BOT_SAMPLE_MINUTE && !item.missed && item.bidCount != null);
    return cp?.bidCount ?? 0;
  });
  const bots = estimateActiveBots(botCounts);

  return {
    generatedAt: now.toISOString(),
    lookbackHours,
    maxJobs: cfg.maxJobs,
    from: formatTokyo(since),
    to: formatTokyo(now),
    totalJobs,
    truncated: lastTruncated,
    contracts: contractRows.map((row) => ({ status: row._id || "unknown", count: row.count })),
    knownBids: {
      jobs: bidRows[0]?.jobs ?? 0,
      average: bidRows[0]?.average == null ? null : Math.round(bidRows[0].average * 10) / 10,
    },
    byHour: byHourRows.map((row) => ({ hour: row._id, count: row.count })),
    checkpoints: BID_WINDOWS_MIN.map((minute) => {
      const row = checkpointRows.find((item) => item._id === minute);
      return {
        minute,
        jobs: row?.jobs ?? 0,
        totalBids: row?.totalBids ?? 0,
        avgBids: row ? Math.round(row.avgBids * 10) / 10 : 0,
      };
    }),
    bots: {
      sampleJobs: bots.sampleJobs,
      approx: bots.approx,
      atLeast: bots.atLeast,
      windowMinutes: cfg.botWindowMinutes,
      definition: "Bids confirmed at 2 minutes after posting are treated as bots (placed within 1–2 minutes).",
    },
    recent: recentDocs.map((doc) => {
      const bids: Record<string, number | "missed" | null> = {};
      const missReasons: Record<string, string> = {};
      const seenMs = doc.firstSeenAt ? new Date(doc.firstSeenAt).getTime() : 0;
      for (const cp of doc.checkpoints || []) {
        if (cp.missed) {
          bids[String(cp.minute)] = "missed";
          missReasons[String(cp.minute)] = missReason(cp, seenMs, cfg.toleranceMs);
        }
        else if (cp.bidCount != null && cp.checkedAt) bids[String(cp.minute)] = cp.bidCount;
        else bids[String(cp.minute)] = null;
      }
      return {
        source: doc.source || "crowdworks",
        jobId: doc.jobId,
        title: doc.title || "",
        postedClock: doc.postedClock || "",
        jobUrl: jobLink(doc.jobId, doc.source || "crowdworks"),
        clientId: doc.clientId || 0,
        clientName: doc.clientName || "",
        clientUrl: doc.clientUrl || employerLink(doc.clientId || 0),
        clientRating: doc.clientRating ?? null,
        clientReviewCount: doc.clientReviewCount ?? null,
        clientReview: doc.clientReview || "",
        bidCount: doc.bidCount ?? null,
        contractCount: doc.contractCount ?? null,
        contractStatus: doc.contractStatus || "unknown",
        payType: doc.payType || "",
        priceMin: doc.priceMin ?? null,
        priceMax: doc.priceMax ?? null,
        scam: isScamClient(doc.clientName, doc.clientUrl),
        bidUpdatedAt: doc.bidFetchedAt ? new Date(doc.bidFetchedAt).toISOString() : null,
        jobKind: doc.jobKind || "",
        bids,
        missReasons,
      };
    }),
    watching: watchTimer != null,
    scanning: scanRunning,
    alarm: alarmTimer != null,
    alarmMinutes: cfg.alarmMinutes,
    lastError,
  };
}

function formatJobCard(job: {
  source?: string;
  jobId: number;
  title?: string;
  postedClock?: string;
  clientId?: number;
  clientName?: string;
  clientUrl?: string;
  clientRating?: number | null;
  clientReviewCount?: number | null;
  clientReview?: string;
  bidCount?: number | null;
  contractCount?: number | null;
  contractStatus?: string;
  payType?: string;
  priceMin?: number | null;
  priceMax?: number | null;
  checkpoints?: { minute: number; missed?: boolean; bidCount?: number | null; checkedAt?: Date | null }[];
  bids?: Record<string, number | "missed" | null>;
}): string {
  const title = escapeHtml(job.title || "Untitled job");
  const clientName = escapeHtml(job.clientName || (job.clientId ? `Client ${job.clientId}` : "Unknown client"));
  const clientHref = job.clientUrl || employerLink(job.clientId || 0);
  const rating =
    job.clientRating == null
      ? "Rating: not loaded yet"
      : `Rating: ${job.clientRating} (${job.clientReviewCount ?? 0} reviews)`;
  const review = job.clientReview
    ? `Latest review: ${escapeHtml(job.clientReview)}`
    : "Latest review: none";
  const low = job.priceMin ?? job.priceMax;
  const high = job.priceMax ?? job.priceMin;
  const yen = (n: number) => `¥${n.toLocaleString("en-US")}`;
  const unit = job.payType === "hourly" ? "/h" : "";
  const price =
    low == null || high == null
      ? "Price: unknown"
      : `Price: ${low === high ? `${yen(low)}${unit}` : `${yen(low)}–${yen(high)}${unit}`}`;
  const bids = job.checkpoints
    ? bidLabel(job.checkpoints)
    : BID_WINDOWS_MIN.map((minute) => {
        const value = job.bids?.[String(minute)];
        if (value == null) return `${minute}m pending`;
        if (value === "missed") return `${minute}m missed`;
        return `${minute}m ${value}`;
      }).join(", ");
  const link = jobLink(job.jobId, job.source || "crowdworks");
  const scam = isScamClient(job.clientName, job.clientUrl) ? "⚠️ <b>SCAM CLIENT</b> · " : "";
  return [
    `${scam}<b>${escapeHtml(sourceLabel(job.source || "crowdworks"))}</b> · <b>${title}</b>`,
    `Posted: ${escapeHtml(job.postedClock || "")}`,
    `Job: <a href="${link}">${link}</a>`,
    clientHref ? `Client: <a href="${clientHref}">${clientName}</a>` : `Client: ${clientName}`,
    rating,
    review,
    price,
    `Bid count: ${job.bidCount == null ? "unknown" : job.bidCount}`,
    `Contract: ${escapeHtml(job.contractStatus || "unknown")}${job.contractCount == null ? "" : ` (${job.contractCount})`}`,
    `Bids by minute: ${bids}`,
  ].join("\n");
}

let noticeChain: Promise<void> = Promise.resolve();

function enqueueProjectNotice(text: string): void {
  if (process.env.ANALYSIS_ALARM === "false") return;
  noticeChain = noticeChain
    .then(async () => {
      await notify(text);
      await delay(800);
    })
    .catch((error) => console.error("[market] project notice:", error));
}

function formatProjectNotice(doc: any, headline: string): string {
  return [
    `<b>${escapeHtml(headline)}</b>`,
    "",
    formatJobCard({
      source: doc.source,
      jobId: doc.jobId,
      title: doc.title,
      postedClock: doc.postedClock,
      clientId: doc.clientId,
      clientName: doc.clientName,
      clientUrl: doc.clientUrl,
      clientRating: doc.clientRating,
      clientReviewCount: doc.clientReviewCount,
      clientReview: doc.clientReview,
      bidCount: doc.bidCount,
      contractCount: doc.contractCount,
      contractStatus: doc.contractStatus,
      payType: doc.payType,
      priceMin: doc.priceMin,
      priceMax: doc.priceMax,
      checkpoints: doc.checkpoints,
    }),
  ].join("\n");
}

function notifyHoursMs(): number {
  return intEnv("ANALYSIS_NOTIFY_HOURS", 6) * 60 * 60 * 1000;
}

function formatReport(report: MarketReport): string {
  const hourLines = report.byHour.length
    ? report.byHour.map((row) => `• ${row.hour}  ${row.count.toLocaleString("en-US")} jobs`).join("\n")
    : "• No timestamps yet";
  const recentLines = report.recent.slice(0, 8).map((job) => formatJobCard(job));
  const bidLines = report.checkpoints
    .map((row) => `• ${row.minute} min: average ${row.avgBids} (${row.totalBids.toLocaleString("en-US")} bids across ${row.jobs.toLocaleString("en-US")} jobs)`)
    .join("\n");
  const botLine =
    report.bots.approx == null
      ? "No 2-minute samples yet. Another report will be sent after the watch has been running for a few minutes."
      : `About <b>${report.bots.approx}</b> bots (max ${report.bots.atLeast} on one job, ${report.bots.sampleJobs} jobs in the last ${report.bots.windowMinutes} minutes)`;
  const capNote = report.truncated
    ? `\nThe scan hit the cap of ${report.maxJobs.toLocaleString("en-US")} jobs, so this can be less than the full 24 hours.`
    : "";

  return [
    `<b>CW market report (last ${report.lookbackHours} hours)</b>`,
    `${escapeHtml(report.from)} to ${escapeHtml(report.to)} (Tokyo)`,
    "",
    "<b>1. Jobs posted</b>",
    `${report.totalJobs.toLocaleString("en-US")} jobs (cap ${report.maxJobs.toLocaleString("en-US")})${capNote}`,
    "",
    "<b>Posts by hour (Tokyo)</b>",
    hourLines,
    "",
    "<b>Latest jobs</b>",
    recentLines.length ? recentLines.join("\n\n") : "• None",
    "Every job, with its link, client, review, and bid counts, is in the admin CSV.",
    "",
    "<b>2. Bids after posting</b>",
    bidLines,
    "",
    "<b>3. Active bidding bots</b>",
    botLine,
    "A bid counted at 2 minutes is treated as a bot bid (placed within 1–2 minutes). One bid per bot per job.",
  ].join("\n");
}

export async function publishMarketReport(hours?: number): Promise<MarketReport> {
  const report = await buildMarketReport(hours);
  await notify(formatReport(report));
  return report;
}

export function scanRecentJobs(opts?: { hours?: number; maxJobs?: number; notify?: boolean }): { started: boolean; message: string } {
  if (scanRunning) return { started: false, message: "A scan is already running." };
  const cfg = settings();
  const hours = opts?.hours && opts.hours > 0 ? Math.floor(opts.hours) : cfg.lookbackHours;
  const maxJobs = opts?.maxJobs && opts.maxJobs > 0 ? Math.min(Math.floor(opts.maxJobs), 500_000) : cfg.maxJobs;
  const shouldNotify = opts?.notify !== false;
  scanRunning = true;
  lastError = null;

  void runScan(hours, maxJobs, shouldNotify).catch((error) => {
    lastError = error?.message || "Scan failed";
    console.error("[market] scan failed:", error);
  });

  return {
    started: true,
    message: `Started a ${hours}-hour scan (cap ${maxJobs.toLocaleString("en-US")} jobs). The report will be sent on Telegram when it finishes.`,
  };
}

async function runScan(hours: number, maxJobs: number, shouldNotify: boolean): Promise<void> {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const pageDelayMs = settings().pageDelayMs;
  let page = 1;
  let collected = 0;
  let truncated = false;
  let previousFirstId = 0;
  lastTruncated = false;

  try {
    while (collected < maxJobs && page <= 20_000) {
      const seenAt = new Date();
      const jobs = await fetchSearchPage(page);
      if (!jobs.length) break;
      if (jobs[0].id === previousFirstId) break;
      previousFirstId = jobs[0].id;

      const inWindow = jobs.filter((job) => {
        const postedAt = parsePostedAt(job.postedDate);
        return postedAt != null && postedAt.getTime() >= cutoff;
      });
      const room = maxJobs - collected;
      const slice = inWindow.slice(0, room);
      if (slice.length) {
        await saveObservedJobs(slice, seenAt);
        collected += slice.length;
      }

      const oldest = parsePostedAt(jobs[jobs.length - 1].postedDate);
      console.log(`[market] page ${page} kept ${slice.length} (running total ${collected})`);
      if (collected >= maxJobs) {
        truncated = true;
        break;
      }
      if (oldest && oldest.getTime() < cutoff) break;
      if (!oldest && inWindow.length === 0) break;
      page += 1;
      await delay(pageDelayMs);
    }

    lastTruncated = truncated;
    console.log(`[market] scan finished. collected=${collected} truncated=${truncated}`);
    if (shouldNotify) await publishMarketReport(hours);
  } catch (error: any) {
    const message = error?.message || "Scan failed";
    lastError = message;
    if (shouldNotify) {
      await notify(`<b>CW market scan failed</b>\n${escapeHtml(message)}`);
    }
    throw error;
  } finally {
    scanRunning = false;
  }
}

let loggedBidMiss = false;

type JobFacts = { bidCount: number | null; contractCount: number | null; contractStatus: string; taskJob?: boolean; content?: string };

function applyFacts(doc: any, facts: JobFacts | null) {
  if (!facts) return;
  if (facts.contractCount != null) doc.contractCount = facts.contractCount;
  if (facts.contractStatus !== "unknown") doc.contractStatus = facts.contractStatus;
  if (facts.taskJob) doc.jobKind = "task";
  if (facts.content) {
    doc.description = facts.content;
    doc.descriptionFetchedAt = new Date();
  }
}

export async function fetchPublicJobFacts(
  jobId: number,
  source = "crowdworks",
  timeoutMs = 20_000,
): Promise<JobFacts | null> {
  if (source === "lancers" || source === "coconala") {
    const { bidCount, content } = await fetchSourceFacts(source, jobId);
    return { bidCount, contractCount: null, contractStatus: "unknown", content };
  }
  const response = await cwGet(`https://crowdworks.jp/public/jobs/${jobId}`, {
    timeout: timeoutMs,
  });
  if (response.status !== 200) return null;
  const html = String(response.data);
  const facts: JobFacts = { ...parseJobFacts(html), content: parseCrowdworksContent(html) };
  if (facts.bidCount == null && !loggedBidMiss) {
    loggedBidMiss = true;
    console.warn(`[market] bid count not found on job ${jobId}`);
  }
  return facts;
}

/** Saved description, or a live read when none is stored yet. */
export async function getJobContent(source: string, jobId: number): Promise<{ content: string; fetchedAt: string | null; cached: boolean }> {
  const doc = await JobObservation.findOne({ source, jobId }).select("description descriptionFetchedAt");
  if (doc?.description) {
    return { content: doc.description, fetchedAt: doc.descriptionFetchedAt?.toISOString() ?? null, cached: true };
  }
  const content = await fetchJobContent(source, jobId);
  if (!content) throw new Error("The job page has no description.");
  if (doc) {
    doc.description = content;
    doc.descriptionFetchedAt = new Date();
    await doc.save();
  }
  return { content, fetchedAt: new Date().toISOString(), cached: false };
}

let contentBusy = false;

/** Stores descriptions for recent jobs while their pages are still public. */
async function fillMissingContent(): Promise<void> {
  if (contentBusy) return;
  contentBusy = true;
  try {
    const docs = await JobObservation.find({
      postedAt: { $gte: new Date(Date.now() - 6 * 60 * 60_000) },
      description: { $in: ["", null] },
      $and: [
        { $or: [{ descriptionAttempts: { $lt: 3 } }, { descriptionAttempts: { $exists: false } }] },
        // CrowdWorks pages are already read at the 1-minute check, which stores the description.
        { $or: [{ source: { $ne: "crowdworks" } }, { postedAt: { $lte: new Date(Date.now() - 3 * 60_000) } }] },
      ],
    })
      .sort({ postedAt: -1 })
      .limit(1);
    for (const doc of docs) {
      try {
        const content = await fetchJobContent(doc.source || "crowdworks", doc.jobId);
        if (content) {
          doc.description = content;
          doc.descriptionFetchedAt = new Date();
        } else {
          doc.descriptionAttempts = (doc.descriptionAttempts || 0) + 1;
        }
      } catch (error: any) {
        doc.descriptionAttempts = (doc.descriptionAttempts || 0) + 1;
        console.error(`[market] description failed for ${doc.source} ${doc.jobId}:`, error?.message || error);
      }
      await doc.save();
    }
  } catch (error) {
    console.error("[market] descriptions:", error);
  } finally {
    contentBusy = false;
  }
}

async function processOneCheckpoint(doc: any): Promise<void> {
  const now = Date.now();
  const toleranceMs = settings().toleranceMs;
  let checkpoints = (doc.checkpoints || []) as CheckpointDraft[];
  const have = checkpoints.map((cp) => cp.minute).sort((a, b) => a - b).join(",");
  const want = [...BID_WINDOWS_MIN].join(",");
  const anyChecked = checkpoints.some((cp) => cp.checkedAt);
  if (have !== want && !anyChecked && doc.postedAt) {
    checkpoints = buildCheckpoints(new Date(doc.postedAt), doc.firstSeenAt ? new Date(doc.firstSeenAt) : new Date(), toleranceMs);
    doc.checkpoints = checkpoints;
  }
  const due: CheckpointDraft[] = [];

  for (const cp of checkpoints) {
    if (cp.checkedAt || cp.missed) continue;
    if (new Date(cp.dueAt).getTime() > now) continue;
    if (now - new Date(cp.dueAt).getTime() > toleranceMs) cp.missed = true;
    else due.push(cp);
  }

  if (due.length) {
    const source = doc.source || "crowdworks";
    let count: number | null = null;
    let checkedAt = new Date();
    let facts: JobFacts | null = null;
    const snap = source === "crowdworks" ? undefined : listingSnapshots.get(`${source}:${doc.jobId}`);
    const snapFits = snap != null && due.every((cp) => {
      const dueMs = new Date(cp.dueAt).getTime();
      return snap.seenAt >= dueMs && snap.seenAt <= dueMs + toleranceMs;
    });
    const earliestDue = Math.min(...due.map((cp) => new Date(cp.dueAt).getTime()));

    if (snap && snapFits) {
      count = snap.bidCount;
      checkedAt = new Date(snap.seenAt);
    } else if (source !== "crowdworks" && now < earliestDue + LISTING_WAIT_MS) {
      doc.nextCheckpointAt = new Date(now + 3_000);
      doc.watchStatus = "scheduled";
      doc.markModified("checkpoints");
      await doc.save();
      return;
    } else {
      try {
        facts = await fetchPublicJobFacts(doc.jobId, source, 12_000);
        count = facts?.bidCount ?? null;
      } catch (error: any) {
        console.error(`[market] bid fetch failed for ${source} ${doc.jobId}:`, error?.message || error);
        count = null;
      }
      checkedAt = new Date();
    }

    if (count == null) {
      let retry = false;
      for (const cp of due) {
        cp.attempts = (cp.attempts || 0) + 1;
        const stillInWindow = Date.now() + CHECKPOINT_RETRY_MS <= new Date(cp.dueAt).getTime() + toleranceMs;
        if (cp.attempts >= 5 || !stillInWindow) cp.missed = true;
        else retry = true;
      }
      if (retry) {
        doc.nextCheckpointAt = new Date(Date.now() + CHECKPOINT_RETRY_MS);
        doc.watchStatus = "scheduled";
        doc.markModified("checkpoints");
        await doc.save();
        return;
      }
    } else {
      for (const cp of due) {
        cp.bidCount = count;
        cp.checkedAt = checkedAt;
      }
      doc.bidCount = count;
      doc.bidFetchedAt = checkedAt;
      doc.bidCheckedAt = checkedAt;
      doc.bidFetchAttempts = 0;
      doc.bidNotifiedAt = checkedAt;
      applyFacts(doc, facts);
      const minutes = due.map((cp) => cp.minute).join(", ");
      enqueueProjectNotice(formatProjectNotice(doc, `Bid count at ${minutes} min`));
    }
  }

  doc.nextCheckpointAt = nextCheckpointAt(checkpoints);
  doc.watchStatus = watchStatusOf(checkpoints);
  doc.markModified("checkpoints");
  await doc.save();
}

export async function processDueCheckpoints(): Promise<void> {
  if (checkpointBusy) return;
  checkpointBusy = true;
  try {
    const due = await JobObservation.find({
      watchStatus: "scheduled",
      nextCheckpointAt: { $lte: new Date() },
    })
      .sort({ nextCheckpointAt: 1 })
      .limit(settings().concurrency);

    await Promise.all(due.map((doc) => processOneCheckpoint(doc)));
  } finally {
    checkpointBusy = false;
  }
}

async function formatAlarmSlice(minutes: number): Promise<string> {
  const since = new Date(Date.now() - minutes * 60_000);
  const recentSince = new Date(Date.now() - 40 * 60_000);
  const [total, recent, sampled] = await Promise.all([
    JobObservation.countDocuments({ postedAt: { $gte: since } }),
    JobObservation.find({ postedAt: { $gte: since } })
      .sort({ postedAt: -1 })
      .limit(12)
      .select("source jobId title postedClock checkpoints clientId clientName clientUrl clientRating clientReviewCount clientReview bidCount contractCount contractStatus payType priceMin priceMax")
      .lean(),
    JobObservation.find({
      postedAt: { $gte: recentSince },
      jobKind: { $ne: "task" },
      checkpoints: { $elemMatch: { checkedAt: { $gte: since }, missed: false, bidCount: { $ne: null } } },
    })
      .select("checkpoints")
      .limit(300)
      .lean(),
  ]);

  const sums = new Map<number, { jobs: number; bids: number }>();
  const botCounts: number[] = [];
  for (const doc of sampled) {
    for (const cp of doc.checkpoints || []) {
      if (cp.missed || cp.bidCount == null || !cp.checkedAt) continue;
      if (new Date(cp.checkedAt).getTime() < since.getTime()) continue;
      const cur = sums.get(cp.minute) || { jobs: 0, bids: 0 };
      cur.jobs += 1;
      cur.bids += cp.bidCount;
      sums.set(cp.minute, cur);
      if (cp.minute === BOT_SAMPLE_MINUTE) botCounts.push(cp.bidCount);
    }
  }

  if (total === 0 && sums.size === 0 && minutes < 5) return "";

  const cards = recent.length
    ? recent.map((job) => formatJobCard(job)).join("\n\n")
    : "No new jobs.";
  const hidden = total > recent.length ? `\n\n${total - recent.length} more jobs are in the admin page and CSV.` : "";
  const bidLines = BID_WINDOWS_MIN.flatMap((minute) => {
    const row = sums.get(minute);
    if (!row) return [];
    const avg = Math.round((row.bids / row.jobs) * 10) / 10;
    return [`• ${minute} min: average ${avg} (${row.jobs} jobs)`];
  });
  const lines = [
    `<b>CW analysis alarm (last ${minutes} min)</b>`,
    `New jobs: <b>${total.toLocaleString("en-US")}</b>`,
    "",
    cards + hidden,
  ];
  if (bidLines.length) {
    lines.push("", "<b>Average bids after posting</b>", bidLines.join("\n"));
  }
  if (minutes >= 5) {
    const bots = estimateActiveBots(botCounts);
    lines.push(
      "",
      "<b>Active bots</b>",
      bots.approx == null
        ? "No 2-minute samples in this slice yet."
        : `About <b>${bots.approx}</b> (max ${bots.atLeast} on one job, ${bots.sampleJobs} jobs)`
    );
  }
  return lines.join("\n");
}

async function tickAnalysisAlarm(): Promise<void> {
  if (alarmBusy) return;
  const minutes = settings().alarmMinutes;
  const now = Date.now();
  const due = minutes.filter((minute) => now - (alarmLastSent.get(minute) ?? 0) >= minute * 60_000);
  if (!due.length) return;
  alarmBusy = true;
  try {
    const sections: string[] = [];
    for (const minute of due) {
      const section = await formatAlarmSlice(minute);
      if (section) sections.push(section);
      alarmLastSent.set(minute, Date.now());
    }
    if (sections.length) await notify(sections.join("\n\n"));
  } catch (error) {
    console.error("[market] analysis alarm:", error);
  } finally {
    alarmBusy = false;
  }
}

export function startAnalysisAlarm(): { started: boolean; message: string } {
  const minutes = settings().alarmMinutes;
  if (!watchTimer) startMarketWatch();
  if (alarmTimer) {
    return { started: false, message: `The analysis alarm is already running (every ${minutes.join(", ")} min).` };
  }
  const now = Date.now();
  for (const minute of minutes) alarmLastSent.set(minute, now);
  alarmTimer = setInterval(() => {
    tickAnalysisAlarm().catch((error) => console.error("[market] analysis alarm:", error));
  }, 15_000);
  console.log("[market] analysis alarm started", minutes.join(","));
  return {
    started: true,
    message: `Analysis alarm started. Telegram updates every ${minutes.join(", ")} minutes.`,
  };
}

export function stopAnalysisAlarm(): { stopped: boolean; message: string } {
  if (alarmTimer) {
    clearInterval(alarmTimer);
    alarmTimer = null;
  }
  return { stopped: true, message: "Analysis alarm stopped. Market watch is still running." };
}

async function fillMissingBidCounts(): Promise<void> {
  if (bidBusy) return;
  bidBusy = true;
  try {
    const docs = await JobObservation.find({
      bidFetchedAt: null,
      $or: [{ bidFetchAttempts: { $lt: 3 } }, { bidFetchAttempts: { $exists: false } }],
    })
      .sort({ postedAt: -1 })
      .limit(2);

    for (const doc of docs) {
      try {
        const facts = await fetchPublicJobFacts(doc.jobId, doc.source || "crowdworks");
        doc.bidCheckedAt = new Date();
        if (!facts || facts.bidCount == null) {
          doc.bidFetchAttempts = (doc.bidFetchAttempts || 0) + 1;
          if (doc.bidFetchAttempts >= 3) doc.bidFetchedAt = new Date();
          await doc.save();
          continue;
        }
        doc.bidCount = facts.bidCount;
        doc.bidFetchedAt = new Date();
        doc.bidFetchAttempts = 0;
        applyFacts(doc, facts);
        const postedMs = doc.postedAt ? new Date(doc.postedAt).getTime() : 0;
        const fresh = postedMs > 0 && Date.now() - postedMs <= notifyHoursMs() && !doc.bidNotifiedAt;
        if (fresh) doc.bidNotifiedAt = new Date();
        await doc.save();
        if (fresh) enqueueProjectNotice(formatProjectNotice(doc, "Bid count"));
      } catch (error: any) {
        console.error(`[market] bid page failed for ${doc.jobId}:`, error?.message || error);
        return;
      }
    }
  } catch (error) {
    console.error("[market] bid pages:", error);
  } finally {
    bidBusy = false;
  }
}

async function notifyStoredBidCounts(): Promise<void> {
  if (process.env.ANALYSIS_ALARM === "false") return;
  const since = new Date(Date.now() - notifyHoursMs());
  const docs = await JobObservation.find({
    postedAt: { $gte: since },
    bidCount: { $ne: null },
    bidNotifiedAt: null,
  })
    .sort({ postedAt: -1 })
    .limit(2);

  for (const doc of docs) {
    doc.bidNotifiedAt = new Date();
    await doc.save();
    enqueueProjectNotice(formatProjectNotice(doc, "Bid count"));
  }
}

function bidRefreshSettings() {
  const hours = Number(process.env.ANALYSIS_BID_REFRESH_HOURS);
  const minutes = Number(process.env.ANALYSIS_BID_REFRESH_MIN);
  const batch = Number(process.env.ANALYSIS_BID_REFRESH_BATCH);
  return {
    horizonMs: (Number.isFinite(hours) && hours > 0 ? hours : 2) * 60 * 60_000,
    fastMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : 3) * 60_000,
    batch: Number.isFinite(batch) && batch > 0 ? Math.min(Math.floor(batch), 10) : 4,
  };
}

let refreshBusy = false;

async function refreshOneBidCount(doc: any): Promise<void> {
  doc.bidCheckedAt = new Date();
  try {
    const facts = await fetchPublicJobFacts(doc.jobId, doc.source || "crowdworks");
    if (facts?.bidCount != null) {
      doc.bidCount = facts.bidCount;
      doc.bidFetchedAt = doc.bidCheckedAt;
      applyFacts(doc, facts);
    }
  } catch (error: any) {
    console.error(`[market] bid refresh failed for ${doc.source} ${doc.jobId}:`, error?.message || error);
  }
  await doc.save();
}

async function refreshBidCounts(): Promise<void> {
  if (refreshBusy || checkpointBusy || process.env.ANALYSIS_BID_REFRESH === "false") return;
  refreshBusy = true;
  try {
    const { horizonMs, fastMs, batch } = bidRefreshSettings();
    const now = Date.now();
    const hourAgo = new Date(now - 60 * 60_000);
    const base = { bidFetchedAt: { $ne: null }, contractStatus: { $ne: "closed" } };
    const dueBy = (ms: number) => ({ $or: [{ bidCheckedAt: null }, { bidCheckedAt: { $lte: new Date(now - ms) } }] });
    const fresh = await JobObservation.find({ ...base, postedAt: { $gte: hourAgo }, ...dueBy(fastMs) })
      .sort({ bidCheckedAt: 1, postedAt: -1 })
      .limit(batch);
    const older = fresh.length >= batch
      ? []
      : await JobObservation.find({ ...base, postedAt: { $gte: new Date(now - horizonMs), $lt: hourAgo }, ...dueBy(fastMs * 4) })
        .sort({ bidCheckedAt: 1, postedAt: -1 })
        .limit(batch - fresh.length);
    await Promise.all(fresh.concat(older).map((doc) => refreshOneBidCount(doc)));
  } catch (error) {
    console.error("[market] bid refresh:", error);
  } finally {
    refreshBusy = false;
  }
}

async function fillMissingClients(): Promise<void> {
  if (clientBusy) return;
  clientBusy = true;
  try {
    const docs = await JobObservation.find({
      clientId: { $gt: 0 },
      clientFetchedAt: null,
      $or: [{ clientFetchAttempts: { $lt: 3 } }, { clientFetchAttempts: { $exists: false } }],
    })
      .sort({ postedAt: -1 })
      .limit(2);

    for (const doc of docs) {
      const clientId = doc.clientId;
      let snap = clientCache.get(clientId);
      if (!snap) {
        const info = await getClientInfo(clientId);
        if (!info) {
          doc.clientFetchAttempts = (doc.clientFetchAttempts || 0) + 1;
          if (doc.clientFetchAttempts >= 3) doc.clientFetchedAt = new Date();
          if (!doc.clientUrl) doc.clientUrl = employerLink(clientId);
          await doc.save();
          continue;
        }
        const review = (info.recent_ratings || []).find((item) => item.comment && !item.private)?.comment || "";
        snap = {
          name: info.display_name || "",
          rating: info.average_rating ?? null,
          reviewCount: info.total_ratings ?? null,
          review: review.replace(/\s+/g, " ").trim().slice(0, 240),
        };
        clientCache.set(clientId, snap);
      }
      doc.clientName = snap.name || doc.clientName || "";
      doc.clientUrl = employerLink(clientId);
      doc.clientRating = snap.rating;
      doc.clientReviewCount = snap.reviewCount;
      doc.clientReview = snap.review;
      doc.clientFetchedAt = new Date();
      await doc.save();
    }
  } catch (error) {
    console.error("[market] client info:", error);
  } finally {
    clientBusy = false;
  }
}

export function startCheckpointWorker(): void {
  if (checkpointTimer) return;
  void ensureObservationIndexes().catch((error) => console.error("[market] indexes:", error));
  setInterval(() => {
    processDueCheckpoints().catch((error) => console.error("[market] checkpoint worker:", error));
  }, 2_000);
  checkpointTimer = setInterval(() => {
    fillMissingBidCounts().catch((error) => console.error("[market] bid pages:", error));
    notifyStoredBidCounts().catch((error) => console.error("[market] project notice:", error));
    fillMissingClients().catch((error) => console.error("[market] client info:", error));
    fillMissingContent().catch((error) => console.error("[market] descriptions:", error));
  }, 5_000);
  setInterval(() => {
    refreshBidCounts().catch((error) => console.error("[market] bid refresh:", error));
  }, 3_000);
  console.log("[market] checkpoint worker started");
}

function asRangeDate(value: Date | string | undefined, endOfMinute: boolean): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = parsePostedAt(value);
  if (!parsed) return null;
  if (endOfMinute && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(value.trim())) return new Date(parsed.getTime() + 59_999);
  return parsed;
}

export async function writeTimestampCsv(
  write: (chunk: string) => void,
  hours?: number,
  range?: { from?: Date | string; to?: Date | string },
): Promise<number> {
  let to = asRangeDate(range?.to, true) ?? new Date();
  const lookbackHours = hours && hours > 0 ? Math.floor(hours) : settings().lookbackHours;
  let since = asRangeDate(range?.from, false) ?? new Date(to.getTime() - lookbackHours * 60 * 60 * 1000);
  if (since.getTime() > to.getTime()) {
    const swap = since;
    since = to;
    to = swap;
  }
  const bidHeaders = BID_WINDOWS_MIN.map((minute) => `bid${minute}min`);
  write(`\uFEFFjobId,jobUrl,postedAtTokyo,title,payType,priceMin,priceMax,bidCount,contractStatus,contractCount,clientId,clientName,clientUrl,clientRating,clientReviewCount,clientReview,${bidHeaders.join(",")}\n`);
  const cursor = JobObservation.find({ postedAt: { $gte: since, $lte: to } })
    .sort({ postedAt: 1 })
    .select("source jobId postedClock title checkpoints clientId clientName clientUrl clientRating clientReviewCount clientReview bidCount contractCount contractStatus payType priceMin priceMax")
    .cursor();

  let rows = 0;
  for await (const doc of cursor) {
    rows += 1;
    const byMinute = new Map<number, string>();
    for (const cp of doc.checkpoints || []) {
      if (cp.missed) byMinute.set(cp.minute, "missed");
      else if (cp.bidCount == null) byMinute.set(cp.minute, "");
      else byMinute.set(cp.minute, String(cp.bidCount));
    }
    const bids = BID_WINDOWS_MIN.map((minute) => byMinute.get(minute) ?? "");
    write(
      [
        doc.jobId,
        csvEscape(jobLink(doc.jobId, doc.source || "crowdworks")),
        csvEscape(doc.postedClock || ""),
        csvEscape(doc.title || ""),
        csvEscape(doc.payType || ""),
        doc.priceMin ?? "",
        doc.priceMax ?? "",
        doc.bidCount ?? "",
        csvEscape(doc.contractStatus || "unknown"),
        doc.contractCount ?? "",
        doc.clientId || "",
        csvEscape(doc.clientName || ""),
        csvEscape(doc.clientUrl || employerLink(doc.clientId || 0)),
        doc.clientRating ?? "",
        doc.clientReviewCount ?? "",
        csvEscape(doc.clientReview || ""),
        ...bids,
      ].join(",") + "\n",
    );
  }
  return rows;
}
