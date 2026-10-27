import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useJobProgress } from "@/lib/use-job-progress";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  simulateOpen() {
    if (this.onopen) this.onopen();
  }

  simulateMessage(data: Record<string, unknown>) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }

  simulateError() {
    if (this.onerror) this.onerror();
  }
}

describe("useJobProgress hook", () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    // @ts-expect-error mock EventSource
    globalThis.EventSource = MockEventSource;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.EventSource = originalEventSource;
  });

  it("initializes with default state", () => {
    const { result } = renderHook(() => useJobProgress());

    expect(result.current.activeJobId).toBeNull();
    expect(result.current.event).toBeNull();
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.isReconnecting).toBe(false);
    expect(result.current.reconnectAttempt).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it("opens EventSource connection on startProgress and receives events", () => {
    const { result } = renderHook(() => useJobProgress());

    act(() => {
      result.current.startProgress("job-123");
    });

    expect(result.current.activeJobId).toBe("job-123");
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.isReconnecting).toBe(false);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toContain("jobId=job-123");

    const es = MockEventSource.instances[0];

    // Simulate progress message
    act(() => {
      es.simulateMessage({
        type: "processing",
        jobId: "job-123",
        startedAt: "2026-09-27T12:00:00Z",
      });
    });

    expect(result.current.event?.type).toBe("processing");
    expect(result.current.isStreaming).toBe(true);

    // Simulate completion
    act(() => {
      es.simulateMessage({
        type: "completed",
        jobId: "job-123",
        result: { refreshed: 10 },
      });
    });

    expect(result.current.event?.type).toBe("completed");
    expect(result.current.isStreaming).toBe(false);
    expect(es.closed).toBe(true);
  });

  it("handles disconnect and enters reconnecting state", () => {
    const { result } = renderHook(() =>
      useJobProgress({ maxReconnectAttempts: 3, reconnectDelayMs: 500 })
    );

    act(() => {
      result.current.startProgress("job-123");
    });

    const es1 = MockEventSource.instances[0];

    // Simulate disconnect error
    act(() => {
      es1.simulateError();
    });

    expect(es1.closed).toBe(true);
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.isReconnecting).toBe(true);
    expect(result.current.reconnectAttempt).toBe(1);
    expect(result.current.error).toBeNull();

    // Advance timer to trigger reconnect
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(MockEventSource.instances).toHaveLength(2);
    const es2 = MockEventSource.instances[1];
    expect(es2.url).toContain("jobId=job-123");
  });

  it("resumes progress display on successful reconnect", () => {
    const { result } = renderHook(() =>
      useJobProgress({ maxReconnectAttempts: 3, reconnectDelayMs: 500 })
    );

    act(() => {
      result.current.startProgress("job-123");
    });

    const es1 = MockEventSource.instances[0];

    // Initial event
    act(() => {
      es1.simulateMessage({ type: "processing", jobId: "job-123" });
    });
    expect(result.current.event?.type).toBe("processing");

    // Disconnect
    act(() => {
      es1.simulateError();
    });
    expect(result.current.isReconnecting).toBe(true);

    // Advance timer to reconnect
    act(() => {
      vi.advanceTimersByTime(500);
    });

    const es2 = MockEventSource.instances[1];

    // Successful event after reconnect
    act(() => {
      es2.simulateMessage({
        type: "completed",
        jobId: "job-123",
        result: { refreshed: 5 },
      });
    });

    expect(result.current.isReconnecting).toBe(false);
    expect(result.current.reconnectAttempt).toBe(0);
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.event?.type).toBe("completed");
    expect(result.current.error).toBeNull();
  });

  it("surfaces error when all reconnect attempts fail", () => {
    const { result } = renderHook(() =>
      useJobProgress({ maxReconnectAttempts: 2, reconnectDelayMs: 200 })
    );

    act(() => {
      result.current.startProgress("job-123");
    });

    // Attempt 1 fails
    act(() => {
      MockEventSource.instances[0].simulateError();
    });
    expect(result.current.isReconnecting).toBe(true);
    expect(result.current.reconnectAttempt).toBe(1);

    // Wait and reconnect
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Attempt 2 fails
    expect(MockEventSource.instances).toHaveLength(2);
    act(() => {
      MockEventSource.instances[1].simulateError();
    });
    expect(result.current.isReconnecting).toBe(true);
    expect(result.current.reconnectAttempt).toBe(2);

    // Wait and reconnect
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Final attempt fails
    expect(MockEventSource.instances).toHaveLength(3);
    act(() => {
      MockEventSource.instances[2].simulateError();
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.isReconnecting).toBe(false);
    expect(result.current.error).toContain("Connection lost. Failed to reconnect after 2 attempts.");
  });

  it("cancels reconnect timers and closes connection on stopProgress", () => {
    const { result } = renderHook(() =>
      useJobProgress({ maxReconnectAttempts: 3, reconnectDelayMs: 1000 })
    );

    act(() => {
      result.current.startProgress("job-123");
    });

    // Disconnect
    act(() => {
      MockEventSource.instances[0].simulateError();
    });
    expect(result.current.isReconnecting).toBe(true);

    // Stop progress manually
    act(() => {
      result.current.stopProgress();
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.isReconnecting).toBe(false);
    expect(result.current.reconnectAttempt).toBe(0);

    // Advance time - should not create any new EventSource
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(MockEventSource.instances).toHaveLength(1);
  });
});
