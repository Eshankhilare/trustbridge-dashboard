"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Mail, RefreshCw } from "lucide-react";

import {
  ContributorTable,
  exportContributorsCsv,
} from "@/components/ContributorTable";
import { BatchRecheckLiveRegion } from "@/components/BatchRecheckLiveRegion";
import { ContributorPager } from "@/components/ContributorPager";
import { NetworkStatusPanel } from "@/components/NetworkStatusPanel";
import { DisputePanel } from "@/components/DisputePanel";
import { SorobanEventTimeline } from "@/components/SorobanEventTimeline";
import { WaveReadinessBar } from "@/components/WaveReadinessBar";
import { WavePrepWorkspace } from "@/components/WavePrepWorkspace";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  StaleDataBanner,
  buildStalenessSummaryClient,
} from "@/components/StaleDataBanner";
import { FreezeWindowBanner } from "@/components/FreezeWindowBanner";
import { countReadyContributors } from "@/lib/contributors";
import { useJobProgress } from "@/lib/use-job-progress";
import { useI18n } from "@/lib/i18n-context";
// Single data-fetching strategy (#307): usePaginatedContributors drives both
// the prev/next pager and the panels that need the full contributor list.
// useInfiniteContributors was removed to eliminate the duplicate
// /api/contributors/paginated traffic that existed when both hooks were mounted.
import {
  usePaginatedContributors,
  useAllContributors,
} from "@/lib/use-paginated-contributors";
import type {
  ContributorRow,
  NetworkConfig,
  SorobanEventTimelineResponse,
} from "@/types";

interface BatchRecheckResponse {
  jobId: string;
  status: string;
  message: string;
}

export default function DashboardPage() {
  const queryClient = useQueryClient();
  const { locale } = useI18n();
  const {
    event,
    isStreaming,
    isReconnecting,
    reconnectAttempt,
    maxReconnectAttempts,
    error: streamError,
    startProgress,
  } = useJobProgress();

  // Single data-fetching strategy (#307): one paginated hook for the table/pager,
  // one hook that fetches all contributors (no page limit) for panels that need the
  // full list (WaveReadinessBar, WavePrepWorkspace, DisputePanel).
  const pager = usePaginatedContributors(25);
  const allContributorsQuery = useAllContributors();

  const recheckMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/contributors", { method: "POST" });
      if (!response.ok) throw new Error("Re-check failed");
      return (await response.json()) as BatchRecheckResponse;
    },
    onSuccess: (data) => {
      startProgress(data.jobId);
      void queryClient.invalidateQueries({ queryKey: ["contributors"] });
    },
  });

  const recheckOneMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch("/api/contributors/" + id, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Re-check failed");
      return (await response.json()) as { contributor: ContributorRow };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["contributors"] });
    },
  });

  const exportCsvMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/contributors/export/csv");
      if (!response.ok) throw new Error("CSV export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "contributors-" + new Date().toISOString().slice(0, 10) + ".csv";
      link.click();
      URL.revokeObjectURL(url);
    },
  });

  const exportJsonMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/contributors/export/json");
      if (!response.ok) throw new Error("JSON export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "contributors-" + new Date().toISOString().slice(0, 10) + ".json";
      link.click();
      URL.revokeObjectURL(url);
    },
  });

  const emailNudgeMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/notifications/email-nudge", {
        method: "POST",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? "Email nudge failed");
      }
      return (await response.json()) as {
        sent: number;
        skipped: number;
        failed: number;
      };
    },
  });

  const banMutation = useMutation({
    mutationFn: async ({
      githubUsername,
      action,
      reason,
    }: {
      githubUsername: string;
      action: "ban" | "unban";
      reason?: string;
    }) => {
      const res = await fetch("/api/maintainer/ban", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUsername, action, reason, locale }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || "Failed to update ban status");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["contributors"] });
      void queryClient.invalidateQueries({ queryKey: ["paginated-contributors"] });
    },
  });

  const sorobanQuery = useQuery({
    queryKey: ["soroban-events"],
    queryFn: async () => {
      const response = await fetch("/api/soroban/events");
      if (!response.ok) throw new Error("Failed to load Soroban events");
      return (await response.json()) as SorobanEventTimelineResponse;
    },
  });

  const networkQuery = useQuery({
    queryKey: ["network-config"],
    queryFn: async () => {
      const response = await fetch("/api/settings/network");
      if (!response.ok) throw new Error("Failed to load network config");
      return (await response.json()) as NetworkConfig;
    },
  });

  const freezeQuery = useQuery({
    queryKey: ["freeze-status"],
    queryFn: async () => {
      const response = await fetch("/api/freeze-status");
      if (!response.ok) return { active: false, reason: null, start: null, end: null };
      return (await response.json()) as {
        active: boolean;
        reason?: string | null;
        start?: string | null;
        end?: string | null;
      };
    },
  });

  const contributors = allContributorsQuery.contributors;
  const readyCount = countReadyContributors(contributors);
  const staleness = buildStalenessSummaryClient(contributors);

  const isRecheckRunning = recheckMutation.isPending || isStreaming || isReconnecting;
  const recheckStatus = isReconnecting
    ? `Reconnecting (${reconnectAttempt}/${maxReconnectAttempts})...`
    : event?.type === "completed"
      ? "Completed"
      : event?.type === "failed"
        ? "Failed"
        : event?.type === "processing"
          ? "Processing..."
          : isStreaming
            ? "Waiting..."
            : null;

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      {/*
        The dashboard's own skip link. `layout.tsx` gets a keyboard user to
        `main`; from there the contributor table is still past the re-check
        controls, the network panel, the wave overview and the Wave prep
        workspace — roughly thirty tab stops on a populated dashboard.
      */}
      <a
        href="#contributor-table"
        data-testid="skip-to-table"
        className="sr-only rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      >
        Skip to contributor table
      </a>

      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          {/* The only h1 on this page — every region below opens at h2. */}
          <h1 className="text-3xl font-bold">Maintainer dashboard</h1>
          <p className="mt-2 text-muted-foreground">
            Wave payout readiness across all registered contributors. Re-check
            pulls fresh data from Horizon.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="stellar"
            onClick={() => recheckMutation.mutate()}
            disabled={isRecheckRunning}
          >
            {isRecheckRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {recheckStatus ?? "Re-check all"}
          </Button>
          <Button
            variant="outline"
            onClick={() => emailNudgeMutation.mutate()}
            disabled={emailNudgeMutation.isPending}
            title="Send email nudges to maintainers about not-ready contributors"
          >
            {emailNudgeMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Mail className="h-4 w-4" />
            )}
            Email nudge
          </Button>
        </div>
      </div>

      {/*
        #498: `error` used to be an undefined identifier here, so an SSE
        disconnect was rendered only as the visible banner below and never
        reached screen readers. The stream error is also the *current* failure
        (recheckMutation's error is whatever the last POST left behind), so it
        takes precedence; `||` rather than `??` so an empty stream message
        cannot mask a meaningful mutation error.
      */}
      <BatchRecheckLiveRegion
        event={event}
        isStarting={recheckMutation.isPending}
        isStreaming={isStreaming}
        isReconnecting={isReconnecting}
        reconnectAttempt={reconnectAttempt}
        maxReconnectAttempts={maxReconnectAttempts}
        error={
          streamError ||
          (recheckMutation.isError ? recheckMutation.error.message : null)
        }
      />

      {!allContributorsQuery.isLoading &&
        !allContributorsQuery.isError &&
        contributors.length > 0 && (
          <StaleDataBanner
            staleness={staleness}
            onRecheckAll={() => recheckMutation.mutate()}
            isRecheckRunning={isRecheckRunning}
          />
        )}

      {freezeQuery.data?.active && (
        <FreezeWindowBanner
          reason={freezeQuery.data.reason ?? undefined}
          start={freezeQuery.data.start ?? undefined}
          end={freezeQuery.data.end ?? undefined}
        />
      )}

      {isReconnecting && (
        <Card
          className="mb-4 border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/60"
          role="status"
          aria-live="polite"
          data-testid="recheck-reconnecting-banner"
        >
          <CardContent className="flex items-center gap-2 py-3 text-sm text-amber-800 dark:text-amber-200">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>
              Connection lost. Reconnecting to live recheck progress (attempt {reconnectAttempt}/{maxReconnectAttempts})...
            </span>
          </CardContent>
        </Card>
      )}

      {streamError && !isReconnecting && (
        <Card
          className="mb-4 border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950"
          role="alert"
          data-testid="recheck-disconnect-error-banner"
        >
          <CardContent className="py-3 text-sm text-red-800 dark:text-red-200">
            Batch recheck progress disconnected: {streamError}
          </CardContent>
        </Card>
      )}

      {event?.type === "completed" && (
        <Card className="mb-4 border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
          <CardContent className="py-3 text-sm text-green-800 dark:text-green-200">
            Batch recheck completed.{" "}
            {event.result && typeof event.result === "object" && "refreshed" in event.result
              ? (event.result as { refreshed: number }).refreshed + " contributors refreshed."
              : ""}
          </CardContent>
        </Card>
      )}

      {event?.type === "failed" && (
        <Card className="mb-4 border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
          <CardContent className="py-3 text-sm text-red-800 dark:text-red-200">
            Batch recheck failed: {event.error ?? "Unknown error"}
          </CardContent>
        </Card>
      )}

      {networkQuery.data && (
        <NetworkStatusPanel config={networkQuery.data} className="mb-8" />
      )}

      <Card className="mb-8" role="region" aria-labelledby="wave-overview-heading">
        <CardHeader>
          <CardTitle id="wave-overview-heading">Wave overview</CardTitle>
          <CardDescription>
            Green = funded + USDC trustline + sufficient XLM. Yellow = low
            reserve. Red = missing trustline or unfunded.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WaveReadinessBar
            readyCount={readyCount}
            totalCount={contributors.length}
          />
        </CardContent>
      </Card>

      {!allContributorsQuery.isLoading && !allContributorsQuery.isError && (
        <div className="mb-8">
          <WavePrepWorkspace
            contributors={contributors}
            onExportCsv={() => exportCsvMutation.mutate()}
            onExportJson={() => exportJsonMutation.mutate()}
            isExporting={
              exportCsvMutation.isPending || exportJsonMutation.isPending
            }
          />
        </div>
      )}

      {pager.isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading contributors...
        </div>
      ) : pager.isError ? (
        <p className="text-destructive">Failed to load contributor data.</p>
      ) : (
        <>
          <ContributorTable
            contributors={pager.contributors}
            columnPreferencesEndpoint="/api/contributors/column-preferences"
            // `force`: ContributorTable has already shown the accessible export
            // confirmation, staleness warning included. Leaving this unforced
            // stacks a second, native `window.confirm()` on top of it.
            onExport={() => exportContributorsCsv(pager.contributors, true)}
            onRecheck={(id) => recheckOneMutation.mutate(id)}
            onBanToggle={async (githubUsername, action, reason) => {
              await banMutation.mutateAsync({ githubUsername, action, reason });
            }}
            recheckingId={
              recheckOneMutation.isPending
                ? (recheckOneMutation.variables ?? null)
                : null
            }
          />
          <ContributorPager
            pageIndex={pager.pageIndex}
            total={pager.total}
            pageSize={pager.contributors.length || 25}
            hasMore={pager.hasMore}
            hasPrev={pager.hasPrev}
            isLoading={pager.isLoading}
            onNext={pager.goToNext}
            onPrev={pager.goToPrev}
          />
        </>
      )}

      <DisputePanel contributors={contributors} />

      <Card className="mt-8" role="region" aria-labelledby="soroban-timeline-heading">
        <CardHeader>
          <CardTitle id="soroban-timeline-heading">
            Soroban event timeline
          </CardTitle>
          <CardDescription>
            Recent on-chain events for the configured registry contract
            (<code>SOROBAN_CONTRACT_ID</code>). Filter by event type and
            export for auditing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sorobanQuery.isLoading ? (
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Loading Soroban events...
            </div>
          ) : sorobanQuery.isError ? (
            <p className="text-destructive">Failed to load Soroban events.</p>
          ) : (
            <SorobanEventTimeline
              events={sorobanQuery.data?.events ?? []}
              errors={sorobanQuery.data?.errors ?? []}
            />
          )}
        </CardContent>
      </Card>
    </main>
  );
}