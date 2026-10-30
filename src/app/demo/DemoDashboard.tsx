"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  FlaskConical,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

import { ContributorPager } from "@/components/ContributorPager";
import {
  ContributorTable,
  exportContributorsCsv,
  exportContributorsJson,
} from "@/components/ContributorTable";
import { SorobanEventTimeline } from "@/components/SorobanEventTimeline";
import { WavePrepWorkspace } from "@/components/WavePrepWorkspace";
import { WaveReadinessBar } from "@/components/WaveReadinessBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  createDemoContributors,
  createDemoSorobanEvents,
  DEMO_NETWORK_CONFIG,
  getDemoDashboardStats,
} from "@/lib/demo-data";
import type { ContributorRow } from "@/types";

const DEMO_PAGE_SIZE = 8;

export function DemoDashboard() {
  const [rows, setRows] = useState<ContributorRow[]>(() =>
    createDemoContributors(),
  );
  const [events] = useState(() => createDemoSorobanEvents());
  const [pageIndex, setPageIndex] = useState(0);
  const [recheckingId, setRecheckingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const recheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (recheckTimer.current) clearTimeout(recheckTimer.current);
    },
    [],
  );

  const stats = useMemo(() => getDemoDashboardStats(rows), [rows]);
  const lowReserveCount = useMemo(
    () => rows.filter((row) => row.readiness === "low_reserve").length,
    [rows],
  );
  const notReadyCount = useMemo(
    () => rows.filter((row) => row.readiness === "not_ready").length,
    [rows],
  );
  const verifiedCount = useMemo(
    () => rows.filter((row) => row.verified).length,
    [rows],
  );
  const fundedCount = useMemo(
    () => rows.filter((row) => row.funded).length,
    [rows],
  );

  const totalPages = Math.max(1, Math.ceil(rows.length / DEMO_PAGE_SIZE));
  const pageRows = useMemo(
    () =>
      rows.slice(
        pageIndex * DEMO_PAGE_SIZE,
        pageIndex * DEMO_PAGE_SIZE + DEMO_PAGE_SIZE,
      ),
    [pageIndex, rows],
  );

  function handleRecheck(id: string) {
    if (recheckingId) return;
    const username =
      rows.find((row) => row.id === id)?.githubUsername ?? "contributor";
    setRecheckingId(id);
    setNotice(`Demo re-check started for @${username}.`);

    if (recheckTimer.current) clearTimeout(recheckTimer.current);
    recheckTimer.current = setTimeout(() => {
      setRows((current) =>
        current.map((row) =>
          row.id === id
            ? {
                ...row,
                lastCheckedAt: new Date().toISOString(),
                horizonLatencyMs: 124,
              }
            : row,
        ),
      );
      setRecheckingId(null);
      setNotice(
        `Demo re-check complete for @${username}. No Horizon request was made.`,
      );
    }, 700);
  }

  async function handleBanToggle(
    githubUsername: string,
    action: "ban" | "unban",
    reason?: string,
  ) {
    setRows((current) =>
      current.map((row) =>
        row.githubUsername === githubUsername
          ? {
              ...row,
              banned: action === "ban",
              banReason: action === "ban" ? reason : undefined,
            }
          : row,
      ),
    );
    setNotice(
      action === "ban"
        ? `@${githubUsername} was banned in this demo session only.`
        : `@${githubUsername} was unbanned in this demo session only.`,
    );
  }

  function handleReset() {
    if (recheckTimer.current) clearTimeout(recheckTimer.current);
    setRows(createDemoContributors());
    setPageIndex(0);
    setRecheckingId(null);
    setNotice("Demo data reset. No real data was changed.");
  }

  function handleExportCsv() {
    exportContributorsCsv(rows, true);
    setNotice("Downloaded the demo CSV. All values are synthetic.");
  }

  function handleExportJson() {
    exportContributorsJson(rows, true);
    setNotice("Downloaded the demo JSON. All values are synthetic.");
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="warning" data-testid="demo-badge">
              DEMO DATA
            </Badge>
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Public sandbox
            </span>
          </div>
          <h1 className="mt-3 text-3xl font-bold tracking-tight">
            Maintainer dashboard
          </h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Explore the contributor readiness workflow with a synthetic dataset.
            Search, filter, sort, paginate, change columns, export CSV/JSON, and
            test re-check or ban actions without signing in.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back to home
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleReset}
            data-testid="reset-demo-data"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Reset demo data
          </Button>
        </div>
      </div>

      <div
        role="note"
        aria-label="Demo data notice"
        data-testid="demo-data-banner"
        className="mb-6 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/70 dark:bg-amber-950/40 dark:text-amber-100"
      >
        <FlaskConical className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">Sample data only</p>
          <p className="mt-1">
            Every contributor, wallet address, balance, readiness status, and
            on-chain event on this page is synthetic. No database, Horizon,
            OAuth, or payment system is contacted. Re-check and ban actions are
            local to this browser session.
          </p>
        </div>
      </div>

      <p
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="demo-live-status"
      >
        {notice}
      </p>

      <Card className="mb-8" role="region" aria-labelledby="demo-wave-overview">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle id="demo-wave-overview">Wave overview</CardTitle>
              <CardDescription>
                Synthetic readiness for a 24-contributor demo Wave.
              </CardDescription>
            </div>
            <Badge variant="outline">Demo Wave 75</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <WaveReadinessBar
            readyCount={stats.readyCount}
            totalCount={stats.totalContributors}
          />
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-muted/50 p-4">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Contributors
              </dt>
              <dd className="mt-1 text-2xl font-bold tabular-nums">
                {stats.totalContributors}
              </dd>
            </div>
            <div className="rounded-lg bg-emerald-500/10 p-4">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Ready
              </dt>
              <dd className="mt-1 text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                {stats.readyCount}
              </dd>
            </div>
            <div className="rounded-lg bg-amber-500/10 p-4">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Low reserve
              </dt>
              <dd className="mt-1 text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-300">
                {lowReserveCount}
              </dd>
            </div>
            <div className="rounded-lg bg-red-500/10 p-4">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Needs attention
              </dt>
              <dd className="mt-1 text-2xl font-bold tabular-nums text-red-700 dark:text-red-300">
                {notReadyCount}
              </dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">
            {verifiedCount} verified and {fundedCount} funded contributors in
            the demo dataset.
          </p>
        </CardContent>
      </Card>

      <div className="mb-8">
        <WavePrepWorkspace
          contributors={rows}
          waveNumber={75}
          onExportCsv={handleExportCsv}
          onExportJson={handleExportJson}
        />
      </div>

      <section aria-labelledby="demo-contributors-heading" className="mb-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              id="demo-contributors-heading"
              className="text-xl font-semibold tracking-tight"
            >
              Contributor readiness
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Search, filter, sort, reorder columns, and test row actions. Demo
              pagination shows {DEMO_PAGE_SIZE} contributors per page, and the
              table controls apply to the visible page.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => handleRecheck(pageRows[0]?.id ?? "")}
            disabled={!pageRows[0] || recheckingId !== null}
            aria-label="Simulate a re-check for the first contributor on this page"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Try a demo re-check
          </Button>
        </div>

        <ContributorTable
          contributors={pageRows}
          onExport={handleExportCsv}
          onRecheck={handleRecheck}
          recheckingId={recheckingId}
          onBanToggle={handleBanToggle}
          demoMode
        />
        <ContributorPager
          pageIndex={pageIndex}
          total={rows.length}
          pageSize={DEMO_PAGE_SIZE}
          hasMore={pageIndex < totalPages - 1}
          hasPrev={pageIndex > 0}
          onNext={() => setPageIndex((current) => Math.min(current + 1, totalPages - 1))}
          onPrev={() => setPageIndex((current) => Math.max(current - 1, 0))}
        />
      </section>

      <Card className="mb-8" role="region" aria-labelledby="demo-network-heading">
        <CardHeader>
          <CardTitle id="demo-network-heading">Demo environment</CardTitle>
          <CardDescription>
            Static configuration shown for context. No live network calls are
            made from this page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Horizon network</dt>
              <dd className="font-medium">Testnet (demo)</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Soroban network</dt>
              <dd className="font-medium">Testnet (demo)</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Horizon URL</dt>
              <dd className="break-all font-mono text-xs">
                {DEMO_NETWORK_CONFIG.horizonUrl}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Demo contract</dt>
              <dd className="break-all font-mono text-xs">
                {DEMO_NETWORK_CONFIG.actionAlignment.assetCode} readiness
                registry (synthetic)
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card role="region" aria-labelledby="demo-activity-heading">
        <CardHeader>
          <CardTitle id="demo-activity-heading">Recent activity</CardTitle>
          <CardDescription>
            Synthetic registry events for the demo contract. Filter and export
            the activity timeline locally.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SorobanEventTimeline events={events} />
        </CardContent>
      </Card>

      <p className="mt-8 text-center text-xs text-muted-foreground">
        TrustBridge public demo · synthetic data only · no real wallets or
        transactions
      </p>
    </div>
  );
}
