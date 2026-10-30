import { describe, expect, it } from "vitest";

import {
  createDemoContributors,
  createDemoSorobanEvents,
  DEMO_CONTRIBUTORS,
  DEMO_NETWORK_CONFIG,
  DEMO_SOROBAN_EVENTS,
  getDemoDashboardStats,
} from "@/lib/demo-data";

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;
const CONTRACT_ADDRESS = /^C[A-Z2-7]{55}$/;
const TX_HASH = /^[0-9a-f]{64}$/;

describe("public demo data", () => {
  it("provides a realistic, uniquely identifiable contributor set", () => {
    expect(DEMO_CONTRIBUTORS).toHaveLength(24);

    expect(new Set(DEMO_CONTRIBUTORS.map((row) => row.id)).size).toBe(24);
    expect(
      new Set(DEMO_CONTRIBUTORS.map((row) => row.githubUsername)).size,
    ).toBe(24);
    expect(
      new Set(DEMO_CONTRIBUTORS.map((row) => row.stellarAddress)).size,
    ).toBe(24);

    for (const contributor of DEMO_CONTRIBUTORS) {
      expect(contributor.githubUsername).toMatch(/^[a-z0-9-]+$/);
      expect(contributor.stellarAddress).toMatch(STELLAR_ADDRESS);
      expect(contributor.lastCheckedAt).toBeTruthy();
      expect(Number.isNaN(new Date(contributor.lastCheckedAt ?? "").getTime())).toBe(
        false,
      );
    }
  });

  it("keeps readiness flags and balances internally consistent", () => {
    for (const contributor of DEMO_CONTRIBUTORS) {
      const shouldBeReady = contributor.readiness === "ready";
      const shouldHaveTrustline =
        contributor.readiness === "ready" ||
        contributor.readiness === "low_reserve";

      expect(contributor.trustlineReady).toBe(shouldHaveTrustline);
      expect(contributor.trustlineAuthorized).toBe(shouldHaveTrustline);
      expect(contributor.verified).toBe(shouldHaveTrustline);
      expect(contributor.funded).toBe(shouldHaveTrustline);
      if (shouldBeReady) {
        expect(Number.parseFloat(contributor.spendableXlmBalance)).toBeGreaterThan(
          1.5,
        );
      }
    }
  });

  it("calculates dashboard statistics from the same displayed rows", () => {
    const stats = getDemoDashboardStats(DEMO_CONTRIBUTORS);
    const expectedReady = DEMO_CONTRIBUTORS.filter(
      (row) => row.readiness === "ready",
    ).length;

    expect(stats.totalContributors).toBe(DEMO_CONTRIBUTORS.length);
    expect(stats.readyCount).toBe(expectedReady);
    expect(stats.readyPercent).toBe(
      Math.round((expectedReady / DEMO_CONTRIBUTORS.length) * 100),
    );
  });

  it("returns fresh copies so demo interactions do not mutate the source", () => {
    const first = createDemoContributors(1_800_000_000_000);
    const second = createDemoContributors(1_800_000_000_000);

    first[0].banned = true;
    first[0].githubUsername = "changed";

    expect(second[0].banned).toBe(false);
    expect(second[0].githubUsername).not.toBe("changed");
    expect(DEMO_CONTRIBUTORS[0].githubUsername).not.toBe("changed");
  });

  it("provides synthetic activity data for the demo timeline", () => {
    expect(DEMO_SOROBAN_EVENTS.length).toBeGreaterThan(0);
    expect(new Set(DEMO_SOROBAN_EVENTS.map((event) => event.id)).size).toBe(
      DEMO_SOROBAN_EVENTS.length,
    );

    for (const event of DEMO_SOROBAN_EVENTS) {
      expect(event.contractId).toMatch(CONTRACT_ADDRESS);
      expect(event.txHash).toMatch(TX_HASH);
      expect(event.topic.length).toBeGreaterThan(0);
      expect(Number.isNaN(new Date(event.ledgerClosedAt).getTime())).toBe(false);
    }

    const refreshed = createDemoSorobanEvents(1_800_000_000_000);
    expect(refreshed).toHaveLength(DEMO_SOROBAN_EVENTS.length);
    expect(refreshed[0].txHash).toBe(DEMO_SOROBAN_EVENTS[0].txHash);
  });

  it("uses a testnet demo network with no configured mismatch", () => {
    expect(DEMO_NETWORK_CONFIG.horizonNetwork).toBe("testnet");
    expect(DEMO_NETWORK_CONFIG.sorobanNetwork).toBe("testnet");
    expect(DEMO_NETWORK_CONFIG.mismatched).toBe(false);
    expect(DEMO_NETWORK_CONFIG.actionAlignment.aligned).toBe(true);
  });
});
