"use client";

import { useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  Download,
  FileDown,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  type DiffEntry,
  type DiffResult,
  SnapshotParseError,
  buildDiffCsv,
  diffSnapshots,
  validateAndParseSnapshotCsv,
  type SnapshotRow,
} from "@/lib/snapshot-diff";

type UploadState = {
  fileName: string;
  raw: string;
  rows: SnapshotRow[];
  error: string | null;
};

const emptyState: UploadState = {
  fileName: "",
  raw: "",
  rows: [],
  error: null,
};

function ChangeBadge({ change }: { change: DiffEntry["change"] }) {
  switch (change) {
    case "added":
      return (
        <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          <span className="mr-1">+</span>Added
        </Badge>
      );
    case "removed":
      return (
        <Badge className="bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300">
          <span className="mr-1">−</span>Removed
        </Badge>
      );
    case "address_changed":
      return (
        <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <ArrowRightLeft className="mr-1 h-3 w-3" />
          Address changed
        </Badge>
      );
    case "unchanged":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Unchanged
        </Badge>
      );
  }
}

export function SnapshotDiffPanel() {
  const [oldSnap, setOldSnap] = useState<UploadState>(emptyState);
  const [newSnap, setNewSnap] = useState<UploadState>(emptyState);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const oldInput = useRef<HTMLInputElement>(null);
  const newInput = useRef<HTMLInputElement>(null);

  async function handleFile(
    which: "old" | "new",
    file: File | null
  ): Promise<void> {
    if (!file) return;
    const setter = which === "old" ? setOldSnap : setNewSnap;
    try {
      const text = await file.text();
      const rows = validateAndParseSnapshotCsv(text);
      setter({ fileName: file.name, raw: text, rows, error: null });
    } catch (err) {
      const msg =
        err instanceof SnapshotParseError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to parse snapshot CSV.";
      setter({ fileName: file.name, raw: "", rows: [], error: msg });
    }
  }

  function reset(which: "old" | "new") {
    const setter = which === "old" ? setOldSnap : setNewSnap;
    setter(emptyState);
  }

  const diff: DiffResult | null = useMemo(() => {
    if (!oldSnap.rows.length || !newSnap.rows.length) return null;
    if (oldSnap.error || newSnap.error) return null;
    return diffSnapshots(oldSnap.rows, newSnap.rows);
  }, [oldSnap, newSnap]);

  function downloadDiffCsv() {
    if (!diff) return;
    const csv = buildDiffCsv(diff, { includeUnchanged: showUnchanged });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `snapshot-diff-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const visibleRows: DiffEntry[] = useMemo(() => {
    if (!diff) return [];
    const all = [
      ...diff.added,
      ...diff.removed,
      ...diff.addressChanged,
    ];
    if (showUnchanged) all.push(...diff.unchanged);
    return all;
  }, [diff, showUnchanged]);

  return (
    <Card data-testid="snapshot-diff-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowRightLeft className="h-5 w-5" />
          Compare snapshots (Wave diff)
        </CardTitle>
        <CardDescription>
          Upload two contributor CSV exports to see who was added, removed, or
          changed their Stellar address between waves. Diffing runs locally in
          your browser — snapshots never leave the dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Upload slots */}
        <div className="grid gap-4 sm:grid-cols-2">
          {(["old", "new"] as const).map((which) => {
            const state = which === "old" ? oldSnap : newSnap;
            const inputRef = which === "old" ? oldInput : newInput;
            return (
              <div
                key={which}
                className="rounded-lg border-2 border-dashed border-border-strong p-4"
              >
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">
                    {which === "old" ? "Older snapshot" : "Newer snapshot"}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      (Wave N vs Wave N+1)
                    </span>
                  </h3>
                  {state.rows.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => reset(which)}
                      aria-label={`Clear ${which} snapshot`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>

                {state.error ? (
                  <div
                    className="mb-3 rounded-md border border-destructive/60 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                    role="alert"
                  >
                    {state.fileName}: {state.error}
                  </div>
                ) : null}

                {state.rows.length > 0 ? (
                  <div className="space-y-1 text-sm">
                    <p className="flex items-center gap-2">
                      <FileDown className="h-4 w-4 text-muted-foreground" />
                      <span className="font-mono text-xs">{state.fileName}</span>
                    </p>
                    <p className="tabular-nums text-muted-foreground">
                      {state.rows.length.toLocaleString()} contributor rows loaded
                    </p>
                  </div>
                ) : (
                  <>
                    <input
                      ref={inputRef}
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={(e) =>
                        void handleFile(which, e.target.files?.[0] ?? null)
                      }
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      className="w-full"
                      onClick={() => inputRef.current?.click()}
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      Upload CSV
                    </Button>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Diff results */}
        {diff && (
          <>
            <div className="grid gap-3 sm:grid-cols-3 md:grid-cols-6">
              <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-3 dark:border-emerald-700 dark:bg-emerald-950/40">
                <p className="text-xs text-emerald-700 dark:text-emerald-300">
                  Added
                </p>
                <p className="mt-1 text-xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                  +{diff.summary.addedCount}
                </p>
              </div>
              <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-3 dark:border-red-700 dark:bg-red-950/40">
                <p className="text-xs text-red-700 dark:text-red-300">
                  Removed
                </p>
                <p className="mt-1 text-xl font-bold tabular-nums text-red-700 dark:text-red-300">
                  −{diff.summary.removedCount}
                </p>
              </div>
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 dark:border-amber-700 dark:bg-amber-950/40">
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  Address changed
                </p>
                <p className="mt-1 text-xl font-bold tabular-nums text-amber-700 dark:text-amber-300">
                  {diff.summary.addressChangedCount}
                </p>
              </div>
              <div className="rounded-lg border border-border-strong px-3 py-3">
                <p className="text-xs text-muted-foreground">Unchanged</p>
                <p className="mt-1 text-xl font-bold tabular-nums">
                  {diff.summary.unchangedCount}
                </p>
              </div>
              <div className="rounded-lg border border-border-strong px-3 py-3">
                <p className="text-xs text-muted-foreground">Net change</p>
                <p
                  className={`mt-1 text-xl font-bold tabular-nums ${
                    diff.summary.netChange > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : diff.summary.netChange < 0
                        ? "text-red-600 dark:text-red-400"
                        : ""
                  }`}
                >
                  {diff.summary.netChange > 0 ? "+" : ""}
                  {diff.summary.netChange}
                </p>
              </div>
              <div className="rounded-lg border border-border-strong px-3 py-3">
                <p className="text-xs text-muted-foreground">
                  Old → New total
                </p>
                <p className="mt-1 text-sm font-semibold tabular-nums">
                  {diff.summary.totalOld} → {diff.summary.totalNew}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showUnchanged}
                  onChange={(e) => setShowUnchanged(e.target.checked)}
                />
                Include unchanged rows in table + export
              </label>
              <Button
                variant="stellar"
                size="sm"
                onClick={downloadDiffCsv}
                data-testid="snapshot-diff-download"
              >
                <Download className="mr-1.5 h-4 w-4" />
                Export diff CSV
              </Button>
            </div>

            <div
              className="overflow-x-auto rounded-lg border border-border-strong"
              data-testid="snapshot-diff-table"
            >
              <table className="w-full min-w-[720px] text-sm">
                <caption className="sr-only">
                  Snapshot diff rows: added, removed, address changed, and
                  optionally unchanged contributors.
                </caption>
                <thead>
                  <tr className="border-b-2 border-border-strong bg-muted/30 text-left text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Change
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      GitHub
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Old address
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      New address
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-3 py-6 text-center text-sm text-muted-foreground"
                      >
                        No differences found between the two snapshots.
                      </td>
                    </tr>
                  ) : (
                    visibleRows.map((row) => (
                      <tr
                        key={`${row.change}-${row.githubUsername}`}
                        className="border-b border-border-strong last:border-0"
                      >
                        <td className="px-3 py-2">
                          <ChangeBadge change={row.change} />
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {row.githubUsername}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                          {row.oldAddress ?? (
                            <span className="italic">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {row.newAddress ?? (
                            <span className="italic">—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {!diff && (oldSnap.rows.length === 0 || newSnap.rows.length === 0) && (
          <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted-foreground">
            <X className="mx-auto mb-2 h-5 w-5 text-muted-foreground/60" />
            Upload an <strong>older</strong> and <strong>newer</strong> contributor
            CSV export to generate a Wave-to-Wave diff.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
