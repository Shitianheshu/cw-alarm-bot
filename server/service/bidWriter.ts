import axios from "axios";
import fs from "fs";
import http from "http";
import { HttpsProxyAgent } from "https-proxy-agent";
import net from "net";
import os from "os";
import path from "path";
import BidTemplate from "@Server/models/BidTemplate";
import JobObservation from "@Server/models/JobObservation";
import Prompt from "@Server/models/Prompt";
import { getJobContent } from "@Server/service/marketAnalysis";
import { sourceLabel } from "@Server/service/marketSources";

const CHATGPT_URL = "https://chatgpt.com/?temporary-chat=true";
const ANSWER_TIMEOUT_MS = 150_000;
const COMPOSER = 'textarea[aria-label="Chat with ChatGPT"], #prompt-textarea, textarea[placeholder="Ask ChatGPT"], div[contenteditable="true"]';
const ASSISTANT = 'li[data-message-role="assistant"], [data-message-author-role="assistant"]';
const DRAFT_TTL_MS = 6 * 60 * 60_000;
const EMOJI = new RegExp("\\p{Extended_Pictographic}\\uFE0F?", "gu");

function priceText(doc: any): string {
  const low = doc.priceMin ?? doc.priceMax;
  const high = doc.priceMax ?? doc.priceMin;
  if (low == null || high == null) return "記載なし";
  const yen = (n: number) => `${Number(n).toLocaleString("ja-JP")}円`;
  const unit = doc.payType === "hourly" ? "（時給）" : "";
  return (low === high ? yen(low) : `${yen(low)}〜${yen(high)}`) + unit;
}

async function userRules(telegramId: number | null): Promise<string> {
  if (!telegramId) return "";
  const [prompt, template] = await Promise.all([
    Prompt.findOne({ telegramId, $or: [{ isActive: true }, { category: "default" }] }).sort({ isActive: -1, updatedAt: -1 }).lean(),
    BidTemplate.findOne({ telegramId, isActive: true }).sort({ updatedAt: -1 }).lean(),
  ]);
  const parts: string[] = [];
  if ((prompt as any)?.prompt) parts.push(`私のプロフィールと方針:\n${String((prompt as any).prompt).trim()}`);
  if ((template as any)?.template) parts.push(`参考にする私の提案文（言い回しは真似しすぎない）:\n${String((template as any).template).trim()}`);
  return parts.join("\n\n");
}

export function buildBidPrompt(job: { title: string; source: string; price: string; content: string }, rules: string): string {
  return [
    "あなたはクラウドソーシングで仕事を受けている日本人のフリーランスです。次の案件に送る提案文を書いてください。",
    "",
    "書き方:",
    "- 人が自分で書いたような、自然で落ち着いた日本語のビジネス文にする。",
    "- 見出し、箇条書き、記号（■ ● ★ ・ 【】 など）、太字、絵文字、マークダウンは使わず、短い段落だけで書く。",
    "- 「させていただきます」の連発、「全力で」「最大限」「貴社のビジョン」「シナジー」「スムーズかつ」「〜と存じます」など、定型的でAIっぽい言い回しは避ける。",
    "- 依頼内容の具体的な点に2つ以上触れ、どう進めるかを簡潔に書く。できないことや未確定のことを断定しない。",
    "- 確認したいことを1つだけ自然に質問する。",
    "- 300〜500文字くらい。",
    "- 「はじめまして。」など短い挨拶で始める。件名、宛名、署名、[名前] のような空欄は書かない。",
    "- 提案文の本文だけを出力する。前置きや解説は書かない。",
    rules ? `\n${rules}` : "",
    "",
    `案件名: ${job.title}`,
    `サイト: ${job.source}`,
    `予算: ${job.price}`,
    "依頼内容:",
    job.content.slice(0, 3500),
  ].join("\n");
}

/** Removes the formatting and stock phrasing that make a bid read as machine-written. */
export function humanizeBid(raw: string): string {
  let text = String(raw || "").replace(/\r/g, "");
  text = text.replace(/```[a-z]*\n?|```/gi, "");
  text = text.replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2").replace(/`([^`]+)`/g, "$1");
  const lines = text.split("\n").map((line) => line.trim());
  const kept = lines
    .filter((line, index) => {
      if (index < 2 && /^(以下|こちら|はい)[、,]?.*(提案文|文章|作成)/.test(line)) return false;
      if (/^(件名|タイトル|宛先)\s*[:：]/.test(line)) return false;
      if (/^#{1,6}\s/.test(line)) return false;
      return true;
    })
    .map((line) =>
      line
        .replace(/^#{1,6}\s*/, "")
        .replace(/^[-*•●■◆★・]\s*/, "")
        .replace(/^\d+[.)]\s+/, ""),
    );
  text = kept.join("\n");
  text = text
    .replace(EMOJI, "")
    .replace(/\s*[—–―]{1,2}\s*/g, "、")
    .replace(/\[[^\]\n]{1,20}\]|［[^］\n]{1,20}］|〇〇|○○/g, "")
    .replace(/、{2,}/g, "、")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** OpenAI hosts do not resolve on this network, so ChatGPT traffic goes through the VPS proxy. */
function chatProxyUrl(): URL | null {
  const raw = (process.env.CHATGPT_PROXY ?? process.env.PROXY ?? "").trim();
  if (!raw || raw === "off") return null;
  try {
    return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
}

let relayPort: Promise<number> | null = null;

/** Local no-login proxy that forwards to the upstream proxy with its credentials, because Chrome cannot send them itself here. */
function localRelay(upstream: URL): Promise<number> {
  if (relayPort) return relayPort;
  const upstreamHost = upstream.hostname;
  const upstreamPort = Number(upstream.port || 80);
  const auth = upstream.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString("base64")}`
    : "";

  const server = http.createServer((req, res) => {
    const forward = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, ...(auth ? { "proxy-authorization": auth } : {}) },
    });
    forward.on("response", (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    forward.on("error", () => res.destroy());
    req.pipe(forward);
  });

  server.on("connect", (req, client, head) => {
    const tunnel = net.connect(upstreamPort, upstreamHost, () => {
      tunnel.write(
        `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`,
      );
    });
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      tunnel.off("data", onData);
      const status = buffered.subarray(0, end).toString().split(" ")[1];
      if (status !== "200") {
        client.end(`HTTP/1.1 ${status || 502} Upstream proxy refused\r\n\r\n`);
        tunnel.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = buffered.subarray(end + 4);
      if (rest.length) client.write(rest);
      if (head?.length) tunnel.write(head);
      tunnel.pipe(client);
      client.pipe(tunnel);
    };
    tunnel.on("data", onData);
    tunnel.on("error", () => client.destroy());
    client.on("error", () => tunnel.destroy());
  });

  relayPort = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
  return relayPort;
}

async function askOpenAi(prompt: string): Promise<string> {
  const proxy = chatProxyUrl();
  const httpsAgent = proxy ? new HttpsProxyAgent(proxy.toString()) : undefined;
  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.8,
      messages: [{ role: "user", content: prompt }],
    },
    {
      timeout: 90_000,
      proxy: false,
      ...(httpsAgent ? { httpsAgent } : {}),
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    },
  );
  return String(response.data?.choices?.[0]?.message?.content || "");
}

let chat: { page: any } | null = null;
let chatQueue: Promise<void> = Promise.resolve();

async function chatPage(): Promise<any> {
  if (chat) {
    try {
      await chat.page.evaluate(() => 1);
      return chat.page;
    } catch {
      chat = null;
    }
  }
  const { connect } = await import("puppeteer-real-browser");
  const userDataDir = path.join(os.tmpdir(), "cw-chatgpt-browser");
  fs.mkdirSync(userDataDir, { recursive: true });
  const proxy = chatProxyUrl();
  const relay = proxy ? await localRelay(proxy) : null;
  const started = await connect({
    headless: false,
    turnstile: true,
    disableXvfb: true,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      ...(relay ? [`--proxy-server=http://127.0.0.1:${relay}`] : []),
    ],
    customConfig: { userDataDir },
    connectOption: { protocolTimeout: 180_000 },
  });
  chat = { page: started.page };
  console.log("[bid] ChatGPT runs in its own Chrome window; log in there once if it asks");
  return chat.page;
}

async function askChatGpt(prompt: string): Promise<string> {
  const run = chatQueue.then(async () => {
    const page = await chatPage();
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      await page.waitForSelector(COMPOSER, { timeout: 60_000 });
    } catch {
      const shot = path.join(os.tmpdir(), "chatgpt-last.png");
      const title = await page.title().catch(() => "");
      await page.screenshot({ path: shot }).catch(() => undefined);
      console.error(`[bid] ChatGPT message box missing; page "${title}" ${page.url()} (screenshot ${shot})`);
      throw new Error(`ChatGPT did not show the message box (page: "${title || "unknown"}"). Open the ChatGPT Chrome window, log in or pass the check, then try again.`);
    }
    const before: number = await page.evaluate(
      (selector: string) => document.querySelectorAll(selector).length,
      ASSISTANT,
    );
    await page.click(COMPOSER);
    await page.evaluate((selector: string, text: string) => {
      const box = document.querySelector(selector) as HTMLElement | null;
      if (!box) return;
      box.focus();
      if (box instanceof HTMLTextAreaElement) {
        // React tracks the native setter, so assigning .value directly would be ignored.
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, text);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        document.execCommand("insertText", false, text);
      }
    }, COMPOSER, prompt);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const sent = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="send-button"], button[aria-label="Send message"], button[aria-label="Send prompt"]') as HTMLButtonElement | null;
      if (button && !button.disabled) {
        button.click();
        return true;
      }
      return false;
    });
    if (!sent) await page.keyboard.press("Enter");

    const started = Date.now();
    let last = "";
    let stableSince = 0;
    while (Date.now() - started < ANSWER_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const state: { count: number; text: string; done: boolean; streaming: boolean } = await page.evaluate((selector: string) => {
        const nodes = document.querySelectorAll(selector);
        const lastNode = nodes[nodes.length - 1] as HTMLElement | undefined;
        const body = (lastNode?.querySelector("[data-assistant-markdown], .markdown") as HTMLElement | null) || lastNode;
        return {
          count: nodes.length,
          text: body?.innerText || "",
          done: Boolean(lastNode?.hasAttribute("data-message-complete")),
          streaming: Boolean(document.querySelector('[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]')),
        };
      }, ASSISTANT);
      if (state.count <= before || !state.text.trim()) continue;
      if (state.done && !state.streaming && state.text === last) return last;
      if (state.text !== last || state.streaming) {
        last = state.text;
        stableSince = Date.now();
        continue;
      }
      if (Date.now() - stableSince >= 3000) return last;
    }
    if (last.trim()) return last;
    throw new Error("ChatGPT did not answer in time. Check the ChatGPT Chrome window and try again.");
  });
  chatQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function writeBidText(opts: {
  source: string;
  jobId: number;
  telegramId?: number | null;
  fresh?: boolean;
}): Promise<{ text: string; engine: "openai" | "chatgpt"; cached: boolean; createdAt: string }> {
  const doc = await JobObservation.findOne({ source: opts.source, jobId: opts.jobId });
  if (!doc) throw new Error("Job not found");
  const saved = doc.get("bidDraft") as string | undefined;
  const savedAt = doc.get("bidDraftAt") as Date | undefined;
  if (!opts.fresh && saved && savedAt && Date.now() - savedAt.getTime() < DRAFT_TTL_MS) {
    return { text: saved, engine: (doc.get("bidDraftEngine") as "openai" | "chatgpt") || "chatgpt", cached: true, createdAt: savedAt.toISOString() };
  }

  const { content } = await getJobContent(opts.source, opts.jobId);
  const prompt = buildBidPrompt(
    { title: doc.title || "", source: sourceLabel(opts.source), price: priceText(doc), content },
    await userRules(opts.telegramId ?? null),
  );
  const engine = process.env.OPENAI_API_KEY ? "openai" : "chatgpt";
  const raw = engine === "openai" ? await askOpenAi(prompt) : await askChatGpt(prompt);
  const text = humanizeBid(raw);
  if (text.length < 80) throw new Error("The generated text was too short. Try again.");

  const createdAt = new Date();
  doc.set({ bidDraft: text, bidDraftAt: createdAt, bidDraftEngine: engine });
  await doc.save();
  console.log(`[bid] ${engine} wrote ${text.length} chars for ${opts.source} ${opts.jobId}`);
  return { text, engine, cached: false, createdAt: createdAt.toISOString() };
}
