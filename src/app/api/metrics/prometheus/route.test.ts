import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

import * as prometheusRoute from "@/app/api/metrics/prometheus/route";

vi.mock("@/lib/api-auth", () => ({
  requireOperator: vi.fn(),
}));

vi.mock("@/lib/horizon", () => ({
  getHorizonCircuitBreakerMetrics: vi.fn(() => ({
    state: "CLOSED" as const,
    failureCount: 0,
    successCount: 0,
    lastFailureTime: null,
    totalTrips: 2,
    recentTrips: [],
    options: {
      failureThreshold: 5,
      successThreshold: 2,
      recoveryTimeoutMs: 30_000,
    },
    processLocal: true,
  })),
}));

vi.mock("@/lib/rate-limit", () => ({
  getRateLimitMetrics: vi.fn(() => ({
    activeIdentifiers: 7,
    totalAllowed: 150,
    totalBlocked: 5,
    options: { windowMs: 60_000, maxRequests: 10 },
    processLocal: true,
  })),
}));

vi.mock("@/lib/registrations", () => ({
  getContributors: vi.fn(async () => ({
    contributors: [
      { id: "1", readiness: "ready" },
      { id: "2", readiness: "low_reserve" },
      { id: "3", readiness: "not_ready" },
      { id: "4", readiness: "ready" },
    ],
  })),
}));

vi.mock("@/lib/stats", () => ({
  summarizeContributors: vi.fn(() => ({
    totalContributors: 4,
    readyCount: 2,
    readyPercent: 50,
  })),
}));

import { requireOperator } from "@/lib/api-auth";

describe("Prometheus metrics endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PROMETHEUS_SCRAPE_TOKENS;
  });

  afterEach(() => {
    delete process.env.PROMETHEUS_SCRAPE_TOKENS;
  });

  function buildRequest(headers: Record<string, string> = {}) {
    return new NextRequest("http://localhost/api/metrics/prometheus", {
      method: "GET",
      headers,
    });
  }

  describe("authentication", () => {
    it("returns 403 when no auth and no bearer token", async () => {
      vi.mocked(requireOperator).mockResolvedValue(null as never);

      const resp = await prometheusRoute.GET(buildRequest());
      expect(resp.status).toBe(403);
    });

    it("allows access when maintainer session is present", async () => {
      vi.mocked(requireOperator).mockResolvedValue({ user: { isMaintainer: true } } as never);

      const resp = await prometheusRoute.GET(buildRequest());
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toContain("text/plain");
    });

    it("allows access with valid PROMETHEUS_SCRAPE_TOKENS bearer token", async () => {
      process.env.PROMETHEUS_SCRAPE_TOKENS = "token-a, token-b ,tokenc";
      vi.mocked(requireOperator).mockResolvedValue(null as never);

      const resp = await prometheusRoute.GET(
        buildRequest({ Authorization: "Bearer token-b" })
      );
      expect(resp.status).toBe(200);
      expect(requireOperator).not.toHaveBeenCalled();
    });

    it("denies access when bearer token is not in allowlist", async () => {
      process.env.PROMETHEUS_SCRAPE_TOKENS = "trusted-token-1";
      vi.mocked(requireOperator).mockResolvedValue(null as never);

      const resp = await prometheusRoute.GET(
        buildRequest({ Authorization: "Bearer wrong-token" })
      );
      expect(resp.status).toBe(403);
    });

    it("falls back to session auth when allowlist env is not set", async () => {
      vi.mocked(requireOperator).mockResolvedValue({ user: { isMaintainer: true } } as never);

      const resp = await prometheusRoute.GET(
        buildRequest({ Authorization: "Bearer whatever" })
      );
      expect(resp.status).toBe(200);
      expect(requireOperator).toHaveBeenCalled();
    });
  });

  describe("prometheus text format", () => {
    beforeEach(() => {
      vi.mocked(requireOperator).mockResolvedValue({ user: { isMaintainer: true } } as never);
    });

    it("returns the correct content-type for Prometheus scraping", async () => {
      const resp = await prometheusRoute.GET(buildRequest());
      const ct = resp.headers.get("content-type");
      expect(ct).toContain("text/plain");
      expect(ct).toContain("version=0.0.4");
    });

    it("includes HELP and TYPE lines for every metric", async () => {
      const resp = await prometheusRoute.GET(buildRequest());
      const body = await resp.text();

      expect(body).toContain("# HELP trustbridge_contributors_total");
      expect(body).toContain("# TYPE trustbridge_contributors_total gauge");
      expect(body).toContain("# HELP trustbridge_circuit_breaker_state");
      expect(body).toContain("# TYPE trustbridge_circuit_breaker_state gauge");
      expect(body).toContain("# HELP trustbridge_rate_limit_requests_blocked_total");
      expect(body).toContain("# TYPE trustbridge_rate_limit_requests_blocked_total counter");
    });

    it("emits expected contributor gauge values", async () => {
      const resp = await prometheusRoute.GET(buildRequest());
      const body = await resp.text();

      expect(body).toMatch(/^trustbridge_contributors_total 4$/m);
      expect(body).toMatch(/^trustbridge_contributors_ready 2$/m);
      expect(body).toMatch(/^trustbridge_contributors_low_reserve 1$/m);
      expect(body).toMatch(/^trustbridge_contributors_not_ready 1$/m);
    });

    it("encodes circuit breaker state as 0=CLOSED 1=HALF_OPEN 2=OPEN", async () => {
      const resp = await prometheusRoute.GET(buildRequest());
      const body = await resp.text();
      expect(body).toMatch(/^trustbridge_circuit_breaker_state 0$/m);
    });

    it("includes counter metrics for trips and rate limit counts", async () => {
      const resp = await prometheusRoute.GET(buildRequest());
      const body = await resp.text();

      expect(body).toMatch(/^trustbridge_circuit_breaker_total_trips 2$/m);
      expect(body).toMatch(/^trustbridge_rate_limit_requests_allowed_total 150$/m);
      expect(body).toMatch(/^trustbridge_rate_limit_requests_blocked_total 5$/m);
      expect(body).toMatch(/^trustbridge_rate_limit_active_identifiers 7$/m);
    });

    it("includes the process_local_info gauge as an honest scope marker", async () => {
      const resp = await prometheusRoute.GET(buildRequest());
      const body = await resp.text();
      expect(body).toContain('trustbridge_process_local_info{scope="process"} 1');
    });

    it("emits a numeric timestamp (seconds) for last_failure instead of 0 when available", async () => {
      const { getHorizonCircuitBreakerMetrics } = await import("@/lib/horizon");
      vi.mocked(getHorizonCircuitBreakerMetrics).mockReturnValueOnce({
        state: "OPEN",
        failureCount: 5,
        successCount: 0,
        lastFailureTime: 1_700_000_000_000,
        totalTrips: 1,
        recentTrips: [],
        options: { failureThreshold: 5, successThreshold: 2, recoveryTimeoutMs: 30_000 },
        processLocal: true,
      });

      const resp = await prometheusRoute.GET(buildRequest());
      const body = await resp.text();
      expect(body).toMatch(/^trustbridge_circuit_breaker_state 2$/m);
      expect(body).toMatch(/^trustbridge_circuit_breaker_last_failure_timestamp_seconds 1700000000$/m);
    });

    it("sanitizes labels so PII/cardinality cannot leak via labels", async () => {
      const resp = await prometheusRoute.GET(buildRequest());
      const body = await resp.text();
      for (const line of body.split("\n")) {
        if (line.includes("{")) {
          expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*\{[^}]*\} -?\d+(?:\.\d+)?$/);
        }
      }
    });
  });
});
