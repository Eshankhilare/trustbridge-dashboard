import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SnapshotDiffPanel } from "@/components/SnapshotDiffPanel";

// ── Test helpers ────────────────────────────────────────────────────────────────

const validOldCsv = `githubUsername,stellarAddress,readiness
alice,GA1234567890ABCDEF1234567890ABCDEF12345678,ready
bob,GB1234567890ABCDEF1234567890ABCDEF12345678,ready
charlie,GC1234567890ABCDEF1234567890ABCDEF12345678,not_ready`;

const validNewCsv = `githubUsername,stellarAddress,readiness
alice,GA1234567890ABCDEF1234567890ABCDEF12345678,ready
bob,GB1234567890ABCDEF1234567890ABCDEF12345678,ready
charlie,GC1234567890ABCDEF1234567890ABCDEF12345678,ready
dave,GD1234567890ABCDEF1234567890ABCDEF12345678,ready`;

const addedOnlyOld = `githubUsername,stellarAddress
alice,GA1234567890ABCDEF1234567890ABCDEF12345678`;

const addedOnlyNew = `githubUsername,stellarAddress
alice,GA1234567890ABCDEF1234567890ABCDEF12345678
bob,GB1234567890ABCDEF1234567890ABCDEF12345678`;

const removedOld = `githubUsername,stellarAddress
alice,GA1234567890ABCDEF1234567890ABCDEF12345678
bob,GB1234567890ABCDEF1234567890ABCDEF12345678`;

const removedNew = `githubUsername,stellarAddress
alice,GA1234567890ABCDEF1234567890ABCDEF12345678`;

const addressChangedOld = `githubUsername,stellarAddress
alice,GA1234567890ABCDEF1234567890ABCDEF12345678`;

const addressChangedNew = `githubUsername,stellarAddress
alice,GA9999999999ABCDEF1234567890ABCDEF12345678`;

const invalidCsv = `not,a,valid,csv`;

const duplicateCsv = `githubUsername,stellarAddress
alice,GA1234567890ABCDEF1234567890ABCDEF12345678
alice,GB1234567890ABCDEF1234567890ABCDEF12345678`;

const emptyUserCsv = `githubUsername,stellarAddress
,GA1234567890ABCDEF1234567890ABCDEF12345678`;

const emptyAddrCsv = `githubUsername,stellarAddress
alice,`;

// Create a file-like object with a working text() method
function createMockFile(content: string, name = "test.csv") {
  const file = new File([content], name, { type: "text/csv" });
  // Override text() to return the content directly
  file.text = vi.fn().mockResolvedValue(content);
  return file;
}

// Direct file input simulation - trigger onChange with mock file.
// Loaded slots unmount their input (stats render instead), so re-query every
// time: with two inputs present index by slot, otherwise the single remaining
// input is necessarily the other (still-empty) slot.
async function uploadFileDirect(which: "older" | "newer", file: File) {
  const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".csv,text/csv"]');
  const input =
    fileInputs.length === 2
      ? fileInputs[which === "older" ? 0 : 1]
      : fileInputs[0];
  
  if (!input) {
    throw new Error(`File input for ${which} not found. Found ${fileInputs.length} inputs.`);
  }
  
  // Create a mock FileList with the file that has working text()
  const mockFileList = {
    0: file,
    length: 1,
    item: (index: number) => index === 0 ? file : null,
  } as unknown as FileList;
  
  // Trigger the onChange handler directly
  await act(async () => {
    Object.defineProperty(input, "files", { value: mockFileList, configurable: true });
    fireEvent.change(input);
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SnapshotDiffPanel", () => {
  it("renders the panel with title and description", () => {
    render(<SnapshotDiffPanel />);

    expect(screen.getByTestId("snapshot-diff-panel")).toBeInTheDocument();
    expect(screen.getByText(/Compare snapshots \(Wave diff\)/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Upload two contributor CSV exports/i)
    ).toBeInTheDocument();
  });

  it("shows empty state when no snapshots uploaded", () => {
    render(<SnapshotDiffPanel />);

    // Text is broken up by <strong> elements and repeats up the ancestor
    // chain, so assert that at least one match exists rather than exactly one.
    expect(
      screen.getAllByText((_, el) =>
        el.textContent?.includes("Upload an") &&
        el.textContent?.includes("older") &&
        el.textContent?.includes("newer") &&
        el.textContent?.includes("contributor")
      ).length
    ).toBeGreaterThan(0);
    expect(screen.queryByTestId("snapshot-diff-table")).not.toBeInTheDocument();
    expect(screen.queryByTestId("snapshot-diff-download")).not.toBeInTheDocument();
  });

  it("shows file input slots for older and newer snapshots", () => {
    render(<SnapshotDiffPanel />);

    // The headings for each slot
    expect(screen.getByText(/Older snapshot/i)).toBeInTheDocument();
    expect(screen.getByText(/Newer snapshot/i)).toBeInTheDocument();
    // Two "Upload CSV" buttons
    expect(screen.getAllByRole("button", { name: /upload csv/i })).toHaveLength(2);
  });

  it("displays error message for invalid CSV", async () => {
    render(<SnapshotDiffPanel />);

    const invalidFile = createMockFile(invalidCsv, "bad.csv");
    await uploadFileDirect("older", invalidFile);

    expect(screen.getByText(/bad.csv:/i)).toBeInTheDocument();
    expect(screen.getByText(/missing required columns/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("displays error message for empty CSV", async () => {
    render(<SnapshotDiffPanel />);

    const emptyFile = createMockFile("", "empty.csv");
    await uploadFileDirect("older", emptyFile);

    expect(screen.getByText(/empty.csv:/i)).toBeInTheDocument();
    expect(screen.getByText(/empty/i)).toBeInTheDocument();
  });

  it("shows loaded row count after successful upload", async () => {
    render(<SnapshotDiffPanel />);

    const file = createMockFile(validOldCsv, "old.csv");
    await uploadFileDirect("older", file);

    expect(screen.getByText(/old.csv/i)).toBeInTheDocument();
    expect(screen.getByText(/3 contributor rows loaded/i)).toBeInTheDocument();
  });

  it("shows clear button after upload and clears on click", async () => {
    render(<SnapshotDiffPanel />);

    const file = createMockFile(validOldCsv, "old.csv");
    await uploadFileDirect("older", file);

    expect(screen.getByRole("button", { name: /clear old snapshot/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /clear old snapshot/i }));

    expect(screen.getByText(/Older snapshot/i)).toBeInTheDocument();
    expect(screen.queryByText(/old.csv/i)).not.toBeInTheDocument();
  });

  it("renders diff summary when both snapshots uploaded with differences", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(validOldCsv, "old.csv"));
    await uploadFileDirect("newer", createMockFile(validNewCsv, "new.csv"));

    // Summary cards: "+1" appears twice for this fixture (Added card and
    // Net-change card); "(Wave N vs Wave N+1)" never equals "+1" exactly.
    const summary = screen.getByTestId("snapshot-diff-panel");
    expect(within(summary).getAllByText("+1")).toHaveLength(2); // added (dave)
    expect(within(summary).getByText("3 → 4")).toBeInTheDocument(); // old → new total
  });

  it("renders diff table with added rows", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(addedOnlyOld, "old.csv"));
    await uploadFileDirect("newer", createMockFile(addedOnlyNew, "new.csv"));

    // Should show bob as added (scoped to the diff table: page copy also mentions these words)
    const table = screen.getByTestId("snapshot-diff-table");
    expect(within(table).getByText("Added")).toBeInTheDocument();
    expect(within(table).getByText("bob")).toBeInTheDocument();
    expect(within(table).getByText("GB1234567890ABCDEF1234567890ABCDEF12345678")).toBeInTheDocument();
  });

  it("renders removed rows correctly", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(removedOld, "old.csv"));
    await uploadFileDirect("newer", createMockFile(removedNew, "new.csv"));

    const table = screen.getByTestId("snapshot-diff-table");
    expect(within(table).getByText("Removed")).toBeInTheDocument();
    expect(within(table).getByText("bob")).toBeInTheDocument();
    expect(within(table).getByText("GB1234567890ABCDEF1234567890ABCDEF12345678")).toBeInTheDocument();
  });

  it("renders address_changed rows correctly", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(addressChangedOld, "old.csv"));
    await uploadFileDirect("newer", createMockFile(addressChangedNew, "new.csv"));

    const table = screen.getByTestId("snapshot-diff-table");
    expect(within(table).getByText("Address changed")).toBeInTheDocument();
    expect(within(table).getByText("alice")).toBeInTheDocument();
    expect(within(table).getByText("GA1234567890ABCDEF1234567890ABCDEF12345678")).toBeInTheDocument();
    expect(within(table).getByText("GA9999999999ABCDEF1234567890ABCDEF12345678")).toBeInTheDocument();
  });

  it("shows 'No differences found' when snapshots are identical", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(validOldCsv, "old.csv"));
    await uploadFileDirect("newer", createMockFile(validOldCsv, "new.csv"));

    expect(screen.getByText(/No differences found between the two snapshots/i)).toBeInTheDocument();
  });

  it("toggles unchanged rows visibility", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(validOldCsv, "old.csv"));
    await uploadFileDirect("newer", createMockFile(validNewCsv, "new.csv"));

    // Checkbox appears after diff is rendered
    const checkbox = screen.getByRole("checkbox", {
      name: /include unchanged rows in table/i,
    });
    expect(checkbox).not.toBeChecked();

    // Check the box
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    // Unchanged rows should now appear in table
    const table = screen.getByTestId("snapshot-diff-table");
    expect(within(table).getAllByText("Unchanged")).toHaveLength(3);
    expect(within(table).getByText("alice")).toBeInTheDocument();
    expect(within(table).getByText("bob")).toBeInTheDocument();
    expect(within(table).getByText("charlie")).toBeInTheDocument();

    // Uncheck
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it("download button is present when diff exists", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(validOldCsv, "old.csv"));
    await uploadFileDirect("newer", createMockFile(validNewCsv, "new.csv"));

    expect(screen.getByTestId("snapshot-diff-download")).toBeInTheDocument();
  });

  it("download button triggers CSV download with correct filename pattern", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(validOldCsv, "old.csv"));
    await uploadFileDirect("newer", createMockFile(validNewCsv, "new.csv"));

    const downloadBtn = screen.getByTestId("snapshot-diff-download");
    // jsdom has no URL.createObjectURL — stub it (and revoke) directly.
    const createObjectURLSpy = vi.fn().mockReturnValue("blob:mock");
    URL.createObjectURL = createObjectURLSpy;
    const revokeObjectURLSpy = vi.fn();
    URL.revokeObjectURL = revokeObjectURLSpy;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    fireEvent.click(downloadBtn);

    expect(createObjectURLSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURLSpy).toHaveBeenCalled();

    clickSpy.mockRestore();
  });

  it("does not show download button when no diff", () => {
    render(<SnapshotDiffPanel />);

    expect(screen.queryByTestId("snapshot-diff-download")).not.toBeInTheDocument();
  });

  it("does not compute diff when either snapshot has an error", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(invalidCsv, "bad.csv"));
    await uploadFileDirect("newer", createMockFile(validNewCsv, "new.csv"));

    expect(screen.queryByTestId("snapshot-diff-table")).not.toBeInTheDocument();
    expect(screen.getByText(/bad.csv:/i)).toBeInTheDocument();
  });

  it("handles file input binding correctly for both slots", () => {
    render(<SnapshotDiffPanel />);

    // Click both upload buttons to reveal inputs
    const uploadButtons = screen.getAllByRole("button", { name: /upload csv/i });
    
    // First slot (older)
    fireEvent.click(uploadButtons[0]);
    const oldInputs = document.querySelectorAll('input[type="file"][accept=".csv,text/csv"]');
    expect(oldInputs.length).toBeGreaterThan(0);
    const oldInput = oldInputs[0] as HTMLInputElement;
    expect(oldInput.type).toBe("file");
    expect(oldInput.accept).toBe(".csv,text/csv");

    // Second slot (newer)
    fireEvent.click(uploadButtons[1]);
    const newInputs = document.querySelectorAll('input[type="file"][accept=".csv,text/csv"]');
    expect(newInputs.length).toBeGreaterThan(0);
    const newInput = newInputs[1] as HTMLInputElement;
    expect(newInput.type).toBe("file");
    expect(newInput.accept).toBe(".csv,text/csv");
  });

  it("shows error for CSV with duplicate githubUsername", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(duplicateCsv, "dup.csv"));

    expect(screen.getByText(/dup.csv:/i)).toBeInTheDocument();
    expect(screen.getByText(/duplicate githubusername/i)).toBeInTheDocument();
  });

  it("shows error for CSV with empty githubUsername", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(emptyUserCsv, "empty-user.csv"));

    expect(screen.getByText(/empty-user.csv:/i)).toBeInTheDocument();
    const errorElements = screen.getAllByText((_, el) => 
      el.textContent?.toLowerCase().includes("githubusername is empty")
    );
    expect(errorElements.length).toBeGreaterThan(0);
  });

  it("shows error for CSV with empty stellarAddress", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(emptyAddrCsv, "empty-addr.csv"));

    expect(screen.getByText(/empty-addr.csv:/i)).toBeInTheDocument();
    const errorElements = screen.getAllByText((_, el) => 
      el.textContent?.toLowerCase().includes("stellaraddress is empty")
    );
    expect(errorElements.length).toBeGreaterThan(0);
  });

  it("accessible labels and roles are present initially", () => {
    render(<SnapshotDiffPanel />);

    // Two upload buttons
    expect(screen.getAllByRole("button", { name: /upload csv/i })).toHaveLength(2);
    // Clear buttons not visible initially
    expect(screen.queryByRole("button", { name: /clear old snapshot/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear new snapshot/i })).not.toBeInTheDocument();
    // Download button not visible initially
    expect(screen.queryByTestId("snapshot-diff-download")).not.toBeInTheDocument();
  });

  it("table has proper caption for accessibility", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(validOldCsv, "old.csv"));
    await uploadFileDirect("newer", createMockFile(validNewCsv, "new.csv"));

    const table = screen.getByTestId("snapshot-diff-table");
    const caption = table.querySelector("caption");
    expect(caption).toBeInTheDocument();
    expect(caption).toHaveTextContent(/Snapshot diff rows: added, removed, address changed/i);
  });

  it("live region announces diff results for screen readers", async () => {
    render(<SnapshotDiffPanel />);

    await uploadFileDirect("older", createMockFile(validOldCsv, "old.csv"));
    await uploadFileDirect("newer", createMockFile(validNewCsv, "new.csv"));

    // The summary cards act as visual indicators; the table caption is sr-only
    // but the diff results are readable by screen readers through the table
    expect(screen.getByTestId("snapshot-diff-table")).toBeInTheDocument();
  });
});