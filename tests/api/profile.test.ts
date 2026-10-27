import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET as getPublicProfile } from "@/app/api/profile/[username]/route";
import { GET as getPrivacySettings, PATCH as patchPrivacySettings } from "@/app/api/profile/route";
import { resetRateLimit } from "@/lib/rate-limit";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    registration: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sameOrigin = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function getProfile(username: string) {
  return new NextRequest(`http://localhost:3000/api/profile/${username}`, {
    method: "GET",
    headers: { "x-forwarded-for": "1.2.3.4" },
  });
}

function patchSettings(body: unknown) {
  return new NextRequest("http://localhost:3000/api/profile", {
    method: "PATCH",
    headers: sameOrigin,
    body: JSON.stringify(body),
  });
}

const readyRegistration = {
  profilePublic: true,
  showStellarAddress: false,
  stellarAddress: "GDXNXL25GDM3N5LAR5FALA3VSGHFET3EOKLXRP3ITPPMR3PISTQSKSFS",
  funded: true,
  trustlineReady: true,
  trustlineAuthorized: true,
  xlmBalance: "10",
  spendableXlmBalance: "8",
  lastCheckedAt: new Date("2026-08-01"),
  deletedAt: null,
};

// ---------------------------------------------------------------------------
// GET /api/profile/[username] — public profile
// ---------------------------------------------------------------------------
describe("GET /api/profile/[username]", () => {
  beforeEach(() => {
    resetRateLimit();
    vi.clearAllMocks();
  });

  it("returns 404 when user does not exist", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const res = await getPublicProfile(getProfile("nobody"), {
      params: { username: "nobody" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when registration is private (profilePublic=false)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      githubUsername: "alice",
      registration: { ...readyRegistration, profilePublic: false },
    } as any);
    const res = await getPublicProfile(getProfile("alice"), {
      params: { username: "alice" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when registration is soft-deleted", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      githubUsername: "alice",
      registration: { ...readyRegistration, deletedAt: new Date() },
    } as any);
    const res = await getPublicProfile(getProfile("alice"), {
      params: { username: "alice" },
    });
    expect(res.status).toBe(404);
  });

  it("returns public profile without stellarAddress when showStellarAddress=false", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      githubUsername: "alice",
      registration: { ...readyRegistration, showStellarAddress: false },
    } as any);
    const res = await getPublicProfile(getProfile("alice"), {
      params: { username: "alice" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.githubUsername).toBe("alice");
    expect(body.profile.readiness).toBe("ready");
    expect(body.profile.stellarAddress).toBeNull();
  });

  it("includes stellarAddress when showStellarAddress=true", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      githubUsername: "alice",
      registration: { ...readyRegistration, showStellarAddress: true },
    } as any);
    const res = await getPublicProfile(getProfile("alice"), {
      params: { username: "alice" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.stellarAddress).toBe(readyRegistration.stellarAddress);
  });

  it("returns 404 for invalid username format", async () => {
    const res = await getPublicProfile(getProfile("a".repeat(40)), {
      params: { username: "a".repeat(40) },
    });
    expect(res.status).toBe(404);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limit is exceeded", async () => {
    // Exhaust the 30 req/min limit
    for (let i = 0; i < 30; i++) {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
      await getPublicProfile(
        new NextRequest(`http://localhost:3000/api/profile/nobody`, {
          method: "GET",
          headers: { "x-forwarded-for": "9.9.9.9" },
        }),
        { params: { username: "nobody" } }
      );
    }
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const res = await getPublicProfile(
      new NextRequest(`http://localhost:3000/api/profile/nobody`, {
        method: "GET",
        headers: { "x-forwarded-for": "9.9.9.9" },
      }),
      { params: { username: "nobody" } }
    );
    expect(res.status).toBe(429);
  });

  it("sets Cache-Control: public on a valid profile", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      githubUsername: "alice",
      registration: readyRegistration,
    } as any);
    const res = await getPublicProfile(getProfile("alice"), {
      params: { username: "alice" },
    });
    expect(res.headers.get("Cache-Control")).toContain("public");
  });
});

// ---------------------------------------------------------------------------
// GET /api/profile — authenticated privacy settings
// ---------------------------------------------------------------------------
describe("GET /api/profile (own settings)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await getPrivacySettings();
    expect(res.status).toBe(401);
  });

  it("returns default settings when no registration exists", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "u1" } } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue(null);
    const res = await getPrivacySettings();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual({ profilePublic: false, showStellarAddress: false });
  });

  it("returns stored settings when registration exists", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "u1" } } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      profilePublic: true,
      showStellarAddress: false,
      deletedAt: null,
    } as any);
    const res = await getPrivacySettings();
    const body = await res.json();
    expect(body.settings).toEqual({ profilePublic: true, showStellarAddress: false });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/profile — update privacy settings
// ---------------------------------------------------------------------------
describe("PATCH /api/profile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 403 when cross-origin", async () => {
    const res = await patchPrivacySettings(
      new NextRequest("http://localhost:3000/api/profile", {
        method: "PATCH",
        headers: { origin: "https://evil.com", host: "localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ profilePublic: true, showStellarAddress: false }),
      })
    );
    expect(res.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await patchPrivacySettings(patchSettings({ profilePublic: true, showStellarAddress: false }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid body", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "u1" } } as any);
    const res = await patchPrivacySettings(patchSettings({ profilePublic: "yes" }));
    expect(res.status).toBe(400);
  });

  it("coerces showStellarAddress to false when profilePublic=false", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "u1", githubUsername: "alice" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      id: "r1",
      deletedAt: null,
    } as any);
    vi.mocked(prisma.registration.update).mockResolvedValue({} as any);

    const res = await patchPrivacySettings(
      new NextRequest("http://localhost:3000/api/profile", {
        method: "PATCH",
        headers: sameOrigin,
        body: JSON.stringify({ profilePublic: false, showStellarAddress: true }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // showStellarAddress must be coerced to false
    expect(body.settings.showStellarAddress).toBe(false);

    expect(prisma.registration.update).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: { profilePublic: false, showStellarAddress: false },
    });
  });

  it("returns 404 when user has no active registration", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "u1" } } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue(null);

    const res = await patchPrivacySettings(
      new NextRequest("http://localhost:3000/api/profile", {
        method: "PATCH",
        headers: sameOrigin,
        body: JSON.stringify({ profilePublic: true, showStellarAddress: false }),
      })
    );
    expect(res.status).toBe(404);
  });

  it("updates settings and returns them", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "u1", githubUsername: "alice" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      id: "r1",
      deletedAt: null,
    } as any);
    vi.mocked(prisma.registration.update).mockResolvedValue({} as any);

    const res = await patchPrivacySettings(
      new NextRequest("http://localhost:3000/api/profile", {
        method: "PATCH",
        headers: sameOrigin,
        body: JSON.stringify({ profilePublic: true, showStellarAddress: true }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual({ profilePublic: true, showStellarAddress: true });
  });
});
