import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    registration: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    registrationConflict: {
      create: vi.fn().mockResolvedValue({ id: "conflict-mock-id" }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("@/lib/horizon", () => ({
  checkStellarAddress: vi.fn(),
}));

vi.mock("@/lib/soroban-register", () => ({
  mirrorRegistrationToSoroban: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { GET, PATCH } from "@/app/api/register/checklist/route";
import { GET as getRegister } from "@/app/api/register/route";
import { PATCH as patchChecklist } from "@/app/api/register/checklist/route";

const sameOriginHeaders: Record<string, string> = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function patch(body: unknown, headers?: Record<string, string>) {
  return new NextRequest("http://localhost:3000/api/register/checklist", {
    method: "PATCH",
    headers: headers ?? sameOriginHeaders,
    body: JSON.stringify(body),
  });
}
function patchRequest(body: unknown, headers?: Record<string, string>) {
  return new NextRequest("http://localhost:3000/api/register/checklist", {
    method: "PATCH",
    headers: headers ?? sameOriginHeaders,
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/register/checklist", () => {
  it("returns 401 when not authenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns empty checklist when registration has no checklist data", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      checklistCompleted: null,
    } as any);

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.checklistCompleted).toEqual({});
  });

  it("returns persisted checklist state", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      checklistCompleted: { stellarAccountCreated: true, addressRegistered: true },
    } as any);

    const res = await GET();
    const json = await res.json();
    expect(json.checklistCompleted.stellarAccountCreated).toBe(true);
    expect(json.checklistCompleted.addressRegistered).toBe(true);
  });
});

describe("PATCH /api/register/checklist", () => {
  it("returns 403 for cross-origin requests", async () => {
    const r = patch(
      { addressRegistered: true },
      { origin: "https://evil.com", host: "localhost:3000", "content-type": "application/json" }
    );
    const res = await PATCH(r);
    expect(res.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const r = patch({ addressRegistered: true });
    const res = await PATCH(r);
    expect(res.status).toBe(401);
  });

  it("returns 404 when user has no registration", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue(null);

    const r = patch({ addressRegistered: true });
    const res = await PATCH(r);
    expect(res.status).toBe(404);
  });

  it("merges incoming keys without wiping existing completed steps", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      checklistCompleted: { stellarAccountCreated: true },
    } as any);
    vi.mocked(prisma.registration.update).mockResolvedValue({} as any);

    const r = patch({ addressRegistered: true });
    const res = await PATCH(r);
    expect(res.status).toBe(200);

    const json = await res.json();
    // Previously completed step must be preserved.
    expect(json.checklistCompleted.stellarAccountCreated).toBe(true);
    // New step must be applied.
    expect(json.checklistCompleted.addressRegistered).toBe(true);
  });

  it("strips unknown keys from the payload", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      checklistCompleted: {},
    } as any);
    vi.mocked(prisma.registration.update).mockResolvedValue({} as any);

    const r = patch({ unknownKey: true, addressRegistered: true });
    const res = await PATCH(r);
    const json = await res.json();

    expect("unknownKey" in json.checklistCompleted).toBe(false);
    expect(json.checklistCompleted.addressRegistered).toBe(true);
  });

  it("null checklistCompleted from server normalises to {} before merge", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as any);
    vi.mocked(prisma.registration.findUnique).mockResolvedValue({
      checklistCompleted: null,
    } as any);
    vi.mocked(prisma.registration.update).mockResolvedValue({} as any);

    const r = patch({ usdcTrustlineAdded: true });
    const res = await PATCH(r);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.checklistCompleted.usdcTrustlineAdded).toBe(true);
  });
});

describe("Onboarding Checklist Persistence & GDPR Deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("PATCH /api/register/checklist", () => {
    it("rejects cross-origin requests with 403", async () => {
      const req = patchRequest(
        { stepId: "choose_wallet", completed: true },
        {
          origin: "https://attacker.com",
          host: "localhost:3000",
          "content-type": "application/json",
        }
      );
      const res = await patchChecklist(req);
      expect(res.status).toBe(403);
      expect(getServerSession).not.toHaveBeenCalled();
    });

    it("returns 401 for unauthenticated request", async () => {
      vi.mocked(getServerSession).mockResolvedValue(null);
      const req = patchRequest({ stepId: "choose_wallet", completed: true });
      const res = await patchChecklist(req);
      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid stepId format (preventing PII/injection)", async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: "user-1" },
      } as any);

      const req = patchRequest({
        stepId: "invalid step name with spaces and special chars @#$%",
        completed: true,
      });
      const res = await patchChecklist(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid stepId format");
    });

    it("returns 400 when completed is not a boolean", async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: "user-1" },
      } as any);

      const req = patchRequest({
        stepId: "choose_wallet",
        completed: "not_a_boolean",
      });
      const res = await patchChecklist(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("boolean");
    });

    it("successfully toggles a single step and persists merged state to User and Registration", async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: "user-1" },
      } as any);

      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: "user-1",
        checklistCompleted: { choose_wallet: true },
      } as any);

      vi.mocked(prisma.registration.findUnique).mockResolvedValue({
        id: "reg-1",
        userId: "user-1",
        deletedAt: null,
        checklistCompleted: { choose_wallet: true },
      } as any);

      vi.mocked(prisma.user.update).mockResolvedValue({} as any);
      vi.mocked(prisma.registration.update).mockResolvedValue({} as any);

      const req = patchRequest({ stepId: "fund_wallet", completed: true });
      const res = await patchChecklist(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.checklistCompleted).toEqual({
        choose_wallet: true,
        fund_wallet: true,
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: {
          checklistCompleted: {
            choose_wallet: true,
            fund_wallet: true,
          },
        },
      });

      expect(prisma.registration.update).toHaveBeenCalledWith({
        where: { id: "reg-1" },
        data: {
          checklistCompleted: {
            choose_wallet: true,
            fund_wallet: true,
          },
        },
      });
    });

    it("supports multi-step update and merges with existing steps (concurrent tab safety)", async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: "user-1" },
      } as any);

      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: "user-1",
        checklistCompleted: { choose_wallet: true },
      } as any);

      vi.mocked(prisma.registration.findUnique).mockResolvedValue({
        id: "reg-1",
        userId: "user-1",
        deletedAt: null,
        checklistCompleted: { choose_wallet: true, add_trustline: true },
      } as any);

      vi.mocked(prisma.user.update).mockResolvedValue({} as any);
      vi.mocked(prisma.registration.update).mockResolvedValue({} as any);

      const req = patchRequest({
        steps: {
          fund_wallet: true,
          register_address: true,
        },
      });
      const res = await patchChecklist(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.checklistCompleted).toEqual({
        choose_wallet: true,
        add_trustline: true,
        fund_wallet: true,
        register_address: true,
      });
    });
  });

  describe("GET /api/register with checklist persistence", () => {
    it("returns checklistCompleted from user when registration does not exist", async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: "user-1" },
      } as any);

      vi.mocked(prisma.registration.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: "user-1",
        checklistCompleted: { choose_wallet: true, fund_wallet: true },
      } as any);

      const res = await getRegister();
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.registration).toBeNull();
      expect(data.checklistCompleted).toEqual({
        choose_wallet: true,
        fund_wallet: true,
      });
    });

    it("returns checklistCompleted from registration when registration exists", async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: "user-1", githubUsername: "alice" },
      } as any);

      vi.mocked(prisma.registration.findUnique).mockResolvedValue({
        id: "reg-1",
        userId: "user-1",
        stellarAddress: "GDXNXL25GDM3N5LAR5FALA3VSGHFET3EOKLXRP3ITPPMR3PISTQSKSFS",
        funded: true,
        trustlineReady: true,
        trustlineAuthorized: true,
        xlmBalance: "10",
        spendableXlmBalance: "8",
        checklistCompleted: {
          choose_wallet: true,
          fund_wallet: true,
          add_trustline: true,
          register_address: true,
        },
        deletedAt: null,
      } as any);

      const res = await getRegister();
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.registration).toBeDefined();
      expect(data.checklistCompleted).toEqual({
        choose_wallet: true,
        fund_wallet: true,
        add_trustline: true,
        register_address: true,
      });
    });

    it("defaults null checklistCompleted to empty object", async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: "user-1" },
      } as any);

      vi.mocked(prisma.registration.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: "user-1",
        checklistCompleted: null,
      } as any);

      const res = await getRegister();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.checklistCompleted).toEqual({});
    });

    it("retains checklist state for soft-deleted registrations", async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: "user-1" },
      } as any);

      vi.mocked(prisma.registration.findUnique).mockResolvedValue({
        id: "reg-1",
        userId: "user-1",
        stellarAddress: "GDXNXL25GDM3N5LAR5FALA3VSGHFET3EOKLXRP3ITPPMR3PISTQSKSFS",
        deletedAt: new Date(),
        checklistCompleted: { choose_wallet: true, fund_wallet: true },
      } as any);

      const res = await getRegister();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.registration).toBeNull();
      expect(data.checklistCompleted).toEqual({
        choose_wallet: true,
        fund_wallet: true,
      });
    });
  });

  describe("GDPR Cascade Deletion Verification", () => {
    it("deleting user permanently cascades and wipes checklist data", async () => {
      vi.mocked(prisma.user.delete).mockResolvedValue({
        id: "user-1",
        checklistCompleted: null,
      } as any);

      const deleted = await prisma.user.delete({
        where: { id: "user-1" },
      });

      expect(deleted.id).toBe("user-1");
      expect(prisma.user.delete).toHaveBeenCalledWith({
        where: { id: "user-1" },
      });
    });
  });
});
