/**
 * API integration tests — auth roles, tokens, and edge cases (#45)
 *
 * Part 3: token encryption flows, /api/check, /api/stats, /api/health,
 *         and cross-cutting edge cases (rate limiting, error propagation)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/horizon", () => ({ checkStellarAddress: vi.fn() }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    extractClientIp: vi.fn(() => "127.0.0.1"),
    checkRateLimit: vi.fn(() => ({ allowed: true, retryAfter: 0, remaining: 9 })),
    resetRateLimit: vi.fn(),
  };
});
vi.mock("@/lib/registrations", () => ({
  getDashboardStats: vi.fn(),
  toContributorRow: vi.fn((r: unknown) => r),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    registration: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/stale-export", () => ({
  buildStalenessSummary: vi.fn(),
}));
vi.mock("@/lib/token-crypto", () => ({
  encryptToken: vi.fn((t: string) => `enc:${t}`),
  decryptToken: vi.fn((t: string) => t.replace("enc:", "")),
}));
vi.mock("@/lib/token-audit", () => ({ recordTokenAudit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn() }));

import { getServerSession } from "next-auth";
import { checkStellarAddress } from "@/lib/horizon";
import { checkRateLimit, resetRateLimit } from "@/lib/rate-limit";
import { getDashboardStats } from "@/lib/registrations";
import { prisma } from "@/lib/prisma";
import { buildStalenessSummary } from "@/lib/stale-export";
import { checkCache } from "@/lib/cache";

import { POST as checkPost } from "@/app/api/check/route";
import { GET as statsGet } from "@/app/api/stats/route";
import { GET as healthGet } from "@/app/api/health/route";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const SAME_ORIGIN_HEADERS = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function postCheck(body: unknown, headers = SAME_ORIGIN_HEADERS) {
  return new NextRequest("http://localhost:3000/api/check", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function mockHorizonReady() {
  vi.mocked(checkStellarAddress).mockResolvedValue({
    funded: true,
    trustline: true,
    trustline_authorized: true,
    verified: true,
    xlm_balance: "5",
    spendable_xlm_balance: "4",
    errors: [],
    readiness: "ready",
  } as never);
}

beforeEach(() => {
  checkCache.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// POST /api/check — CSRF + rate limit
// ---------------------------------------------------------------------------
describe("POST /api/check — CSRF protection", () => {
  it("rejects cross-origin before touching Horizon", async () => {
    const res = await checkPost(
      postCheck({ address: "GBSX" }, {
        origin: "https://evil.com",
        host: "localhost:3000",
        "content-type": "application/json",
      })
    );
    expect(res.status).toBe(403);
    expect(checkStellarAddress).not.toHaveBeenCalled();
  });

  it("returns 400 for missing address (same-origin)", async () => {
    const res = await checkPost(postCheck({ address: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 200 with readiness for a valid address", async () => {
    mockHorizonReady();
    const res = await checkPost(postCheck({ address: "GBSX" + "X".repeat(52) }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.funded).toBe(true);
    expect(json.readiness).toBe("ready");
  });

  it("returns 200 with Horizon errors forwarded (circuit-breaker open)", async () => {
    vi.mocked(checkStellarAddress).mockResolvedValue({
      funded: false,
      trustline: false,
      trustline_authorized: false,
      verified: false,
      xlm_balance: "0",
      spendable_xlm_balance: "0",
      errors: ["Horizon is temporarily unavailable. Please try again later."],
      readiness: "not_ready",
    } as never);
    const res = await checkPost(postCheck({ address: "GBSX" + "X".repeat(52) }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.errors).toContain(
      "Horizon is temporarily unavailable. Please try again later."
    );
  });
});

describe("POST /api/check — rate limiting", () => {
  it("returns 429 when rate limit is exhausted", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: false,
      retryAfter: 42,
      remaining: 0,
    });
    const res = await checkPost(postCheck({ address: "GBSX" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(checkStellarAddress).not.toHaveBeenCalled();
  });

  it("returns 200 when rate limit has remaining capacity", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({
      allowed: true,
      retryAfter: 0,
      remaining: 5,
    });
    mockHorizonReady();
    const res = await checkPost(postCheck({ address: "GBSX" + "X".repeat(52) }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/check — Horizon error propagation", () => {
  it("returns 500 when checkStellarAddress throws unexpectedly", async () => {
    vi.mocked(checkStellarAddress).mockRejectedValue(new Error("Unexpected boom"));
    const res = await checkPost(postCheck({ address: "GBSX" + "X".repeat(52) }));
    expect(res.status).toBe(500);
  });

  it("forwards custom asset_code and asset_issuer to checkStellarAddress", async () => {
    mockHorizonReady();
    await checkPost(
      postCheck({
        address: "GBSX" + "X".repeat(52),
        asset_code: "XLM",
        asset_issuer: "native",
      })
    );
    expect(checkStellarAddress).toHaveBeenCalledWith(
      expect.any(String),
      "XLM",
      "native",
      expect.objectContaining({ useCache: true })
    );
  });
});

// ---------------------------------------------------------------------------
// GET /api/stats — public endpoint
// ---------------------------------------------------------------------------
describe("GET /api/stats — public, no auth required", () => {
  it("returns 200 with aggregate stats", async () => {
    vi.mocked(getDashboardStats).mockResolvedValue({
      totalContributors: 10,
      readyCount: 7,
      readyPercent: 70,
    });
    const res = await statsGet();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.totalContributors).toBe(10);
    expect(json.readyCount).toBe(7);
    expect(json.readyPercent).toBe(70);
  });

  it("returns 200 with zero stats when no contributors exist", async () => {
    vi.mocked(getDashboardStats).mockResolvedValue({
      totalContributors: 0,
      readyCount: 0,
      readyPercent: 0,
    });
    const res = await statsGet();
    const json = await res.json();
    expect(json.totalContributors).toBe(0);
    expect(json.readyPercent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/health — always 200, unauthenticated
// ---------------------------------------------------------------------------
describe("GET /api/health — always 200, unauthenticated", () => {
  it("returns 200 (not 401/403) even without a session", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([]);
    vi.mocked(buildStalenessSummary).mockReturnValue({
      stale: false, staleCount: 0, totalCount: 0,
      stalePercent: 0, warning: "", allowExport: true,
    });
    const res = await healthGet();
    expect(res.status).toBe(200);
  });

  it("reports status=ok when DB healthy and data fresh", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([]);
    vi.mocked(buildStalenessSummary).mockReturnValue({
      stale: false, staleCount: 0, totalCount: 3,
      stalePercent: 0, warning: "", allowExport: true,
    });
    const res = await healthGet();
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.checks.database.status).toBe("ok");
    expect(json.checks.csvStaleness.status).toBe("ok");
  });

  it("reports status=degraded when contributor data is stale", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([]);
    vi.mocked(buildStalenessSummary).mockReturnValue({
      stale: true, staleCount: 2, totalCount: 5,
      stalePercent: 40,
      warning: "2 of 5 contributors not verified recently.",
      allowExport: false,
    });
    const res = await healthGet();
    const json = await res.json();
    expect(json.status).toBe("degraded");
    expect(json.checks.csvStaleness.staleCount).toBe(2);
  });

  it("reports status=error (still 200) when DB is unreachable", async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await healthGet();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("error");
    expect(json.checks.database.status).toBe("error");
    expect(json.checks.database.error).toContain("ECONNREFUSED");
  });

  it("does not expose PII in health response", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([]);
    vi.mocked(buildStalenessSummary).mockReturnValue({
      stale: false, staleCount: 0, totalCount: 0,
      stalePercent: 0, warning: "", allowExport: true,
    });
    const res = await healthGet();
    const text = await res.text();
    expect(text).not.toContain("githubUsername");
    expect(text).not.toContain("stellarAddress");
    expect(text).not.toContain("accessToken");
  });
});

// ---------------------------------------------------------------------------
// Token encryption — getDecryptedGithubAccessToken edge cases
// ---------------------------------------------------------------------------
describe("token encryption — getDecryptedGithubAccessToken", () => {
  // Import lazily so mocks are applied first
  it("returns null when no access token is stored for the user", async () => {
    const prismaModule = await vi.importMock("@/lib/prisma") as {
      prisma: { user: { findUnique: ReturnType<typeof vi.fn> } };
    };
    prismaModule.prisma.user = {
      findUnique: vi.fn().mockResolvedValue({ accessToken: null }),
    };

    const { getDecryptedGithubAccessToken } = await import("@/lib/auth");
    const result = await getDecryptedGithubAccessToken("user-no-token");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: response shape consistency
// ---------------------------------------------------------------------------
describe("response shape — API contracts", () => {
  it("POST /api/check always includes funded, trustline, verified, readiness", async () => {
    mockHorizonReady();
    const res = await checkPost(postCheck({ address: "GBSX" + "X".repeat(52) }));
    const json = await res.json();
    expect(json).toHaveProperty("funded");
    expect(json).toHaveProperty("trustline");
    expect(json).toHaveProperty("verified");
    expect(json).toHaveProperty("readiness");
    expect(json).toHaveProperty("errors");
    expect(Array.isArray(json.errors)).toBe(true);
  });

  it("GET /api/health always includes status, timestamp, version, checks", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([]);
    vi.mocked(buildStalenessSummary).mockReturnValue({
      stale: false, staleCount: 0, totalCount: 0,
      stalePercent: 0, warning: "", allowExport: true,
    });
    const res = await healthGet();
    const json = await res.json();
    expect(json).toHaveProperty("status");
    expect(json).toHaveProperty("timestamp");
    expect(json).toHaveProperty("version");
    expect(json).toHaveProperty("checks");
    expect(json.checks).toHaveProperty("database");
    expect(json.checks).toHaveProperty("csvStaleness");
  });

  it("GET /api/stats always includes totalContributors, readyCount, readyPercent", async () => {
    vi.mocked(getDashboardStats).mockResolvedValue({
      totalContributors: 5,
      readyCount: 3,
      readyPercent: 60,
    });
    const json = await (await statsGet()).json();
    expect(json).toHaveProperty("totalContributors");
    expect(json).toHaveProperty("readyCount");
    expect(json).toHaveProperty("readyPercent");
  });
});
