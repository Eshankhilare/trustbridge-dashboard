export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  successThreshold: number;
  recoveryTimeoutMs: number;
}

export interface CircuitBreakerTripEvent {
  trippedAt: number;
  failureCountAtTrip: number;
  recoveredAt: number | null;
}

const MAX_TRIP_HISTORY = 20;

/**
 * Resolve the breaker options from the current environment. Exported so
 * metrics surfaces can report live config (matching rate-limit behavior)
 * instead of import-time snapshots.
 */
export function getDefaultOptions(): CircuitBreakerOptions {
  const failureThreshold = Number.parseInt(
    process.env.HORIZON_CB_FAILURE_THRESHOLD ?? "5",
    10
  );
  const successThreshold = Number.parseInt(
    process.env.HORIZON_CB_SUCCESS_THRESHOLD ?? "2",
    10
  );
  const recoveryTimeoutMs = Number.parseInt(
    process.env.HORIZON_CB_RECOVERY_MS ?? "30000",
    10
  );

  return {
    failureThreshold:
      Number.isFinite(failureThreshold) && failureThreshold > 0
        ? failureThreshold
        : 5,
    successThreshold:
      Number.isFinite(successThreshold) && successThreshold > 0
        ? successThreshold
        : 2,
    recoveryTimeoutMs:
      Number.isFinite(recoveryTimeoutMs) && recoveryTimeoutMs > 0
        ? recoveryTimeoutMs
        : 30000,
  };
}

export class CircuitBreaker {
  private state: CircuitBreakerState = "CLOSED";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  private totalTrips = 0;
  private tripHistory: CircuitBreakerTripEvent[] = [];
  private currentTrip: CircuitBreakerTripEvent | null = null;

  constructor(private options: CircuitBreakerOptions = getDefaultOptions()) {}

  getState(): CircuitBreakerState {
    return this.state;
  }

  getOptions(): CircuitBreakerOptions {
    return { ...this.options };
  }

  getMetrics(): {
    state: CircuitBreakerState;
    failureCount: number;
    successCount: number;
    lastFailureTime: number | null;
    totalTrips: number;
    recentTrips: CircuitBreakerTripEvent[];
    options: CircuitBreakerOptions;
    processLocal: boolean;
  } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      totalTrips: this.totalTrips,
      recentTrips: [...this.tripHistory],
      options: { ...this.options },
      processLocal: true,
    };
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      const elapsed = Date.now() - (this.lastFailureTime ?? 0);
      if (elapsed > this.options.recoveryTimeoutMs) {
        this.state = "HALF_OPEN";
        this.successCount = 0;
      } else {
        throw new CircuitBreakerOpenError(
          this.options.recoveryTimeoutMs - elapsed
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    if (this.state === "HALF_OPEN") {
      this.successCount++;
      if (this.successCount >= this.options.successThreshold) {
        if (this.currentTrip) {
          this.currentTrip.recoveredAt = Date.now();
          this.currentTrip = null;
        }
        this.state = "CLOSED";
        this.failureCount = 0;
        this.successCount = 0;
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    const wasClosed = this.state === "CLOSED";
    const wasHalfOpen = this.state === "HALF_OPEN";

    if (wasHalfOpen) {
      this.state = "OPEN";
      this.successCount = 0;
    } else if (wasClosed && this.failureCount >= this.options.failureThreshold) {
      this.state = "OPEN";
      this.totalTrips++;
      this.currentTrip = {
        trippedAt: Date.now(),
        failureCountAtTrip: this.failureCount,
        recoveredAt: null,
      };
      this.tripHistory.push(this.currentTrip);
      if (this.tripHistory.length > MAX_TRIP_HISTORY) {
        this.tripHistory.shift();
      }
    } else if (!wasHalfOpen && this.state === "OPEN" && this.currentTrip) {
      this.currentTrip.failureCountAtTrip = this.failureCount;
    }
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(public readonly remainingMs: number) {
    super(`Circuit breaker is open. Retry after ${remainingMs}ms.`);
    this.name = "CircuitBreakerOpenError";
  }
}

/**
 * Shared, process-local circuit breakers for outbound Stellar calls.
 *
 * Horizon and Soroban RPC are independent upstreams, so each gets its own
 * breaker. This keeps a Soroban outage from tripping the Horizon breaker (and
 * vice versa) while still letting the dashboard degrade gracefully when either
 * upstream is unhealthy.
 *
 * Tunable via the existing HORIZON_CB_* env vars (see getDefaultOptions).
 */
export const horizonCircuitBreaker = new CircuitBreaker();
export const sorobanCircuitBreaker = new CircuitBreaker();

export type OutboundUpstream = "horizon" | "soroban";

export function getCircuitBreakerFor(
  upstream: OutboundUpstream
): CircuitBreaker {
  return upstream === "soroban" ? sorobanCircuitBreaker : horizonCircuitBreaker;
}

export interface DegradedResult {
  ok: false;
  degraded: true;
  upstream: OutboundUpstream;
  retryAfterMs: number;
  message: string;
  cause?: unknown;
}

export interface SuccessResult<T> {
  ok: true;
  degraded: false;
  data: T;
}

export type BreakerResult<T> = SuccessResult<T> | DegradedResult;

/**
 * Run an outbound call through the breaker for the given upstream and return a
 * discriminated result instead of throwing. Callers (check-api / check-api-client)
 * can then surface a clear degraded state to the UI without try/catch noise.
 *
 * - Happy path: `{ ok: true, degraded: false, data }`.
 * - Open breaker: `{ ok: false, degraded: true, retryAfterMs, message }`.
 * - Upstream failure: `{ ok: false, degraded: true, retryAfterMs: 0, message, cause }`.
 */
export async function callWithBreaker<T>(
  upstream: OutboundUpstream,
  fn: () => Promise<T>
): Promise<BreakerResult<T>> {
  const breaker = getCircuitBreakerFor(upstream);
  try {
    const data = await breaker.call(fn);
    return { ok: true, degraded: false, data };
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      return {
        ok: false,
        degraded: true,
        upstream,
        retryAfterMs: error.remainingMs,
        message: `${upstream} is temporarily unavailable. Retry in ${Math.ceil(
          error.remainingMs / 1000
        )}s.`,
      };
    }
    return {
      ok: false,
      degraded: true,
      upstream,
      retryAfterMs: 0,
      message: `${upstream} request failed. Please try again.`,
      cause: error,
    };
  }
}
