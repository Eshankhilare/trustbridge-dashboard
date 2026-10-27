import { NextResponse } from "next/server";

import type { HorizonCheckResult, ReadinessStatus } from "@/types";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "@/lib/circuit-breaker";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export const HORIZON_BREAKER_NAME = "horizon";
export const SOROBAN_BREAKER_NAME = "soroban";

/**
 * Shared circuit breakers guarding outbound Stellar calls. A single breaker
 * per upstream keeps state consistent across requests so a Horizon or Soroban
 * outage trips once and short-circuits subsequent calls instead of cascading.
 */
export const horizonBreaker = new CircuitBreaker();
export const sorobanBreaker = new CircuitBreaker();

export function emptyCheckResult(
  readiness: ReadinessStatus = "not_ready",
  errors: string[] = [],
): HorizonCheckResult {
  return {
    funded: false,
    trustline: false,
    trustline_authorized: false,
    verified: false,
    xlm_balance: "0",
    spendable_xlm_balance: "0",
    usdc_balance: "0",
    errors,
    readiness,
  };
}

/**
 * Run an outbound Horizon call through the shared breaker. When the breaker is
 * open (or the upstream fails) a stable, actionable error is surfaced instead
 * of letting the failure cascade through the dashboard.
 */
export async function withHorizonBreaker<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return horizonBreaker.call(fn);
}

/**
 * Run an outbound Soroban call through the shared breaker. Mirrors
 * {@link withHorizonBreaker} so both upstreams degrade identically.
 */
export async function withSorobanBreaker<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return sorobanBreaker.call(fn);
}

/**
 * Map a breaker/upstream failure to a stable, user-facing message. Open
 * breakers report a degraded state so the UI can show a retry hint rather than
 * a generic 500.
 */
export function describeBreakerError(error: unknown): {
  message: string;
  degraded: boolean;
} {
  if (error instanceof CircuitBreakerOpenError) {
    return {
      message:
        "Stellar network is temporarily unavailable. Please retry shortly.",
      degraded: true,
    };
  }
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "Stellar network request failed.";
  return { message, degraded: false };
}

/**
 * Read the idempotency key supplied by the check-api client on mutation
 * requests (e.g. recheck). Returns a trimmed key or null when absent/blank so
 * callers can reject malformed input with a stable error.
 */
export function readIdempotencyKey(request: Request): string | null {
  const raw = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (raw === null) return null;
  const key = raw.trim();
  return key.length > 0 ? key : null;
}

export function jsonCheckError(
  errors: string[],
  status: number,
  readiness: ReadinessStatus = "not_ready",
  headers?: HeadersInit
) {
  return NextResponse.json(emptyCheckResult(readiness, errors), {
    status,
    ...(headers ? { headers } : {}),
  });
}

export function jsonCheckResult(
  result: HorizonCheckResult,
  status = 200,
  headers?: HeadersInit
) {
  return NextResponse.json(result, {
    status,
    ...(headers ? { headers } : {}),
  });
}
