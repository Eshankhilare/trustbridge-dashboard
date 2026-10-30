import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-auth", () => ({
  requireMaintainerSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contributorColumnPreference: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

import { requireMaintainerSession } from "@/lib/api-auth";
import {
  defaultContributorColumnPreferences,
  type ContributorColumnPreference,
} from "@/lib/contributors";
import { prisma } from "@/lib/prisma";

import {
  GET,
  PUT,
} from "@/app/api/contributors/column-preferences/route";

const findUnique = vi.mocked(prisma.contributorColumnPreference.findUnique);
const upsert = vi.mocked(prisma.contributorColumnPreference.upsert);

const SAME_ORIGIN = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

const USER_A_ORG_A = {
  user: {
    id: "maintainer-a",
    githubUsername: "alice",
    isMaintainer: true,
    maintainerOrgId: "org-a",
  },
};

const USER_B_ORG_B = {
  user: {
    id: "maintainer-b",
    githubUsername: "bob",
    isMaintainer: true,
    maintainerOrgId: "org-b",
  },
};

function putRequest(
  body: unknown = { columns: defaultContributorColumnPreferences() },
  headers: Record<string, string> = SAME_ORIGIN,
) {
  return new NextRequest(
    "http://localhost:3000/api/contributors/column-preferences",
    {
      method: "PUT",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

function customPreferences(): ContributorColumnPreference[] {
  const preferences = defaultContributorColumnPreferences();
  const readinessIndex = preferences.findIndex(
    (entry) => entry.key === "readiness",
  );
  const [readiness] = preferences.splice(readinessIndex, 1);
  preferences.unshift(readiness);
  const verified = preferences.find((entry) => entry.key === "verified");
  if (verified) verified.visible = false;
  return preferences;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMaintainerSession).mockResolvedValue(USER_A_ORG_A as never);
});

describe("GET /api/contributors/column-preferences", () => {
  it("rejects unauthenticated or non-maintainer callers", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValueOnce(null);

    const res = await GET();

    expect(res.status).toBe(403);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns sensible defaults when the maintainer has no saved preferences", async () => {
    findUnique.mockResolvedValueOnce(null);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.columns).toEqual(defaultContributorColumnPreferences());
    expect(body.isDefault).toBe(true);
    expect(body.updatedAt).toBeNull();
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        userId_maintainerOrgId: {
          userId: "maintainer-a",
          maintainerOrgId: "org-a",
        },
      },
    });
  });

  it("loads saved preferences for the session user and org", async () => {
    const columns = customPreferences();
    findUnique.mockResolvedValueOnce({
      columns,
      updatedAt: new Date("2026-10-31T10:00:00.000Z"),
    } as never);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.columns).toEqual(columns);
    expect(body.isDefault).toBe(false);
    expect(body.updatedAt).toBe("2026-10-31T10:00:00.000Z");
  });

  it("falls back to defaults when the stored value is invalid", async () => {
    findUnique.mockResolvedValueOnce({
      columns: [{ key: "unknownColumn", visible: true }],
      updatedAt: new Date("2026-10-31T10:00:00.000Z"),
    } as never);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.columns).toEqual(defaultContributorColumnPreferences());
    expect(body.isDefault).toBe(true);
  });

  it("isolates preferences between maintainers and organizations", async () => {
    const orgAColumns = customPreferences();
    const orgBColumns = defaultContributorColumnPreferences().map((entry) => ({
      ...entry,
      visible: entry.key !== "xlmBalance",
    }));

    vi.mocked(requireMaintainerSession)
      .mockResolvedValueOnce(USER_A_ORG_A as never)
      .mockResolvedValueOnce(USER_B_ORG_B as never);
    findUnique
      .mockResolvedValueOnce({
        columns: orgAColumns,
        updatedAt: new Date("2026-10-31T10:00:00.000Z"),
      } as never)
      .mockResolvedValueOnce({
        columns: orgBColumns,
        updatedAt: new Date("2026-10-31T11:00:00.000Z"),
      } as never);

    const first = await (await GET()).json();
    const second = await (await GET()).json();

    expect(first.columns).toEqual(orgAColumns);
    expect(second.columns).toEqual(orgBColumns);
    expect(findUnique).toHaveBeenNthCalledWith(1, {
      where: {
        userId_maintainerOrgId: {
          userId: "maintainer-a",
          maintainerOrgId: "org-a",
        },
      },
    });
    expect(findUnique).toHaveBeenNthCalledWith(2, {
      where: {
        userId_maintainerOrgId: {
          userId: "maintainer-b",
          maintainerOrgId: "org-b",
        },
      },
    });
  });

  it("returns 500 when the database read fails", async () => {
    findUnique.mockRejectedValueOnce(new Error("db unavailable"));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Failed to load column preferences" });
  });
});

describe("PUT /api/contributors/column-preferences", () => {
  beforeEach(() => {
    upsert.mockResolvedValue({
      updatedAt: new Date("2026-10-31T12:00:00.000Z"),
    } as never);
  });

  it("saves valid preferences for the session user and org", async () => {
    const columns = customPreferences();

    const res = await PUT(putRequest({ columns }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.columns).toEqual(columns);
    expect(body.isDefault).toBe(false);
    expect(upsert).toHaveBeenCalledWith({
      where: {
        userId_maintainerOrgId: {
          userId: "maintainer-a",
          maintainerOrgId: "org-a",
        },
      },
      create: {
        userId: "maintainer-a",
        maintainerOrgId: "org-a",
        columns,
      },
      update: { columns },
    });
  });

  it("writes distinct rows for different maintainers and organizations", async () => {
    const columns = customPreferences();

    await PUT(putRequest({ columns }));
    vi.mocked(requireMaintainerSession).mockResolvedValueOnce(
      USER_B_ORG_B as never,
    );
    await PUT(putRequest({ columns }));

    expect(upsert).toHaveBeenNthCalledWith(1, {
      where: {
        userId_maintainerOrgId: {
          userId: "maintainer-a",
          maintainerOrgId: "org-a",
        },
      },
      create: {
        userId: "maintainer-a",
        maintainerOrgId: "org-a",
        columns,
      },
      update: { columns },
    });
    expect(upsert).toHaveBeenNthCalledWith(2, {
      where: {
        userId_maintainerOrgId: {
          userId: "maintainer-b",
          maintainerOrgId: "org-b",
        },
      },
      create: {
        userId: "maintainer-b",
        maintainerOrgId: "org-b",
        columns,
      },
      update: { columns },
    });
  });

  it("rejects unauthenticated or non-maintainer callers", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValueOnce(null);

    const res = await PUT(putRequest());

    expect(res.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests before writing", async () => {
    const res = await PUT(
      putRequest(
        { columns: defaultContributorColumnPreferences() },
        {
          origin: "https://evil.example",
          host: "localhost:3000",
          "content-type": "application/json",
        },
      ),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid request origin" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const res = await PUT(putRequest("not-json"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid JSON body" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a missing columns field", async () => {
    const res = await PUT(putRequest({}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid column preferences");
    expect(body.details).toContain("Column preferences must be an array.");
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an unknown column",
      [
        ...defaultContributorColumnPreferences().slice(0, -1),
        { key: "madeUpColumn", visible: true },
      ],
      /Unknown column/i,
    ],
    [
      "a duplicate column",
      [
        ...defaultContributorColumnPreferences().slice(0, -1),
        { ...defaultContributorColumnPreferences()[0] },
      ],
      /Duplicate column/i,
    ],
    [
      "an incomplete ordering",
      defaultContributorColumnPreferences().slice(0, -1),
      /exactly once/i,
    ],
    [
      "an all-hidden table",
      defaultContributorColumnPreferences().map((entry) => ({
        ...entry,
        visible: false,
      })),
      /At least one column/i,
    ],
    [
      "a non-boolean visibility flag",
      defaultContributorColumnPreferences().map((entry) =>
        entry.key === "githubUsername"
          ? { key: entry.key, visible: "yes" }
          : entry,
      ),
      /boolean visible flag/i,
    ],
  ])("rejects %s", async (_label, columns, expectedError) => {
    const res = await PUT(putRequest({ columns }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid column preferences");
    expect(body.details.join(" ")).toMatch(expectedError);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns 500 when the database write fails", async () => {
    upsert.mockRejectedValueOnce(new Error("db unavailable"));

    const res = await PUT(putRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Failed to save column preferences" });
  });
});
