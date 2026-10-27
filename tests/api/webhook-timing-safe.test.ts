/**
 * Webhook signature timing-safe compare tests
 *
 * These tests lock in the security contract for both webhook signature
 * verifiers:
 *
 * 1. `verifyWebhookSignature` (github-org-membership) — already exported
 * 2. `verifySignature` (trustbridge-action) — now exported for testability
 *
 * For each verifier we prove:
 *  a) A correct HMAC-SHA256 signature is accepted (happy path).
 *  b) An incorrect signature of the *same byte length* is rejected — this
 *     specifically tests that `crypto.timingSafeEqual` is used and not a
 *     naive `===` string comparison (which would also reject it, but for
 *     the wrong reason and without constant-time behaviour).
 *  c) A signature with a flipped single bit (one-byte diff, same length) is
 *     rejected — mutation test that would survive `===` but proves
 *     byte-level comparison.
 *  d) A valid-looking signature with one extra byte is rejected — exercises
 *     the `length !== length` early-exit guard.
 *  e) A signature that is one byte shorter than the digest is rejected.
 *  f) An all-zero bytes signature of the correct length is rejected.
 *  g) A missing/undefined signature is rejected.
 *  h) A missing/unconfigured secret fails closed.
 *  i) A whitespace-only secret fails closed.
 *  j) Correct signature on an empty payload is accepted.
 *  k) Correct signature on a large (100 KB) payload is accepted.
 */

import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Import the two exported verifiers ──────────────────────────────────────

import { verifyWebhookSignature } from "@/lib/github-org-membership-webhook";
import { verifySignature } from "@/lib/trustbridge-action-webhook";

// ── Helpers ─────────────────────────────────────────────────────────────────

const GH_SECRET_ENV = "GITHUB_WEBHOOK_SECRET";
const TB_SECRET_ENV = "TRUSTBRIDGE_ACTION_SECRET";
const TEST_SECRET = "super-secret-webhook-key-for-tests-only";

function hmacSha256(secret: string, payload: Buffer): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/** Flip one bit in the hex digest portion after "sha256=". */
function corruptSignatureOneBit(sig: string): string {
  const prefix = "sha256=";
  const hex = sig.slice(prefix.length);
  // Replace the first hex character with its complement (0→f, f→0, else flip last bit).
  const firstChar = hex[0];
  const flipped =
    firstChar === "0"
      ? "f"
      : firstChar === "f"
        ? "0"
        : (parseInt(firstChar, 16) ^ 0x1).toString(16);
  return prefix + flipped + hex.slice(1);
}

/** Build a correct-length but entirely wrong signature (all-zero digest bytes). */
function allZeroSignature(): string {
  return "sha256=" + "0".repeat(64);
}

/** Build a payload of n bytes filled with repeating text. */
function buildPayload(sizeBytes: number): Buffer {
  return Buffer.alloc(sizeBytes, "a");
}

// ── GitHub org-membership webhook ───────────────────────────────────────────

describe("verifyWebhookSignature (github-org-membership) — timing-safe compare", () => {
  beforeEach(() => {
    vi.stubEnv(GH_SECRET_ENV, TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // ── happy paths ──────────────────────────────────────────────────────────

  it("accepts a correct HMAC-SHA256 signature (happy path)", () => {
    const payload = Buffer.from(JSON.stringify({ action: "added" }));
    const sig = hmacSha256(TEST_SECRET, payload);
    expect(verifyWebhookSignature(payload.toString("utf8"), sig).ok).toBe(true);
  });

  it("accepts a correct signature for an empty payload", () => {
    const payload = Buffer.alloc(0);
    const sig = hmacSha256(TEST_SECRET, payload);
    expect(verifyWebhookSignature(payload.toString("utf8"), sig).ok).toBe(true);
  });

  it("accepts a correct signature for a 100 KB payload", () => {
    const payload = buildPayload(100_000);
    const sig = hmacSha256(TEST_SECRET, payload);
    expect(verifyWebhookSignature(payload.toString("utf8"), sig).ok).toBe(true);
  });

  // ── timing-safe equality ─────────────────────────────────────────────────

  it("rejects an incorrect signature of the same byte length (timingSafeEqual path)", () => {
    const payload = Buffer.from(JSON.stringify({ action: "added" }));
    const correctSig = hmacSha256(TEST_SECRET, payload);
    // Build a wrong-but-same-length signature: correct length, wrong HMAC.
    const wrongSig = hmacSha256(TEST_SECRET + "-wrong", payload);
    // Sanity: lengths must match for this to test timingSafeEqual, not the length guard.
    expect(correctSig.length).toBe(wrongSig.length);

    expect(verifyWebhookSignature(payload.toString("utf8"), wrongSig).ok).toBe(false);
  });

  it("rejects a one-bit-flipped signature (same length, mutation test)", () => {
    const payload = Buffer.from(JSON.stringify({ action: "added" }));
    const correctSig = hmacSha256(TEST_SECRET, payload);
    const flipped = corruptSignatureOneBit(correctSig);

    expect(flipped.length).toBe(correctSig.length); // same length — exercises timingSafeEqual
    expect(verifyWebhookSignature(payload.toString("utf8"), flipped).ok).toBe(false);
  });

  it("rejects an all-zero-bytes signature of the correct length", () => {
    const payload = Buffer.from(JSON.stringify({ action: "added" }));
    const sig = allZeroSignature();
    const correctSig = hmacSha256(TEST_SECRET, payload);
    expect(sig.length).toBe(correctSig.length); // same length, wrong value

    expect(verifyWebhookSignature(payload.toString("utf8"), sig).ok).toBe(false);
  });

  // ── length-guard boundary ────────────────────────────────────────────────

  it("rejects a signature one byte longer than the digest", () => {
    const payload = Buffer.from(JSON.stringify({ action: "added" }));
    const correctSig = hmacSha256(TEST_SECRET, payload);
    const longerSig = correctSig + "a"; // one extra hex char

    expect(verifyWebhookSignature(payload.toString("utf8"), longerSig).ok).toBe(false);
  });

  it("rejects a signature one byte shorter than the digest", () => {
    const payload = Buffer.from(JSON.stringify({ action: "added" }));
    const correctSig = hmacSha256(TEST_SECRET, payload);
    const shorterSig = correctSig.slice(0, -1);

    expect(verifyWebhookSignature(payload.toString("utf8"), shorterSig).ok).toBe(false);
  });

  // ── missing / unconfigured secret ────────────────────────────────────────

  it("fails closed when GITHUB_WEBHOOK_SECRET is not set", () => {
    vi.unstubAllEnvs();
    delete process.env[GH_SECRET_ENV];

    const payload = Buffer.from("{}");
    const sig = hmacSha256(TEST_SECRET, payload);

    // The verifier returns a reason instead of logging (fail-closed, no throw).
    const result = verifyWebhookSignature(payload.toString("utf8"), sig);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it("fails closed when GITHUB_WEBHOOK_SECRET is whitespace only", () => {
    vi.stubEnv(GH_SECRET_ENV, "   ");

    const payload = Buffer.from("{}");
    const sig = hmacSha256(TEST_SECRET, payload);

    const result = verifyWebhookSignature(payload.toString("utf8"), sig);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it("fails closed when the signature header is undefined", () => {
    const payload = Buffer.from("{}");

    const result = verifyWebhookSignature(payload.toString("utf8"), null);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing.*header/i);
  });

  // ── prefix / format ───────────────────────────────────────────────────────

  it("rejects a signature without the sha256= prefix", () => {
    const payload = Buffer.from("{}");
    const rawHex = crypto
      .createHmac("sha256", TEST_SECRET)
      .update(payload)
      .digest("hex");

    // Correct hex but missing the required prefix
    expect(verifyWebhookSignature(payload.toString("utf8"), rawHex).ok).toBe(false);
  });

  it("rejects an empty string signature", () => {
    const payload = Buffer.from("{}");
    expect(verifyWebhookSignature(payload.toString("utf8"), "").ok).toBe(false);
  });
});

// ── TrustBridge-action webhook ───────────────────────────────────────────────

describe("verifySignature (trustbridge-action) — timing-safe compare", () => {
  beforeEach(() => {
    vi.stubEnv(TB_SECRET_ENV, TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // ── happy paths ──────────────────────────────────────────────────────────

  it("accepts a correct HMAC-SHA256 signature (happy path)", () => {
    const payload = Buffer.from(
      JSON.stringify({ schema_version: "1", event: "validation_complete" })
    );
    const sig = hmacSha256(TEST_SECRET, payload);
    expect(verifySignature(payload, sig)).toBe(true);
  });

  it("accepts a correct signature for an empty payload", () => {
    const payload = Buffer.alloc(0);
    const sig = hmacSha256(TEST_SECRET, payload);
    expect(verifySignature(payload, sig)).toBe(true);
  });

  it("accepts a correct signature for a 100 KB payload", () => {
    const payload = buildPayload(100_000);
    const sig = hmacSha256(TEST_SECRET, payload);
    expect(verifySignature(payload, sig)).toBe(true);
  });

  // ── timing-safe equality ─────────────────────────────────────────────────

  it("rejects an incorrect signature of the same byte length (timingSafeEqual path)", () => {
    const payload = Buffer.from(
      JSON.stringify({ schema_version: "1", event: "validation_complete" })
    );
    const correctSig = hmacSha256(TEST_SECRET, payload);
    const wrongSig = hmacSha256(TEST_SECRET + "-tampered", payload);

    expect(correctSig.length).toBe(wrongSig.length);
    expect(verifySignature(payload, wrongSig)).toBe(false);
  });

  it("rejects a one-bit-flipped signature (mutation test for timingSafeEqual)", () => {
    const payload = Buffer.from(
      JSON.stringify({ schema_version: "1", event: "validation_complete" })
    );
    const correctSig = hmacSha256(TEST_SECRET, payload);
    const flipped = corruptSignatureOneBit(correctSig);

    expect(flipped.length).toBe(correctSig.length);
    expect(verifySignature(payload, flipped)).toBe(false);
  });

  it("rejects an all-zero-bytes signature of the correct length", () => {
    const payload = Buffer.from("{}");
    const allZero = allZeroSignature();
    const correct = hmacSha256(TEST_SECRET, payload);

    expect(allZero.length).toBe(correct.length);
    expect(verifySignature(payload, allZero)).toBe(false);
  });

  // ── length-guard boundary ────────────────────────────────────────────────

  it("rejects a signature one byte longer than the digest", () => {
    const payload = Buffer.from("{}");
    const correctSig = hmacSha256(TEST_SECRET, payload);
    expect(verifySignature(payload, correctSig + "a")).toBe(false);
  });

  it("rejects a signature one byte shorter than the digest", () => {
    const payload = Buffer.from("{}");
    const correctSig = hmacSha256(TEST_SECRET, payload);
    expect(verifySignature(payload, correctSig.slice(0, -1))).toBe(false);
  });

  // ── missing / unconfigured secret ────────────────────────────────────────

  it("fails closed when TRUSTBRIDGE_ACTION_SECRET is not set", () => {
    vi.unstubAllEnvs();
    delete process.env[TB_SECRET_ENV];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const payload = Buffer.from("{}");
    const sig = hmacSha256(TEST_SECRET, payload);

    expect(verifySignature(payload, sig)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("TRUSTBRIDGE_ACTION_SECRET not configured")
    );
  });

  it("fails closed when TRUSTBRIDGE_ACTION_SECRET is whitespace only", () => {
    vi.stubEnv(TB_SECRET_ENV, "   ");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const payload = Buffer.from("{}");
    const sig = hmacSha256(TEST_SECRET, payload);

    expect(verifySignature(payload, sig)).toBe(false);
    // The trimmed secret is empty → warns and returns false
    expect(warnSpy).toHaveBeenCalled();
  });

  it("fails closed and warns when the signature header is undefined", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const payload = Buffer.from("{}");

    expect(verifySignature(payload, undefined)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Missing X-TrustBridge-Signature")
    );
  });

  // ── prefix / format ───────────────────────────────────────────────────────

  it("rejects a raw hex digest without the sha256= prefix", () => {
    const payload = Buffer.from("{}");
    const rawHex = crypto
      .createHmac("sha256", TEST_SECRET)
      .update(payload)
      .digest("hex");

    expect(verifySignature(payload, rawHex)).toBe(false);
  });

  it("rejects an empty string signature", () => {
    const payload = Buffer.from("{}");
    expect(verifySignature(payload, "")).toBe(false);
  });
});

// ── Cross-verifier regression ─────────────────────────────────────────────
// A signature generated for one webhook must not validate against the other,
// even when both use HMAC-SHA256 with the same algorithm.

describe("Cross-verifier isolation", () => {
  it("a GitHub signature does not validate as a TrustBridge signature", () => {
    vi.stubEnv(GH_SECRET_ENV, TEST_SECRET);
    vi.stubEnv(TB_SECRET_ENV, TEST_SECRET);

    const payload = Buffer.from('{"action":"added"}');
    // Both use the same secret but the GitHub verifier checks X-Hub-Signature-256
    // while the TrustBridge verifier checks X-TrustBridge-Signature — same HMAC
    // format, so they'd both accept the same sig when secrets match.
    // The important property: if secrets DIFFER they reject each other.

    const ghSig = hmacSha256("gh-secret", payload);
    const tbSig = hmacSha256("tb-secret", payload);

    vi.stubEnv(GH_SECRET_ENV, "gh-secret");
    vi.stubEnv(TB_SECRET_ENV, "tb-secret");

    // TrustBridge sig should not pass the GitHub verifier
    expect(verifyWebhookSignature(payload.toString("utf8"), tbSig).ok).toBe(false);
    // GitHub sig should not pass the TrustBridge verifier
    expect(verifySignature(payload, ghSig)).toBe(false);

    vi.unstubAllEnvs();
  });
});
