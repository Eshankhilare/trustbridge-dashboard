import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/check/route";
import { resetRateLimit } from "@/lib/rate-limit";
import { checkCache } from "@/lib/cache";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("@/lib/horizon", () => ({
  checkStellarAddress: vi.fn(),
}));

import { checkStellarAddress } from "@/lib/horizon";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sameOriginHeaders: Record<string, string> = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  "content-type": "application/json",
};

function post(body: unknown, headers?: Record<string, string>) {
  return new NextRequest("http://localhost:3000/api/check", {
    method: "POST",
    headers: headers ?? sameOriginHeaders,
    body: JSON.stringify(body),
  });
}

function postWithBypass(body: unknown) {
  return new NextRequest("http://localhost:3000/api/check", {
    method: "POST",
    headers: { ...sameOriginHeaders, "x-cache-bypass": "1" },
    body: JSON.stringify(body),
  });
}

/** A complete, ready HorizonCheckResult stub */
const readyResult = {
  funded: true,
  trustline: true,
  trustline_authorized: true,
  verified: true,
  xlm_balance: "5",
  spendable_xlm_balance: "3",
  readiness: "ready" as const,
  errors: [],
};

/** A not-ready result for a transient Horizon error */
const transientResult = {
  funded: false,
  trustline: false,
  trustline_authorized: false,
  verified: false,
  xlm_balance: "0",
  spendable_xlm_balance: "0",
  readiness: "not_ready" as const,
  errors: ["Horizon is temporarily unavailable. Please try again later."],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("POST /api/check", () => {
  beforeEach(() => {
    resetRateLimit();
    checkCache.reset();
    vi.clearAllMocks();
  });

  // ── CSRF ──────────────────────────────────────────────────────────────────

  it("rejects cross-origin requests before touching Horizon", async () => {
    const r = post(
      { address: "GBSX" },
      {
        origin: "https://evil.com",
        host: "localhost:3000",
        "content-type": "application/json",
      }
    );
    const res = await POST(r);
    expect(res.status).toBe(403);
    expect(checkStellarAddress).not.toHaveBeenCalled();
  });

  // ── Rate limit ────────────────────────────────────────────────────────────

  it("returns 429 when rate limit exceeded", async () => {
    vi.mocked(checkStellarAddress).mockResolvedValue(readyResult);

    // Use distinct addresses so the KV cache does not serve any of the 10
    // requests from cache — each is a genuine cache miss that exercises the
    // full CSRF → rate-limit → Horizon path and counts toward the limit.
    vi.mocked(checkStellarAddress).mockResolvedValue({
      funded: true,
      trustline: true,
      trustline_authorized: true,
      verified: true,
      xlm_balance: "2",
      spendable_xlm_balance: "1.5",
      readiness: "ready",
      horizon_error: null,
      errors: [],
    } as never);

    // Exhaust the default limit (10 requests)
    for (let i = 0; i < 10; i++) {
      const r = post({ address: `GBSX${i}` });
      const res = await POST(r);
      expect(res.status).toBe(200);
    }

    // The rate window is now exhausted for this IP.
    // Use any address — the rate limiter fires before the cache is consulted.
    const r = post({ address: "GBSX_OVER" });
    const res = await POST(r);
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("retry-after");
    expect(retryAfter).toBeTruthy();
    // Horizon was called once per unique address (all 10 cache misses).
    expect(checkStellarAddress).toHaveBeenCalledTimes(10);
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it("returns 400 for a missing address", async () => {
    const r = post({ address: "" });
    const res = await POST(r);
    expect(res.status).toBe(400);
    expect(checkStellarAddress).not.toHaveBeenCalled();
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("returns 200 with the Horizon result on cache miss (first call)", async () => {
    vi.mocked(checkStellarAddress).mockResolvedValue(readyResult);

    const r = post({ address: "GABCDEF" });
    const res = await POST(r);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.funded).toBe(true);
    expect(json.readiness).toBe("ready");
    expect(checkStellarAddress).toHaveBeenCalledTimes(1);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns 200 with not-ready state when circuit breaker is open", async () => {
    vi.mocked(checkStellarAddress).mockResolvedValue({
      funded: false,
      trustline: false,
      trustline_authorized: false,
      verified: false,
      xlm_balance: "0",
      spendable_xlm_balance: "0",
      readiness: "not_ready",
      errors: ["Horizon is temporarily unavailable. Please try again later."],
    } as any);

    const r = post({ address: "GBSX" });
    const res = await POST(r);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.errors).toContain(
      "Horizon is temporarily unavailable. Please try again later."
    );
  });

  it("returns 200 with mocked result (same-origin)", async () => {
    vi.mocked(checkStellarAddress).mockResolvedValue({
      funded: true,
      trustline: true,
      trustline_authorized: true,
      verified: true,
      xlm_balance: "2",
      spendable_xlm_balance: "1.5",
      readiness: "ready",
      horizon_error: null,
      errors: [],
    } as never);

    const r = post({ address: "GBSX" });
    const res = await POST(r);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.funded).toBe(true);
    expect(json.readiness).toBe("ready");
    expect(checkStellarAddress).toHaveBeenCalledTimes(1);
  });

  // ── KV cache: hit ─────────────────────────────────────────────────────────

  it("returns the cached result on a second identical request (cache hit)", async () => {
    vi.mocked(checkStellarAddress).mockResolvedValue(readyResult);

    // Prime the cache
    await POST(post({ address: "GABCDEF" }));
    expect(checkStellarAddress).toHaveBeenCalledTimes(1);

    // Second request must be served from cache — Horizon not called again
    const res2 = await POST(post({ address: "GABCDEF" }));
    expect(res2.status).toBe(200);
    expect(checkStellarAddress).toHaveBeenCalledTimes(1);

    const json = await res2.json();
    expect(json.funded).toBe(true);
  });

  it("cache keys are address + asset — different assets are independent entries", async () => {
    vi.mocked(checkStellarAddress).mockResolvedValue(readyResult);

    await POST(
      post({ address: "GABCDEF", asset_code: "USDC", asset_issuer: "GI1" })
    );
    await POST(
      post({ address: "GABCDEF", asset_code: "EURC", asset_issuer: "GI2" })
    );

    // Two distinct cache misses → Horizon called twice
    expect(checkStellarAddress).toHaveBeenCalledTimes(2);
  });

  it("cache keys are address + asset — same address+asset is a cache hit", async () => {
    vi.mocked(checkStellarAddress).mockResolvedValue(readyResult);

    await POST(
      post({ address: "GABCDEF", asset_code: "USDC", asset_issuer: "GI1" })
    );
    await POST(
      post({ address: "GABCDEF", asset_code: "USDC", asset_issuer: "GI1" })
    );

    expect(checkStellarAddress).toHaveBeenCalledTimes(1);
  });

  // ── KV cache: transient errors NOT cached ─────────────────────────────────

  it("does not cache transient Horizon errors (circuit breaker open)", async () => {
    vi.mocked(checkStellarAddress).mockResolvedValue(transientResult);

    const r1 = await POST(post({ address: "GBSX" }));
    expect(r1.status).toBe(200);
    const json1 = await r1.json();
    expect(json1.errors).toContain(
      "Horizon is temporarily unavailable. Please try again later."
    );

    // Second request must NOT be served from cache — Horizon called again
    await POST(post({ address: "GBSX" }));
    expect(checkStellarAddress).toHaveBeenCalledTimes(2);
  });

  it("does not cache generic Horizon errors", async () => {
    const horizonError = {
      ...transientResult,
      errors: ["Horizon error: connection reset"],
    };
    vi.mocked(checkStellarAddress).mockResolvedValue(horizonError);

    await POST(post({ address: "GBSX" }));
    await POST(post({ address: "GBSX" }));

    expect(checkStellarAddress).toHaveBeenCalledTimes(2);
  });

  // ── KV cache: bypass header ───────────────────────────────────────────────

  it("X-Cache-Bypass: 1 skips the cache and calls Horizon fresh", async () => {
    vi.mocked(checkStellarAddress).mockResolvedValue(readyResult);

    // Prime cache
    await POST(post({ address: "GABCDEF" }));
    expect(checkStellarAddress).toHaveBeenCalledTimes(1);

    // Bypass request must hit Horizon even though cache is warm
    const bypassRes = await POST(postWithBypass({ address: "GABCDEF" }));
    expect(bypassRes.status).toBe(200);
    expect(checkStellarAddress).toHaveBeenCalledTimes(2);
  });

  it("cache_bypass=1 query param also skips the cache", async () => {
    vi.mocked(checkStellarAddress).mockResolvedValue(readyResult);

    // Prime
    await POST(post({ address: "GABCDEF" }));

    // Bypass via query param
    const bypassReq = new NextRequest(
      "http://localhost:3000/api/check?cache_bypass=1",
      {
        method: "POST",
        headers: sameOriginHeaders,
        body: JSON.stringify({ address: "GABCDEF" }),
      }
    );
    await POST(bypassReq);
    expect(checkStellarAddress).toHaveBeenCalledTimes(2);
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("returns 500 for unexpected errors thrown by checkStellarAddress", async () => {
    vi.mocked(checkStellarAddress).mockRejectedValue(new Error("boom"));

    const r = post({ address: "GBSX" });
    const res = await POST(r);
    expect(res.status).toBe(500);
  });
});

