import { beforeEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/register/route";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/horizon", () => ({
  checkStellarAddress: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
    registrationConflict: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("@/lib/soroban-register", () => ({
  mirrorRegistrationToSoroban: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { checkStellarAddress } from "@/lib/horizon";
import { prisma } from "@/lib/prisma";
import { mirrorRegistrationToSoroban } from "@/lib/soroban-register";
import { resetRateLimit } from "@/lib/rate-limit";

const sameOriginHeaders: Record<string, string> = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function post(body: unknown, headers?: Record<string, string>) {
  return new NextRequest("http://localhost:3000/api/register", {
    method: "POST",
    headers: headers ?? sameOriginHeaders,
    body: JSON.stringify(body),
  });
}

describe("POST /api/register", () => {
  const validAddress =
    "GDXNXL25GDM3N5LAR5FALA3VSGHFET3EOKLXRP3ITPPMR3PISTQSKSFS";

  it("rejects cross-origin requests before touching session or DB", async () => {
    const r = post({ stellarAddress: "GBSX" }, {
      origin: "https://evil.com",
      host: "localhost:3000",
      "content-type": "application/json",
    });
    const res = await POST(r);
    expect(res.status).toBe(403);
    expect(getServerSession).not.toHaveBeenCalled();
    expect(prisma.registration.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 when same-origin but unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const r = post({ stellarAddress: "GBSX" });
    const res = await POST(r);
    expect(res.status).toBe(401);
  });

  it("returns 400 for empty address", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    const r = post({ stellarAddress: "" });
    const res = await POST(r);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("required");
    expect(json.validationErrors).toBeDefined();
  });

  it("returns 400 for invalid address format", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    const r = post({ stellarAddress: "SBSX7U7ARH74ENSCCX7FYTA5FS2YQXZHY737IBSZEOF72ULMITMZNKQ" });
    const res = await POST(r);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.validationErrors).toBeDefined();
    expect(checkStellarAddress).not.toHaveBeenCalled();
  });

  it("returns 200 for valid same-origin session registration", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", githubUsername: "gidson5" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue(null);
    vi.mocked(checkStellarAddress).mockResolvedValue({
      funded: true,
      trustline: true,
      xlm_balance: "2",
      readiness: "ready",
      horizon_error: null,
      trustline_authorized: true,
      verified: true,
      spendable_xlm_balance: "1.5",
      errors: [],
    } as any);
    vi.mocked(prisma.registration.upsert).mockResolvedValue({
      id: "reg-1",
      userId: "user-1",
      stellarAddress: validAddress,
      funded: true,
      trustlineReady: true,
      trustlineAuthorized: true,
      xlmBalance: "2",
      spendableXlmBalance: "1.5",
      lastCheckedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.mocked(mirrorRegistrationToSoroban).mockResolvedValue({
      success: true,
      errors: [],
    });

    const r = post({
      stellarAddress: validAddress,
    });
    const res = await POST(r);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.registration.stellarAddress).toBe(validAddress);
    expect(json.registration.walletProof.provider).toBe("Freighter");
    expect(json.registration.walletProof.challenge).toContain(
      "GitHub handle: @gidson5"
    );
    expect(json.registration.horizonDebug.summary).toContain("All Horizon");
    expect(mirrorRegistrationToSoroban).toHaveBeenCalled();
  });
});

// ── Issue #146: machine-readable error shape ───────────────────────────────

describe("POST /api/register — error codes", () => {
  const validAddress =
    "GDXNXL25GDM3N5LAR5FALA3VSGHFET3EOKLXRP3ITPPMR3PISTQSKSFS";
  const otherAddress =
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

  function signedIn(userId = "user-1") {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: userId, githubUsername: "contributor" },
    } as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // The route rate-limits per IP with process-local state; reset between
    // tests so earlier POSTs in this file cannot 429 later ones.
    resetRateLimit();
    vi.mocked(prisma.registration.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue(null as never);
    vi.mocked(checkStellarAddress).mockResolvedValue({
      funded: true,
      trustline: true,
      trustline_authorized: true,
      verified: true,
      xlm_balance: "10",
      spendable_xlm_balance: "8",
      usdc_balance: "0",
      errors: [],
      readiness: "ready",
    } as never);
    vi.mocked(mirrorRegistrationToSoroban).mockResolvedValue(undefined as never);
  });

  it("tags an unauthenticated request with UNAUTHORIZED", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null as never);

    const res = await POST(post({ stellarAddress: validAddress }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.code).toBe("UNAUTHORIZED");
    // The human-readable message is unchanged.
    expect(body.error).toBe("Unauthorized");
  });

  it("tags a malformed address with VALIDATION_FAILED", async () => {
    signedIn();

    const res = await POST(post({ stellarAddress: "not-an-address" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(Array.isArray(body.validationErrors)).toBe(true);
  });

  it("tags a contested address with ADDRESS_TAKEN", async () => {
    signedIn("user-1");
    // Someone else already holds it.
    vi.mocked(prisma.registration.findFirst).mockResolvedValue({
      id: "reg-9",
      userId: "user-2",
      stellarAddress: validAddress,
    } as never);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      id: "reg-9",
      userId: "user-2",
      stellarAddress: validAddress,
    } as never);

    const res = await POST(post({ stellarAddress: validAddress }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("ADDRESS_TAKEN");
    expect(body.error).toMatch(/already registered/i);
  });

  it("distinguishes ADDRESS_TAKEN from UNAUTHORIZED", async () => {
    // These are the two the client must never conflate: one is recoverable by
    // editing the form, the other by signing in again.
    vi.mocked(getServerSession).mockResolvedValue(null as never);
    const unauth = await (await POST(post({ stellarAddress: validAddress }))).json();

    vi.clearAllMocks();
    signedIn("user-1");
    vi.mocked(checkStellarAddress).mockResolvedValue({
      funded: true,
      trustline: true,
      trustline_authorized: true,
      verified: true,
      xlm_balance: "10",
      spendable_xlm_balance: "8",
      usdc_balance: "0",
      errors: [],
      readiness: "ready",
    } as never);
    vi.mocked(prisma.registration.findFirst).mockResolvedValue({
      id: "reg-9",
      userId: "user-2",
      stellarAddress: validAddress,
    } as never);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      id: "reg-9",
      userId: "user-2",
      stellarAddress: validAddress,
    } as never);
    const conflict = await (await POST(post({ stellarAddress: validAddress }))).json();

    expect(unauth.code).not.toBe(conflict.code);
  });

  it("maps a racing unique-constraint violation to 409, not 500", async () => {
    // Two writers pass the `findUnique` pre-check together; Postgres rejects
    // the loser at the index. The client can act on a conflict; it can do
    // nothing useful with a generic server error.
    signedIn("user-1");
    vi.mocked(prisma.registration.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.registration.upsert).mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
        meta: { target: ["stellarAddress"] },
      }) as never
    );

    const res = await POST(post({ stellarAddress: otherAddress }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("ADDRESS_TAKEN");
  });

  it("still returns SERVER_ERROR for unrelated failures", async () => {
    signedIn("user-1");
    vi.mocked(prisma.registration.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.registration.upsert).mockRejectedValue(
      new Error("connection reset") as never
    );

    const res = await POST(post({ stellarAddress: otherAddress }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe("SERVER_ERROR");
    // The cause stays in Sentry, not in the response.
    expect(JSON.stringify(body)).not.toMatch(/connection reset/);
  });

  it("persists a RegistrationConflict row when an address is already registered to another user", async () => {
    signedIn("user-attempting");
    vi.mocked(prisma.registration.findFirst).mockResolvedValue({
      id: "reg-existing",
      userId: "user-existing",
      stellarAddress: validAddress,
    } as never);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue(null as never);

    const res = await POST(post({ stellarAddress: validAddress }));
    expect(res.status).toBe(409);
    expect(prisma.registrationConflict.create).toHaveBeenCalledWith({
      data: {
        attemptedAddress: validAddress,
        attemptedUserId: "user-attempting",
        existingUserId: "user-existing",
      },
    });
  });
});

