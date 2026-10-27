import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkAddressChangeAnomaly, evaluateAndAuditAddressChangeAnomaly } from "./address-anomaly";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    addressHistoryRecord: {
      count: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn().mockResolvedValue(true),
}));

describe("Address Change Anomaly Detector", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns isAnomaly: false when count is below threshold", async () => {
    process.env.MASS_ADDRESS_CHANGE_THRESHOLD = "5";
    process.env.MASS_ADDRESS_CHANGE_WINDOW_MINUTES = "60";

    vi.mocked(prisma.addressHistoryRecord.count).mockResolvedValue(2);

    const status = await checkAddressChangeAnomaly();
    expect(status.isAnomaly).toBe(false);
    expect(status.count).toBe(2);
    expect(status.threshold).toBe(5);
    expect(status.windowMinutes).toBe(60);
  });

  it("returns isAnomaly: true when count reaches or exceeds threshold", async () => {
    process.env.MASS_ADDRESS_CHANGE_THRESHOLD = "5";
    process.env.MASS_ADDRESS_CHANGE_WINDOW_MINUTES = "60";

    vi.mocked(prisma.addressHistoryRecord.count).mockResolvedValue(7);

    const status = await checkAddressChangeAnomaly();
    expect(status.isAnomaly).toBe(true);
    expect(status.count).toBe(7);
  });

  it("evaluates and logs audit event when threshold is breached (fail-open)", async () => {
    process.env.MASS_ADDRESS_CHANGE_THRESHOLD = "3";
    vi.mocked(prisma.addressHistoryRecord.count).mockResolvedValue(4);

    const status = await evaluateAndAuditAddressChangeAnomaly("user-1", "admin1");

    expect(status.isAnomaly).toBe(true);
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        // Multi-signal alert action (issue #574); supersedes the old
        // single-signal "anomaly.mass_address_changes" action.
        action: "anomaly.address_anomaly_detected",
        actorId: "user-1",
        actorLogin: "admin1",
      })
    );
  });
});
