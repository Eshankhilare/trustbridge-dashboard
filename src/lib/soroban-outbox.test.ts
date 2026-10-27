import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSorobanOutbox,
  enqueueSorobanOutbox,
  getSorobanOutboxEntry,
  listSorobanOutbox,
  setSorobanOutboxSink,
  type SorobanOutboxEntry,
} from "./soroban-outbox";

// The Map and process-wide sink are separate module state: reset both for
// every case. Clearing the outbox alone does not unregister its delivery sink.
describe("in-memory Soroban outbox", () => {
  beforeEach(() => {
    clearSorobanOutbox();
    setSorobanOutboxSink(undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    clearSorobanOutbox();
    setSorobanOutboxSink(undefined);
    vi.useRealTimers();
  });

  it.each([undefined, null])("rejects a missing payload (%s) without storing it", async (payload) => {
    const sink = vi.fn();
    setSorobanOutboxSink(sink);

    await expect(enqueueSorobanOutbox(payload)).rejects.toThrow(
      "enqueueSorobanOutbox: payload is required",
    );

    expect(listSorobanOutbox()).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
  });

  it("persists a pending entry without a sink", async () => {
    const payload = { registrationId: "reg-1", githubUsername: "alice" };
    const entry = await enqueueSorobanOutbox(payload);

    expect(entry.id).toEqual(expect.any(String));
    expect(entry.id).not.toBe("");
    expect(entry).toMatchObject({
      payload,
      status: "PENDING",
      attempts: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(entry.lastError).toBeUndefined();
    expect(getSorobanOutboxEntry(entry.id)).toBe(entry);
    expect(getSorobanOutboxEntry("missing")).toBeUndefined();
    expect(listSorobanOutbox()).toEqual([entry]);
  });

  it("returns the same pending entry for an idempotency key without replacing its payload", async () => {
    const first = await enqueueSorobanOutbox({ registrationId: "reg-1" }, {
      idempotencyKey: "mirror-1",
    });
    vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
    const sink = vi.fn();
    const duplicate = await enqueueSorobanOutbox({ registrationId: "replacement" }, {
      idempotencyKey: "mirror-1",
      sink,
    });

    expect(duplicate).toBe(first);
    expect(duplicate.id).toBe("mirror-1");
    expect(duplicate.payload).toEqual({ registrationId: "reg-1" });
    expect(duplicate.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(listSorobanOutbox()).toEqual([first]);
    expect(sink).not.toHaveBeenCalled();
  });

  it("assigns distinct ids to equal payloads without an idempotency key", async () => {
    const payload = { registrationId: "reg-1" };
    const first = await enqueueSorobanOutbox(payload);
    const second = await enqueueSorobanOutbox(payload);

    expect(second.id).not.toBe(first.id);
    expect(listSorobanOutbox()).toEqual([first, second]);
  });

  it("lists entries in insertion order and keeps that order when retrying a failed entry", async () => {
    await expect(enqueueSorobanOutbox({ number: 1 }, {
      idempotencyKey: "z-first",
      sink: () => { throw new Error("unavailable"); },
    })).rejects.toThrow("unavailable");
    const second = await enqueueSorobanOutbox({ number: 2 }, { idempotencyKey: "a-second" });
    const first = await enqueueSorobanOutbox({ number: 1 }, { idempotencyKey: "z-first" });

    expect(listSorobanOutbox()).toEqual([first, second]);
    expect(first.status).toBe("PENDING");
    expect(first.attempts).toBe(1);
  });

  it("delivers a pending entry to the global sink and marks it sent after completion", async () => {
    const sink = vi.fn(async (entry: SorobanOutboxEntry) => {
      expect(entry.status).toBe("PENDING");
      expect(getSorobanOutboxEntry(entry.id)).toBe(entry);
      vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
    });
    setSorobanOutboxSink(sink);

    const entry = await enqueueSorobanOutbox({ registrationId: "reg-1" }, {
      idempotencyKey: "mirror-1",
    });
    const duplicate = await enqueueSorobanOutbox({ registrationId: "reg-1" }, {
      idempotencyKey: "mirror-1",
    });

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(entry);
    expect(entry.status).toBe("COMPLETED");
    expect(entry.attempts).toBe(0);
    expect(entry.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(entry.updatedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(duplicate).toBe(entry);
    expect(listSorobanOutbox()).toEqual([entry]);
  });

  it("uses a per-enqueue sink override without changing the global sink", async () => {
    const globalSink = vi.fn();
    const overrideSink = vi.fn();
    setSorobanOutboxSink(globalSink);

    const overridden = await enqueueSorobanOutbox({ number: 1 }, { sink: overrideSink });
    const global = await enqueueSorobanOutbox({ number: 2 });

    expect(overrideSink).toHaveBeenCalledTimes(1);
    expect(overrideSink).toHaveBeenCalledWith(overridden);
    expect(globalSink).toHaveBeenCalledTimes(1);
    expect(globalSink).toHaveBeenCalledWith(global);
    expect(overridden.status).toBe("COMPLETED");
    expect(global.status).toBe("COMPLETED");
  });

  it("propagates async failures, counts retries, and clears the error on successful retry", async () => {
    const error = new Error("Soroban unavailable");
    const failingSink = vi.fn(async () => {
      vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
      throw error;
    });
    const options = { idempotencyKey: "retry-1", sink: failingSink };

    await expect(enqueueSorobanOutbox({ version: 1 }, options)).rejects.toBe(error);
    const failed = getSorobanOutboxEntry("retry-1");
    expect(failed).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastError: "Soroban unavailable",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });

    await expect(enqueueSorobanOutbox({ version: 2 }, options)).rejects.toBe(error);
    expect(getSorobanOutboxEntry("retry-1")?.attempts).toBe(2);

    vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));
    const successfulSink = vi.fn();
    const retried = await enqueueSorobanOutbox({ version: 3 }, {
      idempotencyKey: "retry-1",
      sink: successfulSink,
    });

    expect(retried).not.toBe(failed);
    expect(retried).toMatchObject({
      id: "retry-1",
      payload: { version: 3 },
      status: "COMPLETED",
      attempts: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });
    expect(retried.lastError).toBeUndefined();
    expect(successfulSink).toHaveBeenCalledTimes(1);
    expect(successfulSink).toHaveBeenCalledWith(retried);
    expect(listSorobanOutbox()).toEqual([retried]);
  });

  it("records and rethrows non-Error synchronous sink failures", async () => {
    await expect(enqueueSorobanOutbox({ number: 1 }, {
      idempotencyKey: "sync-failure",
      sink: () => { throw "delivery failed"; },
    })).rejects.toBe("delivery failed");

    expect(getSorobanOutboxEntry("sync-failure")).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastError: "delivery failed",
    });
  });

  it("deduplicates concurrent enqueues while delivery is still pending", async () => {
    let finishDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => { finishDelivery = resolve; });
    const sink = vi.fn(() => delivery);
    const firstPromise = enqueueSorobanOutbox({ number: 1 }, {
      idempotencyKey: "concurrent",
      sink,
    });
    const duplicates = await Promise.all([
      enqueueSorobanOutbox({ number: 1 }, { idempotencyKey: "concurrent", sink }),
      enqueueSorobanOutbox({ number: 1 }, { idempotencyKey: "concurrent", sink }),
    ]);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(listSorobanOutbox()).toHaveLength(1);
    expect(duplicates[0]).toBe(duplicates[1]);
    expect(duplicates[0].status).toBe("PENDING");

    finishDelivery();
    const first = await firstPromise;
    expect(first).toBe(duplicates[0]);
    expect(first.status).toBe("COMPLETED");
    expect(listSorobanOutbox()).toEqual([first]);
  });

  it("clears all entries and allows the same key to be enqueued again", async () => {
    const first = await enqueueSorobanOutbox({ number: 1 }, { idempotencyKey: "reusable" });
    await enqueueSorobanOutbox({ number: 2 });

    clearSorobanOutbox();

    expect(listSorobanOutbox()).toEqual([]);
    expect(getSorobanOutboxEntry(first.id)).toBeUndefined();
    const fresh = await enqueueSorobanOutbox({ number: 3 }, { idempotencyKey: "reusable" });
    expect(fresh).not.toBe(first);
    expect(fresh.payload).toEqual({ number: 3 });
    expect(listSorobanOutbox()).toEqual([fresh]);
  });

  it("unregisters a global sink explicitly", async () => {
    const sink = vi.fn();
    setSorobanOutboxSink(sink);
    setSorobanOutboxSink(undefined);

    const entry = await enqueueSorobanOutbox({ number: 1 });

    expect(sink).not.toHaveBeenCalled();
    expect(entry.status).toBe("PENDING");
  });

  it("stores a large JSON payload and deduplicates it by its explicit key", async () => {
    const payload = JSON.parse(JSON.stringify({ data: "x".repeat(1024 * 1024) }));
    const entry = await enqueueSorobanOutbox(payload, { idempotencyKey: "large-payload" });
    const duplicate = await enqueueSorobanOutbox(payload, { idempotencyKey: "large-payload" });

    expect(entry.payload).toBe(payload);
    expect(entry.id).toBe("large-payload");
    expect(duplicate).toBe(entry);
    expect(listSorobanOutbox()).toEqual([entry]);
  });
});
