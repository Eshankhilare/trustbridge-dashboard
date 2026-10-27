import { describe, it, expect, beforeEach, vi } from "vitest";
import { Horizon } from "stellar-sdk";
import {
  HORIZON_TEST_ACCOUNTS,
  HORIZON_MOCK_RESPONSES,
} from "../mocks/horizon-fixtures";
import { checkStellarAddress } from "@/lib/horizon";
import { verificationCache } from "@/lib/cache";

describe("Horizon Mock Integration Tests (Shared WireMock Fixtures)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    verificationCache.clear();
  });

  it("evaluates funded account with USDC trustline as ready", async () => {
    const address = HORIZON_TEST_ACCOUNTS.FUNDED;
    const mockData = HORIZON_MOCK_RESPONSES[address];

    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockResolvedValueOnce(mockData as never);

    const result = await checkStellarAddress(address, "USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", { useCache: false });

    expect(result.funded).toBe(true);
    expect(result.trustline).toBe(true);
    expect(result.trustline_authorized).toBe(true);
    expect(parseFloat(result.xlm_balance)).toBe(10);
    expect(parseFloat(result.usdc_balance)).toBe(50);
  });

  it("evaluates low balance account properly", async () => {
    const address = HORIZON_TEST_ACCOUNTS.LOW_BALANCE;
    const mockData = HORIZON_MOCK_RESPONSES[address];

    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockResolvedValueOnce(mockData as never);

    const result = await checkStellarAddress(address, "USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", { useCache: false });

    expect(result.funded).toBe(true);
    expect(result.trustline).toBe(true);
    expect(parseFloat(result.xlm_balance)).toBe(0.5);
    expect(parseFloat(result.usdc_balance)).toBe(10);
  });

  it("evaluates account without trustline as trustline=false", async () => {
    const address = HORIZON_TEST_ACCOUNTS.NO_TRUSTLINE;
    const mockData = HORIZON_MOCK_RESPONSES[address];

    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockResolvedValueOnce(mockData as never);

    const result = await checkStellarAddress(address, "USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", { useCache: false });

    expect(result.funded).toBe(true);
    expect(result.trustline).toBe(false);
    expect(result.trustline_authorized).toBe(false);
    expect(parseFloat(result.usdc_balance)).toBe(0);
  });

  // Higher timeout: the default 3-attempt retry path uses real sleeps and
  // can exceed 5s when the shared suite workers are CPU-saturated.
  it("handles unfunded account (404) gracefully", async () => {
    const address = HORIZON_TEST_ACCOUNTS.UNFUNDED;

    const notFoundError = new Error("Resource Missing") as any;
    notFoundError.response = {
      status: 404,
      data: {
        type: "https://stellar.org/horizon-errors/not_found",
        title: "Resource Missing",
        status: 404,
      },
    };

    // mockRejectedValue (all calls): withRetry makes 3 attempts by default
    // and unconsumed attempts would hit the live network.
    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockRejectedValue(notFoundError);

    const result = await checkStellarAddress(address, "USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", { useCache: false });

    expect(result.funded).toBe(false);
    expect(result.trustline).toBe(false);
    expect(result.xlm_balance).toBe("0");
    expect(result.usdc_balance).toBe("0");
  }, 15000);

  it("handles rate limited Horizon response (429)", async () => {
    const address = HORIZON_TEST_ACCOUNTS.RATE_LIMITED;

    const rateLimitError = new Error("Rate limit exceeded") as any;
    rateLimitError.response = {
      status: 429,
      data: {
        type: "https://stellar.org/horizon-errors/too_many_requests",
        title: "Too Many Requests",
        status: 429,
      },
    };

    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockRejectedValueOnce(rateLimitError);

    const result = await checkStellarAddress(address, "USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", { useCache: false, retries: 1 });

    expect(result.funded).toBe(false);
    expect(result.trustline).toBe(false);
  });
});
