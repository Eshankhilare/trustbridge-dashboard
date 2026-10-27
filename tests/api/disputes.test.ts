import { beforeEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST, PATCH } from "@/app/api/disputes/route";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    disputeProof: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    registration: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/analytics", () => ({
  trackServerDisputeOpened: vi.fn(),
  trackServerDisputeClosed: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import {
  trackServerDisputeClosed,
  trackServerDisputeOpened,
} from "@/lib/analytics";

beforeEach(() => {
  vi.clearAllMocks();
});

const sameOriginHeaders: Record<string, string> = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function request(
  method: string,
  body?: unknown,
  headers?: Record<string, string>
) {
  return new NextRequest("http://localhost:3000/api/disputes", {
    method,
    headers: headers ?? sameOriginHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("GET /api/disputes", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await GET(request("GET"));
    expect(res.status).toBe(401);
  });

  it("returns all disputes for maintainer", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    const mockDisputes = [
      {
        id: "d-1",
        registrationId: "r-1",
        reason: "Invalid address",
        proofCid: null,
        status: "OPEN",
        createdAt: new Date(),
        updatedAt: new Date(),
        resolvedAt: null,
      },
    ];
    vi.mocked(prisma.disputeProof.findMany).mockResolvedValue(mockDisputes);

    const res = await GET(request("GET"));
    expect(res.status).toBe(200);
    const json = await res.json();
    // Responses cross JSON serialization, so Dates arrive as ISO strings.
    expect(json.disputes).toEqual(JSON.parse(JSON.stringify(mockDisputes)));
  });

  it("returns only user's disputes for contributors", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: false },
    } as any);
    const mockDisputes = [
      {
        id: "d-1",
        registrationId: "r-1",
        reason: "Invalid address",
        proofCid: null,
        status: "OPEN",
        createdAt: new Date(),
        updatedAt: new Date(),
        resolvedAt: null,
      },
    ];
    vi.mocked(prisma.disputeProof.findMany).mockResolvedValue(mockDisputes);

    const res = await GET(request("GET"));
    expect(res.status).toBe(200);
    // Verify that the where clause includes registration filtering
    expect(prisma.disputeProof.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          registration: { userId: "user-1" },
        }),
      })
    );
  });

  it("filters by status parameter", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.disputeProof.findMany).mockResolvedValue([]);

    const url = new NextRequest("http://localhost:3000/api/disputes?status=VALIDATED", {
      method: "GET",
      headers: sameOriginHeaders,
    });

    const res = await GET(url);
    expect(res.status).toBe(200);
    expect(prisma.disputeProof.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "VALIDATED",
        }),
      })
    );
  });

  it("ignores invalid status parameter", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.disputeProof.findMany).mockResolvedValue([]);

    const url = new NextRequest("http://localhost:3000/api/disputes?status=INVALID", {
      method: "GET",
      headers: sameOriginHeaders,
    });

    const res = await GET(url);
    expect(res.status).toBe(200);
    // Status should not be in the where clause for invalid values
    expect(prisma.disputeProof.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({
          status: "INVALID",
        }),
      })
    );
  });

  it("returns pagination metadata with hasMore and nextCursor", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    const mockDisputes = [
      {
        id: "d-1",
        registrationId: "r-1",
        reason: "Invalid address",
        proofCid: null,
        status: "OPEN",
        createdAt: new Date(),
        updatedAt: new Date(),
        resolvedAt: null,
      },
    ];
    vi.mocked(prisma.disputeProof.findMany).mockResolvedValue(mockDisputes);

    const res = await GET(request("GET"));
    expect(res.status).toBe(200);
    const json = await res.json();
    // Responses cross JSON serialization, so Dates arrive as ISO strings.
    expect(json.disputes).toEqual(JSON.parse(JSON.stringify(mockDisputes)));
    expect(json.hasMore).toBe(false);
    expect(json.nextCursor).toBeUndefined();
  });

  it("supports limit parameter", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.disputeProof.findMany).mockResolvedValue([]);

    const url = new NextRequest("http://localhost:3000/api/disputes?limit=50", {
      method: "GET",
      headers: sameOriginHeaders,
    });

    const res = await GET(url);
    expect(res.status).toBe(200);
    expect(prisma.disputeProof.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 51,
      })
    );
  });

  it("caps limit at 100", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.disputeProof.findMany).mockResolvedValue([]);

    const url = new NextRequest("http://localhost:3000/api/disputes?limit=500", {
      method: "GET",
      headers: sameOriginHeaders,
    });

    const res = await GET(url);
    expect(res.status).toBe(200);
    expect(prisma.disputeProof.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 101,
      })
    );
  });

  it("uses default limit of 25 when not specified", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.disputeProof.findMany).mockResolvedValue([]);

    const res = await GET(request("GET"));
    expect(res.status).toBe(200);
    expect(prisma.disputeProof.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 26,
      })
    );
  });

  it("supports cursor-based pagination", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.disputeProof.findMany).mockResolvedValue([]);

    const cursor = Buffer.from("d-1").toString("base64");
    const url = new NextRequest(`http://localhost:3000/api/disputes?cursor=${cursor}`, {
      method: "GET",
      headers: sameOriginHeaders,
    });

    const res = await GET(url);
    expect(res.status).toBe(200);
    expect(prisma.disputeProof.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "d-1" },
        skip: 1,
      })
    );
  });

  it("returns hasMore and nextCursor when more results exist", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    const manyResults = Array.from({ length: 26 }, (_, i) => ({
      id: `d-${i}`,
      registrationId: `r-${i}`,
      reason: `Reason ${i}`,
      proofCid: null,
      status: "OPEN" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
      resolvedAt: null,
    }));
    vi.mocked(prisma.disputeProof.findMany).mockResolvedValue(manyResults);

    const res = await GET(request("GET"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.hasMore).toBe(true);
    expect(json.nextCursor).toBeDefined();
    expect(json.disputes).toHaveLength(25);
  });
});

describe("POST /api/disputes", () => {
  it("returns 403 for cross-origin requests before checking session", async () => {
    const r = request("POST", { registrationId: "r-1", reason: "test" }, {
      origin: "https://evil.com",
      host: "localhost:3000",
      "content-type": "application/json",
    });
    const res = await POST(r);
    expect(res.status).toBe(403);
    expect(getServerSession).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await POST(request("POST", { registrationId: "r-1", reason: "test" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing required fields", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: false },
    } as any);

    const res = await POST(request("POST", { registrationId: "" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid");
  });

  it("returns 400 for reason exceeding max length", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: false },
    } as any);

    const longReason = "a".repeat(2001);
    const res = await POST(
      request("POST", { registrationId: "r-1", reason: longReason })
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 if user doesn't own registration and isn't maintainer", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: false },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      id: "r-1",
      userId: "user-2",
    });

    const res = await POST(
      request("POST", { registrationId: "r-1", reason: "test" })
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 if dispute already exists for registration", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: false },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      id: "r-1",
      userId: "user-1",
    });
    vi.mocked(prisma.disputeProof.findUnique).mockResolvedValue({
      id: "d-1",
    });

    const res = await POST(
      request("POST", { registrationId: "r-1", reason: "test" })
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("already exists");
  });

  it("allows maintainer to file dispute for any registration", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      id: "r-1",
      userId: "user-2",
    });
    vi.mocked(prisma.disputeProof.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.disputeProof.create).mockResolvedValue({
      id: "d-1",
      registrationId: "r-1",
      reason: "test",
      proofCid: null,
      status: "OPEN",
      createdAt: new Date(),
    });

    const res = await POST(
      request("POST", { registrationId: "r-1", reason: "test" })
    );
    expect(res.status).toBe(201);
    expect(prisma.disputeProof.create).toHaveBeenCalled();
  });

  it("creates dispute successfully with optional proofCid", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: false },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      id: "r-1",
      userId: "user-1",
    });
    vi.mocked(prisma.disputeProof.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.disputeProof.create).mockResolvedValue({
      id: "d-1",
      registrationId: "r-1",
      reason: "Invalid address",
      proofCid: "Qm12345",
      status: "OPEN",
      createdAt: new Date(),
    });

    const res = await POST(
      request("POST", {
        registrationId: "r-1",
        reason: "Invalid address",
        proofCid: "Qm12345",
      })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.dispute.proofCid).toBe("Qm12345");
    expect(trackServerDisputeOpened).toHaveBeenCalledWith({
      userId: "user-1",
      disputeId: "d-1",
      registrationId: "r-1",
      actorRole: "contributor",
      hasProof: true,
    });
  });
});

describe("PATCH /api/disputes", () => {
  it("returns 403 for cross-origin requests before checking session", async () => {
    const r = request(
      "PATCH",
      { disputeId: "d-1", status: "VALIDATED" },
      {
        origin: "https://evil.com",
        host: "localhost:3000",
        "content-type": "application/json",
      }
    );
    const res = await PATCH(r);
    expect(res.status).toBe(403);
    expect(getServerSession).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await PATCH(
      request("PATCH", { disputeId: "d-1", status: "VALIDATED" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 if user is not a maintainer", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: false },
    } as any);

    const res = await PATCH(
      request("PATCH", { disputeId: "d-1", status: "VALIDATED" })
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid status", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);

    const res = await PATCH(
      request("PATCH", { disputeId: "d-1", status: "INVALID" })
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 if dispute not found", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.disputeProof.findUnique).mockResolvedValue(null);

    const res = await PATCH(
      request("PATCH", { disputeId: "d-1", status: "VALIDATED" })
    );
    expect(res.status).toBe(404);
  });

  it("updates dispute status to VALIDATED", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.disputeProof.findUnique).mockResolvedValue({
      id: "d-1",
      status: "OPEN",
    });
    vi.mocked(prisma.disputeProof.update).mockResolvedValue({
      id: "d-1",
      registrationId: "r-1",
      reason: "Invalid address",
      proofCid: null,
      status: "VALIDATED",
      createdAt: new Date(),
      updatedAt: new Date(),
      resolvedAt: new Date(),
    });

    const res = await PATCH(
      request("PATCH", { disputeId: "d-1", status: "VALIDATED" })
    );
    expect(res.status).toBe(200);
    expect(prisma.disputeProof.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "VALIDATED",
          resolvedAt: expect.any(Date),
        }),
      })
    );
    expect(trackServerDisputeClosed).toHaveBeenCalledWith({
      userId: "user-1",
      disputeId: "d-1",
      status: "VALIDATED",
    });
  });

  it("updates dispute status to REJECTED", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.disputeProof.findUnique).mockResolvedValue({
      id: "d-1",
      status: "OPEN",
    });
    vi.mocked(prisma.disputeProof.update).mockResolvedValue({
      id: "d-1",
      registrationId: "r-1",
      reason: "Invalid address",
      proofCid: null,
      status: "REJECTED",
      createdAt: new Date(),
      updatedAt: new Date(),
      resolvedAt: new Date(),
    });

    const res = await PATCH(
      request("PATCH", { disputeId: "d-1", status: "REJECTED" })
    );
    expect(res.status).toBe(200);
    expect(prisma.disputeProof.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "REJECTED",
          resolvedAt: expect.any(Date),
        }),
      })
    );
  });

  it("does not track another close event when the dispute was already closed", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.disputeProof.findUnique).mockResolvedValue({
      id: "d-1",
      status: "VALIDATED",
    });
    vi.mocked(prisma.disputeProof.update).mockResolvedValue({
      id: "d-1",
      registrationId: "r-1",
      reason: "Invalid address",
      proofCid: null,
      status: "REJECTED",
      createdAt: new Date(),
      updatedAt: new Date(),
      resolvedAt: new Date(),
    });

    const res = await PATCH(
      request("PATCH", { disputeId: "d-1", status: "REJECTED" })
    );

    expect(res.status).toBe(200);
    expect(trackServerDisputeClosed).not.toHaveBeenCalled();
  });
});
