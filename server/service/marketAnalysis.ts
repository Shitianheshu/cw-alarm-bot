import JobObservation from "@Server/models/JobObservation";
import { cwGet } from "@Server/utils/cwHttp";
import { sendMessage } from "@Server/telegram";
import { delay } from "@Server/utils";
import {
  BID_WINDOWS_MIN,
  bidCountFromSearchItem,
  buildCheckpoints,
  csvEscape,
  decodeHtmlAttr,
  escapeHtml,
  estimateActiveBots,
  formatTokyo,
  intEnv,
  nextCheckpointAt,
  parseMinuteList,
  parseBidCount,
  parsePostedAt,
  watchStatusOf,
  type CheckpointDraft,
} from "@Server/service/marketStats";

const SEARCH_URL = "https://crowdworks.jp/public/jobs/search";

export interface ObservedJobInput {
  id: number;
  title?: string;
  categoryId?: number;
  clientId?: number;
  postedDate?: string;
  bidCount?: number | null;
}

export interface MarketReport {
  generatedAt: string;
  lookbackHours: number;
  maxJobs: number;
  from: string;
  to: string;
  totalJobs: number;
  truncated: boolean;
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
    jobId: number;
    title: string;
    postedClock: string;
    bids: Record<string, number | null>;
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
let loggedSearchShape = false;

function settings() {
  return {
    lookbackHours: intEnv("ANALYSIS_LOOKBACK_HOURS", 24),
    maxJobs: intEnv("ANALYSIS_MAX_JOBS", 100_000),
    pageDelayMs: intEnv("ANALYSIS_PAGE_DELAY_MS", 350),
    pollMs: intEnv("ANALYSIS_POLL_MS", 20_000),
    concurrency: intEnv("ANALYSIS_CHECKPOINT_CONCURRENCY", 3),
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

function toObserved(item: any): ObservedJobInput | null {
  const job = item?.job_offer || {};
  const id = Number(job.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    title: String(job.title || ""),
    categoryId: Number(job.category_id ?? 0) || 0,
    clientId: Number(item?.client?.user_id ?? 0) || 0,
    postedDate: String(job.last_released_at || ""),
    bidCount: bidCountFromSearchItem(item),
  };
}

async function fetchSearchPage(page: number): Promise<ObservedJobInput[]> {
  const response = await cwGet(SEARCH_URL, {
    params: { order: "new", page },
  });
  if (response.status === 403) {
    throw new Error("CrowdWorks returned 403. The scan could not read public job listings.");
  }
  if (response.status !== 200) throw new Error(`CrowdWorks search failed with status ${response.status}`);
  return parseSearchHtml(String(response.data)).map(toObserved).filter((job): job is ObservedJobInput => job != null);
}

async function saveObservedJobs(jobs: ObservedJobInput[], seenAt: Date): Promise<number> {
  if (!jobs.length) return 0;
  const cfg = settings();
  const ids = jobs.map((job) => job.id);
  const existingDocs = await JobObservation.find({ jobId: { $in: ids } }).select("jobId").lean();
  const existingIds = new Set(existingDocs.map((doc) => doc.jobId));
  const scheduledCount = await JobObservation.countDocuments({ watchStatus: "scheduled" });
  let scheduledRoom = Math.max(0, cfg.watchLimit - scheduledCount);

  const inserts: Record<string, unknown>[] = [];
  const updates: { updateOne: { filter: { jobId: number }; update: { $set: Record<string, unknown> } } }[] = [];

  for (const job of jobs) {
    const postedAt = parsePostedAt(job.postedDate) ?? seenAt;
    const postedClock = formatTokyo(postedAt);
    if (existingIds.has(job.id)) {
      updates.push({
        updateOne: {
          filter: { jobId: job.id },
          update: {
            $set: {
              title: job.title || "",
              categoryId: job.categoryId || 0,
              clientId: job.clientId || 0,
              postedAt,
              postedClock,
            },
          },
        },
      });
      continue;
    }

    let checkpoints = buildCheckpoints(postedAt, seenAt, cfg.toleranceMs);
    if (scheduledRoom <= 0) {
      checkpoints = checkpoints.map((cp) => ({ ...cp, missed: true }));
    } else if (watchStatusOf(checkpoints) === "scheduled") {
      scheduledRoom -= 1;
    }
    const status = watchStatusOf(checkpoints);
    inserts.push({
      jobId: job.id,
      title: job.title || "",
      categoryId: job.categoryId || 0,
      clientId: job.clientId || 0,
      postedAt,
      postedClock,
      firstSeenAt: seenAt,
      bidCountAtFirstSeen: job.bidCount ?? null,
      checkpoints,
      nextCheckpointAt: nextCheckpointAt(checkpoints),
      watchStatus: status,
    });
  }

  if (inserts.length) {
    try {
      await JobObservation.insertMany(inserts, { ordered: false });
    } catch (error: any) {
      const message = String(error?.message || "");
      if (error?.code !== 11000 && error?.name !== "MongoBulkWriteError" && !message.includes("E11000")) throw error;
    }
  }
  if (updates.length) await JobObservation.bulkWrite(updates, { ordered: false });
  return inserts.length;
}

export async function recordLiveJob(job: ObservedJobInput): Promise<void> {
  if (!job?.id) return;
  await saveObservedJobs([job], new Date());
}

async function ingestFirstPage(): Promise<void> {
  const jobs = await fetchSearchPage(1);
  await saveObservedJobs(jobs, new Date());
}

export function startMarketWatch(): { started: boolean; message: string } {
  if (watchTimer) return { started: false, message: "相場ウォッチはすでに動いています。" };
  const pollMs = settings().pollMs;
  const tick = () => {
    ingestFirstPage().catch((error) => {
      lastError = error?.message || "Watch poll failed";
      console.error("[market] watch poll failed:", lastError);
    });
  };
  tick();
  watchTimer = setInterval(tick, pollMs);
  return { started: true, message: `相場ウォッチを開始しました。新規案件を ${Math.round(pollMs / 1000)} 秒ごとに確認します。` };
}

export function stopMarketWatch(): { stopped: boolean; message: string } {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  return { stopped: true, message: "相場ウォッチを停止しました。採取済みの入札チェックは続行します。" };
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

export async function buildMarketReport(hours?: number): Promise<MarketReport> {
  const cfg = settings();
  const lookbackHours = hours && hours > 0 ? Math.floor(hours) : cfg.lookbackHours;
  const now = new Date();
  const since = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);

  const [totalJobs, byHourRows, checkpointRows, recentDocs, botDocs] = await Promise.all([
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
      { $match: { postedAt: { $gte: since, $lte: now } } },
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
      .limit(40)
      .select("jobId title postedClock checkpoints")
      .lean(),
    JobObservation.find({
      postedAt: { $gte: new Date(now.getTime() - cfg.botWindowMinutes * 60_000), $lte: now },
      checkpoints: { $elemMatch: { minute: 3, missed: false, bidCount: { $ne: null } } },
    })
      .select("checkpoints")
      .lean(),
  ]);

  const botCounts = botDocs.map((doc) => {
    const cp = (doc.checkpoints || []).find((item) => item.minute === 3 && !item.missed && item.bidCount != null);
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
      definition: "Bids confirmed within 3 minutes of posting are treated as bots (the 1–3 minute window).",
    },
    recent: recentDocs.map((doc) => {
      const bids: Record<string, number | null> = {};
      for (const minute of BID_WINDOWS_MIN) {
        const cp = (doc.checkpoints || []).find((item) => item.minute === minute);
        bids[String(minute)] = cp && !cp.missed && cp.bidCount != null ? cp.bidCount : null;
      }
      return {
        jobId: doc.jobId,
        title: doc.title || "",
        postedClock: doc.postedClock || "",
        bids,
      };
    }),
    watching: watchTimer != null,
    scanning: scanRunning,
    alarm: alarmTimer != null,
    alarmMinutes: cfg.alarmMinutes,
    lastError,
  };
}

function formatReport(report: MarketReport): string {
  const hourLines = report.byHour.length
    ? report.byHour.map((row) => `• ${row.hour}  ${row.count.toLocaleString("ja-JP")}件`).join("\n")
    : "• まだ時刻データがありません";
  const recentLines = report.recent.slice(0, 12).map((job) => {
    const title = escapeHtml(job.title).slice(0, 28);
    return `• ${escapeHtml(job.postedClock)}  #${job.jobId}  ${title}`;
  });
  const bidLines = report.checkpoints
    .map((row) => `• ${row.minute}分: 平均 ${row.avgBids}（合計 ${row.totalBids.toLocaleString("ja-JP")} / 観測 ${row.jobs.toLocaleString("ja-JP")}件）`)
    .join("\n");
  const botLine =
    report.bots.approx == null
      ? "まだ3分時点の観測がありません。ウォッチ開始から数分後に再送します。"
      : `およそ <b>${report.bots.approx}</b> 台（同一案件の最大 ${report.bots.atLeast}、直近${report.bots.windowMinutes}分のサンプル ${report.bots.sampleJobs}件）`;
  const capNote = report.truncated ? `\n上限 ${report.maxJobs.toLocaleString("ja-JP")} 件に達したため、24時間の全件より少ない可能性があります。` : "";

  return [
    `<b>CW相場レポート（過去${report.lookbackHours}時間）</b>`,
    `${escapeHtml(report.from)} 〜 ${escapeHtml(report.to)}`,
    "",
    `<b>1. 案件数</b>`,
    `${report.totalJobs.toLocaleString("ja-JP")} 件（上限 ${report.maxJobs.toLocaleString("ja-JP")} 件）${capNote}`,
    "",
    `<b>投稿時刻（東京・時間ごと）</b>`,
    hourLines,
    "",
    `<b>直近の投稿（時:分:秒）</b>`,
    recentLines.length ? recentLines.join("\n") : "• なし",
    "全件の時分秒は管理画面の CSV に出しています。",
    "",
    `<b>2. 開始後の入札数</b>`,
    bidLines,
    "",
    `<b>3. 稼働中の入札ボット概算</b>`,
    botLine,
    "開始後3分時点の入札をボットとみなします（1〜3分以内に入ったもの）。同一案件に1ボット1入札として概算しています。",
  ].join("\n");
}

export async function publishMarketReport(hours?: number): Promise<MarketReport> {
  const report = await buildMarketReport(hours);
  await notify(formatReport(report));
  return report;
}

export function scanRecentJobs(opts?: { hours?: number; maxJobs?: number; notify?: boolean }): { started: boolean; message: string } {
  if (scanRunning) return { started: false, message: "スキャンはすでに実行中です。" };
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
    message: `過去${hours}時間のスキャンを開始しました（上限 ${maxJobs.toLocaleString("ja-JP")} 件）。完了したら Telegram に送ります。`,
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
      await notify(`<b>CW相場スキャン失敗</b>\n${escapeHtml(message)}`);
    }
    throw error;
  } finally {
    scanRunning = false;
  }
}

let loggedBidMiss = false;

export async function fetchPublicBidCount(jobId: number): Promise<number | null> {
  const response = await cwGet(`https://crowdworks.jp/public/jobs/${jobId}`, {
    timeout: 20_000,
  });
  if (response.status !== 200) return null;
  const count = parseBidCount(String(response.data));
  if (count == null && !loggedBidMiss) {
    loggedBidMiss = true;
    console.warn(`[market] bid count not found on job ${jobId}`);
  }
  return count;
}

async function processOneCheckpoint(doc: any): Promise<void> {
  const now = Date.now();
  const toleranceMs = settings().toleranceMs;
  const checkpoints = (doc.checkpoints || []) as CheckpointDraft[];
  const due: CheckpointDraft[] = [];

  for (const cp of checkpoints) {
    if (cp.checkedAt || cp.missed) continue;
    if (new Date(cp.dueAt).getTime() > now) continue;
    if (now - new Date(cp.dueAt).getTime() > toleranceMs) cp.missed = true;
    else due.push(cp);
  }

  if (due.length) {
    let count: number | null = null;
    try {
      count = await fetchPublicBidCount(doc.jobId);
    } catch (error: any) {
      console.error(`[market] bid fetch failed for ${doc.jobId}:`, error?.message || error);
      count = null;
    }

    if (count == null) {
      let retry = false;
      for (const cp of due) {
        cp.attempts = (cp.attempts || 0) + 1;
        const stillInWindow = Date.now() + 15_000 <= new Date(cp.dueAt).getTime() + toleranceMs;
        if (cp.attempts >= 3 || !stillInWindow) cp.missed = true;
        else retry = true;
      }
      if (retry) {
        doc.nextCheckpointAt = new Date(Date.now() + 15_000);
        doc.watchStatus = "scheduled";
        doc.markModified("checkpoints");
        await doc.save();
        return;
      }
    } else {
      const checkedAt = new Date();
      for (const cp of due) {
        cp.bidCount = count;
        cp.checkedAt = checkedAt;
      }
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
      .limit(8)
      .select("jobId title postedClock")
      .lean(),
    JobObservation.find({
      postedAt: { $gte: recentSince },
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
      if (cp.minute === 3) botCounts.push(cp.bidCount);
    }
  }

  if (total === 0 && sums.size === 0 && minutes < 5) return "";

  const posted = recent.length
    ? recent
        .map((job) => `• ${escapeHtml(job.postedClock || "")}  #${job.jobId}  ${escapeHtml((job.title || "").slice(0, 28))}`)
        .join("\n")
    : "• なし";
  const bidLines = BID_WINDOWS_MIN.flatMap((minute) => {
    const row = sums.get(minute);
    if (!row) return [];
    const avg = Math.round((row.bids / row.jobs) * 10) / 10;
    return [`• ${minute}分: 平均 ${avg}（観測 ${row.jobs}件）`];
  });
  const lines = [
    `<b>CW分析アラーム（直近${minutes}分）</b>`,
    `新規案件: <b>${total.toLocaleString("ja-JP")}</b>`,
    posted,
  ];
  if (bidLines.length) {
    lines.push("", "<b>開始後の入札</b>", bidLines.join("\n"));
  }
  if (minutes >= 5) {
    const bots = estimateActiveBots(botCounts);
    lines.push(
      "",
      "<b>稼働ボット概算</b>",
      bots.approx == null
        ? "この区間では3分時点の観測がまだありません。"
        : `およそ <b>${bots.approx}</b> 台（同一案件の最大 ${bots.atLeast}、サンプル ${bots.sampleJobs}件）`
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
    return { started: false, message: `分析アラームはすでに動いています（${minutes.join("、")}分ごと）。` };
  }
  const now = Date.now();
  for (const minute of minutes) alarmLastSent.set(minute, now);
  alarmTimer = setInterval(() => {
    tickAnalysisAlarm().catch((error) => console.error("[market] analysis alarm:", error));
  }, 15_000);
  console.log("[market] analysis alarm started", minutes.join(","));
  return {
    started: true,
    message: `分析アラームを開始しました。${minutes.join("、")}分ごとに Telegram へ送ります。`,
  };
}

export function stopAnalysisAlarm(): { stopped: boolean; message: string } {
  if (alarmTimer) {
    clearInterval(alarmTimer);
    alarmTimer = null;
  }
  return { stopped: true, message: "分析アラームを停止しました。相場ウォッチは続行します。" };
}

export function startCheckpointWorker(): void {
  if (checkpointTimer) return;
  checkpointTimer = setInterval(() => {
    processDueCheckpoints().catch((error) => console.error("[market] checkpoint worker:", error));
  }, 5_000);
  console.log("[market] checkpoint worker started");
}

export async function writeTimestampCsv(write: (chunk: string) => void, hours?: number): Promise<void> {
  const lookbackHours = hours && hours > 0 ? Math.floor(hours) : settings().lookbackHours;
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  write("\uFEFFjobId,postedAtTokyo,title,bid1,bid3,bid5,bid10,bid20,bid30\n");
  const cursor = JobObservation.find({ postedAt: { $gte: since } })
    .sort({ postedAt: 1 })
    .select("jobId postedClock title checkpoints")
    .cursor();

  for await (const doc of cursor) {
    const byMinute = new Map<number, string>();
    for (const cp of doc.checkpoints || []) {
      if (cp.missed) byMinute.set(cp.minute, "missed");
      else if (cp.bidCount == null) byMinute.set(cp.minute, "");
      else byMinute.set(cp.minute, String(cp.bidCount));
    }
    const bids = BID_WINDOWS_MIN.map((minute) => byMinute.get(minute) ?? "");
    write([doc.jobId, csvEscape(doc.postedClock || ""), csvEscape(doc.title || ""), ...bids].join(",") + "\n");
  }
}
