/**
 * Unit tests for the opt-in tracing module (issue #203).
 *
 * No collector required. Verifies: default-off passthrough, PII redaction of
 * span attributes, address/email scrubbing from span names, and error
 * propagation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isTracingEnabled,
  redactSpanAttributes,
  resetTracingForTests,
  sanitizeSpanName,
  withSpan,
} from "@/lib/tracing";

const ORIGINAL_ENV = process.env;
const SAMPLE_ADDRESS = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.OTEL_TRACES_ENABLED;
  delete process.env.FEATURE_FLAG_OTEL_TRACES;
  delete process.env.DEBUG;
  resetTracingForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("isTracingEnabled", () => {
  it("is off by default", () => {
    expect(isTracingEnabled()).toBe(false);
  });

  it("is on with OTEL_TRACES_ENABLED truthy", () => {
    process.env.OTEL_TRACES_ENABLED = "1";
    expect(isTracingEnabled()).toBe(true);
  });

  it("is on with the otel_traces env flag", () => {
    process.env.FEATURE_FLAG_OTEL_TRACES = "true";
    expect(isTracingEnabled()).toBe(true);
  });
});

describe("sanitizeSpanName", () => {
  it("strips Stellar addresses", () => {
    expect(sanitizeSpanName(`horizon.loadAccount ${SAMPLE_ADDRESS}`)).toBe(
      "horizon.loadAccount {address}",
    );
  });

  it("strips emails", () => {
    expect(sanitizeSpanName("email.send to alice@example.com")).toBe(
      "email.send to {email}",
    );
  });

  it("caps length", () => {
    expect(sanitizeSpanName("x".repeat(500)).length).toBe(200);
  });
});

describe("redactSpanAttributes", () => {
  it("redacts addresses and tokens but keeps benign values", () => {
    const out = redactSpanAttributes({
      "horizon.url": "https://horizon.stellar.org",
      address: SAMPLE_ADDRESS,
      note: "hello",
    });
    expect(out?.["horizon.url"]).toBe("https://horizon.stellar.org");
    expect(out?.note).toBe("hello");
    expect(String(out?.address)).toContain("redacted");
  });

  it("returns undefined for no attributes", () => {
    expect(redactSpanAttributes(undefined)).toBeUndefined();
  });
});

describe("withSpan (disabled)", () => {
  it("is a transparent passthrough and emits nothing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fn = vi.fn().mockResolvedValue(42);

    await expect(withSpan("api.check", fn)).resolves.toBe(42);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe("withSpan (enabled)", () => {
  beforeEach(() => {
    process.env.OTEL_TRACES_ENABLED = "1";
    // The structured logger only emits debug spans for DEBUG=true.
    process.env.DEBUG = "true";
  });

  it("returns the wrapped value and logs a span", async () => {
    // Spans go through the structured logger (stdout), not console.log.
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await expect(withSpan("prisma.User.findMany", () => "ok")).resolves.toBe(
      "ok",
    );

    const payloads = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(payloads.some((p) => p.includes('"span"'))).toBe(true);
    expect(payloads.some((p) => p.includes("prisma.User.findMany"))).toBe(true);

    writeSpy.mockRestore();
  });

  it("propagates errors and never leaks an address into the log", async () => {
    // Error spans go through the structured logger (stderr).
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await expect(
      withSpan(
        `horizon.loadAccount ${SAMPLE_ADDRESS}`,
        () => {
          throw new Error(`account ${SAMPLE_ADDRESS} not found`);
        },
        { attributes: { address: SAMPLE_ADDRESS } },
      ),
    ).rejects.toThrow(/not found/);

    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain(SAMPLE_ADDRESS);
    expect(logged).toContain("{address}");
  });
});
