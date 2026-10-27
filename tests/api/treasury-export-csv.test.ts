import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-auth", () => ({
  requireOperator: vi.fn(),
}));
vi.mock("@/lib/api-key-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api-key-auth")>();
  return {
    ...actual,
    API_KEY_RATE_LIMIT: { maxRequests: 60 },
    buildRateLimitHeaders: vi.fn().mockReturnValue({}),
    authenticateApiKey: vi.fn(),
  };
});
vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import { POST } from "@/app/api/treasury/export/route";
import { requireOperator } from "@/lib/api-auth";
import { authenticateApiKey } from "@/lib/api-key-auth";
import { prisma } from "@/lib/prisma";

const session = {
  user: { id: "operator-1", githubUsername: "operator" },
};

function request(body: unknown, origin = "http://localhost:3000") {
  return new NextRequest("http://localhost:3000/api/treasury/export", {
    method: "POST",
    headers: {
      origin,
      host: "localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/treasury/export CSV", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    vi.mocked(prisma.registration.count).mockResolvedValue(1);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([
      {
        stellarAddress: "GABC",
        funded: true,
        trustlineReady: true,
        trustlineAuthorized: true,
        xlmBalance: "10",
        spendableXlmBalance: "9",
        lastCheckedAt: new Date(),
        user: { githubUsername: 'payee,"primary"\nsecondary' },
      },
    ] as never);
  });

  it("returns a quoted CSV attachment for an authorized operator", async () => {
    vi.mocked(requireOperator).mockResolvedValue(session as never);

    const response = await POST(request({ format: "csv", allowStale: true }));
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv;charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="treasury-export-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(csv).toContain('"payee,""primary""\nsecondary"');
    expect(csv).toContain('"stellar_address"');
  });

  it("rejects cross-origin requests before authorization", async () => {
    const response = await POST(
      request({ format: "csv" }, "https://attacker.example")
    );

    expect(response.status).toBe(403);
    expect(requireOperator).not.toHaveBeenCalled();
    expect(authenticateApiKey).not.toHaveBeenCalled();
  });

  it("rejects callers without an operator session or export API key", async () => {
    vi.mocked(requireOperator).mockResolvedValue(null);
    vi.mocked(authenticateApiKey).mockResolvedValue(null);

    const response = await POST(request({ format: "csv" }));

    expect(response.status).toBe(401);
  });

  it("returns a header-only CSV when the roster is empty", async () => {
    vi.mocked(requireOperator).mockResolvedValue(session as never);
    vi.mocked(prisma.registration.count).mockResolvedValue(0);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([]);

    const response = await POST(request({ format: "csv", allowStale: true }));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('"github_username"');
  });
});