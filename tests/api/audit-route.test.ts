/**
 * Tests for GET /api/audit
 *
 * Covers:
 *  - 403 when no maintainer session
 *  - Default limit (50) when no `limit` query param
 *  - Custom limit passed via query param
 *  - Capped at 200 (library-enforced max)
 *  - Response payload includes both `entries` and the `summary` from
 *    summarizeAuditLog (total + byAction counts)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that use the mocked modules
// ---------------------------------------------------------------------------

vi.mock("@/lib/api-auth", () => ({
  requireOperator: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  getRecentAuditLog: vi.fn(),
}));

// audit-format has no server-only import and is pure logic; we let it run
// for real so the summary assertions exercise the actual summariseAuditLog
// implementation rather than a stub.

import { requireOperator } from "@/lib/api-auth";
import { getRecentAuditLog } from "@/lib/audit";
import type { AuditLogEntry } from "@/types";
import type { Session } from "next-auth";

import { GET } from "@/app/api/audit/route";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MAINTAINER_SESSION: Session = {
  user: {
    id: "maintainer-1",
    githubUsername: "admin-user",
    isMaintainer: true,
    role: "admin",
  },
  expires: "2099-01-01T00:00:00.000Z",
} as Session;

function makeEntry(
  id: string,
  action: string,
  overrides?: Partial<AuditLogEntry>
): AuditLogEntry {
  return {
    id,
    actorId: "user-1",
    actorLogin: "tester",
    action,
    targetId: null,
    targetLabel: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Build a list of n entries all with the same action. */
function makeEntries(count: number, action = "recheck.single"): AuditLogEntry[] {
  return Array.from({ length: count }, (_, i) => makeEntry(`id-${i}`, action));
}

function request(url: string) {
  return new NextRequest(url, { method: "GET" });
}

// ---------------------------------------------------------------------------
// Auth gating
// ---------------------------------------------------------------------------

describe("GET /api/audit — auth gating", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 403 when there is no session at all", async () => {
    vi.mocked(requireOperator).mockResolvedValue(null);

    const res = await GET(request("http://localhost/api/audit"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("does NOT call getRecentAuditLog when auth fails", async () => {
    vi.mocked(requireOperator).mockResolvedValue(null);

    await GET(request("http://localhost/api/audit"));
    expect(getRecentAuditLog).not.toHaveBeenCalled();
  });

  it("proceeds for a valid maintainer session", async () => {
    vi.mocked(requireOperator).mockResolvedValue(MAINTAINER_SESSION);
    vi.mocked(getRecentAuditLog).mockResolvedValue([]);

    const res = await GET(request("http://localhost/api/audit"));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Pagination / limit behaviour
// ---------------------------------------------------------------------------

describe("GET /api/audit — limit behaviour", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the default limit of 50 when no limit param is provided", async () => {
    vi.mocked(requireOperator).mockResolvedValue(MAINTAINER_SESSION);
    vi.mocked(getRecentAuditLog).mockResolvedValue(makeEntries(50));

    await GET(request("http://localhost/api/audit"));
    expect(getRecentAuditLog).toHaveBeenCalledWith(50);
  });

  it("passes a custom limit when the limit param is a positive integer", async () => {
    vi.mocked(requireOperator).mockResolvedValue(MAINTAINER_SESSION);
    vi.mocked(getRecentAuditLog).mockResolvedValue(makeEntries(10));

    await GET(request("http://localhost/api/audit?limit=10"));
    expect(getRecentAuditLog).toHaveBeenCalledWith(10);
  });

  it("uses the default when the limit param is 0 (invalid)", async () => {
    vi.mocked(requireOperator).mockResolvedValue(MAINTAINER_SESSION);
    vi.mocked(getRecentAuditLog).mockResolvedValue(makeEntries(50));

    await GET(request("http://localhost/api/audit?limit=0"));
    // limit=0 is not > 0, so the route falls back to 50
    expect(getRecentAuditLog).toHaveBeenCalledWith(50);
  });

  it("uses the default when the limit param is negative", async () => {
    vi.mocked(requireOperator).mockResolvedValue(MAINTAINER_SESSION);
    vi.mocked(getRecentAuditLog).mockResolvedValue(makeEntries(50));

    await GET(request("http://localhost/api/audit?limit=-5"));
    expect(getRecentAuditLog).toHaveBeenCalledWith(50);
  });

  it("uses the default when the limit param is non-numeric", async () => {
    vi.mocked(requireOperator).mockResolvedValue(MAINTAINER_SESSION);
    vi.mocked(getRecentAuditLog).mockResolvedValue(makeEntries(50));

    await GET(request("http://localhost/api/audit?limit=abc"));
    expect(getRecentAuditLog).toHaveBeenCalledWith(50);
  });

  it("passes limit=200 when explicitly requested (library-enforced ceiling)", async () => {
    vi.mocked(requireOperator).mockResolvedValue(MAINTAINER_SESSION);
    vi.mocked(getRecentAuditLog).mockResolvedValue(makeEntries(200));

    await GET(request("http://localhost/api/audit?limit=200"));
    expect(getRecentAuditLog).toHaveBeenCalledWith(200);
  });

  it("passes limit=300 as-is to getRecentAuditLog (the lib caps at 200 internally)", async () => {
    // The route itself does not re-cap; getRecentAuditLog owns that boundary.
    vi.mocked(requireOperator).mockResolvedValue(MAINTAINER_SESSION);
    vi.mocked(getRecentAuditLog).mockResolvedValue(makeEntries(200));

    await GET(request("http://localhost/api/audit?limit=300"));
    expect(getRecentAuditLog).toHaveBeenCalledWith(300);
  });
});

// ---------------------------------------------------------------------------
// Response payload — entries + summary
// ---------------------------------------------------------------------------

describe("GET /api/audit — response payload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns an entries array in the response", async () => {
    const entries = makeEntries(3, "registration.create");
    vi.mocked(requireOperator).mockResolvedValue(MAINTAINER_SESSION);
    vi.mocked(getRecentAuditLog).mockResolvedValue(entries);

    const res = await GET(request("http://localhost/api/audit"));
    const body = await res.json();

    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries).toHaveLength(3);
  });

  it("includes a summary object with a total count", async () => {
    const entries = makeEntries(7, "recheck.single");
    vi.mocked(requireOperator).mockResolvedValue(MAINTAINER_SESSION);
    vi.mocked(getRecentAuditLog).mockResolvedValue(entries);

    const res = await GET(request("http://localhost/api/audit"));
    const body = await res.json();

    expect(body.summary).toBeDefined();
    expect(body.summary.total).toBe(7);
  });

  it("summary.byAction counts actions correctly", async () => {
    const entries = [
      ...makeEntries(3, "registration.create"),
      ...makeEntries(2, "recheck.single"),
      ...makeEntries(1, "export.csv"),
    ];
    vi.mocked(requireOperator).mockResolvedValue(MAINTAINER_SESSION);
    vi.mocked(getRecentAuditLog).mockResolvedValue(entries);

    const res = await GET(request("http://localhost/api/audit"));
    const body = await res.json();

    expect(body.summary.byAction["registration.create"]).toBe(3);
    expect(body.summary.byAction["recheck.single"]).toBe(2);
    expect(body.summary.byAction["export.csv"]).toBe(1);
  });

  it("returns total=0 and empty byAction when there are no entries", async () => {
    vi.mocked(requireOperator).mockResolvedValue(MAINTAINER_SESSION);
    vi.mocked(getRecentAuditLog).mockResolvedValue([]);

    const res = await GET(request("http://localhost/api/audit"));
    const body = await res.json();

    expect(body.entries).toHaveLength(0);
    expect(body.summary.total).toBe(0);
    expect(body.summary.byAction).toEqual({});
  });

  it("each entry has the expected shape (id, action, actorId, createdAt)", async () => {
    const entry = makeEntry("e-1", "registration.update", {
      actorId: "user-42",
      actorLogin: "alice",
      targetId: "reg-7",
      targetLabel: "GABCDE",
    });
    vi.mocked(requireOperator).mockResolvedValue(MAINTAINER_SESSION);
    vi.mocked(getRecentAuditLog).mockResolvedValue([entry]);

    const res = await GET(request("http://localhost/api/audit"));
    const body = await res.json();
    const returned = body.entries[0];

    expect(returned.id).toBe("e-1");
    expect(returned.action).toBe("registration.update");
    expect(returned.actorId).toBe("user-42");
    expect(returned.actorLogin).toBe("alice");
    expect(returned.targetId).toBe("reg-7");
    expect(returned.targetLabel).toBe("GABCDE");
    expect(typeof returned.createdAt).toBe("string");
  });
});
