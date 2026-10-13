import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import os from "os";
import path from "path";
import { cwGet } from "@Server/utils/cwHttp";

export type MarketSource = "crowdworks" | "coconala" | "lancers";

export interface ListedJob {
  source: MarketSource;
  id: number;
  title: string;
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

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.8,en;q=0.5",
};

const LANCERS_SEARCH = "https://www.lancers.jp/work/search?open=1&sort=started";
const COCONALA_SEARCH = "https://coconala.com/requests";

function digits(value: string): number | null {
  const cleaned = value.replace(/,/g, "").trim();
  if (!/^\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** "27分前" / "5時間前" / "3日前" measured from now. */
export function parseRelativePosted(text: string, now: Date): Date | null {
  const compact = text.replace(/\s+/g, "");
  const minute = compact.match(/(\d+)分前/);
  if (minute) return new Date(now.getTime() - Number(minute[1]) * 60_000);
  const hour = compact.match(/(\d+)時間前/);
  if (hour) return new Date(now.getTime() - Number(hour[1]) * 60 * 60_000);
  const day = compact.match(/(\d+)日前/);
  if (day) return new Date(now.getTime() - Number(day[1]) * 24 * 60 * 60_000);
  if (/たった今|数秒前/.test(compact)) return now;
  return null;
}

function priceFromText(text: string): { payType: string; priceMin: number | null; priceMax: number | null } {
  const man = Array.from(text.matchAll(/(\d[\d,]*)\s*万円/g)).map((match) => (digits(match[1]) ?? 0) * 10_000);
  const yen = Array.from(text.matchAll(/(\d[\d,]*)\s*円/g)).map((match) => digits(match[1]) ?? NaN).filter((n) => Number.isFinite(n));
  const values = man.length ? man : yen;
  if (!values.length) return { payType: "", priceMin: null, priceMax: null };
  const priceMin = Math.min(...values);
  const priceMax = Math.max(...values);
  const payType = /時給|\/\s*時間|円\s*\/\s*h/i.test(text) ? "hourly" : "fixed";
  return { payType, priceMin, priceMax };
}

async function fetchDirect(url: string): Promise<string | null> {
  try {
    const response = await axios.get(url, {
      timeout: 25_000,
      proxy: false,
      headers: HEADERS,
      validateStatus: (status) => status < 500,
    });
    const html = String(response.data || "");
    if (response.status === 200 && html.length > 2000 && !html.includes("awsWafCookieDomainList")) return html;
  } catch {
    return null;
  }
  return null;
}

async function fetchHtml(url: string): Promise<string> {
  const direct = await fetchDirect(url);
  if (direct) return direct;
  const response = await cwGet(url, { timeout: 25_000 });
  const html = String(response.data || "");
  if (response.status === 200 && html.length > 2000 && !html.includes("awsWafCookieDomainList")) return html;
  throw new Error(`Listing was not readable (${response.status})`);
}

export function parseLancersSearch(html: string): ListedJob[] {
  const $ = cheerio.load(html);
  const jobs: ListedJob[] = [];
  $(".p-search-job-media").each((_, element) => {
    const card = $(element);
    const href = card.find("a[href*='/work/detail/']").first().attr("href") || "";
    const id = Number((href.match(/\/work\/detail\/(\d+)/) || [])[1]);
    if (!Number.isFinite(id) || id <= 0) return;
    const titleNode = card.find("a.p-search-job-media__title").first().clone();
    titleNode.find("ul, li").remove();
    const title = collapse(titleNode.text());
    const proposalText = collapse(card.text());
    const bidMatch = proposalText.match(/提案数\s*([\d,]+)/);
    const bidCount = bidMatch ? digits(bidMatch[1]) : null;
    const clientLink = card.find("a[href^='/client/']").filter((__, link) => collapse($(link).text()).length > 0).first();
    const clientPath = clientLink.attr("href") || "";
    const priceText = collapse(card.find(".p-search-job-media__price").first().text());
    const price = /後で決める|応相談/.test(priceText) && !/\d/.test(priceText) ? { payType: "", priceMin: null, priceMax: null } : priceFromText(priceText);
    const ratingMatch = collapse(card.text()).match(/評価\s*([\d.]+)/);
    const open = /募集中/.test(card.find(".p-search-job-media__time-text").text()) || /募集中/.test(card.text());
    jobs.push({
      source: "lancers",
      id,
      title: title || `Lancers ${id}`,
      clientName: collapse(clientLink.text()),
      clientUrl: clientPath ? `https://www.lancers.jp${clientPath}` : "",
      clientRating: ratingMatch ? Number(ratingMatch[1]) : null,
      bidCount,
      contractStatus: open ? "open" : "unknown",
      ...price,
    });
  });
  return jobs;
}

export function parseLancersBidCount(html: string): number | null {
  const text = collapse(html.replace(/<[^>]+>/g, " "));
  if (/提案非公開/.test(text) && !/提案数\s*[\d,]+/.test(text)) return null;
  const match = text.match(/提案数\s*([\d,]+)\s*件/);
  return match ? digits(match[1]) : null;
}

function parseJapanesePosted(text: string): Date | null {
  const match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日.*?(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}T${match[4].padStart(2, "0")}:${match[5]}:00+09:00`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseCoconalaSearch(html: string, now = new Date()): ListedJob[] {
  const $ = cheerio.load(html);
  const jobs: ListedJob[] = [];
  $(".c-searchItemWrapper").each((_, element) => {
    const card = $(element);
    const href = card.find("a[href*='/requests/']").first().attr("href") || "";
    const id = Number((href.match(/\/requests\/(\d+)/) || [])[1]);
    if (!Number.isFinite(id) || id <= 0) return;
    const title = collapse(card.find(".c-itemInfo_title").text());
    const bidText = collapse(card.find(".c-itemTileLine_emphasis-proposalCount").first().text());
    const bidCount = digits(bidText);
    const postedTitle = card.find(".c-itemInfoUser_created [title]").attr("title") || "";
    const postedAt = parseJapanesePosted(postedTitle) || parseRelativePosted(collapse(card.find(".c-itemInfoUser_created").text()), now);
    const budget = collapse(card.find(".d-requestBudget").first().text()) || collapse(card.find(".c-itemTile_tile-budget").first().text());
    const price = /見積/.test(budget) && !/\d/.test(budget) ? { payType: "", priceMin: null, priceMax: null } : priceFromText(budget);
    const clientName = collapse(card.find(".c-itemInfoUser_name").text()) || collapse(card.find(".c-itemInfoUser a").first().text());
    jobs.push({
      source: "coconala",
      id,
      title: title || `Coconala ${id}`,
      clientName,
      postedAt,
      bidCount,
      contractStatus: "open",
      ...price,
    });
  });
  return jobs;
}

export function parseCoconalaBidCount(html: string): number | null {
  const text = collapse(html.replace(/<[^>]+>/g, " "));
  const match = text.match(/応募者数\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

export async function fetchLancersJobs(): Promise<ListedJob[]> {
  const html = await fetchHtml(LANCERS_SEARCH);
  const jobs = parseLancersSearch(html);
  if (!jobs.length) throw new Error("Lancers search page has no jobs");
  return jobs;
}

type RenderedPage = {
  goto: (url: string, opts?: { waitUntil?: "domcontentloaded"; timeout?: number }) => Promise<unknown>;
  content: () => Promise<string>;
  waitForFunction?: (fn: () => boolean, opts?: { timeout?: number }) => Promise<unknown>;
};

let rendered: { browser: { close: () => Promise<void> }; page: RenderedPage } | null = null;
let renderQueue: Promise<void> = Promise.resolve();

async function renderedHtml(url: string): Promise<string> {
  const run = renderQueue.then(async () => {
    if (!rendered) {
      const { connect } = await import("puppeteer-real-browser");
      const userDataDir = path.join(os.tmpdir(), "cw-market-browser");
      fs.mkdirSync(userDataDir, { recursive: true });
      const started = await connect({
        headless: false,
        turnstile: false,
        disableXvfb: true,
        args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
        customConfig: { userDataDir },
        connectOption: { protocolTimeout: 120_000 },
      });
      rendered = {
        browser: started.browser as { close: () => Promise<void> },
        page: started.page as RenderedPage,
      };
      console.log("[market] Coconala is read in a Chrome window so the site check can finish");
    }
    await rendered.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const started = Date.now();
    let html = "";
    while (Date.now() - started < 20_000) {
      html = await rendered.page.content();
      if (!html.includes("awsWafCookieDomainList") && (html.includes("応募") || html.includes("/requests/"))) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (html.includes("awsWafCookieDomainList")) throw new Error("Coconala blocked the read before the page loaded");
    return html;
  });
  renderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function fetchCoconalaJobs(): Promise<ListedJob[]> {
  const html = await renderedHtml(COCONALA_SEARCH);
  const jobs = parseCoconalaSearch(html);
  if (!jobs.length) throw new Error("Coconala request page has no jobs");
  return jobs;
}

const SCAM_CLIENTS = [
  "https://www.lancers.jp/client/sns_creator",
  "ひらた｜SNSマーケティング",
  "ご応募はURLからお願いします",
];

function scamNeedles(): string[] {
  const extra = (process.env.ANALYSIS_SCAM_CLIENTS || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return SCAM_CLIENTS.concat(extra).map((item) => item.toLowerCase());
}

/** Matches a client URL exactly or the client name as a substring. */
export function isScamClient(clientName?: string, clientUrl?: string): boolean {
  const name = (clientName || "").trim().toLowerCase();
  const url = (clientUrl || "").trim().toLowerCase().replace(/\/+$/, "");
  if (!name && !url) return false;
  return scamNeedles().some((needle) => {
    if (/^https?:\/\//.test(needle)) return url === needle.replace(/\/+$/, "");
    return name.includes(needle);
  });
}

export function jobUrl(source: string, jobId: number): string {
  if (source === "lancers") return `https://www.lancers.jp/work/detail/${jobId}`;
  if (source === "coconala") return `https://coconala.com/requests/${jobId}`;
  return `https://crowdworks.jp/public/jobs/${jobId}`;
}

export function sourceLabel(source: string): string {
  if (source === "lancers") return "Lancers";
  if (source === "coconala") return "Coconala";
  return "CrowdWorks";
}

export async function fetchSourceBidCount(source: string, jobId: number): Promise<number | null> {
  if (source === "lancers") {
    const html = await fetchHtml(jobUrl(source, jobId));
    return parseLancersBidCount(html);
  }
  if (source === "coconala") {
    const html = await renderedHtml(jobUrl(source, jobId));
    return parseCoconalaBidCount(html);
  }
  return null;
}

/** Converts an HTML fragment to plain text, keeping line breaks. */
export function htmlToText(html: string): string {
  const marked = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|dd|dt|section)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "・");
  const text = cheerio.load(`<body>${marked}</body>`)("body").text();
  return text
    .replace(/\r/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function jsonLdDescription(html: string): string {
  const $ = cheerio.load(html);
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    try {
      const parsed = JSON.parse($(element).text());
      for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
        if (node?.["@type"] === "JobPosting" && typeof node.description === "string" && node.description.trim()) {
          // The description is HTML that CrowdWorks escapes once more, so decode before stripping tags.
          const decoded = cheerio.load(`<body>${node.description}</body>`)("body").text();
          return htmlToText(decoded);
        }
      }
    } catch {
      // Ignore malformed blocks; other sources follow.
    }
  }
  return "";
}

export function parseCrowdworksContent(html: string): string {
  const fromLd = jsonLdDescription(html);
  if (fromLd) return fromLd;
  const $ = cheerio.load(html);
  const block = $(".job_offer_detail_table .confirm_outside_block, .confirm_outside_block").first().html() || "";
  return block ? htmlToText(block) : "";
}

export function parseLancersContent(html: string): string {
  const $ = cheerio.load(html);
  const lines: string[] = [];
  for (const list of $("dl.c-definition-list").toArray()) {
    let stop = false;
    $(list).find("dt").each((_, term) => {
      const label = collapse($(term).text());
      if (!label) {
        stop = true;
        return false;
      }
      const value = htmlToText($(term).next("dd").html() || "");
      if (value) lines.push(`■ ${label}\n${value}`);
      return undefined;
    });
    if (stop) break;
  }
  if (lines.length) return lines.join("\n\n");
  return htmlToText($('meta[property="og:description"]').attr("content") || "");
}

export function parseCoconalaContent(html: string): string {
  const fromLd = jsonLdDescription(html);
  if (fromLd) return fromLd;
  const $ = cheerio.load(html);
  const selectors = [
    ".c-requestDetailContent",
    ".c-requestOutlineDetail",
    "[class*='requestDetail'] [class*='description']",
    "[class*='request'] [class*='Description']",
    "[class*='request'] [class*='description']",
    ".d-requestDetail",
  ];
  let best = "";
  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const text = htmlToText($(element).html() || "");
      if (text.length > best.length) best = text;
    });
  }
  if (best.length >= 40) return best;
  return htmlToText($('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content") || "");
}

/** Bid count and description from one Lancers/Coconala job page read. */
export async function fetchSourceFacts(source: string, jobId: number): Promise<{ bidCount: number | null; content: string }> {
  if (source === "lancers") {
    const html = await fetchHtml(jobUrl(source, jobId));
    return { bidCount: parseLancersBidCount(html), content: parseLancersContent(html) };
  }
  if (source === "coconala") {
    const html = await renderedHtml(jobUrl(source, jobId));
    return { bidCount: parseCoconalaBidCount(html), content: parseCoconalaContent(html) };
  }
  return { bidCount: null, content: "" };
}

/** Full job description as plain text. Throws when the page cannot be read. */
export async function fetchJobContent(source: string, jobId: number): Promise<string> {
  const url = jobUrl(source, jobId);
  if (source === "lancers" || source === "coconala") return (await fetchSourceFacts(source, jobId)).content;
  const response = await cwGet(url, { timeout: 20_000 });
  if (response.status !== 200) throw new Error(`CrowdWorks job page returned ${response.status}`);
  return parseCrowdworksContent(String(response.data));
}
