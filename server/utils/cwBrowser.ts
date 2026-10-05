import fs from "fs";
import os from "os";
import path from "path";
import type { AxiosRequestConfig } from "axios";

const EXTENSION_ID = "eppiocemhmnlbhjplcgkofciiegomcon";

type ConnectFn = (typeof import("puppeteer-real-browser"))["connect"];

type BrowserPage = {
  goto: (url: string, opts?: { waitUntil?: "domcontentloaded"; timeout?: number }) => Promise<{ status: () => number } | null>;
  content: () => Promise<string>;
  isClosed?: () => boolean;
};

type BrowserSession = {
  browser: { newPage: () => Promise<BrowserPage>; on: (ev: string, fn: () => void) => void };
  page: BrowserPage;
  owned: boolean;
};

type UrbanProfile = {
  userDataDir: string;
  profile: string;
};

let session: BrowserSession | null = null;
let queue: Promise<void> = Promise.resolve();

function debugPort(): number {
  const parsed = Number.parseInt(process.env.CW_DEBUG_PORT || "9222", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 9222;
}

function userDataRoots(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    return [path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data")].filter(Boolean);
  }
  return [
    path.join(home, ".config", "google-chrome"),
    path.join(home, ".config", "chromium"),
    path.join(home, "snap", "chromium", "common", "chromium"),
  ];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[._]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[._]/).map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Chrome profile that already has Urban VPN installed. */
export function findUrbanProfile(): UrbanProfile | null {
  let best: (UrbanProfile & { version: string }) | null = null;
  for (const userDataDir of userDataRoots()) {
    if (!fs.existsSync(userDataDir)) continue;
    let profiles: string[] = [];
    try {
      profiles = fs.readdirSync(userDataDir);
    } catch {
      continue;
    }
    for (const profile of profiles) {
      if (profile !== "Default" && !profile.startsWith("Profile")) continue;
      const extRoot = path.join(userDataDir, profile, "Extensions", EXTENSION_ID);
      if (!fs.existsSync(extRoot)) continue;
      for (const version of fs.readdirSync(extRoot)) {
        if (!fs.existsSync(path.join(extRoot, version, "manifest.json"))) continue;
        if (!best || compareVersions(version, best.version) > 0) {
          best = { userDataDir, profile, version };
        }
      }
    }
  }
  return best ? { userDataDir: best.userDataDir, profile: best.profile } : null;
}

function findChrome(): string | undefined {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ]
    : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function chromeIsOpen(userDataDir: string): boolean {
  return ["SingletonLock", "SingletonCookie", "SingletonSocket"].some((name) =>
    fs.existsSync(path.join(userDataDir, name)),
  );
}

function buildUrl(url: string, extra?: AxiosRequestConfig): string {
  const built = new URL(url);
  const params = extra?.params as Record<string, unknown> | undefined;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null) built.searchParams.set(key, String(value));
    }
  }
  return built.toString();
}

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function restartHint(profile: UrbanProfile | null): string {
  const port = debugPort();
  const chrome = findChrome() || "google-chrome";
  const profileArg = profile ? ` --profile-directory="${profile.profile}"` : "";
  return [
    "Chrome is already open, so this app cannot join the Urban VPN window.",
    "Quit Chrome, then start it again with Urban VPN turned on:",
    `${chrome} --remote-debugging-port=${port}${profileArg}`,
    "Leave that window open and run the scan again.",
  ].join(" ");
}

async function attach(port: number): Promise<BrowserSession | null> {
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!probe.ok) return null;
  } catch {
    return null;
  }
  const imported = await import("rebrowser-puppeteer-core");
  const puppeteer = ("default" in imported && imported.default ? imported.default : imported) as {
    connect: (opts: { browserURL: string; defaultViewport: null }) => Promise<BrowserSession["browser"]>;
  };
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`,
    defaultViewport: null,
  });
  const page = await browser.newPage();
  console.log(`[cw] using the open Chrome on port ${port}. Keep Urban VPN turned on there.`);
  return { browser, page, owned: false };
}

async function launchWithProfile(profile: UrbanProfile): Promise<BrowserSession> {
  const { connect } = (await import("puppeteer-real-browser")) as { connect: ConnectFn };
  const chromePath = findChrome();
  console.log(`[cw] opening Chrome profile ${profile.profile} with the installed Urban VPN extension`);
  const started = await connect({
    headless: false,
    ignoreAllFlags: true,
    disableXvfb: process.platform !== "linux" || Boolean(process.env.DISPLAY),
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      `--profile-directory=${profile.profile}`,
    ],
    customConfig: {
      userDataDir: profile.userDataDir,
      chromePath,
    },
    turnstile: false,
    connectOption: { protocolTimeout: 120_000 },
  });
  const browser = started.browser as unknown as BrowserSession["browser"];
  const page = started.page as unknown as BrowserPage;
  console.log("[cw] CrowdWorks is read in that Chrome window. Keep Urban VPN turned on.");
  return { browser, page, owned: true };
}

async function ensureBrowser(): Promise<BrowserSession> {
  if (session && session.page.isClosed?.() !== true) return session;
  const port = debugPort();
  const attached = await attach(port);
  if (attached) {
    session = attached;
    attached.browser.on("disconnected", () => {
      session = null;
    });
    return attached;
  }

  const profile = findUrbanProfile();
  if (!profile) {
    throw new Error("Urban VPN is not installed in Chrome. Install it, turn it on, then scan again.");
  }
  if (chromeIsOpen(profile.userDataDir)) {
    throw new Error(restartHint(profile));
  }

  session = await launchWithProfile(profile);
  session.browser.on("disconnected", () => {
    session = null;
  });
  return session;
}

export function browseCrowdWorks(url: string, extra?: AxiosRequestConfig): Promise<{ status: number; data: string }> {
  const target = buildUrl(url, extra);
  const timeout = typeof extra?.timeout === "number" ? extra.timeout : 45_000;
  return runExclusive(async () => {
    const current = await ensureBrowser();
    const response = await current.page.goto(target, { waitUntil: "domcontentloaded", timeout });
    const status = response?.status() ?? 0;
    const data = await current.page.content();
    if (status === 403) {
      console.warn("[cw] CrowdWorks returned 403 in Chrome. Turn Urban VPN on in that window, then scan again.");
    }
    return { status, data };
  });
}
