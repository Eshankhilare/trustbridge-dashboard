import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/maintainers", () => ({
  isMaintainer: vi.fn(),
  listRegistrationConflicts: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registrationConflict: {
      findMany: vi.fn(),
    },
  },
}));

import { getServerSession } from "next-auth";
import { isMaintainer, listRegistrationConflicts } from "@/lib/maintainers";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

describe("GET /api/maintainer/conflicts", () => {
  it("returns 401 for unauthenticated requests", async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-maintainer users", async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({
      user: { id: "user-1" },
    } as any);
    vi.mocked(isMaintainer).mockResolvedValueOnce(false);

    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns list of conflicts for maintainers", async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce({
      user: { id: "maintainer-1" },
    } as any);
    vi.mocked(isMaintainer).mockResolvedValueOnce(true);
    vi.mocked(listRegistrationConflicts).mockResolvedValueOnce([
      {
        id: "conflict-1",
        attemptedAddress: "GABC...",
        attemptedUserId: "user-2",
        existingUserId: "user-1",
        createdAt: new Date(),
        maintainerOrgId: "default",
      },
    ] as any);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].id).toBe("conflict-1");
  });
});
