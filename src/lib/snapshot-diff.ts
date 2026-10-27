export type DiffChangeType = "added" | "removed" | "address_changed" | "unchanged";

export interface SnapshotRow {
  githubUsername: string;
  stellarAddress: string;
  readiness?: string | null;
}

export interface DiffEntry {
  githubUsername: string;
  change: DiffChangeType;
  oldAddress: string | null;
  newAddress: string | null;
  oldReadiness: string | null;
  newReadiness: string | null;
}

export interface DiffResult {
  added: DiffEntry[];
  removed: DiffEntry[];
  addressChanged: DiffEntry[];
  unchanged: DiffEntry[];
  summary: {
    totalOld: number;
    totalNew: number;
    addedCount: number;
    removedCount: number;
    addressChangedCount: number;
    unchangedCount: number;
    netChange: number;
  };
}

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const EXPECTED_COLUMNS = ["githubUsername", "stellarAddress"];

export class SnapshotParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotParseError";
  }
}

export function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result.map((c) => c.trim());
}

export function validateAndParseSnapshotCsv(raw: string): SnapshotRow[] {
  if (!raw || !raw.trim().length) {
    throw new SnapshotParseError("Snapshot CSV is empty.");
  }
  if (new Blob([raw]).size > MAX_FILE_SIZE_BYTES) {
    throw new SnapshotParseError(
      `Snapshot CSV exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB size cap.`
    );
  }

  const lines = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    throw new SnapshotParseError("Snapshot CSV has no rows.");
  }

  const headerCells = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idxUser = headerCells.findIndex((h) => h === "githubusername");
  const idxAddr = headerCells.findIndex((h) => h === "stellaraddress");
  const idxReadiness = headerCells.findIndex((h) => h === "readiness");

  if (idxUser < 0 || idxAddr < 0) {
    throw new SnapshotParseError(
      `Snapshot CSV is missing required columns (${EXPECTED_COLUMNS.join(", ")}). Found columns: ${headerCells.join(", ")}`
    );
  }

  const seenUsernames = new Set<string>();
  const rows: SnapshotRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells.every((c) => !c.trim())) continue;

    const githubUsername = (cells[idxUser] || "").trim();
    const stellarAddress = (cells[idxAddr] || "").trim();

    if (!githubUsername) {
      throw new SnapshotParseError(
        `Row ${i + 1}: githubUsername is empty.`
      );
    }
    if (!stellarAddress) {
      throw new SnapshotParseError(
        `Row ${i + 1}: stellarAddress is empty.`
      );
    }
    if (seenUsernames.has(githubUsername.toLowerCase())) {
      throw new SnapshotParseError(
        `Duplicate githubUsername "${githubUsername}" at row ${i + 1}. Snapshot CSVs must have one row per contributor.`
      );
    }
    seenUsernames.add(githubUsername.toLowerCase());

    const readiness =
      idxReadiness >= 0 && cells[idxReadiness] ? cells[idxReadiness].trim() : null;

    rows.push({ githubUsername, stellarAddress, readiness });
  }

  return rows;
}

export function diffSnapshots(
  oldSnapshot: SnapshotRow[],
  newSnapshot: SnapshotRow[]
): DiffResult {
  const oldByUser = new Map<string, SnapshotRow>();
  for (const row of oldSnapshot) {
    oldByUser.set(row.githubUsername.toLowerCase(), row);
  }
  const newByUser = new Map<string, SnapshotRow>();
  for (const row of newSnapshot) {
    newByUser.set(row.githubUsername.toLowerCase(), row);
  }

  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const addressChanged: DiffEntry[] = [];
  const unchanged: DiffEntry[] = [];

  for (const [key, newRow] of Array.from(newByUser.entries())) {
    const oldRow = oldByUser.get(key);
    if (!oldRow) {
      added.push({
        githubUsername: newRow.githubUsername,
        change: "added",
        oldAddress: null,
        newAddress: newRow.stellarAddress,
        oldReadiness: null,
        newReadiness: newRow.readiness ?? null,
      });
      continue;
    }
    if (oldRow.stellarAddress !== newRow.stellarAddress) {
      addressChanged.push({
        githubUsername: newRow.githubUsername,
        change: "address_changed",
        oldAddress: oldRow.stellarAddress,
        newAddress: newRow.stellarAddress,
        oldReadiness: oldRow.readiness ?? null,
        newReadiness: newRow.readiness ?? null,
      });
    } else {
      unchanged.push({
        githubUsername: newRow.githubUsername,
        change: "unchanged",
        oldAddress: oldRow.stellarAddress,
        newAddress: newRow.stellarAddress,
        oldReadiness: oldRow.readiness ?? null,
        newReadiness: newRow.readiness ?? null,
      });
    }
  }

  for (const [key, oldRow] of Array.from(oldByUser.entries())) {
    if (!newByUser.has(key)) {
      removed.push({
        githubUsername: oldRow.githubUsername,
        change: "removed",
        oldAddress: oldRow.stellarAddress,
        newAddress: null,
        oldReadiness: oldRow.readiness ?? null,
        newReadiness: null,
      });
    }
  }

  const cmp = (a: DiffEntry, b: DiffEntry) =>
    a.githubUsername.localeCompare(b.githubUsername, undefined, { sensitivity: "base" });

  added.sort(cmp);
  removed.sort(cmp);
  addressChanged.sort(cmp);
  unchanged.sort(cmp);

  return {
    added,
    removed,
    addressChanged,
    unchanged,
    summary: {
      totalOld: oldSnapshot.length,
      totalNew: newSnapshot.length,
      addedCount: added.length,
      removedCount: removed.length,
      addressChangedCount: addressChanged.length,
      unchangedCount: unchanged.length,
      netChange: added.length - removed.length,
    },
  };
}

export interface DiffCsvOptions {
  includeUnchanged?: boolean;
}

export function buildDiffCsv(
  diff: DiffResult,
  opts: DiffCsvOptions = {}
): string {
  const { includeUnchanged = false } = opts;
  const headers = [
    "change",
    "githubUsername",
    "oldStellarAddress",
    "newStellarAddress",
    "oldReadiness",
    "newReadiness",
  ];

  function escape(value: unknown): string {
    const str = value === null || value === undefined ? "" : String(value);
    const needsQuote =
      /[",\n\r=+\-@\t]/.test(str) ||
      /^[0-9a-zA-Z]{20,}$/.test(str);
    const safe = str.replace(/"/g, '""');
    return needsQuote ? `"${safe}"` : safe;
  }

  function row(e: DiffEntry): string[] {
    return [
      e.change,
      e.githubUsername,
      e.oldAddress ?? "",
      e.newAddress ?? "",
      e.oldReadiness ?? "",
      e.newReadiness ?? "",
    ];
  }

  const lines: string[][] = [headers];
  for (const e of diff.added) lines.push(row(e));
  for (const e of diff.removed) lines.push(row(e));
  for (const e of diff.addressChanged) lines.push(row(e));
  if (includeUnchanged) {
    for (const e of diff.unchanged) lines.push(row(e));
  }

  return lines.map((l) => l.map(escape).join(",")).join("\n") + "\n";
}

export { MAX_FILE_SIZE_BYTES };
