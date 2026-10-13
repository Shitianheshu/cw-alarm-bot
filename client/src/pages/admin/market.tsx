import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Bell, Check, ChevronLeft, ChevronRight, Copy, Download, Loader2, PenLine, Radar, RefreshCw, Clock, Bot } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import api, { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Tooltip as HintTooltip, TooltipContent as HintContent, TooltipTrigger as HintTrigger } from "@/components/ui/tooltip";

type CheckpointRow = { minute: number; jobs: number; totalBids: number; avgBids: number };

type MarketReport = {
  generatedAt: string;
  lookbackHours: number;
  maxJobs: number;
  from: string;
  to: string;
  totalJobs: number;
  truncated: boolean;
  contracts?: { status: string; count: number }[];
  knownBids?: { jobs: number; average: number | null };
  byHour: { hour: string; count: number }[];
  checkpoints: CheckpointRow[];
  bots: {
    sampleJobs: number;
    approx: number | null;
    atLeast: number | null;
    windowMinutes: number;
    definition: string;
  };
  recent: {
    source?: string;
    jobId: number;
    title: string;
    postedClock: string;
    jobUrl?: string;
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
    scam?: boolean;
    bidUpdatedAt?: string | null;
    jobKind?: string;
    bids: Record<string, number | "missed" | null>;
    missReasons?: Record<string, string>;
  }[];
  watching: boolean;
  scanning: boolean;
  alarm?: boolean;
  alarmMinutes?: number[];
  lastError: string | null;
};

const WINDOWS = ["1", "2", "3", "5", "10", "20", "30"];
const PAGE_SIZE = 20;
const NEW_JOB_MS = 30 * 60 * 1000;
const HIGH_FIXED_YEN = 50_000;
const HIGH_HOURLY_YEN = 3_000;

function postedMs(clock: string) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(clock);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}T${match[2].length === 5 ? `${match[2]}:00` : match[2]}+09:00`);
  return Number.isFinite(ms) ? ms : null;
}

function priceHigh(job: { priceMin?: number | null; priceMax?: number | null }) {
  return job.priceMax ?? job.priceMin ?? null;
}

function isHighPrice(job: { payType?: string; priceMin?: number | null; priceMax?: number | null }) {
  const high = priceHigh(job);
  if (high == null) return false;
  return job.payType === "hourly" ? high >= HIGH_HOURLY_YEN : high >= HIGH_FIXED_YEN;
}

function isNewJob(clock: string, now = Date.now()) {
  const ms = postedMs(clock);
  return ms != null && now - ms >= 0 && now - ms <= NEW_JOB_MS;
}

function postedAgo(clock: string | undefined, now: number) {
  return agoLabel(clock ? postedMs(clock) : null, now);
}

function agoLabel(ms: number | null, now: number) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min ago` : `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function openInNewTab(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function FilterBadge({
  pressed,
  onClick,
  children,
  tone,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  tone?: "high";
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        badgeVariants({ variant: pressed ? "default" : "outline" }),
        "cursor-pointer px-2.5 py-1",
        pressed && tone === "high" && "border-transparent bg-[hsl(var(--chart-4))] text-white",
      )}
    >
      {children}
    </button>
  );
}

function BadgeSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <FilterBadge key={option.value} pressed={value === option.value} onClick={() => onChange(option.value)}>
            {option.label}
          </FilterBadge>
        ))}
      </div>
    </div>
  );
}

function BidSample({ value, reason }: { value: number | "missed" | null | undefined; reason?: string }) {
  if (value === "missed") {
    const chip = (
      <span className={cn("inline-flex rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground", reason && "cursor-help")}>
        Missed
      </span>
    );
    if (!reason) return chip;
    return (
      <HintTooltip>
        <HintTrigger asChild>{chip}</HintTrigger>
        <HintContent className="max-w-64 text-xs">{reason}</HintContent>
      </HintTooltip>
    );
  }
  if (typeof value === "number") {
    return <span className="inline-flex min-w-6 justify-center rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-primary">{value}</span>;
  }
  return <span className="text-muted-foreground">—</span>;
}

function priceLabel(job: { payType?: string; priceMin?: number | null; priceMax?: number | null }) {
  const low = job.priceMin ?? job.priceMax;
  const high = job.priceMax ?? job.priceMin;
  if (low == null || high == null) return "—";
  const yen = (n: number) => `¥${n.toLocaleString()}`;
  const unit = job.payType === "hourly" ? "/h" : "";
  return low === high ? `${yen(low)}${unit}` : `${yen(low)}–${yen(high)}${unit}`;
}

function splitClock(clock: string) {
  const [date, time] = clock.split(" ");
  return { date: date || "—", time: time || "" };
}

function contractLabel(status?: string, count?: number | null) {
  const name = status === "contracted" ? "Contracted" : status === "open" ? "Open" : status === "closed" ? "Closed" : "Unknown";
  return count != null && status === "contracted" ? `${name} (${count})` : name;
}

type CopyableJob = {
  source?: string;
  jobId: number;
  title: string;
  jobUrl?: string;
  postedClock?: string;
  clientName?: string;
  clientUrl?: string;
  bidCount?: number | null;
  payType?: string;
  priceMin?: number | null;
  priceMax?: number | null;
  scam?: boolean;
  jobKind?: string;
};

function jobCopyText(job: CopyableJob, content: string) {
  const url = job.jobUrl || `https://crowdworks.jp/public/jobs/${job.jobId}`;
  const ago = postedAgo(job.postedClock, Date.now());
  const client = job.clientName ? `${job.clientName}${job.clientUrl ? ` (${job.clientUrl})` : ""}` : "—";
  return [
    `${job.scam ? "[SCAM CLIENT] " : ""}${job.title || `Job ${job.jobId}`}`,
    url,
    `Site: ${sourceName(job.source)}${job.jobKind === "task" ? " (task)" : ""}`,
    `Posted: ${job.postedClock || "—"}${ago ? ` (${ago})` : ""}`,
    `Price: ${priceLabel(job)}`,
    `Bids: ${job.bidCount ?? "—"}`,
    `Client: ${client}`,
    "",
    "--- Description ---",
    content.trim(),
  ].join("\n");
}

const contentCache = new Map<string, Promise<string>>();

function loadJobContent(job: CopyableJob, telegramId: number | string | undefined): Promise<string> {
  const source = job.source || "crowdworks";
  const key = `${source}:${job.jobId}`;
  const cached = contentCache.get(key);
  if (cached) return cached;
  const request = (apiClient.get("/api/admin/market/job-content", { telegramId, source, jobId: job.jobId }) as Promise<{ content: string }>)
    .then((data) => {
      if (!data?.content?.trim()) throw new Error("The job page has no description.");
      return data.content;
    })
    .catch((e: any) => {
      contentCache.delete(key);
      throw new Error(e?.response?.data?.error || e?.message || "Failed to load the description");
    });
  contentCache.set(key, request);
  return request;
}

/** Writes text that is still loading; ClipboardItem keeps the click's permission while the request runs. */
async function writeClipboardLater(text: Promise<string>) {
  if (window.isSecureContext && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return;
    } catch (error) {
      await text;
      if (!(error instanceof DOMException)) throw error;
    }
  }
  await writeClipboard(await text);
}

async function writeClipboard(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  if (!ok) throw new Error("Clipboard is not available");
}

function CopyJobButton({ job, className }: { job: CopyableJob; className?: string }) {
  const { telegramUser } = useAuth();
  const telegramId = telegramUser?.id;
  const [state, setState] = useState<"idle" | "loading" | "copied">("idle");
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);

  const warm = () => {
    loadJobContent(job, telegramId).catch(() => undefined);
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7 shrink-0", className)}
      aria-label="Copy project with description"
      title="Copy project with description"
      disabled={state === "loading"}
      onMouseEnter={warm}
      onFocus={warm}
      onClick={async (event) => {
        event.stopPropagation();
        setState("loading");
        try {
          await writeClipboardLater(loadJobContent(job, telegramId).then((content) => jobCopyText(job, content)));
          setState("copied");
          toast({ title: "Copied", description: `${job.title || `Job ${job.jobId}`} (with description)` });
        } catch (e: any) {
          setState("idle");
          toast({
            title: "Not copied",
            description: `${e?.message || "Copy failed"}. Nothing was copied; try again.`,
            variant: "destructive",
          });
        }
      }}
    >
      {state === "loading" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : state === "copied" ? (
        <Check className="h-4 w-4 text-primary" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
    </Button>
  );
}

type BidDraft = { text: string; engine: "openai" | "chatgpt"; cached: boolean; createdAt: string };

function BidButton({ job, className }: { job: CopyableJob; className?: string }) {
  const { telegramUser } = useAuth();
  const telegramId = telegramUser?.id;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [meta, setMeta] = useState<BidDraft | null>(null);
  const [error, setError] = useState("");

  const generate = (fresh: boolean) => {
    setLoading(true);
    setError("");
    const request = (apiClient.post("/api/admin/market/bid-text", {
      telegramId,
      source: job.source || "crowdworks",
      jobId: job.jobId,
      fresh,
    }) as Promise<BidDraft>).then((data) => {
      if (!data?.text?.trim()) throw new Error("No text came back");
      return data;
    });

    writeClipboardLater(request.then((data) => data.text))
      .then(() => toast({ title: "Copied", description: "Bid sentence is on the clipboard." }))
      .catch(() => undefined);

    request
      .then((data) => {
        setText(data.text);
        setMeta(data);
      })
      .catch((e: any) => setError(e?.response?.data?.error || e?.message || "Failed to write the bid"))
      .finally(() => setLoading(false));
  };

  const copyNow = async () => {
    try {
      await writeClipboard(text);
      toast({ title: "Copied", description: "Bid sentence is on the clipboard." });
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || "Copy failed", variant: "destructive" });
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("h-7 w-7 shrink-0", className)}
        aria-label="Write bid sentence"
        title="Write bid sentence"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
          if (!text && !loading) generate(false);
        }}
      >
        <PenLine className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl" onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Bid sentence</DialogTitle>
            <DialogDescription className="line-clamp-2">{job.title || `Job ${job.jobId}`}</DialogDescription>
          </DialogHeader>
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              Writing with ChatGPT. This can take up to a minute.
            </div>
          ) : error ? (
            <Alert variant="destructive">
              <AlertTitle>Could not write the bid</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-2">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-[280px] text-sm leading-relaxed" />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {meta ? `${meta.engine === "openai" ? "OpenAI API" : "ChatGPT"}${meta.cached ? " · saved draft" : ""}` : ""}
                </span>
                <span className="tabular-nums">{text.length} characters</span>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" className="gap-2" onClick={() => generate(true)} disabled={loading}>
              <RefreshCw className="h-4 w-4" />
              Regenerate
            </Button>
            <Button className="gap-2" onClick={copyNow} disabled={loading || !text.trim()}>
              <Copy className="h-4 w-4" />
              Copy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type NewJobAlert = {
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
};

const ALERT_POLL_MS = 10_000;
const ALERT_KEEP = 30;

function sourceName(source?: string) {
  return source === "lancers" ? "Lancers" : source === "coconala" ? "Coconala" : "CrowdWorks";
}

function alertTime(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function NewJobAlerts({ telegramId }: { telegramId?: number | string }) {
  const [alerts, setAlerts] = useState<NewJobAlert[]>([]);
  const [unread, setUnread] = useState<Set<string>>(() => new Set());
  const [ready, setReady] = useState(false);
  const sinceRef = useRef<string | null>(null);
  const now = useNow();

  const markRead = useCallback((key: string) => {
    setUnread((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const poll = useCallback(async () => {
    if (!telegramId) return;
    try {
      const data = (await apiClient.get("/api/admin/market/alerts", {
        telegramId,
        ...(sinceRef.current ? { since: sinceRef.current } : {}),
      })) as { now: string; alerts: NewJobAlert[] };
      const first = sinceRef.current == null;
      const newest = data.alerts[0]?.alertAt;
      sinceRef.current = newest && (!sinceRef.current || newest > sinceRef.current) ? newest : sinceRef.current ?? data.now;
      if (!data.alerts.length) return;
      const keyOf = (a: NewJobAlert) => `${a.source}:${a.jobId}`;
      setAlerts((prev) => {
        const seen = new Set(prev.map(keyOf));
        return data.alerts.filter((a) => !seen.has(keyOf(a))).concat(prev).slice(0, ALERT_KEEP);
      });
      if (first) return;
      setUnread((prev) => {
        const next = new Set(prev);
        data.alerts.forEach((a) => next.add(keyOf(a)));
        return next;
      });
      const lead = data.alerts[0];
      const leadKey = keyOf(lead);
      toast({
        title: data.alerts.length > 1 ? `${data.alerts.length} new jobs` : `New job · ${sourceName(lead.source)}`,
        description: `${lead.scam ? "Scam client · " : ""}${lead.title} · Click to open`,
        variant: lead.scam ? "destructive" : "default",
        className: "cursor-pointer",
        onClick: (event) => {
          if ((event.target as HTMLElement).closest("[toast-close]")) return;
          openInNewTab(lead.jobUrl);
          markRead(leadKey);
        },
      });
    } catch {
      // The next poll retries; the report loader already surfaces API errors.
    } finally {
      setReady(true);
    }
  }, [telegramId, markRead]);

  useEffect(() => {
    poll();
    const timer = setInterval(poll, ALERT_POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            New job alerts
            {unread.size ? <Badge>{unread.size} new</Badge> : null}
          </CardTitle>
          <CardDescription>
            The same jobs Telegram announces as new. Click an alert to open the job in a new tab. Checked every 10 seconds; the first read after a restart is not announced.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setUnread(new Set())} disabled={!unread.size}>
          Mark all read
        </Button>
      </CardHeader>
      <CardContent>
        {!ready ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : alerts.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No new job alerts yet. They appear here while the watch is running.</p>
        ) : (
          <div className="max-h-80 divide-y overflow-y-auto rounded-md border">
            {alerts.map((alert) => {
              const key = `${alert.source}:${alert.jobId}`;
              const fresh = unread.has(key);
              const ago = postedAgo(alert.postedClock, now);
              return (
                <div
                  key={key}
                  role="link"
                  tabIndex={0}
                  title="Open job in a new tab"
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("a")) return;
                    openInNewTab(alert.jobUrl);
                    markRead(key);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.target !== event.currentTarget) return;
                    openInNewTab(alert.jobUrl);
                    markRead(key);
                  }}
                  className={cn("flex cursor-pointer flex-wrap items-start justify-between gap-3 px-4 py-3 hover-elevate", fresh && "bg-primary/5")}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1">
                      {fresh ? <Badge className="px-1.5 py-0 text-[11px]">New</Badge> : null}
                      {alert.scam ? <Badge variant="destructive" className="px-1.5 py-0 text-[11px]">Scam</Badge> : null}
                      <Badge variant="outline" className="px-1.5 py-0 text-[11px]">{sourceName(alert.source)}</Badge>
                      {alert.payType === "hourly" ? <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">Hourly</Badge> : null}
                      {isHighPrice(alert) ? (
                        <Badge className="border-transparent bg-[hsl(var(--chart-4))] px-1.5 py-0 text-[11px] text-white">High price</Badge>
                      ) : null}
                    </div>
                    <a
                      className="mt-1 block truncate text-sm font-medium underline-offset-4 hover:text-primary hover:underline"
                      href={alert.jobUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => markRead(key)}
                    >
                      {alert.title || `Job ${alert.jobId}`}
                    </a>
                    <div className="text-xs text-muted-foreground">
                      {alert.clientName || "Client unknown"} · {priceLabel(alert)} · {alert.bidCount == null ? "Bids —" : `${alert.bidCount} bids`}
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <div className="text-right text-xs text-muted-foreground tabular-nums">
                      {ago ? <div className="text-sm font-semibold text-foreground">{ago}</div> : null}
                      {alert.postedClock ? <div>Posted {splitClock(alert.postedClock).time || alert.postedClock}</div> : null}
                      <div>Detected {alertTime(alert.alertAt)}</div>
                    </div>
                    <BidButton job={alert} />
                    <CopyJobButton job={alert} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type RangePreset = "24h" | "today" | "since8" | "custom";

function tokyoInput(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}`;
}

function presetRange(preset: Exclude<RangePreset, "custom">) {
  const now = new Date();
  const to = tokyoInput(now);
  if (preset === "24h") return { from: tokyoInput(new Date(now.getTime() - 24 * 60 * 60 * 1000)), to };
  const day = to.slice(0, 10);
  if (preset === "today") return { from: `${day}T00:00`, to };
  return { from: `${day}T08:00`, to };
}

export default function AdminMarket() {
  const { telegramUser } = useAuth();
  const telegramId = telegramUser?.id;
  const [report, setReport] = useState<MarketReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [hours, setHours] = useState("24");
  const [busy, setBusy] = useState<"scan" | "watch" | "stop" | "csv" | null>(null);
  const [query, setQuery] = useState("");
  const [contractFilter, setContractFilter] = useState("all");
  const [sampleFilter, setSampleFilter] = useState("all");
  const [reviewFilter, setReviewFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [payFilter, setPayFilter] = useState("all");
  const [marks, setMarks] = useState({ latest: false, fresh: false, high: false });
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const opening = presetRange("24h");
  const [draftFrom, setDraftFrom] = useState(opening.from);
  const [draftTo, setDraftTo] = useState(opening.to);
  const [preset, setPreset] = useState<RangePreset>("24h");
  const [page, setPage] = useState(1);
  const tick = useNow();
  const rangeRef = useRef({ from: opening.from, to: opening.to, preset: "24h" as RangePreset });
  const draftRef = useRef({ from: opening.from, to: opening.to });
  draftRef.current = { from: draftFrom, to: draftTo };

  const load = useCallback(async () => {
    if (!telegramId) return;
    const current = rangeRef.current;
    const range = current.preset === "custom" ? current : { ...presetRange(current.preset), preset: current.preset };
    if (current.preset !== "custom") {
      const editing = draftRef.current.from !== current.from || draftRef.current.to !== current.to;
      rangeRef.current = range;
      if (!editing) {
        setDraftFrom(range.from);
        setDraftTo(range.to);
      }
    }
    try {
      const data = (await apiClient.get("/api/admin/market/report", {
        telegramId,
        from: range.from,
        to: range.to,
      })) as MarketReport;
      setReport(data);
    } catch (e: any) {
      toast({
        title: "Error",
        description: e?.response?.data?.error || e?.message || "Failed to load market report",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [telegramId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [query, contractFilter, sampleFilter, reviewFilter, payFilter, priceMin, priceMax, marks.latest, marks.fresh, marks.high, sourceFilter]);

  const run = async (kind: "scan" | "watch" | "stop") => {
    if (!telegramId) return;
    setBusy(kind);
    try {
      const path =
        kind === "scan" ? "/api/admin/market/scan" : kind === "watch" ? "/api/admin/market/watch" : "/api/admin/market/stop";
      const body =
        kind === "scan"
          ? { telegramId, hours: Number(hours) || 24, notify: true }
          : { telegramId };
      const result = await apiClient.post(path, body);
      toast({ title: "Market watch", description: result?.message || "Updated" });
      await load();
    } catch (e: any) {
      toast({
        title: "Error",
        description: e?.response?.data?.error || e?.message || "Request failed",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const applyPreset = (next: Exclude<RangePreset, "custom">) => {
    const range = presetRange(next);
    setPage(1);
    setPreset(next);
    rangeRef.current = { ...range, preset: next };
    setDraftFrom(range.from);
    setDraftTo(range.to);
    load();
  };

  const applyCustomRange = () => {
    setPage(1);
    setPreset("custom");
    rangeRef.current = { from: draftFrom, to: draftTo, preset: "custom" };
    load();
  };

  const pool = useMemo(() => {
    const list = report?.recent || [];
    const needle = query.trim().toLowerCase();
    const minYen = priceMin.trim() === "" ? null : Number(priceMin.replace(/,/g, ""));
    const maxYen = priceMax.trim() === "" ? null : Number(priceMax.replace(/,/g, ""));
    return list.filter((job) => {
      if (sourceFilter !== "all" && (job.source || "crowdworks") !== sourceFilter) return false;
      if (minYen != null || maxYen != null) {
        const low = job.priceMin ?? job.priceMax;
        const high = job.priceMax ?? job.priceMin;
        if (low == null || high == null) return false;
        if (minYen != null && Number.isFinite(minYen) && high < minYen) return false;
        if (maxYen != null && Number.isFinite(maxYen) && low > maxYen) return false;
      }
      if (contractFilter !== "all" && (job.contractStatus || "unknown") !== contractFilter) return false;
      if (reviewFilter === "yes" && !job.clientReview?.trim()) return false;
      if (reviewFilter === "no" && !!job.clientReview?.trim()) return false;
      if (sampleFilter === "counted" && job.bidCount == null) return false;
      if (sampleFilter === "missed" && !Object.values(job.bids || {}).includes("missed")) return false;
      if (sampleFilter === "pending" && !WINDOWS.some((minute) => job.bids?.[minute] == null)) return false;
      if (!needle) return true;
      return [job.title, job.clientName, job.postedClock, String(job.jobId), job.contractStatus]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [report?.recent, query, contractFilter, sampleFilter, reviewFilter, priceMin, priceMax, sourceFilter]);

  const rows = useMemo(() => {
    const now = Date.now();
    let list = pool.filter((job) => {
      if (payFilter !== "all" && (job.payType || "") !== payFilter) return false;
      if (marks.fresh && !isNewJob(job.postedClock || "", now)) return false;
      if (marks.high && !isHighPrice(job)) return false;
      return true;
    });
    if (marks.latest) list = list.slice(0, 1);
    return list;
  }, [pool, payFilter, marks, report?.generatedAt]);

  const filtersActive = query.trim() !== "" || sourceFilter !== "all" || contractFilter !== "all" || sampleFilter !== "all" || reviewFilter !== "all" || payFilter !== "all" || priceMin.trim() !== "" || priceMax.trim() !== "" || marks.latest || marks.fresh || marks.high;

  const filteredView = useMemo(() => {
    if (!filtersActive) return null;
    const contracts: Record<string, number> = { open: 0, contracted: 0, closed: 0, unknown: 0 };
    let knownJobs = 0;
    let knownSum = 0;
    const hours = new Map<string, number>();
    const checkpoints = [1, 2, 5, 10, 20, 30].map((minute) => ({ minute, jobs: 0, totalBids: 0, avgBids: 0 }));
    for (const job of rows) {
      const status = job.contractStatus || "unknown";
      contracts[status] = (contracts[status] ?? 0) + 1;
      if (job.bidCount != null) {
        knownJobs += 1;
        knownSum += job.bidCount;
      }
      if (job.postedClock) hours.set(`${job.postedClock.slice(0, 13)}:00`, (hours.get(`${job.postedClock.slice(0, 13)}:00`) ?? 0) + 1);
      for (const row of checkpoints) {
        const value = job.bids?.[String(row.minute)];
        if (typeof value === "number" && job.jobKind !== "task") {
          row.jobs += 1;
          row.totalBids += value;
        }
      }
    }
    for (const row of checkpoints) row.avgBids = row.jobs ? Math.round((row.totalBids / row.jobs) * 10) / 10 : 0;
    return {
      total: rows.length,
      contracts,
      knownBids: { jobs: knownJobs, average: knownJobs ? Math.round((knownSum / knownJobs) * 10) / 10 : null },
      byHour: Array.from(hours.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([hour, count]) => ({ hour, count })),
      checkpoints,
    };
  }, [filtersActive, rows]);

  const nowMs = Math.max(tick, Date.now());
  const latestJobId = rows[0]?.jobId;
  const badgeCounts = {
    fresh: pool.filter((job) => isNewJob(job.postedClock || "", nowMs)).length,
    hourly: pool.filter((job) => job.payType === "hourly").length,
    high: pool.filter((job) => isHighPrice(job)).length,
  };
  const toggleMark = (key: "latest" | "fresh" | "high") => {
    setMarks((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const toggleHourly = () => setPayFilter((prev) => (prev === "hourly" ? "all" : "hourly"));

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageStart = rows.length ? (safePage - 1) * PAGE_SIZE : 0;
  const pageRows = rows.slice(pageStart, pageStart + PAGE_SIZE);

  const downloadCsv = async () => {
    if (!telegramId) return;
    setBusy("csv");
    try {
      const range = rangeRef.current;
      const res = await api.get("/api/admin/market/timestamps", {
        params: { telegramId, from: range.from, to: range.to },
        responseType: "blob",
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cw-jobs-${range.from.slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({
        title: "Error",
        description: e?.message || "Failed to download CSV",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  if (loading && !report) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const bots = report?.bots;
  const contractCount = (status: string) =>
    filteredView ? filteredView.contracts[status] ?? 0 : report?.contracts?.find((row) => row.status === status)?.count ?? 0;
  const knownBids = filteredView?.knownBids ?? report?.knownBids;
  const hourRows = filteredView?.byHour ?? report?.byHour ?? [];
  const checkpointRows = filteredView?.checkpoints ?? report?.checkpoints ?? [];
  const jobTotal = filteredView ? filteredView.total : report?.totalJobs ?? 0;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold mb-2" data-testid="text-page-title">
            Market watch
          </h1>
          <p className="text-muted-foreground">
            CrowdWorks, Coconala, and Lancers. Cards and the chart follow the filters. A dash means that minute was not sampled. Missed means the check ran too late to count.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {report?.watching ? <Badge>Watching</Badge> : <Badge variant="secondary">Watch idle</Badge>}
          {report?.alarm ? (
            <Badge>Alarm {report.alarmMinutes?.join(", ")}m</Badge>
          ) : (
            <Badge variant="secondary">Alarm off</Badge>
          )}
          {report?.scanning ? <Badge variant="outline">Scanning</Badge> : null}
          <Button variant="outline" className="gap-2" onClick={downloadCsv} disabled={busy != null || !report?.totalJobs}>
            {busy === "csv" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export CSV
          </Button>
        </div>
      </div>

      <NewJobAlerts telegramId={telegramId} />

      <Card>
        <CardHeader>
          <CardTitle>Scan settings</CardTitle>
          <CardDescription>
            Choose how many hours to scan. A finished scan is also sent to the Telegram admin.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="market-hours">Hours</label>
            <Input id="market-hours" value={hours} onChange={(e) => setHours(e.target.value)} className="w-28" inputMode="numeric" />
          </div>
          <Button onClick={() => run("scan")} disabled={busy != null || report?.scanning}>
            {busy === "scan" || report?.scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Scan
          </Button>
          <Button variant="outline" onClick={() => run("watch")} disabled={busy != null || report?.watching}>
            Start watch
          </Button>
          <Button variant="outline" onClick={() => run("stop")} disabled={busy != null || !report?.watching}>
            Stop watch
          </Button>
          <Button variant="ghost" onClick={load} disabled={busy != null}>
            Refresh
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Times are Tokyo. Last 24 hours, today, and since 08:00 keep moving. Apply holds a fixed from/to. Badge filters combine.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <BadgeSelect
            label="Site"
            value={sourceFilter}
            onChange={setSourceFilter}
            options={[
              { value: "all", label: "All" },
              { value: "crowdworks", label: "CrowdWorks" },
              { value: "coconala", label: "Coconala" },
              { value: "lancers", label: "Lancers" },
            ]}
          />
          <div className="space-y-2">
            <div className="text-sm font-medium">Badges</div>
            <div className="flex flex-wrap gap-2">
              <FilterBadge pressed={marks.latest} onClick={() => toggleMark("latest")}>Latest {pool.length ? 1 : 0}</FilterBadge>
              <FilterBadge pressed={marks.fresh} onClick={() => toggleMark("fresh")}>New {badgeCounts.fresh}</FilterBadge>
              <FilterBadge pressed={payFilter === "hourly"} onClick={toggleHourly}>Hourly {badgeCounts.hourly}</FilterBadge>
              <FilterBadge pressed={marks.high} onClick={() => toggleMark("high")} tone="high">High price {badgeCounts.high}</FilterBadge>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="market-from">From</label>
              <Input id="market-from" type="datetime-local" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} className="w-52" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="market-to">To</label>
              <Input id="market-to" type="datetime-local" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} className="w-52" />
            </div>
            <Button variant={preset === "24h" ? "default" : "outline"} onClick={() => applyPreset("24h")}>Last 24h</Button>
            <Button variant={preset === "today" ? "default" : "outline"} onClick={() => applyPreset("today")}>Today</Button>
            <Button variant={preset === "since8" ? "default" : "outline"} onClick={() => applyPreset("since8")}>Since 08:00</Button>
            <Button variant="outline" onClick={applyCustomRange}>Apply range</Button>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <BadgeSelect
              label="Pay"
              value={payFilter}
              onChange={setPayFilter}
              options={[
                { value: "all", label: "All" },
                { value: "fixed", label: "Fixed" },
                { value: "hourly", label: "Hourly" },
              ]}
            />
            <BadgeSelect
              label="Contract"
              value={contractFilter}
              onChange={setContractFilter}
              options={[
                { value: "all", label: "All" },
                { value: "open", label: "Open" },
                { value: "contracted", label: "Contracted" },
                { value: "closed", label: "Closed" },
                { value: "unknown", label: "Unknown" },
              ]}
            />
            <BadgeSelect
              label="Bid sample"
              value={sampleFilter}
              onChange={setSampleFilter}
              options={[
                { value: "all", label: "All" },
                { value: "counted", label: "Has a bid count" },
                { value: "missed", label: "Has a missed sample" },
                { value: "pending", label: "Still waiting" },
              ]}
            />
            <BadgeSelect
              label="Review"
              value={reviewFilter}
              onChange={setReviewFilter}
              options={[
                { value: "all", label: "All" },
                { value: "yes", label: "Has a review" },
                { value: "no", label: "No review" },
              ]}
            />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="market-price-min">Min yen</label>
              <Input id="market-price-min" value={priceMin} onChange={(e) => setPriceMin(e.target.value)} className="w-32" inputMode="numeric" placeholder="0" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="market-price-max">Max yen</label>
              <Input id="market-price-max" value={priceMax} onChange={(e) => setPriceMax(e.target.value)} className="w-32" inputMode="numeric" placeholder="Any" />
            </div>
            <div className="space-y-1 flex-1 min-w-[220px]">
              <label className="text-sm font-medium" htmlFor="market-query">Search</label>
              <Input id="market-query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Title, client, or job id" />
            </div>
          </div>
        </CardContent>
      </Card>

      {report?.lastError ? (
        <Alert variant="destructive">
          <AlertTitle>Latest CrowdWorks read failed</AlertTitle>
          <AlertDescription>
            {report.lastError} Stored jobs below stay visible. Bid counts stay blank until a job page is read successfully. Missed means the minute passed before that read.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Jobs posted</CardTitle>
            <Radar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{jobTotal.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {report?.from} — {report?.to}
              {filteredView ? " · matching filters" : ""}
              {report?.truncated ? ` · stopped at cap ${report.maxJobs.toLocaleString()}` : ""}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Known bid counts</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{(knownBids?.jobs ?? 0).toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {knownBids?.average == null
                ? "CrowdWorks has not returned a bid count yet"
                : `Average ${knownBids.average} bids per job`}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Contracts</CardTitle>
            <Radar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-sm leading-6">
              <div className="flex justify-between gap-4"><span>Open</span><span className="font-medium">{contractCount("open")}</span></div>
              <div className="flex justify-between gap-4"><span>Contracted</span><span className="font-medium">{contractCount("contracted")}</span></div>
              <div className="flex justify-between gap-4"><span>Closed</span><span className="font-medium">{contractCount("closed")}</span></div>
              <div className="flex justify-between gap-4"><span>Unknown</span><span className="font-medium">{contractCount("unknown")}</span></div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active bots (approx)</CardTitle>
            <Bot className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{bots?.approx == null ? "—" : bots.approx}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {bots?.atLeast == null
                ? "Waiting for 2-minute samples"
                : `At least ${bots.atLeast} on one job · ${bots.sampleJobs} jobs in ${bots.windowMinutes} min`}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Bid windows</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-sm leading-6">
              {checkpointRows.map((row) => (
                <div key={row.minute} className="flex justify-between gap-4">
                  <span>{row.minute} min</span>
                  <span className="font-medium">{row.jobs ? `avg ${row.avgBids}` : "—"}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Posts by hour (Tokyo)</CardTitle>
          <CardDescription>Each bar is how many jobs were released in that hour. Exact second timestamps are in the CSV.</CardDescription>
        </CardHeader>
        <CardContent>
          {!hourRows.length ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No jobs stored for this window yet. Run a scan.</p>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourRows}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="hour" className="text-xs" tick={{ fontSize: 11 }} />
                  <YAxis className="text-xs" allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "var(--radius)",
                    }}
                  />
                  <Bar dataKey="count" fill="hsl(var(--chart-2))" name="Jobs" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle>All jobs</CardTitle>
            <CardDescription>
              {rows.length
                ? `${pageStart + 1}–${pageStart + pageRows.length} of ${rows.length.toLocaleString()}`
                : "No jobs in this view"}
              {report && report.totalJobs > (report.recent?.length || 0)
                ? ` · ${report.totalJobs.toLocaleString()} stored in this range`
                : ""}
              {" · "}New is the last 30 minutes. High price is ¥50,000+ fixed, or ¥3,000/h.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <FilterBadge pressed={marks.latest} onClick={() => toggleMark("latest")}>Latest {pool.length ? 1 : 0}</FilterBadge>
            <FilterBadge pressed={marks.fresh} onClick={() => toggleMark("fresh")}>New {badgeCounts.fresh}</FilterBadge>
            <FilterBadge pressed={payFilter === "hourly"} onClick={toggleHourly}>Hourly {badgeCounts.hourly}</FilterBadge>
            <FilterBadge pressed={marks.high} onClick={() => toggleMark("high")} tone="high">High price {badgeCounts.high}</FilterBadge>
            <span className="inline-flex items-center gap-1.5"><span className="inline-flex min-w-6 justify-center rounded-md bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">3</span> counted</span>
            <span className="inline-flex items-center gap-1.5"><span className="inline-flex rounded-md bg-muted px-1.5 py-0.5 font-medium">Missed</span> too late</span>
            <span>— not sampled</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[1180px] text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="w-36 px-4 py-3 text-left text-sm font-medium text-muted-foreground">Posted</th>
                  <th className="min-w-[240px] px-4 py-3 text-left text-sm font-medium text-muted-foreground">Job</th>
                  <th className="w-40 px-4 py-3 text-left text-sm font-medium text-muted-foreground">Price</th>
                  <th className="w-24 px-4 py-3 text-right text-sm font-medium text-muted-foreground">Bids</th>
                  <th className="w-36 px-4 py-3 text-left text-sm font-medium text-muted-foreground">Contract</th>
                  <th className="min-w-[160px] px-4 py-3 text-left text-sm font-medium text-muted-foreground">Client</th>
                  <th className="min-w-[200px] px-4 py-3 text-left text-sm font-medium text-muted-foreground">Review</th>
                  {WINDOWS.map((minute) => (
                    <th key={minute} className="w-16 px-2 py-3 text-center text-sm font-medium text-muted-foreground">{minute}m</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((job) => {
                  const clock = splitClock(job.postedClock || "");
                  const ago = postedAgo(job.postedClock, nowMs);
                  const href = job.jobUrl || `https://crowdworks.jp/public/jobs/${job.jobId}`;
                  return (
                    <tr key={`${job.source || "crowdworks"}:${job.jobId}`} className="border-b align-top hover-elevate">
                      <td className="px-4 py-3">
                        {ago ? <div className="text-sm font-semibold">{ago}</div> : null}
                        <div className="font-mono text-xs font-medium">{clock.time || "—"}</div>
                        <div className="text-xs text-muted-foreground">{clock.date}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-start gap-1">
                          <a className="line-clamp-2 flex-1 text-sm font-medium leading-snug text-foreground underline-offset-4 hover:text-primary hover:underline" href={href} target="_blank" rel="noreferrer">
                            {job.title || `Job ${job.jobId}`}
                          </a>
                          <BidButton job={job} className="-mt-1" />
                          <CopyJobButton job={job} className="-mt-1" />
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {job.scam ? <Badge variant="destructive" className="px-1.5 py-0 text-[11px]">Scam</Badge> : null}
                          <Badge variant="outline" className="px-1.5 py-0 text-[11px]">{job.source === "lancers" ? "Lancers" : job.source === "coconala" ? "Coconala" : "CrowdWorks"}</Badge>
                          {job.jobId === latestJobId ? <Badge className="px-1.5 py-0 text-[11px]">Latest</Badge> : null}
                          {isNewJob(job.postedClock || "", nowMs) ? <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">New</Badge> : null}
                          {job.payType === "hourly" ? <Badge variant="outline" className="px-1.5 py-0 text-[11px]">Hourly</Badge> : null}
                          {job.jobKind === "task" ? (
                            <HintTooltip>
                              <HintTrigger asChild>
                                <Badge variant="secondary" className="cursor-help px-1.5 py-0 text-[11px]">Task</Badge>
                              </HintTrigger>
                              <HintContent className="max-w-64 text-xs">
                                Task job (survey etc.). Bids are tasks completed plus people working now. Not used for the bot estimate or bid averages.
                              </HintContent>
                            </HintTooltip>
                          ) : null}
                          {isHighPrice(job) ? <Badge className="border-transparent bg-[hsl(var(--chart-4))] px-1.5 py-0 text-[11px] text-white">High price</Badge> : null}
                        </div>
                        <div className="mt-1 font-mono text-xs text-muted-foreground">{job.jobId}</div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm tabular-nums">{priceLabel(job)}</td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">
                        {job.bidCount == null ? <span className="font-normal text-muted-foreground">—</span> : job.bidCount}
                        {job.bidUpdatedAt ? (
                          <div className="whitespace-nowrap text-[11px] font-normal text-muted-foreground">
                            {agoLabel(Date.parse(job.bidUpdatedAt), nowMs)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={job.contractStatus === "contracted" ? "default" : job.contractStatus === "unknown" ? "outline" : "secondary"}>
                          {contractLabel(job.contractStatus, job.contractCount)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        {job.clientUrl ? (
                          <a className="text-sm font-medium underline-offset-4 hover:text-primary hover:underline" href={job.clientUrl} target="_blank" rel="noreferrer">
                            {job.clientName || "Client"}
                          </a>
                        ) : (
                          <span className="text-sm">{job.clientName || "—"}</span>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {job.clientRating == null ? "Rating not loaded" : `${job.clientRating} · ${job.clientReviewCount ?? 0} reviews`}
                        </div>
                        {job.scam ? <Badge variant="destructive" className="mt-1 px-1.5 py-0 text-[11px]">Scam client</Badge> : null}
                      </td>
                      <td className="max-w-[240px] px-4 py-3">
                        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground" title={job.clientReview || undefined}>
                          {job.clientReview || "—"}
                        </p>
                      </td>
                      {WINDOWS.map((minute) => (
                        <td key={minute} className="px-2 py-3 text-center">
                          <BidSample value={job.bids?.[minute]} reason={job.missReasons?.[minute]} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {!pageRows.length ? (
                  <tr>
                    <td colSpan={14} className="px-4 py-16 text-center text-sm text-muted-foreground">No jobs match these filters.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-muted-foreground">
              Page {safePage} of {pageCount}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="gap-1" onClick={() => setPage(safePage - 1)} disabled={safePage <= 1}>
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <Button variant="outline" size="sm" className="gap-1" onClick={() => setPage(safePage + 1)} disabled={safePage >= pageCount}>
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
