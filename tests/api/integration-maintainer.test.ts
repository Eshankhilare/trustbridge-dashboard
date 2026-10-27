/**
 * API integration tests — auth roles, tokens, and edge cases (#45)
 *
 * Part 2: maintainer-only routes (/api/contributors, /api/contributors/[id],
 *         /api/audit) — role enforcement, token edge cases, and error paths
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/registrations", () => ({
  getContributors: vi.fn(),
  refreshAllContributors: vi.fn(),
  refreshContributor: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
  getRecentAuditLog: vi.fn(),
}));
vi.mock("@/lib/audit-format", () => ({ summarizeAuditLog: vi.fn(() => ({})) }));
vi.mock("@/lib/background-queue", () => ({
  backgroundQueue: {
    enqueue: vi.fn(),
  },
}));

import { getServerSession } from "next-auth";
import {
  getContributors,
  refreshAllContributors,
  refreshContributor,
} from "@/lib/registrations";
import { getRecentAuditLog } from "@/lib/audit";
import { backgroundQueue } from "@/lib/background-queue";

import { GET as getContributorsRoute, POST as postContributorsRoute } from "@/app/api/contributors/route";
import { POST as recheckSingle } from "@/app/api/contributors/[id]/route";
import { GET as getAudit } from "@/app/api/audit/route";

import type { ContributorRow } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SAME_ORIGIN = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function makeContributor(
  id: string,
  readiness: ContributorRow["readiness"] = "ready"
): ContributorRow {
  return {
    id,
    githubUsername: `user-${id}`,
    stellarAddress: `G${id.padEnd(55, "X")}`,
    trustlineReady: readiness !== "not_ready",
    trustlineAuthorized: readiness !== "not_ready",
    verified: readiness === "ready",
    funded: readiness !== "not_ready",
    xlmBalance: "5",
    spendableXlmBalance: "4",
    lastCheckedAt: new Date().toISOString(),
    readiness,
  };
}

function mockMaintainer(id = "m-1", login = "maintainer") {
  // Operator role mirrors a team-configured deployment: requireOperator
  // gates these routes, and role-less maintainers fall back to viewer.
  vi.mocked(getServerSession).mockResolvedValue({
    user: { id, githubUsername: login, isMaintainer: true, role: "operator" },
  } as never);
}

function mockContributor(id = "u-1") {
  vi.mocked(getServerSession).mockResolvedValue({
    user: { id, isMaintainer: false },
  } as never);
}

function mockUnauthenticated() {
  vi.mocked(getServerSession).mockResolvedValue(null);
}

afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// GET /api/contributors — role enforcement
// ---------------------------------------------------------------------------
describe("GET /api/contributors — role enforcement", () => {
  it("returns 403 for unauthenticated requests", async () => {
    mockUnauthenticated();
    const req = new NextRequest("http://localhost:3000/api/contributors");
    const res = await getContributorsRoute(req);
    expect(res.status).toBe(403);
    expect(getContributors).not.toHaveBeenCalled();
  });

  it("returns 403 for contributor (non-maintainer) role", async () => {
    mockContributor();
    const req = new NextRequest("http://localhost:3000/api/contributors");
    const res = await getContributorsRoute(req);
    expect(res.status).toBe(403);
    expect(getContributors).not.toHaveBeenCalled();
  });

  it("returns 200 for maintainer role", async () => {
    mockMaintainer();
    vi.mocked(getContributors).mockResolvedValue({
      contributors: [makeContributor("1")],
      total: 1,
    });
    const req = new NextRequest("http://localhost:3000/api/contributors");
    const res = await getContributorsRoute(req);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/contributors — readiness filter (low_reserve focus)
// ---------------------------------------------------------------------------
describe("GET /api/contributors — readiness filter", () => {
  const fixtures = [
    makeContributor("1", "ready"),
    makeContributor("2", "low_reserve"),
    makeContributor("3", "not_ready"),
  ];

  it("returns all contributors when no filter is applied", async () => {
    mockMaintainer();
    vi.mocked(getContributors).mockResolvedValue({
      contributors: fixtures,
      total: fixtures.length,
    });
    const req = new NextRequest("http://localhost:3000/api/contributors");
    const json = await (await getContributorsRoute(req)).json();
    expect(json.contributors).toHaveLength(3);
    expect(json.total).toBe(3);
    expect(json.filtered).toBe(3);
    expect(json.readiness).toBeUndefined();
  });

  it("isolates low_reserve contributors via ?readiness=low_reserve", async () => {
    mockMaintainer();
    vi.mocked(getContributors).mockResolvedValue({
      contributors: fixtures,
      total: fixtures.length,
    });
    const req = new NextRequest(
      "http://localhost:3000/api/contributors?readiness=low_reserve"
    );
    const json = await (await getContributorsRoute(req)).json();
    expect(json.contributors).toHaveLength(1);
    expect(json.contributors[0].readiness).toBe("low_reserve");
    expect(json.readiness).toBe("low_reserve");
    expect(json.total).toBe(3);
    expect(json.filtered).toBe(1);
  });

  it("returns 400 for unknown readiness value", async () => {
    mockMaintainer();
    const req = new NextRequest(
      "http://localhost:3000/api/contributors?readiness=unknown"
    );
    const res = await getContributorsRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid readiness filter");
  });
});

// ---------------------------------------------------------------------------
// POST /api/contributors — batch recheck
// ---------------------------------------------------------------------------
describe("POST /api/contributors — batch recheck", () => {
  it("rejects cross-origin requests (CSRF)", async () => {
    const req = new NextRequest("http://localhost:3000/api/contributors", {
      method: "POST",
      headers: { origin: "https://attacker.com", host: "localhost:3000" },
    });
    const res = await postContributorsRoute(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("Invalid request origin");
    expect(getServerSession).not.toHaveBeenCalled();
  });

  it("returns 403 for non-maintainer on same-origin", async () => {
    mockContributor();
    const req = new NextRequest("http://localhost:3000/api/contributors", {
      method: "POST",
      headers: SAME_ORIGIN,
    });
    const res = await postContributorsRoute(req);
    expect(res.status).toBe(403);
    expect(refreshAllContributors).not.toHaveBeenCalled();
  });

  it("enqueues batch recheck and returns job metadata for maintainer", async () => {
    mockMaintainer();
    vi.mocked(backgroundQueue.enqueue).mockResolvedValue("job-batch-2");
    const req = new NextRequest("http://localhost:3000/api/contributors", {
      method: "POST",
      headers: SAME_ORIGIN,
    });
    const res = await postContributorsRoute(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.jobId).toBe("job-batch-2");
    expect(json.status).toBe("pending");
    expect(json.message).toMatch(/enqueued/i);
    expect(backgroundQueue.enqueue).toHaveBeenCalledWith(
      "recheck.batch",
      {},
      "m-1"
    );
    expect(refreshAllContributors).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/contributors/[id] — single recheck
// ---------------------------------------------------------------------------
describe("POST /api/contributors/[id] — single contributor recheck", () => {
  it("returns 403 when unauthenticated", async () => {
    mockUnauthenticated();
    const res = await recheckSingle(new Request("http://localhost:3000"), {
      params: { id: "reg-1" },
    });
    expect(res.status).toBe(403);
    expect(refreshContributor).not.toHaveBeenCalled();
  });

  it("returns 403 for contributor (non-maintainer) role", async () => {
    mockContributor();
    const res = await recheckSingle(new Request("http://localhost:3000"), {
      params: { id: "reg-1" },
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 when id param is empty", async () => {
    mockMaintainer();
    const res = await recheckSingle(new Request("http://localhost:3000"), {
      params: { id: "" },
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("required");
  });

  it("returns 404 when contributor does not exist", async () => {
    mockMaintainer();
    vi.mocked(refreshContributor).mockResolvedValue(null);
    const res = await recheckSingle(new Request("http://localhost:3000"), {
      params: { id: "nonexistent" },
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("not found");
  });

  it("returns 200 with refreshed contributor for maintainer", async () => {
    mockMaintainer();
    const contributor = makeContributor("reg-1", "ready");
    vi.mocked(refreshContributor).mockResolvedValue({
      contributor,
      diff: {
        registrationId: contributor.id,
        previousReadiness: "not_ready",
        newReadiness: "ready",
        changed: true,
      },
    });
    const res = await recheckSingle(new Request("http://localhost:3000"), {
      params: { id: "reg-1" },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.contributor.id).toBe("reg-1");
    expect(json.contributor.readiness).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// GET /api/audit — role enforcement
// ---------------------------------------------------------------------------
describe("GET /api/audit — role enforcement", () => {
  it("returns 403 for unauthenticated requests", async () => {
    mockUnauthenticated();
    const req = new NextRequest("http://localhost:3000/api/audit");
    const res = await getAudit(req);
    expect(res.status).toBe(403);
    expect(getRecentAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 for contributor (non-maintainer)", async () => {
    mockContributor();
    const req = new NextRequest("http://localhost:3000/api/audit");
    const res = await getAudit(req);
    expect(res.status).toBe(403);
  });

  it("returns 200 with entries for maintainer", async () => {
    mockMaintainer();
    vi.mocked(getRecentAuditLog).mockResolvedValue([
      {
        id: "log-1",
        action: "recheck.batch",
        actorId: "m-1",
        actorLogin: "maintainer",
        targetId: null,
        targetLabel: null,
        metadata: { refreshed: 3 },
        createdAt: new Date().toISOString(),
      },
    ]);
    const req = new NextRequest("http://localhost:3000/api/audit");
    const res = await getAudit(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.entries)).toBe(true);
    expect(json.entries[0].action).toBe("recheck.batch");
  });

  it("respects ?limit param and caps at max", async () => {
    mockMaintainer();
    vi.mocked(getRecentAuditLog).mockResolvedValue([]);
    const req = new NextRequest("http://localhost:3000/api/audit?limit=10");
    await getAudit(req);
    expect(getRecentAuditLog).toHaveBeenCalledWith(10);
  });

  it("uses default limit of 50 when not specified", async () => {
    mockMaintainer();
    vi.mocked(getRecentAuditLog).mockResolvedValue([]);
    const req = new NextRequest("http://localhost:3000/api/audit");
    await getAudit(req);
    expect(getRecentAuditLog).toHaveBeenCalledWith(50);
  });

  it("ignores invalid (non-numeric) limit and uses default", async () => {
    mockMaintainer();
    vi.mocked(getRecentAuditLog).mockResolvedValue([]);
    const req = new NextRequest("http://localhost:3000/api/audit?limit=abc");
    await getAudit(req);
    expect(getRecentAuditLog).toHaveBeenCalledWith(50);
  });
});
