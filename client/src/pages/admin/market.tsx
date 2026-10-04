import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Download, Loader2, Radar, Clock, Bot } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import api, { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "@/hooks/use-toast";

type CheckpointRow = { minute: number; jobs: number; totalBids: number; avgBids: number };

type MarketReport = {
  generatedAt: string;
  lookbackHours: number;
  maxJobs: number;
  from: string;
  to: string;
  totalJobs: number;
  truncated: boolean;
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
    jobId: number;
    title: string;
    postedClock: string;
    bids: Record<string, number | null>;
  }[];
  watching: boolean;
  scanning: boolean;
  alarm?: boolean;
  alarmMinutes?: number[];
  lastError: string | null;
};

const WINDOWS = ["1", "3", "5", "10", "20", "30"];

function bidCell(value: number | null | undefined) {
  return value == null ? "—" : String(value);
}

export default function AdminMarket() {
  const { telegramUser } = useAuth();
  const telegramId = telegramUser?.id;
  const [report, setReport] = useState<MarketReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [hours, setHours] = useState("24");
  const [maxJobs, setMaxJobs] = useState("100000");
  const [busy, setBusy] = useState<"scan" | "watch" | "stop" | "csv" | null>(null);
  const hoursRef = useRef(hours);
  hoursRef.current = hours;

  const load = useCallback(async () => {
    if (!telegramId) return;
    try {
      const data = (await apiClient.get("/api/admin/market/report", {
        telegramId,
        hours: Number(hoursRef.current) || 24,
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
    if (!report?.scanning && !report?.watching) return;
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [report?.scanning, report?.watching, load]);

  const run = async (kind: "scan" | "watch" | "stop") => {
    if (!telegramId) return;
    setBusy(kind);
    try {
      const path =
        kind === "scan" ? "/api/admin/market/scan" : kind === "watch" ? "/api/admin/market/watch" : "/api/admin/market/stop";
      const body =
        kind === "scan"
          ? { telegramId, hours: Number(hours) || 24, maxJobs: Number(maxJobs) || 100000, notify: true }
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

  const downloadCsv = async () => {
    if (!telegramId) return;
    setBusy("csv");
    try {
      const res = await api.get("/api/admin/market/timestamps", {
        params: { telegramId, hours: Number(hours) || 24 },
        responseType: "blob",
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cw-jobs-${Number(hours) || 24}h.csv`;
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

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold mb-2" data-testid="text-page-title">
            Market watch
          </h1>
          <p className="text-muted-foreground">
            Jobs posted in the lookback window, bid counts at 1–30 minutes, and an estimate of active bidding bots
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

      <Card>
        <CardHeader>
          <CardTitle>Scan settings</CardTitle>
          <CardDescription>
            Lookback and the job cap are configurable. Default cap is 100,000. A finished scan is also sent to the Telegram admin.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="market-hours">Hours</label>
            <Input id="market-hours" value={hours} onChange={(e) => setHours(e.target.value)} className="w-28" inputMode="numeric" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="market-max">Max jobs</label>
            <Input id="market-max" value={maxJobs} onChange={(e) => setMaxJobs(e.target.value)} className="w-36" inputMode="numeric" />
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

      {report?.lastError ? (
        <p className="text-sm text-destructive">{report.lastError}</p>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Jobs posted</CardTitle>
            <Radar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{(report?.totalJobs ?? 0).toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {report?.from} — {report?.to}
              {report?.truncated ? ` · stopped at cap ${report.maxJobs.toLocaleString()}` : ""}
            </p>
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
                ? "Waiting for 3-minute samples"
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
              {(report?.checkpoints || []).map((row) => (
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
          {!report?.byHour?.length ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No jobs stored for this window yet. Run a scan.</p>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={report.byHour}>
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
        <CardHeader>
          <CardTitle>Latest jobs</CardTitle>
          <CardDescription>
            Posted clock is Tokyo time, down to the second. Bid columns are the proposal count observed at that minute after posting.
            {bots?.definition ? ` ${bots.definition}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background border-b">
                <tr>
                  <th className="text-left py-2 px-2">Posted</th>
                  <th className="text-left py-2 px-2">Job</th>
                  <th className="text-left py-2 px-2">Title</th>
                  {WINDOWS.map((minute) => (
                    <th key={minute} className="text-right py-2 px-2">{minute}m</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(report?.recent || []).map((job) => (
                  <tr key={job.jobId} className="border-b">
                    <td className="py-2 px-2 font-mono text-xs whitespace-nowrap">{job.postedClock}</td>
                    <td className="py-2 px-2 font-mono text-xs">{job.jobId}</td>
                    <td className="py-2 px-2 max-w-[280px] truncate">{job.title}</td>
                    {WINDOWS.map((minute) => (
                      <td key={minute} className="py-2 px-2 text-right">{bidCell(job.bids?.[minute])}</td>
                    ))}
                  </tr>
                ))}
                {!report?.recent?.length ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-muted-foreground">No rows yet.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
