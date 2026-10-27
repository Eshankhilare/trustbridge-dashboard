import "server-only";

import type { Registration } from "@prisma/client";

import { checkStellarAddress } from "@/lib/horizon";
import { prisma } from "@/lib/prisma";
import {
  buildWalletProofInfo,
  buildHorizonDebugInfo,
} from "@/lib/registration-insights";
import { computeReadiness, computeVerified } from "@/lib/readiness";
import { buildDashboardStats } from "@/lib/stats";
import { CacheStore, statsCache, buildCacheKey, parseStatsCacheTtl } from "@/lib/cache";
import type { ContributorRow, DashboardStats, ReadinessStatus } from "@/types";

/** Typed view of the shared statsCache for dashboard stats. */
const typedStatsCache = statsCache as CacheStore<DashboardStats>;

/** Cache key used for the single aggregate stats entry. */
const STATS_CACHE_KEY = buildCacheKey("stats", "dashboard");

type PersistedRegistration = Pick<
  Registration,
  | "id"
  | "stellarAddress"
  | "funded"
  | "trustlineReady"
  | "trustlineAuthorized"
  | "xlmBalance"
  | "spendableXlmBalance"
>;

type RegistrationWithUserRow = Registration & {
  user: { githubUsername: string; banned?: boolean; banReason?: string | null };
};

/** Readiness for any persisted registration row (with or without its user join). */
function readinessOf(row: PersistedRegistration): ReadinessStatus {
  return computeReadiness(row.funded, row.trustlineReady, row.xlmBalance, {
    authorized: row.trustlineAuthorized,
    spendableBalance: row.spendableXlmBalance,
  });
}

/** Map a persisted registration (+ user) to a serializable contributor row. */
export function toContributorRow(row: RegistrationWithUserRow): ContributorRow {
  return {
    id: row.id,
    githubUsername: row.user.githubUsername,
    stellarAddress: row.stellarAddress,
    trustlineReady: row.trustlineReady,
    trustlineAuthorized: row.trustlineAuthorized,
    verified: computeVerified(
      row.funded,
      row.trustlineReady,
      row.trustlineAuthorized
    ),
    funded: row.funded,
    xlmBalance: row.xlmBalance,
    spendableXlmBalance: row.spendableXlmBalance,
    usdcBalance: row.usdcBalance,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    horizonLatencyMs: row.horizonLatencyMs ?? null,
    readiness: readinessOf(row),
    banned: row.user.banned ?? false,
    banReason: row.user.banReason ?? undefined,
    walletProof: buildWalletProofInfo(
      row.stellarAddress,
      row.user.githubUsername
    ),
    horizonDebug: buildHorizonDebugInfo({
      funded: row.funded,
      trustlineReady: row.trustlineReady,
      trustlineAuthorized: row.trustlineAuthorized,
      readiness: readinessOf(row),
      xlmBalance: row.xlmBalance,
      spendableXlmBalance: row.spendableXlmBalance,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    }),
  };
}

/**
 * Fetch aggregate dashboard statistics, backed by an in-process cache.
 *
 * The TTL is controlled by the `STATS_CACHE_TTL_MS` environment variable
 * (default 60 s).  Callers that need a guaranteed-fresh result (e.g. after a
 * batch recheck) should call `invalidateDashboardStatsCache()` first.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  return typedStatsCache.getOrCompute(
    STATS_CACHE_KEY,
    async () => {
      const registrations = await prisma.registration.findMany({
        where: { deletedAt: null },
        select: {
          funded: true,
          trustlineReady: true,
          trustlineAuthorized: true,
          xlmBalance: true,
          spendableXlmBalance: true,
        },
      });

      const totalContributors = registrations.length;
      const readyCount = registrations.filter(
        (row) =>
          computeReadiness(row.funded, row.trustlineReady, row.xlmBalance, {
            authorized: row.trustlineAuthorized,
            spendableBalance: row.spendableXlmBalance,
          }) === "ready"
      ).length;

      return buildDashboardStats(totalContributors, readyCount);
    },
    parseStatsCacheTtl(),
  );
}

/**
 * Evict the cached dashboard stats so the next call to `getDashboardStats()`
 * queries the database fresh.
 *
 * Call this after any operation that mutates registration readiness data
 * (e.g. batch recheck, single contributor recheck, new registration).
 */
export function invalidateDashboardStatsCache(): void {
  statsCache.invalidate(STATS_CACHE_KEY);
}

export async function getContributors(
  page: number = 1,
  limit: number = 50
): Promise<{ contributors: ContributorRow[]; total: number }> {
  const skip = (page - 1) * limit;

  const [registrations, total] = await Promise.all([
    prisma.registration.findMany({
      where: { deletedAt: null },
      include: {
        user: {
          select: { githubUsername: true, banned: true, banReason: true },
        },
      },
      orderBy: { updatedAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.registration.count({ where: { deletedAt: null } }),
  ]);

  return {
    contributors: registrations.map(toContributorRow),
    total,
  };
}

export interface ReadinessDiff {
  registrationId: string;
  previousReadiness: ReadinessStatus;
  newReadiness: ReadinessStatus;
  changed: boolean;
}

interface RecheckOutcome {
  registration: Registration;
  diff: ReadinessDiff;
}

/**
 * Cursor-paginated contributor query
 * @param cursor Base64-encoded registration ID for pagination
 * @param limit Number of results (1-100, default 50)
 */
export async function getContributorsPaginated(
  cursor?: string,
  limit: number = 50,
  verificationStatus?: 'verified' | 'unverified' | 'banned'
): Promise<{
  contributors: ContributorRow[];
  nextCursor: string | null;
  hasMore: boolean;
}> {
  const { encodeCursor, decodeCursor } = await import("@/lib/cursor-pagination");

  const decodedCursor = cursor ? decodeCursor(cursor) : null;
  const normalizedLimit = Math.min(Math.max(limit, 1), 100);

  // Optional Issue #602 filter. Applied in the database query (not after
  // pagination) so page sizes stay stable when a filter is active.
  // verified = funded + trustline present + authorized (mirrors
  // computeVerified in src/lib/readiness.ts); unverified = anything else.
  const statusFilter =
    verificationStatus === 'verified'
      ? { funded: true, trustlineReady: true, trustlineAuthorized: true }
      : verificationStatus === 'unverified'
        ? { OR: [{ funded: false }, { trustlineReady: false }, { trustlineAuthorized: false }] }
        : undefined;

  // Fetch normalizedLimit + 1 to determine if there are more records
  const registrations = await prisma.registration.findMany({
    where: {
      deletedAt: null,
      ...statusFilter,
      ...(verificationStatus === 'banned' ? { user: { banned: true } } : {}),
    },
    include: {
      user: {
        select: { githubUsername: true },
      },
    },
    orderBy: { updatedAt: "desc" },
    ...(decodedCursor && {
      skip: 1, // Skip the cursor record itself
      cursor: { id: decodedCursor },
    }),
    take: normalizedLimit + 1,
  });

  const hasMore = registrations.length > normalizedLimit;
  const pageData = registrations.slice(0, normalizedLimit);
  const nextCursor = hasMore
    ? encodeCursor(pageData[pageData.length - 1].id)
    : null;

  return {
    contributors: pageData.map(toContributorRow),
    nextCursor,
    hasMore,
  };
}

/**
 * Re-run the Horizon check for a single registration and persist the result.
 * Shared by the single- and batch-recheck flows. Captures the readiness
 * before and after the check so callers can audit what actually changed,
 * rather than just the post-recheck state.
 */
async function recheckRegistration(
  registration: PersistedRegistration
): Promise<RecheckOutcome> {
  const previousReadiness = readinessOf(registration);

  const result = await checkStellarAddress(registration.stellarAddress);

  const updated = await prisma.registration.update({
    where: { id: registration.id },
    data: {
      funded: result.funded,
      trustlineReady: result.trustline,
      trustlineAuthorized: result.trustline_authorized,
      xlmBalance: result.xlm_balance,
      spendableXlmBalance: result.spendable_xlm_balance,
      usdcBalance: result.usdc_balance,
      horizonLatencyMs: result.horizon_latency_ms,
      lastCheckedAt: new Date(),
    },
  });

  const newReadiness = readinessOf(updated);

  // Any readiness change invalidates the cached aggregate stats so the next
  // call to getDashboardStats() reflects the fresh DB state.
  if (previousReadiness !== newReadiness) {
    invalidateDashboardStatsCache();
  }

  return {
    registration: updated,
    diff: {
      registrationId: updated.id,
      previousReadiness,
      newReadiness,
      changed: previousReadiness !== newReadiness,
    },
  };
}

export interface RefreshAllError {
  registrationId: string;
  message: string;
}

export interface RefreshAllSummary {
  refreshed: number;
  changed: number;
  diffs: ReadinessDiff[];
  errors: RefreshAllError[];
}

/**
 * Number of registrations rechecked concurrently by `refreshAllContributors`.
 * Bounded so a large contributor base can't fan out into an unbounded burst
 * of simultaneous Horizon requests (see docs/HORIZON_RETRY_NOTES.md).
 */
function getBatchConcurrency(): number {
  const parsed = Number.parseInt(
    process.env.HORIZON_BATCH_CONCURRENCY ?? "5",
    10
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

/**
 * Run `recheckRegistration` over every row with bounded concurrency. A single
 * registration's failure (e.g. a transient DB error — Horizon errors are
 * already caught inside `checkStellarAddress`) is recorded and skipped
 * rather than rejecting the whole batch, so one bad row can't lose the
 * results already computed for everyone else.
 */
async function recheckAllWithConcurrency(
  registrations: Registration[],
  concurrency: number
): Promise<{ diffs: ReadinessDiff[]; errors: RefreshAllError[] }> {
  const diffs: ReadinessDiff[] = [];
  const errors: RefreshAllError[] = [];
  const queue = [...registrations];

  async function worker() {
    while (queue.length > 0) {
      const registration = queue.shift();
      if (!registration) break;

      try {
        const { diff } = await recheckRegistration(registration);
        diffs.push(diff);
      } catch (error) {
        errors.push({
          registrationId: registration.id,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, registrations.length) },
    () => worker()
  );
  await Promise.all(workers);

  return { diffs, errors };
}

export async function refreshAllContributors(): Promise<RefreshAllSummary> {
  const registrations = await prisma.registration.findMany({
    where: { deletedAt: null },
  });

  const { diffs, errors } = await recheckAllWithConcurrency(
    registrations,
    getBatchConcurrency()
  );

  return {
    refreshed: diffs.length,
    changed: diffs.filter((diff) => diff.changed).length,
    diffs,
    errors,
  };
}

export interface RefreshContributorResult {
  contributor: ContributorRow;
  diff: ReadinessDiff;
}

/**
 * Re-check a single contributor by registration id. Returns the refreshed
 * contributor row plus the before/after readiness diff, or `null` when no
 * registration matches.
 */
export async function refreshContributor(
  id: string
): Promise<RefreshContributorResult | null> {
  const registration = await prisma.registration.findFirst({
    where: { id, deletedAt: null },
  });
  if (!registration) return null;

  const { diff } = await recheckRegistration(registration);

  const updated = await prisma.registration.findFirst({
    where: { id, deletedAt: null },
    include: { user: { select: { githubUsername: true } } },
  });

  return updated ? { contributor: toContributorRow(updated), diff } : null;
}
