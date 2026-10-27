import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-auth", () => ({
  requireMaintainerSession: vi.fn(),
}));

vi.mock("@/lib/registrations", () => ({
  getDashboardStats: vi.fn(),
  getContributorsPaginated: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  // Headers are asserted on, so the default mock has to look like the real
  // thing rather than an empty object.
  buildRateLimitHeaders: vi.fn(() => ({
    "x-ratelimit-limit": "120",
    "x-ratelimit-remaining": "119",
  })),
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  extractClientIp: vi.fn(() => "127.0.0.1"),
}));

import { requireMaintainerSession } from "@/lib/api-auth";
import { buildRateLimitHeaders, checkRateLimit } from "@/lib/rate-limit";
import {
  getContributorsPaginated,
  getDashboardStats,
} from "@/lib/registrations";
import { POST } from "@/app/api/graphql/route";

function post(query: string, variables?: Record<string, unknown>) {
  return new NextRequest("http://localhost:3000/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
}

describe("POST /api/graphql", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: true } as never);
    vi.mocked(requireMaintainerSession).mockResolvedValue(null);
    vi.mocked(getDashboardStats).mockResolvedValue({
      totalContributors: 12,
      readyCount: 8,
      readyPercent: 67,
    });
    vi.mocked(getContributorsPaginated).mockResolvedValue({
      contributors: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.clearAllMocks();
  });

  it("serves aggregate stats without maintainer authorization", async () => {
    const response = await POST(post("{ stats { totalContributors readyCount readyPercent } }"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        stats: { totalContributors: 12, readyCount: 8, readyPercent: 67 },
      },
    });
    expect(getDashboardStats).toHaveBeenCalledOnce();
  });

  it("rate limits requests before executing a query", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: false } as never);

    const response = await POST(post("{ stats { totalContributors } }"));

    expect(response.status).toBe(429);
    expect(getDashboardStats).not.toHaveBeenCalled();
  });

  it("returns a GraphQL forbidden error for contributors without a maintainer session", async () => {
    const response = await POST(
      post("{ stats { readyCount } contributors { nodes { githubUsername } } }")
    );
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.data.stats.readyCount).toBe(8);
    expect(result.data.contributors).toBeNull();
    expect(result.errors[0].extensions.code).toBe("FORBIDDEN");
    expect(getContributorsPaginated).not.toHaveBeenCalled();
  });

  it("uses the bounded cursor query for maintainer contributor reads", async () => {
    vi.mocked(requireMaintainerSession).mockResolvedValue({
      user: { id: "maintainer-1", isMaintainer: true },
    } as never);

    const response = await POST(
      post(
        "query($first: Int!, $after: String) { contributors(first: $first, after: $after) { nodes { githubUsername stellarAddress readiness } hasMore nextCursor } }",
        { first: 10, after: "cursor-1" }
      )
    );

    expect(response.status).toBe(200);
    expect(getContributorsPaginated).toHaveBeenCalledWith("cursor-1", 10, undefined);
  });

  it("rejects writes because the API is read-only", async () => {
    const response = await POST(post("mutation { contributors { hasMore } }"));
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.errors[0].message).toMatch(/read-only/i);
  });

  it("rejects excessive depth and weighted query cost", async () => {
    const deepResponse = await POST(
      post(
        "{ stats { totalContributors { nested { deeper { stillDeeper { value } } } } } }"
      )
    );
    expect((await deepResponse.json()).errors[0].message).toMatch(/depth/i);

    const aliases = Array.from(
      { length: 26 },
      (_, index) => `field${index}: githubUsername`
    ).join(" ");
    const costlyResponse = await POST(
      post(`{ contributors(first: 100) { nodes { ${aliases} } } }`)
    );
    expect((await costlyResponse.json()).errors[0].message).toMatch(/cost/i);
  });

  it("disables schema introspection in production", async () => {
    process.env.NODE_ENV = "production";

    const response = await POST(post("{ __schema { queryType { name } } }"));

    expect(response.status).toBe(400);
    expect((await response.json()).errors[0].message).toMatch(/introspection/i);
  });

  // #499 — `valueFromAST` returns a raw variable value without coercing it to
  // the argument's declared type, so a String `first` slipped past the range
  // check and produced a NaN cost multiplier (`NaN > MAX_QUERY_COST` is false),
  // effectively disabling the cost limit for that request.
  describe("contributors.first validation", () => {
    const CONTRIB_QUERY =
      "query($first: Int) { contributors(first: $first) { nodes { githubUsername } } }";

    beforeEach(() => {
      vi.mocked(requireMaintainerSession).mockResolvedValue({
        user: { id: "maintainer-1", isMaintainer: true },
      } as never);
    });

    it("rejects a String variable used as first with HTTP 400", async () => {
      const response = await POST(
        post(
          "query($first: String) { contributors(first: $first) { nodes { githubUsername } } }",
          { first: "25" }
        )
      );
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors[0].message).toMatch(/contributors\.first/i);
      expect(result.errors[0].message).toMatch(/Int/);
      expect(getContributorsPaginated).not.toHaveBeenCalled();
    });

    it("rejects a non-numeric String variable before the resolver runs", async () => {
      const response = await POST(
        post(
          "query($first: String) { contributors(first: $first) { nodes { githubUsername } } }",
          { first: "twenty" }
        )
      );

      expect(response.status).toBe(400);
      expect((await response.json()).errors[0].message).toMatch(
        /contributors\.first/i
      );
      expect(getContributorsPaginated).not.toHaveBeenCalled();
    });

    it("rejects a boolean variable value used as first", async () => {
      const response = await POST(
        post(CONTRIB_QUERY, { first: true })
      );

      expect(response.status).toBe(400);
      expect((await response.json()).errors[0].message).toMatch(
        /contributors\.first/i
      );
      expect(getContributorsPaginated).not.toHaveBeenCalled();
    });

    it("accepts a valid numeric variable within bounds", async () => {
      const response = await POST(post(CONTRIB_QUERY, { first: 12 }));

      expect(response.status).toBe(200);
      expect(getContributorsPaginated).toHaveBeenCalledWith(undefined, 12, undefined);
    });

    it("treats an inline literal and an equivalent variable the same", async () => {
      const literalResponse = await POST(
        post("{ contributors(first: 12) { nodes { githubUsername } } }")
      );
      const variableResponse = await POST(post(CONTRIB_QUERY, { first: 12 }));

      expect(literalResponse.status).toBe(200);
      expect(variableResponse.status).toBe(200);
      // Third argument is the optional verification-status filter (#602).
      expect(getContributorsPaginated).toHaveBeenNthCalledWith(
        1,
        undefined,
        12,
        undefined
      );
      expect(getContributorsPaginated).toHaveBeenNthCalledWith(
        2,
        undefined,
        12,
        undefined
      );
    });

    it("rejects an inline literal above MAX_CONTRIBUTORS before the resolver runs", async () => {
      const response = await POST(
        post("{ contributors(first: 101) { nodes { githubUsername } } }")
      );

      expect(response.status).toBe(400);
      expect((await response.json()).errors[0].message).toMatch(
        /between 1 and 100/
      );
      expect(getContributorsPaginated).not.toHaveBeenCalled();
    });

    it("rejects a variable value above MAX_CONTRIBUTORS", async () => {
      const response = await POST(post(CONTRIB_QUERY, { first: 5000 }));

      expect(response.status).toBe(400);
      expect(getContributorsPaginated).not.toHaveBeenCalled();
    });

    it("rejects a zero or negative first value", async () => {
      for (const first of [0, -1]) {
        const response = await POST(post(CONTRIB_QUERY, { first }));
        expect(response.status).toBe(400);
        expect((await response.json()).errors[0].message).toMatch(
          /between 1 and 100/
        );
      }
      expect(getContributorsPaginated).not.toHaveBeenCalled();
    });

    it("falls back to DEFAULT_CONTRIBUTORS when first is missing", async () => {
      const response = await POST(
        post("{ contributors { nodes { githubUsername } } }")
      );

      expect(response.status).toBe(200);
      expect(getContributorsPaginated).toHaveBeenCalledWith(undefined, 25, undefined);
    });

    // An explicit `null` is legal GraphQL. It reaches the resolver as `null`
    // (a `defaultValue` only applies when the argument is *absent*, so that is
    // unchanged resolver behaviour), and the cost analyzer has to price it at
    // DEFAULT_CONTRIBUTORS rather than producing a NaN multiplier — `NaN > 2500`
    // is false, which silently disabled the cost limit for the request.
    it.each([
      [
        "a variable",
        "query($first: Int) { contributors(first: $first) { nodes { githubUsername } } }",
        { first: null },
      ],
      [
        "an inline literal",
        "{ contributors(first: null) { nodes { githubUsername } } }",
        undefined,
      ],
    ])("accepts null first passed as %s", async (_label, query, variables) => {
      const response = await POST(post(query, variables));

      expect(response.status).toBe(200);
      expect(getContributorsPaginated).toHaveBeenCalledWith(undefined, null, undefined);
    });

    // A missing argument is the case where the schema default does apply, so the
    // resolver gets DEFAULT_CONTRIBUTORS rather than null.
    it("passes DEFAULT_CONTRIBUTORS to the resolver when first is missing", async () => {
      const response = await POST(
        post("{ contributors { nodes { githubUsername } } }")
      );

      expect(response.status).toBe(200);
      expect(getContributorsPaginated).toHaveBeenCalledWith(undefined, 25, undefined);
    });

    it("does not let an invalid first value bypass the cost analyzer", async () => {
      // A String variable previously produced a NaN multiplier, so even a query
      // far over the cost limit sailed through. It must be a 400 for the type,
      // not a silent pass.
      const aliases = Array.from(
        { length: 40 },
        (_, index) => `field${index}: githubUsername`
      ).join(" ");
      const response = await POST(
        post(
          `query($first: String) { contributors(first: $first) { nodes { ${aliases} } } }`,
          { first: "100" }
        )
      );

      expect(response.status).toBe(400);
      expect((await response.json()).errors[0].message).toMatch(
        /contributors\.first/i
      );
      expect(getContributorsPaginated).not.toHaveBeenCalled();
    });

    it("still rejects an over-cost query whose first value is valid", async () => {
      const aliases = Array.from(
        { length: 40 },
        (_, index) => `field${index}: githubUsername`
      ).join(" ");
      const response = await POST(
        post(
          `query($first: Int) { contributors(first: $first) { nodes { ${aliases} } } }`,
          { first: 100 }
        )
      );

      expect(response.status).toBe(400);
      expect((await response.json()).errors[0].message).toMatch(/cost/i);
      expect(getContributorsPaginated).not.toHaveBeenCalled();
    });

    it("keeps contributors maintainer-only for an in-bounds first value", async () => {
      vi.mocked(requireMaintainerSession).mockResolvedValue(null);

      const response = await POST(post(CONTRIB_QUERY, { first: 5 }));
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.data.contributors).toBeNull();
      expect(result.errors[0].extensions.code).toBe("FORBIDDEN");
      expect(getContributorsPaginated).not.toHaveBeenCalled();
    });

    it("keeps rate-limit headers on validation error responses", async () => {
      const response = await POST(post(CONTRIB_QUERY, { first: "nope" }));

      expect(response.status).toBe(400);
      expect(response.headers.get("x-ratelimit-limit")).toBe("120");
      expect(response.headers.get("x-ratelimit-remaining")).toBe("119");
    });
  });

  it("does not expose token fields in the contributor schema", async () => {
    const response = await POST(
      post("{ contributors { nodes { githubUsername accessToken } } }")
    );

    expect(response.status).toBe(400);
    expect((await response.json()).errors[0].message).toMatch(/accessToken/i);
  });

  it("keeps rate-limit headers on the depth and cost rejections", async () => {
    const response = await POST(
      post(
        "{ stats { totalContributors { nested { deeper { stillDeeper { value } } } } } }"
      )
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("x-ratelimit-limit")).toBe("120");
  });
});
