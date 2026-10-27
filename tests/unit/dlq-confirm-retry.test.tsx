import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DeadLetterQueuePage from "@/app/dashboard/queue/page";

const MOCK_JOBS = [
  {
    id: "job-failed-123",
    type: "recheck.batch",
    status: "failed",
    error: "Horizon rate limit exceeded",
    attempts: 3,
    createdAt: new Date("2026-08-29T10:00:00Z").toISOString(),
    startedAt: new Date("2026-08-29T10:00:01Z").toISOString(),
    completedAt: new Date("2026-08-29T10:00:05Z").toISOString(),
  },
  {
    id: "job-failed-456",
    type: "recheck.single",
    status: "failed",
    error: "Account not found",
    attempts: 1,
    createdAt: new Date("2026-08-29T11:00:00Z").toISOString(),
    startedAt: new Date("2026-08-29T11:00:01Z").toISOString(),
    completedAt: new Date("2026-08-29T11:00:02Z").toISOString(),
  },
];

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

describe("DeadLetterQueuePage — ConfirmDialog before DLQ retry", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/contributors/queue/dlq") && !url.includes("/retry")) {
        return new Response(
          JSON.stringify({ jobs: MOCK_JOBS, count: MOCK_JOBS.length }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("/api/contributors/queue/dlq/job-failed-123/retry")) {
        return new Response(
          JSON.stringify({ job: { id: "job-failed-123", status: "pending" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
      });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders failed jobs list with retry buttons", async () => {
    renderWithClient(<DeadLetterQueuePage />);

    expect(await screen.findByText("job-failed-123")).toBeInTheDocument();
    expect(screen.getByText("job-failed-456")).toBeInTheDocument();
    expect(screen.getByTestId("retry-job-job-failed-123")).toBeInTheDocument();
  });

  it("opens ConfirmDialog on clicking Retry without hitting the retry API immediately", async () => {
    const user = userEvent.setup();
    renderWithClient(<DeadLetterQueuePage />);

    const retryBtn = await screen.findByTestId("retry-job-job-failed-123");
    await user.click(retryBtn);

    // Confirm dialog should be open
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Retry failed DLQ job?")).toBeInTheDocument();
    // Scoped to the dialog: the job id also appears in the table row behind it.
    expect(within(dialog).getByText(/job-failed-123/)).toBeInTheDocument();
    expect(within(dialog).getByText(/recheck\.batch/)).toBeInTheDocument();

    // Verify side effect warning copy is present
    const warning = screen.getByTestId("confirm-dialog-warning");
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveTextContent(/poison job/i);
    expect(warning).toHaveTextContent(/duplicate notifications|rate limits/i);

    // Retry API endpoint should NOT have been called yet
    const retryCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]: [string]) => url.includes("/retry")
    );
    expect(retryCalls).toHaveLength(0);
  });

  it("cancelling the dialog closes it without calling the retry API", async () => {
    const user = userEvent.setup();
    renderWithClient(<DeadLetterQueuePage />);

    const retryBtn = await screen.findByTestId("retry-job-job-failed-123");
    await user.click(retryBtn);

    const cancelBtn = screen.getByTestId("confirm-dialog-cancel");
    await user.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    const retryCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]: [string]) => url.includes("/retry")
    );
    expect(retryCalls).toHaveLength(0);
  });

  it("confirming the dialog triggers the retry API and closes dialog", async () => {
    const user = userEvent.setup();
    renderWithClient(<DeadLetterQueuePage />);

    const retryBtn = await screen.findByTestId("retry-job-job-failed-123");
    await user.click(retryBtn);

    const confirmBtn = screen.getByTestId("confirm-dialog-confirm");
    await user.click(confirmBtn);

    await waitFor(() => {
      const retryCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([url]: [string]) => url.includes("/retry")
      );
      expect(retryCalls).toHaveLength(1);
      expect(retryCalls[0][0]).toContain("/api/contributors/queue/dlq/job-failed-123/retry");
    });

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });
});
