import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import of the modules under test.
// ---------------------------------------------------------------------------
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";

import {
  verifyWebhookSignature,
  processGithubOrgMembershipEvent,
  type GithubOrgMembershipPayload,
} from "@/lib/github-org-membership-webhook";

import { POST as webhookPOST } from "@/app/api/webhooks/github-org-membership/route";
import { POST as replayPOST } from "@/app/api/webhooks/github-org-membership/replay/route";

const TEST_SECRET = "test-webhook-secret";

function sign(body: string, secret = TEST_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function makePayload(
  action = "member_added",
  login = "octocat",
  githubId = 1
): GithubOrgMembershipPayload {
  return {
    action,
    membership: { user: { id: githubId, login }, role: "member", state: "active" },
    organization: { login: "stellar-org" },
    sender: { login: "admin" },
  };
}

function webhookRequest(body: string, sig: string | null): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  return new NextRequest(
    "http://localhost:3000/api/webhooks/github-org-membership",
    { method: "POST", headers, body }
  );
}

const sameOriginHeaders: Record<string, string> = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function replayRequest(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(
    "http://localhost:3000/api/webhooks/github-org-membership/replay",
    { method: "POST", headers: headers ?? sameOriginHeaders, body: JSON.stringify(body) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET;
});

afterEach(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature (lib — pure)
// ---------------------------------------------------------------------------
describe("verifyWebhookSignature", () => {
  it("returns ok=true for a correct signature (success path)", () => {
    const body = '{"action":"member_added"}';
    const sig = sign(body);
    expect(verifyWebhookSignature(body, sig)).toEqual({ ok: true });
  });

  it("returns ok=false for a tampered body (failure path)", () => {
    const body = '{"action":"member_added"}';
    const sig = sign("different-body");
    const result = verifyWebhookSignature(body, sig);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mismatch/i);
  });

  it("returns ok=false when signature header is missing", () => {
    const result = verifyWebhookSignature('{"a":1}', null);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it("returns ok=false when GITHUB_WEBHOOK_SECRET is not set", () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const result = verifyWebhookSignature('{"a":1}', sign('{"a":1}'));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it("returns ok=false for a non-sha256 scheme", () => {
    const result = verifyWebhookSignature('{"a":1}', "sha1=abc123");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processGithubOrgMembershipEvent (lib)
// ---------------------------------------------------------------------------
describe("processGithubOrgMembershipEvent", () => {
  it("upserts user and returns handled=true for member_added", async () => {
    vi.mocked(prisma.user.upsert).mockResolvedValue({} as any);
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const result = await processGithubOrgMembershipEvent(makePayload("member_added"));
    expect(result.handled).toBe(true);
    expect(result.action).toBe("member_added");
    expect(result.login).toBe("octocat");
    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { githubId: "1" } })
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "webhook.github_org_membership.member_added" })
    );
  });

  it("upserts user for member_invited", async () => {
    vi.mocked(prisma.user.upsert).mockResolvedValue({} as any);
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const result = await processGithubOrgMembershipEvent(makePayload("member_invited"));
    expect(result.handled).toBe(true);
    expect(prisma.user.upsert).toHaveBeenCalled();
  });

  it("logs removal and returns handled=true for member_removed without touching DB", async () => {
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const result = await processGithubOrgMembershipEvent(makePayload("member_removed"));
    expect(result.handled).toBe(true);
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "webhook.github_org_membership.member_removed",
      })
    );
  });

  it("returns handled=false for an unrecognised action", async () => {
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const result = await processGithubOrgMembershipEvent(
      makePayload("member_edited")
    );
    expect(result.handled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/github-org-membership (route)
// ---------------------------------------------------------------------------
describe("POST /api/webhooks/github-org-membership", () => {
  it("returns 401 when signature is missing", async () => {
    const body = JSON.stringify(makePayload());
    const res = await webhookPOST(webhookRequest(body, null));
    expect(res.status).toBe(401);
  });

  it("returns 401 for a bad signature", async () => {
    const body = JSON.stringify(makePayload());
    const res = await webhookPOST(webhookRequest(body, sign("wrong-body")));
    expect(res.status).toBe(401);
  });

  it("returns 200 and processes a valid signed payload", async () => {
    vi.mocked(prisma.user.upsert).mockResolvedValue({} as any);
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const body = JSON.stringify(makePayload("member_added"));
    const sig = sign(body);
    const res = await webhookPOST(webhookRequest(body, sig));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.handled).toBe(true);
  });

  it("returns 400 for an invalid JSON body with correct signature", async () => {
    const body = "not-json";
    const sig = sign(body);
    const res = await webhookPOST(webhookRequest(body, sig));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/github-org-membership/replay (route)
// ---------------------------------------------------------------------------
describe("POST /api/webhooks/github-org-membership/replay", () => {
  it("returns 403 for cross-origin request", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const r = replayRequest(makePayload(), {
      origin: "https://evil.com",
      host: "localhost:3000",
      "content-type": "application/json",
    });
    const res = await replayPOST(r);
    expect(res.status).toBe(403);
  });

  it("returns 403 when not a maintainer", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: false },
    } as any);
    const r = replayRequest(makePayload());
    const res = await replayPOST(r);
    expect(res.status).toBe(403);
  });

  it("returns 200 and processes the replayed payload for a maintainer", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1", isMaintainer: true },
    } as any);
    vi.mocked(prisma.user.upsert).mockResolvedValue({} as any);
    vi.mocked(recordAuditLog).mockResolvedValue({} as any);

    const r = replayRequest(makePayload("member_added"));
    const res = await replayPOST(r);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.replayed).toBe(true);
    expect(json.handled).toBe(true);
  });
});
