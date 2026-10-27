import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import MetricsPage from "@/app/dashboard/metrics/page";

const metricsFixture = {
  contributors: {
    total: 3,
    ready: 1,
    readyPercent: 33,
    byStatus: { ready: 1, low_reserve: 1, not_ready: 1 },
  },
  audit: {
    recentEntries: 2,
    byAction: { "recheck.single": 3, "recheck.batch": 1 },
    latestAt: "2026-07-25T10:00:00.000Z",
  },
  circuitBreaker: {
    state: "CLOSED" as const,
    failureCount: 0,
    successCount: 0,
    lastFailureTime: null,
    totalTrips: 2,
    recentTrips: [
      {
        trippedAt: Date.now() - 3_600_000,
        failureCountAtTrip: 5,
        recoveredAt: Date.now() - 3_570_000,
      },
      {
        trippedAt: Date.now() - 600_000,
        failureCountAtTrip: 5,
        recoveredAt: Date.now() - 580_000,
      },
    ],
    processLocal: true,
  },
  rateLimit: {
    activeIdentifiers: 42,
    totalAllowed: 1234,
    totalBlocked: 56,
    processLocal: true,
  },
  config: {
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 10,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerSuccessThreshold: 2,
    circuitBreakerRecoveryMs: 30_000,
    staleCsvMaxAgeMs: 86_400_000,
    horizonUrl: "https://horizon.stellar.org",
    sorobanContractConfigured: false,
  },
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    data: metricsFixture,
  }),
}));

describe("MetricsPage layout", () => {
  it("renders a mobile-first stacked readiness grid", () => {
    const { container } = render(<MetricsPage />);

    expect(screen.getByTestId("metrics-page")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /admin metrics/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/3 registered contributors/i)).toBeInTheDocument();

    const readinessGrid = container.querySelector(
      ".grid.grid-cols-1.sm\\:grid-cols-3"
    );
    expect(readinessGrid).toBeTruthy();
  });

  it("shows mobile audit cards and a desktop table with the same data", () => {
    render(<MetricsPage />);

    expect(screen.getByTestId("metrics-audit-mobile")).toBeInTheDocument();
    expect(screen.getByTestId("metrics-audit-table")).toBeInTheDocument();
    expect(screen.getAllByText("recheck.single").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps all readiness counts visible", () => {
    render(<MetricsPage />);

    // Exact labels (not regex): WaveReadinessBar renders "1/3 ready (33%)",
    // which would also match a loose /ready/i pattern.
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Low reserve")).toBeInTheDocument();
    expect(screen.getByText("Not ready")).toBeInTheDocument();
  });

  describe("circuit breaker section", () => {
    it("renders the horizon circuit breaker card", () => {
      render(<MetricsPage />);
      expect(screen.getByTestId("metrics-circuit-breaker")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: /horizon circuit breaker/i })
      ).toBeInTheDocument();
    });

    it("shows the CLOSED state badge when healthy", () => {
      render(<MetricsPage />);
      expect(screen.getByText(/closed.*healthy/i)).toBeInTheDocument();
    });

    it("displays total trips and stats", () => {
      render(<MetricsPage />);
      expect(screen.getByText("2")).toBeInTheDocument();
      expect(screen.getByText(/total trips/i)).toBeInTheDocument();
      expect(screen.getByText(/current failures/i)).toBeInTheDocument();
    });

    it("renders the recent trips table when trips exist", () => {
      render(<MetricsPage />);
      expect(
        screen.getByTestId("metrics-circuit-breaker-trips")
      ).toBeInTheDocument();
      expect(
        screen.getAllByRole("row").length
      ).toBeGreaterThanOrEqual(3);
    });

    it("shows the process-local disclaimer note", () => {
      render(<MetricsPage />);
      const notes = screen.getAllByText(/process-local data only/i);
      expect(notes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("rate limit section", () => {
    it("renders the rate limiting card", () => {
      render(<MetricsPage />);
      expect(screen.getByTestId("metrics-rate-limit")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: /rate limiting/i })
      ).toBeInTheDocument();
    });

    it("shows allowed, blocked, and active client counts", () => {
      render(<MetricsPage />);
      expect(screen.getByText(/requests allowed/i)).toBeInTheDocument();
      expect(screen.getByText(/requests blocked/i)).toBeInTheDocument();
      expect(screen.getByText(/active clients.*window/i)).toBeInTheDocument();
      expect(screen.getByText("42")).toBeInTheDocument();
    });

    it("displays the block rate and window summary", () => {
      render(<MetricsPage />);
      expect(screen.getByText(/block rate:/i)).toBeInTheDocument();
      expect(screen.getByText(/window:.*60s.*max:.*10 req/i)).toBeInTheDocument();
    });
  });
});
