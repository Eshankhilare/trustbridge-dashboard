import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/csv", async () => {
  const actual = await vi.importActual<typeof import("@/lib/csv")>(
    "@/lib/csv",
  );
  return {
    ...actual,
    buildCsvFilename: vi.fn(() => "trustbridge-demo.csv"),
    buildJsonFilename: vi.fn(() => "trustbridge-demo.json"),
    downloadCsv: vi.fn(),
    downloadJson: vi.fn(),
  };
});

import { DemoDashboard } from "@/app/demo/DemoDashboard";
import { downloadCsv } from "@/lib/csv";

describe("public demo dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a clearly labelled synthetic demo dataset", () => {
    render(<DemoDashboard />);

    expect(screen.getByTestId("demo-data-banner")).toHaveTextContent(
      /sample data only/i,
    );
    expect(screen.getByTestId("demo-badge")).toHaveTextContent(/demo data/i);
    expect(screen.getAllByText(/@alice-dev/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("24").length).toBeGreaterThan(0);
  });

  it("paginates the demo contributor table", async () => {
    const user = userEvent.setup();
    render(<DemoDashboard />);

    const table = screen.getByTestId("contributor-table-region");
    expect(within(table).queryByText(/@ibrahim-infra/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Next page" }));

    expect(
      await within(table).findAllByText(/@ibrahim-infra/),
    ).not.toHaveLength(0);
    const pager = screen.getByRole("navigation", {
      name: /Contributor page navigation/i,
    });
    expect(within(pager).getAllByText(/9–16 of 24/).length).toBeGreaterThan(0);
  });

  it("exports the displayed demo data as CSV", async () => {
    const user = userEvent.setup();
    render(<DemoDashboard />);

    const table = screen.getByTestId("contributor-table-region");
    await user.click(
      within(table).getByRole("button", { name: /Export CSV/i }),
    );
    await user.click(screen.getByRole("button", { name: /Download CSV/i }));

    await waitFor(() => expect(downloadCsv).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadCsv).mock.calls[0][1]).toContain("alice-dev");
  });

  it("keeps ban and reset actions local to the demo session", async () => {
    const user = userEvent.setup();
    render(<DemoDashboard />);

    const table = screen.getByTestId("contributor-table-region");
    await user.click(
      within(table).getByRole("button", { name: "Ban alice-dev" }),
    );
    await user.type(screen.getByTestId("ban-reason-input"), "Demo dispute");
    await user.click(screen.getByRole("button", { name: "Confirm Ban" }));

    expect(
      await within(table).findByRole("button", { name: "Unban alice-dev" }),
    ).toBeInTheDocument();
    expect(downloadCsv).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("reset-demo-data"));

    expect(
      await within(table).findByRole("button", { name: "Ban alice-dev" }),
    ).toBeInTheDocument();
  });
});
