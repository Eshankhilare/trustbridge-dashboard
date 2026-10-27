import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { isFreezeWindowActive, enforceFreezeWindowGuard } from "./freeze-window";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn().mockResolvedValue(true),
}));

// By default the freeze_window feature flag is enabled. Individual tests may
// override FEATURE_FLAG_FREEZE_WINDOW via process.env to flip it.
vi.mock("@/lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn().mockImplementation(async (key: string) => {
    if (key === "freeze_window") {
      const override = process.env.FEATURE_FLAG_FREEZE_WINDOW?.toLowerCase();
      if (override === "false" || override === "0" || override === "off")
        return false;
      return true;
    }
    return false;
  }),
}));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Helpers for building deterministic frozen windows relative to *now* (not
 * hardcoded dates, which rot as soon as the suite runs past them). */
const DAY_MS = 86_400_000;
const PAST_START = new Date(Date.now() - 2 * DAY_MS).toISOString();
const PAST_END = new Date(Date.now() + 2 * DAY_MS).toISOString();
const INSIDE_WINDOW = new Date(Date.now()); // middle of window
const BEFORE_WINDOW = new Date(Date.now() - 3 * DAY_MS); // well before start
const AFTER_WINDOW = new Date(Date.now() + 3 * DAY_MS); // well after end

function makeRequest(
  url = "http://localhost:3000/api/register/recheck",
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(url, { method: "POST", headers });
}

// ---------------------------------------------------------------------------
// isFreezeWindowActive
// ---------------------------------------------------------------------------

describe("isFreezeWindowActive — inactive scenarios", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns active: false when FREEZE_WINDOW_ENABLED is 'false'", () => {
    process.env.FREEZE_WINDOW_ENABLED = "false";
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = PAST_END;

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when FREEZE_WINDOW_START is missing", () => {
    delete process.env.FREEZE_WINDOW_START;
    process.env.FREEZE_WINDOW_END = PAST_END;

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when FREEZE_WINDOW_END is missing", () => {
    process.env.FREEZE_WINDOW_START = PAST_START;
    delete process.env.FREEZE_WINDOW_END;

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when both date env vars are missing", () => {
    delete process.env.FREEZE_WINDOW_START;
    delete process.env.FREEZE_WINDOW_END;

    expect(isFreezeWindowActive(new Date()).active).toBe(false);
  });

  it("returns active: false when now is before the freeze window", () => {
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = PAST_END;

    expect(isFreezeWindowActive(BEFORE_WINDOW).active).toBe(false);
  });

  it("returns active: false when now is after the freeze window", () => {
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = PAST_END;

    expect(isFreezeWindowActive(AFTER_WINDOW).active).toBe(false);
  });
});

describe("isFreezeWindowActive — active scenario", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = PAST_END;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns active: true when now is inside the freeze window", () => {
    const status = isFreezeWindowActive(INSIDE_WINDOW);
    expect(status.active).toBe(true);
    expect(status.reason).toBeTruthy();
    expect(status.reason).toMatch(/freeze window/i);
  });

  it("includes start and end Date objects on the active status", () => {
    const status = isFreezeWindowActive(INSIDE_WINDOW);
    expect(status.start).toBeInstanceOf(Date);
    expect(status.end).toBeInstanceOf(Date);
    expect(status.start?.toISOString()).toBe(new Date(PAST_START).toISOString());
    expect(status.end?.toISOString()).toBe(new Date(PAST_END).toISOString());
  });

  it("treats the exact start boundary as active (inclusive)", () => {
    const exactStart = new Date(PAST_START);
    expect(isFreezeWindowActive(exactStart).active).toBe(true);
  });

  it("treats the exact end boundary as active (inclusive)", () => {
    const exactEnd = new Date(PAST_END);
    expect(isFreezeWindowActive(exactEnd).active).toBe(true);
  });
});

describe("isFreezeWindowActive — misconfigured / invalid env (edge cases)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.FREEZE_WINDOW_ENABLED = "true";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns active: false when FREEZE_WINDOW_START is an invalid date string", () => {
    process.env.FREEZE_WINDOW_START = "not-a-date";
    process.env.FREEZE_WINDOW_END = PAST_END;

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when FREEZE_WINDOW_END is an invalid date string", () => {
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = "INVALID_DATE";

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when both dates are invalid strings", () => {
    process.env.FREEZE_WINDOW_START = "bad";
    process.env.FREEZE_WINDOW_END = "bad";

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when dates are empty strings", () => {
    process.env.FREEZE_WINDOW_START = "   ";
    process.env.FREEZE_WINDOW_END = "   ";

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });

  it("returns active: false when start is after end (inverted window)", () => {
    // Start > End means no moment is simultaneously >= start AND <= end
    process.env.FREEZE_WINDOW_START = PAST_END;
    process.env.FREEZE_WINDOW_END = PAST_START;

    expect(isFreezeWindowActive(INSIDE_WINDOW).active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enforceFreezeWindowGuard — feature flag disabled
// ---------------------------------------------------------------------------

describe("enforceFreezeWindowGuard — feature flag disabled", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Active freeze window in env...
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = PAST_END;
    // ...but the feature flag is turned off
    process.env.FEATURE_FLAG_FREEZE_WINDOW = "false";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("does not block when freeze_window feature flag is disabled", async () => {
    const req = makeRequest();
    const guard = await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: false,
      userId: "user-1",
      userLogin: "contributor",
    });

    expect(guard.blocked).toBe(false);
    expect(guard.isOverride).toBe(false);
    expect(guard.response).toBeUndefined();
  });

  it("does not block even for maintainers when feature flag is disabled", async () => {
    const req = makeRequest();
    const guard = await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: true,
      userId: "maintainer-1",
      userLogin: "admin",
    });

    expect(guard.blocked).toBe(false);
    expect(guard.isOverride).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enforceFreezeWindowGuard — active freeze, blocking
// ---------------------------------------------------------------------------

describe("enforceFreezeWindowGuard — active freeze window blocks requests", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = PAST_END;
    delete process.env.FEATURE_FLAG_FREEZE_WINDOW; // use default (enabled)
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("blocks non-maintainer contributor recheck with HTTP 423", async () => {
    const req = makeRequest();
    const guard = await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: false,
      userId: "user-123",
      userLogin: "contributor1",
      actionLabel: "recheck",
    });

    expect(guard.blocked).toBe(true);
    expect(guard.response?.status).toBe(423);
  });

  it("responds with WAVE_FREEZE_ACTIVE error code and informative message", async () => {
    const req = makeRequest();
    const guard = await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: false,
      userId: "user-123",
      userLogin: "contributor1",
    });

    const json = await guard.response?.json();
    expect(json.code).toBe("WAVE_FREEZE_ACTIVE");
    expect(json.error).toMatch(/frozen for wave payout/i);
  });

  it("includes freezeWindow metadata in the 423 response body", async () => {
    const req = makeRequest();
    const guard = await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: false,
      userId: "user-123",
      userLogin: "contributor1",
    });

    const json = await guard.response?.json();
    expect(json.freezeWindow).toBeDefined();
    expect(json.freezeWindow.active).toBe(true);
    expect(json.freezeWindow.start).toBeTruthy();
    expect(json.freezeWindow.end).toBeTruthy();
  });

  it("blocks a maintainer who does NOT supply an override header", async () => {
    const req = makeRequest(); // no x-freeze-override header
    const guard = await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: true,
      userId: "maintainer-1",
      userLogin: "admin",
    });

    expect(guard.blocked).toBe(true);
    expect(guard.response?.status).toBe(423);
  });

  it("blocks a non-maintainer who supplies override header (non-maintainer cannot override)", async () => {
    const req = makeRequest(undefined, { "x-freeze-override": "true" });
    const guard = await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: false,
      userId: "user-456",
      userLogin: "contributor_sneaky",
    });

    expect(guard.blocked).toBe(true);
    expect(guard.response?.status).toBe(423);
    expect(guard.isOverride).toBe(false);
  });

  it("records a freeze_blocked audit event when a request is blocked", async () => {
    const { recordAuditLog } = await import("@/lib/audit");
    const req = makeRequest();
    await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: false,
      userId: "user-789",
      userLogin: "blocked_user",
      actionLabel: "recheck",
    });

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "recheck.freeze_blocked",
        actorId: "user-789",
        actorLogin: "blocked_user",
      })
    );
  });

  it("records overrideAttempted:true in the audit log when a non-maintainer tries to override", async () => {
    const { recordAuditLog } = await import("@/lib/audit");
    const req = makeRequest(undefined, { "x-freeze-override": "true" });
    await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: false,
      userId: "user-999",
      userLogin: "sneaky_contributor",
      actionLabel: "recheck.batch",
    });

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "recheck.batch.freeze_blocked",
        metadata: expect.objectContaining({ overrideAttempted: true }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// enforceFreezeWindowGuard — maintainer override paths
// ---------------------------------------------------------------------------

describe("enforceFreezeWindowGuard — maintainer override", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.FREEZE_WINDOW_ENABLED = "true";
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = PAST_END;
    delete process.env.FEATURE_FLAG_FREEZE_WINDOW;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("allows a maintainer request with x-freeze-override: true header", async () => {
    const req = makeRequest(undefined, { "x-freeze-override": "true" });
    const guard = await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: true,
      userId: "maintainer-1",
      userLogin: "admin_user",
    });

    expect(guard.blocked).toBe(false);
    expect(guard.isOverride).toBe(true);
    expect(guard.response).toBeUndefined();
  });

  it("allows a maintainer request with overrideFreeze=true query param", async () => {
    const req = makeRequest(
      "http://localhost:3000/api/contributors?overrideFreeze=true"
    );
    const guard = await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: true,
      userId: "maintainer-2",
      userLogin: "superadmin",
    });

    expect(guard.blocked).toBe(false);
    expect(guard.isOverride).toBe(true);
  });

  it("records a freeze_override audit event when a maintainer overrides", async () => {
    const { recordAuditLog } = await import("@/lib/audit");
    const req = makeRequest(undefined, { "x-freeze-override": "true" });
    await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: true,
      userId: "maintainer-3",
      userLogin: "override_admin",
      actionLabel: "recheck.batch",
    });

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "recheck.batch.freeze_override",
        actorId: "maintainer-3",
        actorLogin: "override_admin",
        metadata: expect.objectContaining({
          reason: expect.stringMatching(/override/i),
        }),
      })
    );
  });

  it("override header value matching is case-insensitive (TRUE, True, etc.)", async () => {
    for (const val of ["TRUE", "True", "true"]) {
      const req = makeRequest(undefined, { "x-freeze-override": val });
      const guard = await enforceFreezeWindowGuard({
        request: req,
        isMaintainer: true,
        userId: "maintainer-4",
        userLogin: "admin4",
      });
      expect(guard.blocked).toBe(false);
      expect(guard.isOverride).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// enforceFreezeWindowGuard — inactive window (no blocking)
// ---------------------------------------------------------------------------

describe("enforceFreezeWindowGuard — inactive freeze window", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.FEATURE_FLAG_FREEZE_WINDOW;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("does not block when window is in the past and now is after it", () => {
    // The test runs at an arbitrary time; we just remove FREEZE_WINDOW_* so the
    // helper sees no window at all → inactive.
    delete process.env.FREEZE_WINDOW_ENABLED;
    delete process.env.FREEZE_WINDOW_START;
    delete process.env.FREEZE_WINDOW_END;

    return (async () => {
      const req = makeRequest();
      const guard = await enforceFreezeWindowGuard({
        request: req,
        isMaintainer: false,
        userId: "user-1",
        userLogin: "contrib",
      });
      expect(guard.blocked).toBe(false);
      expect(guard.response).toBeUndefined();
    })();
  });

  it("does not block when FREEZE_WINDOW_ENABLED is 'false' even with valid dates", async () => {
    process.env.FREEZE_WINDOW_ENABLED = "false";
    process.env.FREEZE_WINDOW_START = PAST_START;
    process.env.FREEZE_WINDOW_END = PAST_END;

    const req = makeRequest();
    const guard = await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: false,
      userId: "user-2",
      userLogin: "contrib2",
    });

    expect(guard.blocked).toBe(false);
    expect(guard.isOverride).toBe(false);
  });

  it("does not record any audit log when window is inactive", async () => {
    const { recordAuditLog } = await import("@/lib/audit");
    delete process.env.FREEZE_WINDOW_START;
    delete process.env.FREEZE_WINDOW_END;

    const req = makeRequest();
    await enforceFreezeWindowGuard({
      request: req,
      isMaintainer: false,
      userId: "user-3",
      userLogin: "contrib3",
    });

    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});
