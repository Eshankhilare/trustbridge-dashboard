import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sendEmailNotification,
  buildInviteEmail,
  buildBanEmail,
  buildNotReadyEmailBody,
  buildTreasuryExportEmailBody,
} from "@/lib/email";

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { recordAuditLog } from "@/lib/audit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockFetchSequence(
  responses: Array<{ ok: boolean; status: number; statusText: string; body?: string }>
) {
  let call = 0;
  return vi.fn().mockImplementation(async () => {
    const r = responses[Math.min(call++, responses.length - 1)];
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      text: async () => r.body ?? "",
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("localized invite and ban email templates", () => {
  it.each([
    ["en", "Your TrustBridge invitation", "contributor account has been suspended"],
    ["es", "Tu invitación a TrustBridge", "suspendido tu cuenta de colaborador"],
    ["pt", "Seu convite para o TrustBridge", "suspendeu sua conta de contribuidor"],
  ])("renders invite and ban notices in %s", (locale, inviteText, banText) => {
    const invite = buildInviteEmail({
      inviteCode: "safe-code",
      recipientName: "Contributor",
      locale,
    });
    const ban = buildBanEmail({
      githubUsername: "contributor",
      reason: "Repeated abuse",
      locale,
    });

    expect(invite.subject).toBeTruthy();
    expect(invite.body).toContain(inviteText);
    expect(invite.body).toContain("safe-code");
    expect(ban.subject).toBeTruthy();
    expect(ban.body).toContain(banText);
    expect(ban.body).toContain("Repeated abuse");
  });

  it("falls back to English for unsupported locales and escapes interpolated HTML", () => {
    const invite = buildInviteEmail({
      inviteCode: "<script>alert(1)</script>",
      recipientName: "<Contributor>",
      locale: "fr",
    });
    const ban = buildBanEmail({
      githubUsername: "<Contributor>",
      reason: "Misuse & abuse",
      locale: "fr",
    });

    expect(invite.subject).toBe("You're invited to TrustBridge");
    expect(invite.body).toContain("&lt;Contributor&gt;");
    expect(invite.body).toContain("&lt;script&gt;");
    expect(invite.body).not.toContain("<script>");
    expect(ban.subject).toBe("TrustBridge account access notice");
    expect(ban.body).toContain("&lt;Contributor&gt;");
    expect(ban.body).toContain("Misuse &amp; abuse");
  });

  it("falls back to English for non-string locale input", () => {
    const invite = buildInviteEmail({ inviteCode: "safe-code", locale: 7 as never });
    expect(invite.subject).toBe("You're invited to TrustBridge");
  });

  it("rejects missing invite codes and ban details", () => {
    expect(() => buildInviteEmail({ inviteCode: " " })).toThrow(
      "Invite code is required"
    );
    expect(() =>
      buildBanEmail({ githubUsername: "user", reason: " " })
    ).toThrow("Ban reason is required");
  });
});

describe("Email service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("buildNotReadyEmailBody", () => {
    it("builds not-ready email body with unfunded reason", () => {
      const body = buildNotReadyEmailBody("contributor1", "unfunded");
      expect(body).toContain("contributor1");
      expect(body).toContain("Account not funded with XLM");
      expect(body).toContain("maintainer dashboard");
    });

    it("builds not-ready email body with no_trustline reason", () => {
      const body = buildNotReadyEmailBody("contributor2", "no_trustline");
      expect(body).toContain("contributor2");
      expect(body).toContain("USDC trustline not established");
    });

    it("builds not-ready email body with low_reserve reason", () => {
      const body = buildNotReadyEmailBody("contributor3", "low_reserve");
      expect(body).toContain("contributor3");
      expect(body).toContain("Insufficient spendable XLM balance");
    });
  });

  it("builds treasury export email body with summary and stale warning", () => {
    const body = buildTreasuryExportEmailBody({
      totalContributors: 50,
      readyCount: 45,
      lowReserveCount: 3,
      notReadyCount: 2,
      staleCount: 5,
      filename: "contributors-2026-08-30.csv",
      exportedAt: "2026-08-30T05:00:00.000Z",
    });

    expect(body).toContain("Nightly Treasury Contributor Export");
    expect(body).toContain("Total Contributors:");
    expect(body).toContain("50");
    expect(body).toContain("Ready for Payout:");
    expect(body).toContain("45 (90%)");
    expect(body).toContain("Low Reserve:");
    expect(body).toContain("3");
    expect(body).toContain("Not Ready:");
    expect(body).toContain("2");
    expect(body).toContain("contributors-2026-08-30.csv");
    expect(body).toContain("Stale Data Warning:");
    expect(body).toContain("5 of 50 contributor records");
  });

  it("builds treasury export email body without stale warning when staleCount is 0", () => {
    const body = buildTreasuryExportEmailBody({
      totalContributors: 10,
      readyCount: 10,
      staleCount: 0,
      filename: "contributors-2026-08-30.csv",
    });

    expect(body).toContain("Nightly Treasury Contributor Export");
    expect(body).not.toContain("Stale Data Warning");
  });

  it("sends notification with console service and attachments", async () => {
    const consoleSpy = vi.spyOn(console, "log");
    const result = await sendEmailNotification({
      to: "treasury@example.com",
      subject: "Test export email",
      body: "Test body",
      attachments: [
        {
          filename: "test.csv",
          content: "id,username\n1,alice",
          contentType: "text/csv",
        },
      ],
    });

    expect(result).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("treasury@example.com"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("test.csv"));
    consoleSpy.mockRestore();
  });

  describe("console provider", () => {
    it("sends notification with console service", async () => {
      const consoleSpy = vi.spyOn(console, "log");
      const result = await sendEmailNotification({
        to: "test@example.com",
        subject: "Test email",
        body: "Test body",
      });

      expect(result).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("test@example.com")
      );
      consoleSpy.mockRestore();
    });
  });

  describe("resend provider — retry and jitter", () => {
    beforeEach(() => {
      process.env.EMAIL_SERVICE = "resend";
      process.env.RESEND_API_KEY = "re_test_key_123";
    });

    afterEach(() => {
      delete process.env.EMAIL_SERVICE;
      delete process.env.RESEND_API_KEY;
      delete process.env.EMAIL_MAX_ATTEMPTS;
    });

    it("succeeds on first attempt without retry", async () => {
      globalThis.fetch = mockFetchSequence([{ ok: true, status: 200, statusText: "OK" }]);

      const result = await sendEmailNotification({
        to: "a@example.com",
        subject: "Hello",
        body: "<p>Hi</p>",
      });

      expect(result).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("retries after 500 and succeeds", async () => {
      globalThis.fetch = mockFetchSequence([
        { ok: false, status: 500, statusText: "Internal Server Error" },
        { ok: true, status: 200, statusText: "OK" },
      ]);

      const result = await sendEmailNotification({
        to: "b@example.com",
        subject: "Retry test",
        body: "<p>Hi</p>",
      });

      expect(result).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("retries after 429 and succeeds", async () => {
      globalThis.fetch = mockFetchSequence([
        { ok: false, status: 429, statusText: "Too Many Requests" },
        { ok: true, status: 200, statusText: "OK" },
      ]);

      const result = await sendEmailNotification({
        to: "c@example.com",
        subject: "Rate limit test",
        body: "<p>Hi</p>",
      });

      expect(result).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on 400 (permanent client error)", async () => {
      globalThis.fetch = mockFetchSequence([
        { ok: false, status: 400, statusText: "Bad Request", body: "invalid" },
      ]);

      const result = await sendEmailNotification({
        to: "d@example.com",
        subject: "No retry",
        body: "<p>Hi</p>",
      });

      expect(result).toBe(false);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on 401 (auth failure)", async () => {
      globalThis.fetch = mockFetchSequence([
        { ok: false, status: 401, statusText: "Unauthorized" },
      ]);

      const result = await sendEmailNotification({
        to: "e@example.com",
        subject: "Auth fail",
        body: "<p>Hi</p>",
      });

      expect(result).toBe(false);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on 403 (forbidden)", async () => {
      globalThis.fetch = mockFetchSequence([
        { ok: false, status: 403, statusText: "Forbidden" },
      ]);

      const result = await sendEmailNotification({
        to: "f@example.com",
        subject: "Forbidden",
        body: "<p>Hi</p>",
      });

      expect(result).toBe(false);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("exhausts retries on persistent 500 and returns false", async () => {
      process.env.EMAIL_MAX_ATTEMPTS = "2";
      globalThis.fetch = mockFetchSequence([
        { ok: false, status: 500, statusText: "Internal Server Error" },
        { ok: false, status: 500, statusText: "Internal Server Error" },
      ]);

      const result = await sendEmailNotification({
        to: "g@example.com",
        subject: "Exhaust",
        body: "<p>Hi</p>",
      });

      expect(result).toBe(false);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("records audit log on exhaustion", async () => {
      process.env.EMAIL_MAX_ATTEMPTS = "2";
      globalThis.fetch = mockFetchSequence([
        { ok: false, status: 500, statusText: "Internal Server Error" },
        { ok: false, status: 500, statusText: "Internal Server Error" },
      ]);

      await sendEmailNotification({
        to: "h@example.com",
        subject: "Audit test",
        body: "<p>Hi</p>",
      });

      expect(recordAuditLog).toHaveBeenCalledTimes(1);
      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "email.send_failed",
          targetLabel: "h@example.com",
          metadata: expect.objectContaining({
            subject: "Audit test",
            attempts: 2,
          }),
        })
      );
    });

    it("sends idempotency key header", async () => {
      globalThis.fetch = mockFetchSequence([{ ok: true, status: 200, statusText: "OK" }]);

      await sendEmailNotification({
        to: "i@example.com",
        subject: "Idempotency",
        body: "<p>Hi</p>",
      });

      const callArgs = (globalThis.fetch as any).mock.calls[0][1];
      expect(callArgs.headers["Idempotency-Key"]).toMatch(/^[a-f0-9]{32}$/);
    });

    it("same recipient+subject produces same idempotency key", async () => {
      globalThis.fetch = mockFetchSequence([
        { ok: true, status: 200, statusText: "OK" },
        { ok: true, status: 200, statusText: "OK" },
      ]);

      await sendEmailNotification({
        to: "j@example.com",
        subject: "Same key",
        body: "<p>A</p>",
      });
      await sendEmailNotification({
        to: "j@example.com",
        subject: "Same key",
        body: "<p>B</p>",
      });

      const key1 = (globalThis.fetch as any).mock.calls[0][1].headers["Idempotency-Key"];
      const key2 = (globalThis.fetch as any).mock.calls[1][1].headers["Idempotency-Key"];
      expect(key1).toBe(key2);
    });

    it("uses a distinct idempotency key for each invite scope", async () => {
      globalThis.fetch = mockFetchSequence([
        { ok: true, status: 200, statusText: "OK" },
        { ok: true, status: 200, statusText: "OK" },
      ]);

      await sendEmailNotification({
        to: "guest@example.com",
        subject: "Invitation",
        body: "Invite one",
        idempotencyScope: "invite-1",
      });
      await sendEmailNotification({
        to: "guest@example.com",
        subject: "Invitation",
        body: "Invite two",
        idempotencyScope: "invite-2",
      });

      const firstKey = (globalThis.fetch as any).mock.calls[0][1].headers[
        "Idempotency-Key"
      ];
      const secondKey = (globalThis.fetch as any).mock.calls[1][1].headers[
        "Idempotency-Key"
      ];
      expect(firstKey).not.toBe(secondKey);
    });

    it("respects EMAIL_MAX_ATTEMPTS cap at 5", { timeout: 15000 }, async () => {
      process.env.EMAIL_MAX_ATTEMPTS = "10";
      globalThis.fetch = mockFetchSequence([
        { ok: false, status: 500, statusText: "Error" },
        { ok: false, status: 500, statusText: "Error" },
        { ok: false, status: 500, statusText: "Error" },
        { ok: false, status: 500, statusText: "Error" },
        { ok: false, status: 500, statusText: "Error" },
      ]);

      const result = await sendEmailNotification({
        to: "k@example.com",
        subject: "Cap test",
        body: "<p>Hi</p>",
      });

      expect(result).toBe(false);
      // Cap is 5 even though EMAIL_MAX_ATTEMPTS=10
      expect(globalThis.fetch).toHaveBeenCalledTimes(5);
    });

    it("returns false when RESEND_API_KEY is missing", async () => {
      delete process.env.RESEND_API_KEY;

      const result = await sendEmailNotification({
        to: "l@example.com",
        subject: "No key",
        body: "<p>Hi</p>",
      });

      expect(result).toBe(false);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("retries on network error and succeeds", async () => {
      let call = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        call++;
        if (call === 1) throw new TypeError("fetch failed");
        return { ok: true, status: 200, statusText: "OK", text: async () => "" };
      });

      const result = await sendEmailNotification({
        to: "m@example.com",
        subject: "Network error",
        body: "<p>Hi</p>",
      });

      expect(result).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
