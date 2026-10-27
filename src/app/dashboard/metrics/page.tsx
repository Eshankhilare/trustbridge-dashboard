"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  TimerReset,
  Users,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WaveReadinessBar } from "@/components/WaveReadinessBar";
import { HorizonLatencyChart } from "@/components/HorizonLatencyChart";
import { AddressAnomalyBanner } from "@/components/AddressAnomalyBanner";
import type { HorizonLatencyStats } from "@/lib/stats";
import type { AnomalyStatus } from "@/lib/address-anomaly";

interface CircuitBreakerTripEvent {
  trippedAt: number;
  failureCountAtTrip: number;
  recoveredAt: number | null;
}

interface MetricsResponse {
  contributors: {
    total: number;
    ready: number;
    readyPercent: number;
    byStatus: {
      ready: number;
      low_reserve: number;
      not_ready: number;
    };
  };
  horizonLatency?: HorizonLatencyStats;
  addressAnomaly?: AnomalyStatus;
  audit: {
    recentEntries: number;
    byAction: Record<string, number>;
    latestAt: string | null;
  };
  circuitBreaker: {
    state: "CLOSED" | "OPEN" | "HALF_OPEN";
    failureCount: number;
    successCount: number;
    lastFailureTime: number | null;
    totalTrips: number;
    recentTrips: CircuitBreakerTripEvent[];
    processLocal: boolean;
  };
  rateLimit: {
    activeIdentifiers: number;
    totalAllowed: number;
    totalBlocked: number;
    processLocal: boolean;
  };
  config: {
    rateLimitWindowMs: number;
    rateLimitMaxRequests: number;
    circuitBreakerFailureThreshold: number;
    circuitBreakerSuccessThreshold: number;
    circuitBreakerRecoveryMs: number;
    staleCsvMaxAgeMs: number;
    horizonUrl: string;
    sorobanContractConfigured: boolean;
  };
}

function msToSeconds(ms: number) {
  return (ms / 1000).toFixed(0);
}

function msToHours(ms: number) {
  return (ms / 3_600_000).toFixed(1);
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return "Never";
  return new Date(ts).toLocaleString();
}

function CircuitBreakerStateBadge({ state }: { state: MetricsResponse["circuitBreaker"]["state"] }) {
  switch (state) {
    case "CLOSED":
      return (
        <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          <CheckCircle2 className="mr-1 h-3 w-3" />
          Closed — Healthy
        </Badge>
      );
    case "OPEN":
      return (
        <Badge className="bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300">
          <AlertTriangle className="mr-1 h-3 w-3" />
          Open — Tripped
        </Badge>
      );
    case "HALF_OPEN":
      return (
        <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <TimerReset className="mr-1 h-3 w-3" />
          Half-open — Recovering
        </Badge>
      );
  }
}

function ProcessLocalNote() {
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      ⚠️ Process-local data only — each server instance reports its own state until Redis is deployed.
    </p>
  );
}

export default function MetricsPage() {
  const metricsQuery = useQuery<MetricsResponse>({
    queryKey: ["admin-metrics"],
    queryFn: async () => {
      const res = await fetch("/api/metrics");
      if (!res.ok) throw new Error("Failed to load metrics");
      return res.json();
    },
    refetchInterval: 15000,
  });

  const queueHealthQuery = useQuery<{
    depth: number;
    failedCount: number;
    oldestPendingJobCreatedAt: string | null;
    serverlessNotice: string;
  }>({
    queryKey: ["admin-queue-health"],
    queryFn: async () => {
      const res = await fetch("/api/contributors/queue/health");
      if (!res.ok) return { depth: 0, failedCount: 0, oldestPendingJobCreatedAt: null, serverlessNotice: "" };
      return res.json();
    },
  });

  if (metricsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading metrics…
      </div>
    );
  }

  if (metricsQuery.isError) {
    return (
      <p
        className="my-8 rounded-lg border border-destructive/60 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        role="alert"
      >
        Failed to load metrics. Make sure you are signed in as a maintainer.
      </p>
    );
  }

  const data = metricsQuery.data!;
  const { contributors, audit, circuitBreaker, rateLimit, config } = data;
  const auditEntries = Object.entries(audit.byAction).sort((a, b) => b[1] - a[1]);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10"
      data-testid="metrics-page"
    >
      <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Admin metrics</h1>
          <p className="mt-2 text-sm text-muted-foreground sm:text-base">
            Real-time operational snapshot for the TrustBridge maintainer team.
            Auto-refreshes every 15s.
          </p>
        </div>
        <Button
          variant="outline"
          size="lg"
          className="w-full sm:w-auto"
          onClick={() => metricsQuery.refetch()}
          disabled={metricsQuery.isFetching}
        >
          {metricsQuery.isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      {/* ── Security Anomaly Alert ────────────────────────────── */}
      <AddressAnomalyBanner status={data.addressAnomaly} />

      {/* ── Contributor readiness ─────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Contributor readiness
          </CardTitle>
          <CardDescription>
            Current payout readiness across all {contributors.total} registered
            contributors.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <WaveReadinessBar
            readyCount={contributors.ready}
            totalCount={contributors.total}
          />
          <div className="grid grid-cols-1 gap-3 text-center sm:grid-cols-3 sm:gap-4">
            <div className="min-h-11 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-4 dark:border-emerald-600 dark:bg-emerald-950/40">
              <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">
                {contributors.byStatus.ready}
              </p>
              <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-200">
                Ready
              </p>
            </div>
            <div className="min-h-11 rounded-lg border border-amber-300 bg-amber-50 px-4 py-4 dark:border-amber-600 dark:bg-amber-950/40">
              <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">
                {contributors.byStatus.low_reserve}
              </p>
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-200">
                Low reserve
              </p>
            </div>
            <div className="min-h-11 rounded-lg border border-red-300 bg-red-50 px-4 py-4 dark:border-red-600 dark:bg-red-950/40">
              <p className="text-2xl font-bold text-red-700 dark:text-red-300">
                {contributors.byStatus.not_ready}
              </p>
              <p className="mt-1 text-xs text-red-700 dark:text-red-200">
                Not ready
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Horizon API Latency ─────────────────────────────────── */}
      <HorizonLatencyChart stats={data.horizonLatency} />

      {/* ── Recent audit activity ─────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Recent audit activity
          </CardTitle>
          <CardDescription>
            Last {audit.recentEntries} audit log entries
            {audit.latestAt
              ? ` — latest at ${new Date(audit.latestAt).toLocaleString()}`
              : ""}
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {auditEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No audit events recorded yet.
            </p>
          ) : (
            <>
              <ul
                className="space-y-3 sm:hidden"
                aria-label="Audit log entry counts by action, most frequent first"
                data-testid="metrics-audit-mobile"
              >
                {auditEntries.map(([action, count]) => (
                  <li
                    key={action}
                    className="min-h-11 rounded-lg border border-border-strong px-4 py-3"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span className="font-mono text-xs">{action}</span>
                      <span className="tabular-nums font-medium">{count}</span>
                    </div>
                  </li>
                ))}
              </ul>

              <div
                className="hidden overflow-x-auto sm:block"
                data-testid="metrics-audit-table"
              >
                <table className="w-full min-w-[320px] text-sm">
                  <caption className="sr-only">
                    Audit log entry counts by action, most frequent first.
                  </caption>
                  <thead>
                    <tr className="border-b-2 border-border-strong text-left text-muted-foreground">
                      <th scope="col" className="pb-2 font-medium">
                        Action
                      </th>
                      <th scope="col" className="pb-2 text-right font-medium">
                        Count
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditEntries.map(([action, count]) => (
                      <tr
                        key={action}
                        className="border-b border-border-strong last:border-0"
                      >
                        <th
                          scope="row"
                          className="py-3 text-left font-mono text-xs font-normal"
                        >
                          {action}
                        </th>
                        <td className="py-3 text-right tabular-nums">{count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Circuit Breaker Status ─────────────────────────────── */}
      <Card className="mb-6" data-testid="metrics-circuit-breaker">
        <CardHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Horizon circuit breaker
              </CardTitle>
              <CardDescription>
                Protects Horizon from cascading failures during incidents.
              </CardDescription>
            </div>
            <CircuitBreakerStateBadge state={circuitBreaker.state} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-border-strong px-3 py-3">
              <p className="text-xs text-muted-foreground">State</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{circuitBreaker.state}</p>
            </div>
            <div className="rounded-lg border border-border-strong px-3 py-3">
              <p className="text-xs text-muted-foreground">Total trips</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{circuitBreaker.totalTrips}</p>
            </div>
            <div className="rounded-lg border border-border-strong px-3 py-3">
              <p className="text-xs text-muted-foreground">Current failures</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {circuitBreaker.failureCount}
                <span className="text-xs text-muted-foreground">
                  /{config.circuitBreakerFailureThreshold}
                </span>
              </p>
            </div>
            <div className="rounded-lg border border-border-strong px-3 py-3">
              <p className="text-xs text-muted-foreground">Last failure</p>
              <p className="mt-1 text-xs font-medium">
                {formatTimestamp(circuitBreaker.lastFailureTime)}
              </p>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium">Recent trips</h3>
            {circuitBreaker.recentTrips.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-sm text-muted-foreground">
                No trips recorded. Circuit has been healthy since process start.
              </p>
            ) : (
              <div
                className="overflow-x-auto"
                data-testid="metrics-circuit-breaker-trips"
              >
                <table className="w-full min-w-[320px] text-sm">
                  <caption className="sr-only">
                    Recent circuit breaker trips, most recent first.
                  </caption>
                  <thead>
                    <tr className="border-b-2 border-border-strong text-left text-muted-foreground">
                      <th scope="col" className="pb-2 font-medium">
                        Tripped at
                      </th>
                      <th scope="col" className="pb-2 font-medium">
                        Failures at trip
                      </th>
                      <th scope="col" className="pb-2 font-medium">
                        Recovered at
                      </th>
                      <th scope="col" className="pb-2 font-medium">
                        Duration
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...circuitBreaker.recentTrips]
                      .reverse()
                      .map((trip, idx) => (
                        <tr
                          key={`${trip.trippedAt}-${idx}`}
                          className="border-b border-border-strong last:border-0"
                        >
                          <td className="py-3 font-mono text-xs">
                            {new Date(trip.trippedAt).toLocaleString()}
                          </td>
                          <td className="py-3 tabular-nums">
                            {trip.failureCountAtTrip}
                          </td>
                          <td className="py-3 font-mono text-xs">
                            {trip.recoveredAt
                              ? new Date(trip.recoveredAt).toLocaleString()
                              : (
                                <Badge variant="destructive" className="text-xs">
                                  Still open
                                </Badge>
                              )}
                          </td>
                          <td className="py-3 tabular-nums">
                            {trip.recoveredAt
                              ? `${Math.round((trip.recoveredAt - trip.trippedAt) / 1000)}s`
                              : `${Math.round((Date.now() - trip.trippedAt) / 1000)}s*`}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <ProcessLocalNote />
        </CardContent>
      </Card>


      {/* ── Rate Limit Status ──────────────────────────────────── */}
      <Card className="mb-6" data-testid="metrics-rate-limit">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Rate limiting
          </CardTitle>
          <CardDescription>
            Per-IP request throttling for the check endpoint.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-4 dark:border-emerald-600 dark:bg-emerald-950/40">
              <p className="text-xs text-emerald-700 dark:text-emerald-300">
                Requests allowed
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                {rateLimit.totalAllowed.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-4 dark:border-red-600 dark:bg-red-950/40">
              <p className="text-xs text-red-700 dark:text-red-300">
                Requests blocked
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-red-700 dark:text-red-300">
                {rateLimit.totalBlocked.toLocaleString()}
              </p>
            </div>
            <div className="rounded-lg border border-border-strong px-4 py-4">
              <p className="text-xs text-muted-foreground">
                Active clients (window)
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {rateLimit.activeIdentifiers.toLocaleString()}
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-border-strong px-3 py-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Window: {msToSeconds(config.rateLimitWindowMs)}s · Max: {config.rateLimitMaxRequests} req
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                Block rate:{" "}
                {rateLimit.totalAllowed + rateLimit.totalBlocked > 0
                  ? `${((rateLimit.totalBlocked / (rateLimit.totalAllowed + rateLimit.totalBlocked)) * 100).toFixed(1)}%`
                  : "0%"}
              </span>
            </div>
          </div>

          <ProcessLocalNote />
        </CardContent>
      </Card>


      {/* ── Worker health & queue metrics ──────────────────────── */}
      <Card className="mb-6" data-testid="metrics-queue-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-500" />
            Worker health & background queue
          </CardTitle>
          <CardDescription>
            Live status of background recheck worker jobs and queue depth.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 text-center sm:grid-cols-3 sm:gap-4">
            <div className="rounded-lg border border-border px-4 py-3">
              <p className="text-2xl font-bold">{queueHealthQuery.data?.depth ?? 0}</p>
              <p className="mt-1 text-xs text-muted-foreground">Queue depth (pending)</p>
            </div>
            <div className="rounded-lg border border-border px-4 py-3">
              <p className="text-2xl font-bold text-red-600 dark:text-red-400">
                {queueHealthQuery.data?.failedCount ?? 0}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Failed jobs</p>
            </div>
            <div className="rounded-lg border border-border px-4 py-3">
              <p className="text-sm font-medium">
                {queueHealthQuery.data?.oldestPendingJobCreatedAt
                  ? new Date(queueHealthQuery.data.oldestPendingJobCreatedAt).toLocaleTimeString()
                  : "None"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Oldest pending job</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-md border border-border/50">
            <strong>Serverless Note:</strong> {queueHealthQuery.data?.serverlessNotice || "Background jobs are persisted in PostgreSQL. Worker polling is bound to serverless request execution limits."}
          </p>
        </CardContent>
      </Card>


      {/* ── Operational config ────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            Operational configuration
          </CardTitle>
          <CardDescription>
            Live values for rate limiting, circuit breaker, and export staleness.
            Set via environment variables.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <ConfigRow
              label="Rate limit window"
              value={`${msToSeconds(config.rateLimitWindowMs)}s`}
              hint="RATE_LIMIT_WINDOW_MS"
            />
            <ConfigRow
              label="Rate limit max requests"
              value={String(config.rateLimitMaxRequests)}
              hint="RATE_LIMIT_MAX_REQUESTS"
            />
            <ConfigRow
              label="CB failure threshold"
              value={`${config.circuitBreakerFailureThreshold} failures`}
              hint="HORIZON_CB_FAILURE_THRESHOLD"
            />
            <ConfigRow
              label="CB success threshold"
              value={`${config.circuitBreakerSuccessThreshold} successes`}
              hint="HORIZON_CB_SUCCESS_THRESHOLD"
            />
            <ConfigRow
              label="CB recovery timeout"
              value={`${msToSeconds(config.circuitBreakerRecoveryMs)}s`}
              hint="HORIZON_CB_RECOVERY_MS"
            />
            <ConfigRow
              label="Stale CSV max age"
              value={`${msToHours(config.staleCsvMaxAgeMs)}h`}
              hint="STALE_CSV_MAX_AGE_MS"
            />
            <ConfigRow
              label="Horizon URL"
              value={config.horizonUrl}
              hint="NEXT_PUBLIC_HORIZON_URL"
            />
            <ConfigRow
              label="Soroban contract"
              value={config.sorobanContractConfigured ? "Configured" : "Not set"}
              hint="SOROBAN_CONTRACT_ID"
            />
          </dl>
        </CardContent>
      </Card>
    </main>
  );
}

function ConfigRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="min-h-11 rounded-md border border-border-strong px-3 py-3 sm:py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
      <dd className="mt-0.5 font-mono text-xs text-muted-foreground">{hint}</dd>
    </div>
  );
}
