"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  PauseCircle,
  RefreshCw,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { NetworkConfig, StellarNetwork } from "@/types";

interface NetworkStatusPanelProps {
  config: NetworkConfig;
  className?: string;
}

/**
 * Shape returned by `GET /api/health` (see `src/lib/health.ts`).
 * Fields are optional so partial payloads render without crashing.
 */
interface RpcHealth {
  status?: "ok" | "degraded" | "unavailable" | string;
  latencyMs?: number | null;
  network?: string | null;
  horizonUrl?: string | null;
  sorobanUrl?: string | null;
  checkedAt?: string | null;
  message?: string | null;
}

type HealthState =
  | { kind: "loading" }
  | { kind: "ready"; health: RpcHealth }
  | { kind: "error"; message: string };

const NETWORK_BADGE_VARIANT: Record<
  StellarNetwork,
  "ready" | "warning" | "secondary"
> = {
  mainnet: "ready",
  testnet: "secondary",
  custom: "warning",
};

const NETWORK_LABEL: Record<StellarNetwork, string> = {
  mainnet: "Mainnet",
  testnet: "Testnet",
  custom: "Custom",
};

const NETWORK_ALIGNMENT_EXAMPLES = [
  {
    label: "Testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    sorobanUrl: "https://soroban-testnet.stellar.org",
  },
  {
    label: "Mainnet",
    horizonUrl: "https://horizon.stellar.org",
    sorobanUrl: "https://mainnet.sorobanrpc.com",
  },
] as const;

function isRpcHealth(value: unknown): value is RpcHealth {
  return typeof value === "object" && value !== null;
}

function NetworkPausedEmptyState({
  horizonNetwork,
  sorobanNetwork,
  horizonUrl,
  sorobanUrl,
  warnings,
}: {
  horizonNetwork: StellarNetwork;
  sorobanNetwork: StellarNetwork;
  horizonUrl: string;
  sorobanUrl: string;
  warnings: string[];
}) {
  return (
    <div
      role="alert"
      data-testid="network-paused-empty"
      className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive"
    >
      <div className="flex items-start gap-3">
        <PauseCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="space-y-3">
          <div>
            <p className="font-semibold">
              Network paused — Horizon and Soroban RPC disagree
            </p>
            <p className="mt-1 text-sm">
              Contributor funding checks and Soroban events are reading from
              different networks. Treat payout readiness and the event timeline
              as blocked until the environment variables match.
            </p>
          </div>

          <ul className="list-disc space-y-1 pl-5 text-sm">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>

          <div className="rounded-md border border-destructive/30 bg-background/80 p-3 text-foreground">
            <p className="text-sm font-medium">What to do next</p>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>
                Set <code>NEXT_PUBLIC_HORIZON_URL</code> and{" "}
                <code>SOROBAN_RPC_URL</code> to the same network in your
                deployment environment.
              </li>
              {NETWORK_ALIGNMENT_EXAMPLES.map((example) => (
                <li key={example.label}>
                  {example.label}: Horizon{" "}
                  <code className="text-xs">{example.horizonUrl}</code>, Soroban{" "}
                  <code className="text-xs">{example.sorobanUrl}</code>
                </li>
              ))}
              <li>
                Redeploy or restart the dashboard after updating env vars, then
                confirm both badges below show the same network.
              </li>
            </ol>
          </div>

          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Current Horizon</dt>
              <dd className="font-medium text-foreground">
                {NETWORK_LABEL[horizonNetwork]} — {horizonUrl}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Current Soroban RPC</dt>
              <dd className="font-medium text-foreground">
                {NETWORK_LABEL[sorobanNetwork]} — {sorobanUrl}
              </dd>
            </div>
          </dl>

          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/settings">Review network settings</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function NetworkSwitchConfirmation({
  currentNetwork,
  targetNetwork,
  onConfirm,
  onCancel,
  submitting,
  error,
}: {
  currentNetwork: StellarNetwork;
  targetNetwork: StellarNetwork;
  onConfirm: () => void;
  onCancel: () => void;
  submitting: boolean;
  error: string | null;
}) {
  return (
    <div
      role="alertdialog"
      aria-labelledby="network-switch-confirm-title"
      data-testid="network-switch-confirmation"
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-500"
          aria-hidden="true"
        />
        <div className="space-y-3">
          <div>
            <p
              id="network-switch-confirm-title"
              className="font-semibold text-foreground"
            >
              Confirm network switch
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Switching from {NETWORK_LABEL[currentNetwork]} to{" "}
              {NETWORK_LABEL[targetNetwork]} will change the network the
              dashboard validates against. An accidental switch can break Wave
              registration. This action is recorded in the audit log.
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={onConfirm}
              disabled={submitting}
            >
              {submitting ? "Switching…" : `Switch to ${NETWORK_LABEL[targetNetwork]}`}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RpcHealthSection({
  state,
  onRefresh,
}: {
  state: HealthState;
  onRefresh: () => void;
}) {
  const refreshButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onRefresh}
      disabled={state.kind === "loading"}
      data-testid="rpc-health-refresh"
    >
      {state.kind === "loading" ? (
        <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" />
      )}
      Refresh
    </Button>
  );

  if (state.kind === "loading") {
    return (
      <div
        data-testid="rpc-health-loading"
        className="flex items-center justify-between rounded-lg border border-border/60 bg-background/60 p-3"
      >
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Checking RPC health…
        </span>
        {refreshButton}
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div
        role="alert"
        data-testid="rpc-health-error"
        className="flex items-start justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-destructive"
      >
        <span className="flex items-start gap-2">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium">RPC health unavailable</span>
            <span className="mt-1 block text-sm">{state.message}</span>
          </span>
        </span>
        {refreshButton}
      </div>
    );
  }

  const { health } = state;
  const status = health.status ?? "unavailable";
  const isHealthy = status === "ok";
  const isDegraded = status === "degraded";

  return (
    <div
      data-testid="rpc-health"
      data-status={status}
      className={cn(
        "space-y-2 rounded-lg border p-3",
        isHealthy
          ? "border-emerald-500/30 bg-emerald-500/5"
          : isDegraded
            ? "border-amber-500/40 bg-amber-500/10"
            : "border-destructive/40 bg-destructive/10"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          {isHealthy ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
          ) : isDegraded ? (
            <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />
          ) : (
            <XCircle className="h-4 w-4 text-destructive" aria-hidden="true" />
          )}
          RPC health:{" "}
          {isHealthy ? "Healthy" : isDegraded ? "Degraded" : "Unavailable"}
        </span>
        {refreshButton}
      </div>

      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Latency</dt>
          <dd className="font-medium">
            {typeof health.latencyMs === "number"
              ? `${health.latencyMs} ms`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Network</dt>
          <dd className="font-medium">{health.network ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last checked</dt>
          <dd className="font-medium">
            {health.checkedAt
              ? new Date(health.checkedAt).toLocaleString()
              : "—"}
          </dd>
        </div>
      </dl>

      {health.message && (
        <p className="text-sm text-muted-foreground">{health.message}</p>
      )}
    </div>
  );
}

export function NetworkStatusPanel({
  config,
  className,
}: NetworkStatusPanelProps) {
  const {
    horizonNetwork,
    sorobanNetwork,
    horizonUrl,
    sorobanUrl,
    mismatched,
    warnings,
  } = config;

  const [pendingNetwork, setPendingNetwork] = useState<StellarNetwork | null>(
    null
  );
  const [submitting, setSubmitting] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [healthState, setHealthState] = useState<HealthState>({
    kind: "loading",
  });

  const loadHealth = useCallback(async (signal?: AbortSignal) => {
    setHealthState({ kind: "loading" });
    try {
      const response = await fetch("/api/health", {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal,
      });

      if (!response.ok) {
        setHealthState({
          kind: "error",
          message: `Health check failed (HTTP ${response.status}).`,
        });
        return;
      }

      const payload: unknown = await response.json();
      if (!isRpcHealth(payload)) {
        setHealthState({
          kind: "error",
          message: "Health check returned an unexpected payload.",
        });
        return;
      }

      setHealthState({ kind: "ready", health: payload });
    } catch (error) {
      if (signal?.aborted) return;
      setHealthState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to reach the health endpoint.",
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadHealth(controller.signal);
    return () => controller.abort();
  }, [loadHealth]);

  const otherWarnings = mismatched
    ? warnings.filter(
        (warning) => !/Horizon is configured for/i.test(warning)
      )
    : warnings;

  const switchTargets = (["mainnet", "testnet"] as const).filter(
    (network) => network !== horizonNetwork
  );

  async function confirmSwitch() {
    if (!pendingNetwork) return;
    setSubmitting(true);
    setSwitchError(null);
    try {
      const response = await fetch("/api/settings/network", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: pendingNetwork,
          confirm: true,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(
          payload?.error ?? `Network switch failed (${response.status})`
        );
      }
      setPendingNetwork(null);
    } catch (error) {
      setSwitchError(
        error instanceof Error ? error.message : "Network switch failed"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      className={cn(
        mismatched
          ? "border-destructive/40 bg-destructive/5"
          : "border-stellar-cyan/20 bg-gradient-to-br from-stellar-purple/5 to-stellar-cyan/5",
        className
      )}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          {mismatched ? (
            <AlertTriangle className="h-5 w-5 text-destructive" />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          )}
          {mismatched ? "Network paused" : "Network configuration"}
        </CardTitle>
        <CardDescription>
          {mismatched
            ? "This deployment is blocked until Horizon and Soroban RPC point at the same Stellar network."
            : "The Stellar network the dashboard is validating contributor funding and Soroban events against."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Horizon:</span>
          <Badge variant={NETWORK_BADGE_VARIANT[horizonNetwork]}>
            {NETWORK_LABEL[horizonNetwork]}
          </Badge>
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground">Soroban RPC:</span>
            <Badge variant={NETWORK_BADGE_VARIANT[sorobanNetwork]}>
              {NETWORK_LABEL[sorobanNetwork]}
            </Badge>
          </span>
        </div>

        <RpcHealthSection
          state={healthState}
          onRefresh={() => void loadHealth()}
        />

        {mismatched && (
          <NetworkPausedEmptyState
            horizonNetwork={horizonNetwork}
            sorobanNetwork={sorobanNetwork}
            horizonUrl={horizonUrl}
            sorobanUrl={sorobanUrl}
            warnings={warnings}
          />
        )}

        {!mismatched &&
          otherWarnings.map((warning) => (
            <p key={warning} className="text-muted-foreground">
              {warning}
            </p>
          ))}

        {!mismatched && pendingNetwork === null && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-muted-foreground">Switch network:</span>
            {switchTargets.map((network) => (
              <Button
                key={network}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setSwitchError(null);
                  setPendingNetwork(network);
                }}
              >
                {NETWORK_LABEL[network]}
              </Button>
            ))}
          </div>
        )}

        {!mismatched && pendingNetwork !== null && (
          <NetworkSwitchConfirmation
            currentNetwork={horizonNetwork}
            targetNetwork={pendingNetwork}
            onConfirm={confirmSwitch}
            onCancel={() => {
              setPendingNetwork(null);
              setSwitchError(null);
            }}
            submitting={submitting}
            error={switchError}
          />
        )}
      </CardContent>
    </Card>
  );
}
