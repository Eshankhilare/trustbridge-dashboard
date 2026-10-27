/**
 * API integration tests — auth roles, tokens, and edge cases (#45)
 *
 * Part 1: /api/register (GET + POST) and role-based access patterns
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/register/route";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/horizon", () => ({ checkStellarAddress: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: { findUnique: vi.fn(), findFirst: vi.fn(), upsert: vi.fn() },
    registrationConflict: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/stellar", () => ({ isValidStellarAddress: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn() }));

import { getServerSession } from "next-auth";
import { checkStellarAddress } from "@/lib/horizon";
import { prisma } from "@/lib/prisma";
import { isValidStellarAddress } from "@/lib/stellar";
import { resetRateLimit } from "@/lib/rate-limit";

// The register route rate-limits per IP with process-local state; reset
// between tests so POSTs from earlier tests cannot 429 later ones.
beforeEach(() => {
  resetRateLimit();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const SAME_ORIGIN = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

const CROSS_ORIGIN = {
  origin: "https://evil.com",
  host: "localhost:3000",
  "content-type": "application/json",
};

function postRegister(body: unknown, headers = SAME_ORIGIN) {
  return new NextRequest("http://localhost:3000/api/register", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function mockSession(opts: { id?: string; isMaintainer?: boolean } = {}) {
  vi.mocked(getServerSession).mockResolvedValue({
    user: { id: opts.id ?? "user-1", isMaintainer: opts.isMaintainer ?? false },
  } as never);
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

const VALID_ADDRESS = "GBSX" + "X".repeat(52);

afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// POST /api/register — CSRF
// ---------------------------------------------------------------------------
describe("POST /api/register — CSRF protection", () => {
  it("rejects cross-origin before touching session or DB", async () => {
    const res = await POST(postRegister({ stellarAddress: VALID_ADDRESS }, CROSS_ORIGIN));
    expect(res.status).toBe(403);
    expect(getServerSession).not.toHaveBeenCalled();
    expect(prisma.registration.findUnique).not.toHaveBeenCalled();
  });

  it("allows a request with no Origin/Referer (non-browser API client)", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const req = new NextRequest("http://localhost:3000/api/register", {
      method: "POST",
      headers: { host: "localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ stellarAddress: VALID_ADDRESS }),
    });
    const res = await POST(req);
    // Unauthenticated but CSRF passed — 401 not 403
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/register — auth
// ---------------------------------------------------------------------------
describe("POST /api/register — authentication", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await POST(postRegister({ stellarAddress: VALID_ADDRESS }));
    expect(res.status).toBe(401);
  });

  it("allows contributor (non-maintainer) to register", async () => {
    mockSession({ isMaintainer: false });
    vi.mocked(isValidStellarAddress).mockReturnValue(true);
    vi.mocked(prisma.registration.findFirst).mockResolvedValue(null);
    mockHorizonReady();
    vi.mocked(prisma.registration.upsert).mockResolvedValue({
      id: "reg-1",
      userId: "user-1",
      stellarAddress: VALID_ADDRESS,
      funded: true,
      trustlineReady: true,
      trustlineAuthorized: true,
      xlmBalance: "5",
      spendableXlmBalance: "4",
      lastCheckedAt: new Date(),
    } as never);

    const res = await POST(postRegister({ stellarAddress: VALID_ADDRESS }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.registration.stellarAddress).toBe(VALID_ADDRESS);
  });

  it("allows maintainer to register (no special block)", async () => {
    mockSession({ isMaintainer: true });
    vi.mocked(isValidStellarAddress).mockReturnValue(true);
    vi.mocked(prisma.registration.findFirst).mockResolvedValue(null);
    mockHorizonReady();
    vi.mocked(prisma.registration.upsert).mockResolvedValue({
      id: "reg-2",
      userId: "user-1",
      stellarAddress: VALID_ADDRESS,
      funded: true,
      trustlineReady: true,
      trustlineAuthorized: true,
      xlmBalance: "5",
      spendableXlmBalance: "4",
      lastCheckedAt: new Date(),
    } as never);

    const res = await POST(postRegister({ stellarAddress: VALID_ADDRESS }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/register — validation
// ---------------------------------------------------------------------------
describe("POST /api/register — input validation", () => {
  beforeEach(() => mockSession());

  it("returns 400 for missing address", async () => {
    const res = await POST(postRegister({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty string address", async () => {
    const res = await POST(postRegister({ stellarAddress: "   " }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid G-address", async () => {
    vi.mocked(isValidStellarAddress).mockReturnValue(false);
    const res = await POST(postRegister({ stellarAddress: "not-a-stellar-address" }));
    expect(res.status).toBe(400);
    expect(checkStellarAddress).not.toHaveBeenCalled();
  });

  it("returns 409 when address is already registered to another user", async () => {
    mockSession({ id: "user-2" });
    vi.mocked(isValidStellarAddress).mockReturnValue(true);
    vi.mocked(prisma.registration.findFirst).mockResolvedValue({
      id: "reg-existing",
      userId: "user-1", // different user
      stellarAddress: VALID_ADDRESS,
    } as never);

    const res = await POST(postRegister({ stellarAddress: VALID_ADDRESS }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("already registered");
  });

  it("allows re-registration to the same user (address update)", async () => {
    mockSession({ id: "user-1" });
    vi.mocked(isValidStellarAddress).mockReturnValue(true);
    vi.mocked(prisma.registration.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      id: "reg-1",
      userId: "user-1", // same user
      stellarAddress: VALID_ADDRESS,
    } as never);
    mockHorizonReady();
    vi.mocked(prisma.registration.upsert).mockResolvedValue({
      id: "reg-1",
      userId: "user-1",
      stellarAddress: VALID_ADDRESS,
      funded: true,
      trustlineReady: true,
      trustlineAuthorized: true,
      xlmBalance: "5",
      spendableXlmBalance: "4",
      lastCheckedAt: new Date(),
    } as never);

    const res = await POST(postRegister({ stellarAddress: VALID_ADDRESS }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/register — readiness propagation
// ---------------------------------------------------------------------------
describe("POST /api/register — readiness in response", () => {
  beforeEach(() => {
    mockSession();
    vi.mocked(isValidStellarAddress).mockReturnValue(true);
    vi.mocked(prisma.registration.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue(null);
  });

  it("reflects 'ready' when Horizon confirms funding + authorized trustline", async () => {
    mockHorizonReady();
    vi.mocked(prisma.registration.upsert).mockResolvedValue({
      id: "r1", userId: "user-1", stellarAddress: VALID_ADDRESS,
      funded: true, trustlineReady: true, trustlineAuthorized: true,
      xlmBalance: "5", spendableXlmBalance: "4", lastCheckedAt: new Date(),
    } as never);

    const json = await (await POST(postRegister({ stellarAddress: VALID_ADDRESS }))).json();
    expect(json.registration.readiness).toBe("ready");
    expect(json.registration.verified).toBe(true);
  });

  it("reflects 'low_reserve' when spendable XLM is below threshold", async () => {
    vi.mocked(checkStellarAddress).mockResolvedValue({
      funded: true, trustline: true, trustline_authorized: true,
      verified: true, xlm_balance: "1.5", spendable_xlm_balance: "0.1",
      errors: [], readiness: "low_reserve",
    } as never);
    vi.mocked(prisma.registration.upsert).mockResolvedValue({
      id: "r2", userId: "user-1", stellarAddress: VALID_ADDRESS,
      funded: true, trustlineReady: true, trustlineAuthorized: true,
      xlmBalance: "1.5", spendableXlmBalance: "0.1", lastCheckedAt: new Date(),
    } as never);

    const json = await (await POST(postRegister({ stellarAddress: VALID_ADDRESS }))).json();
    expect(json.registration.readiness).toBe("low_reserve");
  });

  it("reflects 'not_ready' for unauthorized trustline", async () => {
    vi.mocked(checkStellarAddress).mockResolvedValue({
      funded: true, trustline: true, trustline_authorized: false,
      verified: false, xlm_balance: "5", spendable_xlm_balance: "4",
      errors: [], readiness: "not_ready",
    } as never);
    vi.mocked(prisma.registration.upsert).mockResolvedValue({
      id: "r3", userId: "user-1", stellarAddress: VALID_ADDRESS,
      funded: true, trustlineReady: true, trustlineAuthorized: false,
      xlmBalance: "5", spendableXlmBalance: "4", lastCheckedAt: new Date(),
    } as never);

    const json = await (await POST(postRegister({ stellarAddress: VALID_ADDRESS }))).json();
    expect(json.registration.readiness).toBe("not_ready");
    expect(json.registration.verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/register
// ---------------------------------------------------------------------------
describe("GET /api/register", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns null registration when none exists yet", async () => {
    mockSession();
    vi.mocked(prisma.registration.findUnique).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.registration).toBeNull();
  });

  it("returns existing registration for authenticated user", async () => {
    mockSession({ id: "user-1" });
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      id: "reg-1",
      userId: "user-1",
      stellarAddress: VALID_ADDRESS,
      funded: true,
      trustlineReady: true,
    } as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.registration.stellarAddress).toBe(VALID_ADDRESS);
  });
});
