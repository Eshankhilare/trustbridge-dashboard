import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/token-crypto", () => ({
  encryptToken: vi.fn((token: string) => `encrypted:${token}`),
  decryptToken: vi.fn(),
}));

vi.mock("@/lib/token-audit", () => ({
  recordTokenAudit: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

import type { NextAuthOptions } from "next-auth";

import { authOptions, verifyTenantAccess, getAllowedMaintainerOrgs } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";

type JwtCallback = NonNullable<NextAuthOptions["callbacks"]>["jwt"];
type JwtParams = Parameters<NonNullable<JwtCallback>>[0];

const maybeJwtCallback = authOptions.callbacks?.jwt;
if (typeof maybeJwtCallback !== "function") {
  throw new Error("authOptions.callbacks.jwt is not configured");
}
// Re-bound to a non-optional type so nested closures below don't need to
// re-narrow `undefined` out of the callback's type on every call.
const jwtCallback: NonNullable<JwtCallback> = maybeJwtCallback;

function githubAccount(accessToken = "gho_test_token"): JwtParams["account"] {
  return {
    provider: "github",
    access_token: accessToken,
  } as unknown as JwtParams["account"];
}

function githubProfile(login = "octocat"): JwtParams["profile"] {
  return {
    id: 123,
    login,
    name: "Octo Cat",
    email: "octo@example.com",
    image: null,
  } as unknown as JwtParams["profile"];
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function callJwt(login = "octocat") {
  return jwtCallback({
    token: {},
    account: githubAccount(),
    profile: githubProfile(login),
  } as unknown as JwtParams);
}

const ORIGINAL_ENV = process.env;

describe("auth jwt callback - maintainer team scoping", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.mocked(prisma.user.upsert).mockResolvedValue({
      id: "user-1",
    } as Awaited<ReturnType<typeof prisma.user.upsert>>);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("grants maintainer when org and team membership both pass (success path)", async () => {
    process.env.GITHUB_MAINTAINER_ORG = "stellar-org";
    process.env.GITHUB_MAINTAINER_TEAM = "dashboard-maintainers";

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([{ login: "stellar-org" }]))
      .mockResolvedValueOnce(jsonResponse({ state: "active" }));

    const token = await callJwt();

    expect(token.isMaintainer).toBe(true);
    expect(token.maintainerOrgId).toBe("stellar-org");
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("denies maintainer and records an audit log when org passes but team fails (failure path)", async () => {
    process.env.GITHUB_MAINTAINER_ORG = "stellar-org";
    process.env.GITHUB_MAINTAINER_TEAM = "dashboard-maintainers";

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([{ login: "stellar-org" }]))
      .mockResolvedValueOnce(jsonResponse({ state: "pending" }));

    const token = await callJwt("someone");

    expect(token.isMaintainer).toBe(false);
    // maintainerOrgId is still set even when the user is denied
    expect(token.maintainerOrgId).toBe("stellar-org");
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "maintainer_access_denied_team",
        actorLogin: "someone",
        metadata: { team: "dashboard-maintainers" },
      })
    );
  });

  it("falls back to the org-only check when GITHUB_MAINTAINER_TEAM is unset (no regression)", async () => {
    process.env.GITHUB_MAINTAINER_ORG = "stellar-org";
    delete process.env.GITHUB_MAINTAINER_TEAM;

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse([{ login: "stellar-org" }])
    );

    const token = await callJwt();

    expect(token.isMaintainer).toBe(true);
    expect(token.maintainerOrgId).toBe("stellar-org");
    // 1 org-membership check + 1 role-resolution check + 1 available-orgs
    // check (all hit /user/orgs; the latter two are best-effort enrichment).
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it("resolves maintainer false without throwing when the team check is rate-limited", async () => {
    process.env.GITHUB_MAINTAINER_ORG = "stellar-org";
    process.env.GITHUB_MAINTAINER_TEAM = "dashboard-maintainers";

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([{ login: "stellar-org" }]))
      .mockResolvedValueOnce(
        jsonResponse({ message: "API rate limit exceeded" }, false)
      );

    await expect(callJwt()).resolves.toMatchObject({
      isMaintainer: false,
      maintainerOrgId: "stellar-org",
    });
  });

  it("resolves maintainer false without throwing when the team check hits a network error", async () => {
    process.env.GITHUB_MAINTAINER_ORG = "stellar-org";
    process.env.GITHUB_MAINTAINER_TEAM = "dashboard-maintainers";

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse([{ login: "stellar-org" }]))
      .mockRejectedValueOnce(new Error("network down"));

    await expect(callJwt()).resolves.toMatchObject({
      isMaintainer: false,
      maintainerOrgId: "stellar-org",
    });
  });

  it("sets maintainerOrgId to 'default' when GITHUB_MAINTAINER_ORG is unset", async () => {
    delete process.env.GITHUB_MAINTAINER_ORG;
    delete process.env.GITHUB_MAINTAINER_TEAM;

    // No fetch call expected — no org check takes place
    const token = await callJwt();

    expect(token.isMaintainer).toBeUndefined();
    expect(token.maintainerOrgId).toBe("default");
  });

  it("enforces tenant isolation and prevents IDOR across maintainer orgs", () => {
    expect(verifyTenantAccess("OrgA", "OrgA")).toBe(true);
    expect(verifyTenantAccess("OrgA", "orga")).toBe(true);
    expect(verifyTenantAccess("OrgA", "OrgB")).toBe(false);
    expect(verifyTenantAccess("OrgA", "")).toBe(false);

    process.env.ALLOWED_MAINTAINER_ORGS = "OrgA, OrgB, OrgC";
    expect(getAllowedMaintainerOrgs()).toEqual(["OrgA", "OrgB", "OrgC"]);
  });
});
