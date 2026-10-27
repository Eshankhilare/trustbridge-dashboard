import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkAddressViaApi } from "@/lib/check-api-client";

function mockResponse({
  status = 200,
  ok = status >= 200 && status < 300,
  body,
  retryAfter,
}: {
  status?: number;
  ok?: boolean;
  body: unknown;
  retryAfter?: string;
}) {
  return {
    status,
    ok,
    json: async () => body,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null,
    },
  };
}

const readyBody = {
  funded: true,
  trustline: true,
  trustline_authorized: true,
  verified: true,
  xlm_balance: "5",
  spendable_xlm_balance: "4",
  usdc_balance: "0",
  errors: [],
  readiness: "ready",
};

describe("checkAddressViaApi", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an ok outcome for a normal successful result", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ status: 200, body: readyBody })) as unknown as typeof fetch;

    const outcome = await checkAddressViaApi("GADDRESS");
    expect(outcome).toEqual({ kind: "ok", result: readyBody });
  });

  it("returns a rate_limited outcome for a 429 with Retry-After", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 429,
        ok: false,
        body: { errors: ["Rate limit exceeded. Please try again later."] },
        // Small value: checkAddressViaApi honors Retry-After between its
        // 3 attempts, and a large value would exceed the test timeout.
        retryAfter: "1",
      })
    ) as unknown as typeof fetch;

    const outcome = await checkAddressViaApi("GADDRESS");
    expect(outcome).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 1,
      errors: ["Rate limit exceeded. Please try again later."],
    });
  });

  it("returns rate_limited with a null retryAfterSeconds when the header is missing", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 429,
        ok: false,
        body: { errors: ["Rate limit exceeded. Please try again later."] },
      })
    ) as unknown as typeof fetch;

    const outcome = await checkAddressViaApi("GADDRESS");
    expect(outcome.kind).toBe("rate_limited");
    if (outcome.kind === "rate_limited") {
      expect(outcome.retryAfterSeconds).toBeNull();
    }
  });

  it("returns a circuit_open outcome for a 200 with a temporarily-unavailable error", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        body: {
          ...readyBody,
          readiness: "not_ready",
          errors: [
            "Horizon is temporarily unavailable. Please try again later.",
          ],
        },
      })
    ) as unknown as typeof fetch;

    const outcome = await checkAddressViaApi("GADDRESS");
    expect(outcome.kind).toBe("circuit_open");
  });

  it("returns a circuit_open outcome for a 200 with a generic Horizon error prefix", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        body: {
          ...readyBody,
          readiness: "not_ready",
          errors: ["Horizon error: connection reset"],
        },
      })
    ) as unknown as typeof fetch;

    const outcome = await checkAddressViaApi("GADDRESS");
    expect(outcome.kind).toBe("circuit_open");
  });

  it("returns a generic error outcome for a non-2xx, non-429 status", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 500,
        ok: false,
        body: { errors: ["Failed to check address"] },
      })
    ) as unknown as typeof fetch;

    const outcome = await checkAddressViaApi("GADDRESS");
    expect(outcome).toEqual({
      kind: "error",
      status: 500,
      errors: ["Failed to check address"],
    });
  });

  it("returns a timeout outcome when the fetch is aborted", async () => {
    const abortError = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    global.fetch = vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch;

    const outcome = await checkAddressViaApi("GADDRESS");
    expect(outcome).toEqual({ kind: "timeout" });
  });

  it("returns a network_error outcome for other fetch failures", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;

    const outcome = await checkAddressViaApi("GADDRESS");
    expect(outcome).toEqual({ kind: "network_error" });
  });
});
