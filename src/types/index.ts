export type ReadinessStatus = "ready" | "low_reserve" | "not_ready";

export interface WalletProofInfo {
  provider: "Freighter";
  method: "signMessage";
  challenge: string;
  instructions: string[];
  fallback: string;
}

export interface HorizonDebugInfo {
  summary: string;
  nextAction: string;
  checkpoints: Array<{
    label: string;
    value: string;
  }>;
  warnings: string[];
}

export interface HorizonCheckResult {
  funded: boolean;
  trustline: boolean;
  /**
   * Whether the matching trustline is authorized by the asset issuer.
   * A present-but-unauthorized trustline still fails payments, so this is
   * tracked separately from `trustline` (mere presence).
   */
  trustline_authorized: boolean;
  /**
   * On-chain verified: funded, trustline present, and authorized.
   * Convenience flag derived from the checks above.
   */
  verified: boolean;
  xlm_balance: string;
  /**
   * Spendable XLM: raw balance minus the account's minimum reserve
   * (subentries/sponsorships) and any `selling_liabilities`. Used for the
   * reserve check instead of the raw balance — see `computeReadiness`.
   */
  spendable_xlm_balance: string;
  /**
   * USDC (or default configured asset) balance on account.
   */
  usdc_balance: string;
  /**
   * Horizon RPC latency in milliseconds. Only set on successful checks.
   */
  horizon_latency_ms?: number;
  errors: string[];
  readiness: ReadinessStatus;
}

export interface CheckAddressPayload {
  address: string;
  asset_code?: string;
  asset_issuer?: string;
}

export type OnboardingChecklistState = Record<string, boolean>;

/**
 * Safely parse a checklistCompleted JSON column into a typed OnboardingChecklistState.
 * Prevents unchecked casts and ensures null/undefined/non-object values safely default to {}.
 */
export function parseChecklistState(value: unknown): OnboardingChecklistState {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const result: OnboardingChecklistState = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "boolean") {
        result[k] = v;
      }
    }
    return result;
  }
  return {};
}

export interface ContributorRow {
  id: string;
  githubUsername: string;
  stellarAddress: string;
  trustlineReady: boolean;
  trustlineAuthorized: boolean;
  verified: boolean;
  funded: boolean;
  xlmBalance: string;
  spendableXlmBalance: string;
  usdcBalance: string;
  lastCheckedAt: string | null;
  horizonLatencyMs: number | null;
  readiness: ReadinessStatus;
  banned?: boolean;
  banReason?: string;
  walletProof?: WalletProofInfo;
  horizonDebug?: HorizonDebugInfo;
}

export type AuditAction =
  | "recheck.single"
  | "recheck.batch"
  | "recheck.self_service"
  | "registration.create"
  | "registration.update"
  | "checklist.update"
  | "network_config_mismatch_detected"
  | "contract.sync"
  | "soroban.outbox.replayed"
  | "profile.privacy_updated";

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorLogin: string | null;
  action: AuditAction | string;
  targetId: string | null;
  targetLabel: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface DashboardStats {
  totalContributors: number;
  readyCount: number;
  readyPercent: number;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

export type SorobanEventType = "contract" | "system" | "diagnostic";

export interface SorobanEventRow {
  id: string;
  type: SorobanEventType;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  topic: string[];
  value: string;
  txHash: string;
}

export interface SorobanEventTimelineResponse {
  events: SorobanEventRow[];
  latestLedger: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Onboarding checklist
// ---------------------------------------------------------------------------

/**
 * Canonical keys that the onboarding checklist tracks.
 * Add new steps here; the reducer and API route stay in sync automatically.
 */
export type OnboardingChecklistKey =
  | "stellarAccountCreated"
  | "usdcTrustlineAdded"
  | "addressRegistered"
  | "readinessConfirmed";

export type StellarNetwork = "mainnet" | "testnet" | "custom";

/**
 * Result of comparing the dashboard's resolved Stellar configuration against
 * the defaults declared by trustbridge-action's `action.yml`.
 * @see checkActionAlignment in src/lib/network-config.ts
 */
export interface ActionAlignment {
  /** Resolved Horizon base URL the dashboard will query. */
  horizonUrl: string;
  /** Resolved asset code the dashboard checks trustlines for. */
  assetCode: string;
  /** Resolved asset issuer G-address. */
  assetIssuer: string;
  /** Resolved minimum spendable-XLM floor used by `computeReadiness`. */
  minXlmBalance: number;
  /** The corresponding trustbridge-action defaults, for side-by-side display. */
  expected: {
    horizonUrl: string;
    assetCode: string;
    assetIssuer: string;
    minXlmBalance: number;
  };
  /** True when nothing drifted — i.e. `warnings` is empty. */
  aligned: boolean;
  /** Human-readable description of each drift, safe to render verbatim. */
  warnings: string[];
}

export interface NetworkConfig {
  horizonUrl: string;
  horizonNetwork: StellarNetwork;
  sorobanUrl: string;
  sorobanNetwork: StellarNetwork;
  sorobanContractConfigured: boolean;
  mismatched: boolean;
  /** Drift between this dashboard and trustbridge-action's defaults. */
  actionAlignment: ActionAlignment;
  warnings: string[];
}

/** Maintainer RBAC role (see next-auth session.user.role). */
export type AppRole = "admin" | "operator" | "viewer";

/** Public profile shown at /profile/[username]. G-address only when opted in. */
export interface PublicProfile {
  githubUsername: string;
  /** Readiness status — only present when the contributor has an active registration. */
  readiness: ReadinessStatus | null;
  /** Stellar address — only present when showStellarAddress=true. */
  stellarAddress: string | null;
  /** ISO timestamp of last Horizon check, or null. */
  lastCheckedAt: string | null;
}

/** Privacy settings for the authenticated user's own profile. */
export interface ProfilePrivacySettings {
  profilePublic: boolean;
  showStellarAddress: boolean;
}

export interface SorobanEventCursorRecord {
  id: string;
  maintainerOrgId: string;
  eventType: string;
  cursor: string;
  lastPagingToken: string | null;
  lastSyncedAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

// ---------------------------------------------------------------------------
// WavePrep workspace view-model (#613)
// ---------------------------------------------------------------------------

/**
 * Typed view-model for the WavePrep workspace, shared by the dashboard page
 * and `WavePrepWorkspace` stories/panels to prevent prop drift.
 *
 * Data-only: event callbacks stay on the component props
 * (`WavePrepWorkspaceProps`) so stories can stub them independently.
 */
export interface WavePrepWorkspaceViewModel {
  /** Full contributor list backing the workspace stats and filters. */
  contributors: ContributorRow[];
  /** Wave number shown in the workspace header, when known. */
  waveNumber?: number;
  /** True while a CSV/JSON export triggered from the workspace is pending. */
  isExporting?: boolean;
}

/**
 * Build a {@link WavePrepWorkspaceViewModel} from untrusted input.
 *
 * @throws {Error} with a stable `waveprep: ...` message when `input` is not
 * an array of contributor rows. An empty array is valid (zero contributors).
 */
export function createWavePrepWorkspaceViewModel(
  input: unknown,
  opts?: { waveNumber?: number; isExporting?: boolean }
): WavePrepWorkspaceViewModel {
  if (!Array.isArray(input)) {
    throw new Error("waveprep: contributors must be an array");
  }
  for (const row of input) {
    if (!row || typeof row !== "object") {
      throw new Error("waveprep: contributors must be contributor rows");
    }
  }
  return {
    contributors: input as ContributorRow[],
    ...(opts?.waveNumber !== undefined ? { waveNumber: opts.waveNumber } : {}),
    ...(opts?.isExporting !== undefined ? { isExporting: opts.isExporting } : {}),
  };
}

