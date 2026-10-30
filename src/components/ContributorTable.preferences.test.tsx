import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContributorTable } from "@/components/ContributorTable";
import {
  defaultContributorColumnPreferences,
  type ContributorColumnPreference,
} from "@/lib/contributors";
import type { ContributorRow } from "@/types";

const ENDPOINT = "/api/contributors/column-preferences";

const contributors: ContributorRow[] = [
  {
    id: "row-1",
    githubUsername: "alice",
    stellarAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    funded: true,
    trustlineReady: true,
    trustlineAuthorized: true,
    verified: true,
    xlmBalance: "10",
    spendableXlmBalance: "8",
    readiness: "ready",
    lastCheckedAt: "2026-10-31T09:00:00.000Z",
  },
];

function columnResponse(columns: ContributorColumnPreference[]) {
  return {
    ok: true,
    json: async () => ({ columns, isDefault: false }),
  } as Response;
}

function savedPreferences(): ContributorColumnPreference[] {
  const preferences = defaultContributorColumnPreferences();
  const stellarIndex = preferences.findIndex(
    (entry) => entry.key === "stellarAddress",
  );
  const [stellar] = preferences.splice(stellarIndex, 1);
  preferences.unshift(stellar);
  const github = preferences.find((entry) => entry.key === "githubUsername");
  if (github) github.visible = false;
  const spendable = preferences.find(
    (entry) => entry.key === "spendableXlmBalance",
  );
  if (spendable) spendable.visible = true;
  return preferences;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ContributorTable — column preference persistence", () => {
  it("loads and applies saved visibility and ordering", async () => {
    const columns = savedPreferences();
    vi.mocked(fetch).mockResolvedValueOnce(columnResponse(columns));

    render(
      <ContributorTable
        contributors={contributors}
        columnPreferencesEndpoint={ENDPOINT}
      />,
    );

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        ENDPOINT,
        expect.objectContaining({ cache: "no-store" }),
      ),
    );

    await waitFor(() =>
      expect(screen.queryByRole("columnheader", { name: /GitHub/i })).toBeNull(),
    );

    const headers = screen
      .getAllByRole("columnheader")
      .map((header) => header.textContent?.replace(/\s+/g, " ").trim());
    expect(headers[0]).toMatch(/Stellar address/i);
    expect(headers).toEqual(
      expect.arrayContaining(["Spendable XLM", "Diagnostics"]),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /columns/i }));
    expect(
      within(screen.getByTestId("column-picker")).getByRole("checkbox", {
        name: "GitHub",
      }),
    ).not.toBeChecked();
  });

  it("saves changed visibility and order", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        columnResponse(defaultContributorColumnPreferences()),
      )
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse((init as RequestInit).body as string);
        return columnResponse(body.columns);
      });

    const user = userEvent.setup();
    render(
      <ContributorTable
        contributors={contributors}
        columnPreferencesEndpoint={ENDPOINT}
      />,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: /columns/i }));
    const picker = screen.getByTestId("column-picker");
    await user.click(
      within(picker).getByRole("checkbox", { name: "Verified" }),
    );
    await user.click(
      within(picker).getByRole("button", { name: "Move GitHub down" }),
    );
    await user.click(
      within(picker).getByRole("button", { name: "Save preferences" }),
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    const [, init] = vi.mocked(fetch).mock.calls[1];
    expect(init).toMatchObject({ method: "PUT" });
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(
      payload.columns.find(
        (entry: ContributorColumnPreference) => entry.key === "verified",
      ).visible,
    ).toBe(false);
    expect(payload.columns[0].key).toBe("stellarAddress");
    expect(payload.columns[1].key).toBe("githubUsername");

    expect(
      await screen.findByText("Column preferences saved."),
    ).toBeInTheDocument();
  });

  it("keeps the table usable and reports when loading fails", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));

    const user = userEvent.setup();
    render(
      <ContributorTable
        contributors={contributors}
        columnPreferencesEndpoint={ENDPOINT}
      />,
    );

    await user.click(screen.getByRole("button", { name: /columns/i }));

    expect(
      await screen.findByTestId("column-preferences-error"),
    ).toHaveTextContent(/Could not load column preferences/i);
    expect(
      screen.getByRole("columnheader", { name: /GitHub/i }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("column-picker")).getByRole("checkbox", {
        name: "GitHub",
      }),
    ).toBeChecked();
  });

  it("keeps local changes and reports when saving fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        columnResponse(defaultContributorColumnPreferences()),
      )
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Invalid column preferences" }),
      } as Response);

    const user = userEvent.setup();
    render(
      <ContributorTable
        contributors={contributors}
        columnPreferencesEndpoint={ENDPOINT}
      />,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /columns/i }));
    const picker = screen.getByTestId("column-picker");
    const verified = within(picker).getByRole("checkbox", {
      name: "Verified",
    });
    await user.click(verified);
    await user.click(
      within(picker).getByRole("button", { name: "Save preferences" }),
    );

    expect(
      await screen.findByTestId("column-preferences-error"),
    ).toHaveTextContent(/Invalid column preferences/i);
    expect(verified).not.toBeChecked();
    expect(screen.queryByText("Column preferences saved.")).toBeNull();
  });

  it("supports keyboard-driven reordering", async () => {
    const user = userEvent.setup();
    render(<ContributorTable contributors={contributors} />);

    await user.click(screen.getByRole("button", { name: /columns/i }));
    const picker = screen.getByTestId("column-picker");

    const moveVerifiedUp = within(picker).getByRole("button", {
      name: "Move Verified up",
    });
    moveVerifiedUp.focus();
    expect(moveVerifiedUp).toHaveFocus();
    await user.keyboard("{Enter}");

    const labels = Array.from(picker.querySelectorAll("li label")).map(
      (label) => label.textContent?.trim(),
    );
    expect(labels.indexOf("Verified")).toBeLessThan(
      labels.indexOf("Status"),
    );
  });

  it("prevents hiding the last visible column", async () => {
    const onlyGithub = defaultContributorColumnPreferences().map((entry) => ({
      ...entry,
      visible: entry.key === "githubUsername",
    }));
    vi.mocked(fetch).mockResolvedValueOnce(columnResponse(onlyGithub));

    const user = userEvent.setup();
    render(
      <ContributorTable
        contributors={contributors}
        columnPreferencesEndpoint={ENDPOINT}
      />,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /columns/i }));

    expect(
      within(screen.getByTestId("column-picker")).getByRole("checkbox", {
        name: "GitHub",
      }),
    ).toBeDisabled();
  });

  it("resets local changes to the default order and visibility", async () => {
    const user = userEvent.setup();
    render(<ContributorTable contributors={contributors} />);

    await user.click(screen.getByRole("button", { name: /columns/i }));
    const picker = screen.getByTestId("column-picker");
    await user.click(
      within(picker).getByRole("checkbox", { name: "Spendable XLM" }),
    );
    expect(
      within(picker).getByRole("checkbox", { name: "Spendable XLM" }),
    ).toBeChecked();

    await user.click(
      within(picker).getByRole("button", { name: "Reset to defaults" }),
    );

    expect(
      within(picker).getByRole("checkbox", { name: "Spendable XLM" }),
    ).not.toBeChecked();
  });
});
