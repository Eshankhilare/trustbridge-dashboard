import "server-only";

import { Horizon } from "stellar-sdk";

import { buildCacheKey, verificationCache } from "@/lib/cache";
import { DEFAULT_ASSET, DEFAULT_HORIZON_URL } from "@/lib/constants";
import {
  buildCheckResult,
  buildNotFoundCheckResult,
  computeSpendableXlmBalance,
  getHorizonErrorMessage,
  isAccountNotFoundError,
} from "@/lib/readiness";
import { withRetry } from "@/lib/retry";
import { withSpan } from "@/lib/tracing";
import {
  isValidStellarAddress,
  normalizeStellarAddress,
} from "@/lib/stellar";
import { CircuitBreaker, CircuitBreakerOpenError, getDefaultOptions } from "@/lib/circuit-breaker";
import type { HorizonCheckResult } from "@/types";

type AccountBalance = Horizon.HorizonApi.BalanceLine;

/**
 * `num_sponsoring`/`num_sponsored` are present on every Horizon account
 * response and copied onto `AccountResponse` at runtime, but the SDK's
 * `AccountResponse` class type only declares `subentry_count`. Narrow cast
 * to read them without pulling in the full `ServerApi.AccountRecord` shape.
 */
type AccountSponsorshipFields = {
  num_sponsoring: number;
  num_sponsored: number;
};

function getHorizonServer(): Horizon.Server {
  const url =
    process.env.NEXT_PUBLIC_HORIZON_URL?.trim() || DEFAULT_HORIZON_URL;
  return new Horizon.Server(url);
}

const horizonCircuitBreaker = new CircuitBreaker();

export function getHorizonCircuitBreakerState(): string {
  return horizonCircuitBreaker.getState();
}

export function getHorizonCircuitBreakerMetrics(): ReturnType<
  typeof horizonCircuitBreaker.getMetrics
> {
  const metrics = horizonCircuitBreaker.getMetrics();
  // Report live env-derived options (not the import-time snapshot) so the
  // metrics surface reflects current configuration, like rate-limit metrics.
  return { ...metrics, options: getDefaultOptions() };
}

async function loadAccountFromHorizon(address: string) {
  const server = getHorizonServer();
  // Span name carries no address (issue #203); the account is a G-address.
  return withSpan(
    "horizon.loadAccount",
    () =>
      // SDK typings expose AccountResponse; runtime payload includes sponsorship fields.
      server.loadAccount(address) as unknown as Promise<
        Horizon.ServerApi.AccountRecord
      >,
    {
      attributes: {
        "peer.service": "horizon",
        "horizon.url":
          process.env.NEXT_PUBLIC_HORIZON_URL?.trim() || DEFAULT_HORIZON_URL,
      },
    },
  );
}

/** True when the balance line is a trustline for the requested asset. */
function isMatchingTrustline(
  balance: AccountBalance,
  assetCode: string,
  assetIssuer: string
): boolean {
  if (balance.asset_type === "native") return false;
  if (balance.asset_type === "liquidity_pool_shares") return false;
  return (
    "asset_code" in balance &&
    balance.asset_code === assetCode &&
    "asset_issuer" in balance &&
    balance.asset_issuer === assetIssuer
  );
}

/**
 * Whether a matched trustline is authorized by the asset issuer.
 * Horizon exposes `is_authorized` on asset balance lines. Assets that do not
 * require authorization omit or set it true, so a missing flag is treated as
 * authorized to avoid false negatives.
 */
export function isTrustlineAuthorized(
  balance: AccountBalance | undefined
): boolean {
  if (!balance) return false;
  if ("is_authorized" in balance && typeof balance.is_authorized === "boolean") {
    return balance.is_authorized;
  }
  return true;
}

export interface CheckOptions {
  /** Read/write the short-lived verification cache. Defaults to true. */
  useCache?: boolean;
  /** Number of Horizon attempts on transient failures. Defaults to 3. */
  retries?: number;
}

export async function checkStellarAddress(
  address: string,
  assetCode: string = DEFAULT_ASSET.code,
  assetIssuer: string = DEFAULT_ASSET.issuer,
  options: CheckOptions = {}
): Promise<HorizonCheckResult> {
  const { useCache = true, retries = 3 } = options;
  const trimmed = normalizeStellarAddress(address);

  if (!trimmed) {
    return buildCheckResult(false, false, "0", ["Address is required"]);
  }

  if (!isValidStellarAddress(trimmed)) {
    return buildCheckResult(false, false, "0", [
      "Invalid Stellar public key (must be a valid G-address)",
    ]);
  }

  const cacheKey = buildCacheKey("horizon", trimmed, assetCode, assetIssuer);
  if (useCache) {
    const cached = verificationCache.get(cacheKey) as HorizonCheckResult | null;
    if (cached) return cached;
  }

  try {
    const startedAt = Date.now();
    const account = await horizonCircuitBreaker.call(() =>
      withRetry(() => loadAccountFromHorizon(trimmed), {
        attempts: retries,
        // A missing account (404) will never succeed — fail fast instead of retrying.
        shouldRetry: (error) =>
          !isAccountNotFoundError(getHorizonErrorMessage(error)),
      })
    );

    const latencyMs = Date.now() - startedAt;
    const nativeBalance = account.balances.find(
      (b) => b.asset_type === "native"
    );
    const xlmBalance = nativeBalance?.balance ?? "0";
    const sellingLiabilities =
      (nativeBalance && "selling_liabilities" in nativeBalance
        ? nativeBalance.selling_liabilities
        : undefined) ?? "0";

    const { num_sponsoring, num_sponsored } =
      account as unknown as AccountSponsorshipFields;

    const spendableXlmBalance = computeSpendableXlmBalance(xlmBalance, {
      subentryCount: account.subentry_count,
      numSponsoring: num_sponsoring,
      numSponsored: num_sponsored,
      sellingLiabilities,
    });

    const trustlineBalance = account.balances.find((balance) =>
      isMatchingTrustline(balance, assetCode, assetIssuer)
    );
    const trustline = Boolean(trustlineBalance);
    const trustlineAuthorized = isTrustlineAuthorized(trustlineBalance);
    const usdcBalance = (trustlineBalance && "balance" in trustlineBalance) ? trustlineBalance.balance : "0";

    const result = buildCheckResult(
      true,
      trustline,
      xlmBalance,
      [],
      trustlineAuthorized,
      spendableXlmBalance,
      usdcBalance,
      latencyMs
    );

    if (useCache) verificationCache.set(cacheKey, result);
    return result;
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      return buildCheckResult(false, false, "0", [
        "Horizon is temporarily unavailable. Please try again later.",
      ]);
    }

    const message = getHorizonErrorMessage(error);

    if (isAccountNotFoundError(message)) {
      const result = buildNotFoundCheckResult();
      if (useCache) verificationCache.set(cacheKey, result);
      return result;
    }

    // Transient errors are not cached so a later retry can succeed.
    return buildCheckResult(false, false, "0", [`Horizon error: ${message}`]);
  }
}
