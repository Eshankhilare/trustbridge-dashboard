"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpDown,
  Download,
  Loader2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Users,
} from "lucide-react";

import { TrustlineStatusBadge } from "@/components/TrustlineStatusBadge";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import {
  CONTRIBUTOR_COLUMNS,
  defaultVisibleColumns,
  filterContributors,
  searchContributors,
  sortContributors,
  type ContributorColumnKey,
  type ContributorFilter,
  type ContributorSortKey,
} from "@/lib/contributors";
import { buildCsv, buildCsvFilename, buildJson, buildJsonFilename, downloadCsv, downloadJson } from "@/lib/csv";
import {
  buildWalletProofInfo,
  buildHorizonDebugInfo,
} from "@/lib/registration-insights";
import { buildStalenessSummary } from "@/lib/stale-export";
import { getRowAccent } from "@/lib/readiness";
import {
  cn,
  formatGithubHandle,
  formatRelativeTime,
  formatXlmBalance,
  shortenAddress,
} from "@/lib/utils";
import type { ContributorRow } from "@/types";

type FilterOption = ContributorFilter;
type SortKey = ContributorSortKey;
type ContributorViewerRole = "maintainer" | "contributor";

interface ContributorTableProps {
  contributors: ContributorRow[];
  onExport?: () => void;
  onRecheck?: (id: string) => void;
  recheckingId?: string | null;
  onBanToggle?: (githubUsername: string, action: "ban" | "unban", reason?: string) => Promise<void>;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoading?: boolean;
  isLoadingMore?: boolean;
  /** Drives copy in the zero-contributors empty state. */
  viewerRole?: ContributorViewerRole;
  /** Registration page path for invite/share actions. Defaults to `/register`. */
  registerUrl?: string;
  className?: string;
}

function ContributorsZeroEmptyState({
  viewerRole,
  registerUrl,
}: {
  viewerRole: ContributorViewerRole;
  registerUrl: string;
}) {
  const isMaintainer = viewerRole === "maintainer";

  async function copyRegisterLink() {
    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}${registerUrl}`
        : registerUrl;
    await navigator.clipboard.writeText(url);
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="contributors-zero-empty"
      className="rounded-xl border border-dashed bg-muted/20 px-6 py-12 text-center"
    >
      <Users
        className="mx-auto h-10 w-10 text-muted-foreground"
        aria-hidden="true"
      />
      <h3 className="mt-4 text-lg font-semibold">
        {isMaintainer
          ? "No contributors registered yet"
          : "You are not registered yet"}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {isMaintainer
          ? "Share the registration link with wave contributors so they can connect a Stellar payout address and appear in this table."
          : "Register your Stellar payout address to join the wave and show up in the readiness table."}
      </p>
      <p className="mx-auto mt-3 max-w-md text-sm font-medium">
        What to do next:{" "}
        {isMaintainer
          ? "Open the register page and share its URL, or generate invite links for your team."
          : "Complete registration with your GitHub account and Stellar address."}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Button asChild variant="stellar">
          <Link href={registerUrl}>
            {isMaintainer ? "Open register page" : "Register now"}
          </Link>
        </Button>
        {isMaintainer && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void copyRegisterLink()}
          >
            Copy register link
          </Button>
        )}
      </div>
    </div>
  );
}

function ContributorsFilteredEmptyState({
  search,
}: {
  search: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="contributors-filtered-empty"
      className="rounded-xl border bg-card px-4 py-8 text-center text-sm text-muted-foreground"
    >
      {search.trim()
        ? `No contributors match "${search}". Try a different username or Stellar address.`
        : "No contributors match this filter. Choose a different readiness filter or clear your search."}
    </div>
  );
}

function ContributorDebugPanel({ row }: { row: ContributorRow }) {
  const horizonDebug =
    row.horizonDebug ??
    buildHorizonDebugInfo({
      funded: row.funded,
      trustlineReady: row.trustlineReady,
      trustlineAuthorized: row.trustlineAuthorized,
      readiness: row.readiness,
      xlmBalance: row.xlmBalance,
      spendableXlmBalance: row.spendableXlmBalance,
      lastCheckedAt: row.lastCheckedAt,
    });
  const walletProof =
    row.walletProof ?? buildWalletProofInfo(row.stellarAddress, row.githubUsername);

  return (
    <details className="rounded-lg border bg-muted/30 p-3 text-left">
      <summary className="cursor-pointer list-none text-sm font-medium">
        Horizon debug
      </summary>

      <div className="mt-3 space-y-3 text-xs">
        <div>
          <p className="font-medium text-foreground">{horizonDebug.summary}</p>
          <p className="mt-1 text-muted-foreground">{horizonDebug.nextAction}</p>
        </div>

        {horizonDebug.warnings.length > 0 && (
          <ul className="space-y-1 text-amber-700 dark:text-amber-300">
            {horizonDebug.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}

        <dl className="grid gap-2 sm:grid-cols-2">
          {horizonDebug.checkpoints.map((checkpoint) => (
            <div key={checkpoint.label}>
              <dt className="text-muted-foreground">{checkpoint.label}</dt>
              <dd className="font-medium text-foreground">{checkpoint.value}</dd>
            </div>
          ))}
        </dl>

        <div className="space-y-2">
          <p className="font-medium text-foreground">Freighter proof challenge</p>
          <pre className="overflow-x-auto rounded-md border bg-background p-2 whitespace-pre-wrap">
            {walletProof.challenge}
          </pre>
        </div>
      </div>
    </details>
  );
}

function MobileContributorCard({
  row,
  onRecheck,
  recheckingId,
}: {
  row: ContributorRow;
  onRecheck?: (id: string) => void;
  recheckingId?: string | null;
}) {
  return (
    <article className={cn("rounded-xl border bg-card p-4", getRowAccent(row.readiness))}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold">{formatGithubHandle(row.githubUsername)}</h3>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {row.stellarAddress}
          </p>
        </div>
        <TrustlineStatusBadge status={row.readiness} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Verified</dt>
          <dd className="mt-1">
            <VerifiedBadge verified={row.verified} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">XLM</dt>
          <dd className="mt-1 font-medium">{formatXlmBalance(row.xlmBalance)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Spendable XLM</dt>
          <dd className="mt-1 font-medium">
            {formatXlmBalance(row.spendableXlmBalance)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last checked</dt>
          <dd className="mt-1 font-medium">{formatRelativeTime(row.lastCheckedAt)}</dd>
        </div>
      </dl>

      <div className="mt-4">
        <ContributorDebugPanel row={row} />
      </div>

      {onRecheck && (
        <div className="mt-4">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onRecheck(row.id)}
            disabled={recheckingId === row.id}
            aria-label={`Re-check ${row.githubUsername} via Horizon`}
          >
            {recheckingId === row.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Re-check
          </Button>
        </div>
      )}
    </article>
  );
}
export function ContributorTable({
  contributors,
  onExport,
  onRecheck,
  recheckingId = null,
  onBanToggle,
  onLoadMore,
  hasMore = false,
  isLoading = false,
  isLoadingMore = false,
  viewerRole = "maintainer",
  registerUrl = "/register",
  className,
}: ContributorTableProps) {
  const headingId = useId();
  const columnPickerId = useId();
  const searchInputId = useId();
  const paletteTitleId = useId();
  const columnPickerRef = useRef<HTMLFieldSetElement | null>(null);
  const columnPickerToggleRef = useRef<HTMLButtonElement | null>(null);
  const csvExportRef = useRef<HTMLButtonElement | null>(null);
  const jsonExportRef = useRef<HTMLButtonElement | null>(null);
  const [filter, setFilter] = useState<FilterOption>("all");
  const [sortKey, setSortKey] = useState<SortKey>("githubUsername");
  const [sortAsc, setSortAsc] = useState(true);
  const [search, setSearch] = useState("");
  const [visibleColumns, setVisibleColumns] = useState<Set<ContributorColumnKey>>(
    () => defaultVisibleColumns()
  );
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  // Which export the confirmation dialog is standing in front of, or null when
  // it is closed. Both formats share one dialog.
  const [pendingExport, setPendingExport] = useState<"csv" | "json" | null>(null);
  const [banDialogRow, setBanDialogRow] = useState<ContributorRow | null>(null);
  const [banDialogAction, setBanDialogAction] = useState<"ban" | "unban">("ban");
  const [banReasonInput, setBanReasonInput] = useState("");
  const [isSubmittingBan, setIsSubmittingBan] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const paletteOpenerRef = useRef<HTMLElement | null>(null);

  const staleSummary = useMemo(
    () => buildStalenessSummary(contributors),
    [contributors]
  );

  React.useEffect(() => {
    if (!showColumnPicker) return;
    // Focus the panel itself, not its first checkbox: landing on a checkbox
    // reads as "Stellar address, checked" with no announcement of what the
    // panel is or how to leave it.
    columnPickerRef.current?.focus();
  }, [showColumnPicker]);

  const filtered = useMemo(() => {
    const byFilter = filterContributors(contributors, filter);
    const bySearch = searchContributors(byFilter, search);
    return sortContributors(bySearch, sortKey, sortAsc);
  }, [contributors, filter, search, sortAsc, sortKey]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        paletteOpenerRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
        setPaletteOpen(true);
      }
    }

    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (!paletteOpen) return;
    const focusable = Array.from(
      paletteRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled])'
      ) ?? []
    );
    focusable[0]?.focus();

    const opener = paletteOpenerRef.current ?? searchInputRef.current;
    return () => {
      opener?.focus();
    };
  }, [paletteOpen]);

  function handlePaletteKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setPaletteOpen(false);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      paletteRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled])'
      ) ?? []
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc((current) => !current);
      return;
    }
    setSortKey(key);
    setSortAsc(true);
  }

  /**
   * Run an export and hand focus back to the button that started it.
   *
   * Both export paths go through `window.confirm()`, which is a modal dialog:
   * the browser takes focus for the prompt and, in Chrome and Safari, does not
   * reliably return it to the trigger. A keyboard user is then dropped at the
   * top of the document and has to tab back through the whole toolbar — which
   * for this table means the search box, four filter buttons, the column
   * toggle, and every visible column checkbox.
   */
  function runExport(
    action: () => void,
    trigger: React.RefObject<HTMLButtonElement>
  ) {
    try {
      action();
    } finally {
      trigger.current?.focus();
    }
  }

  /**
   * Closing the column picker must return focus to the toggle that opened it.
   * The panel's checkboxes are removed from the DOM on close; whatever focus
   * was inside it goes to `document.body` unless it is moved deliberately.
   */
  function closeColumnPicker() {
    setShowColumnPicker(false);
    columnPickerToggleRef.current?.focus();
  }

  function handleColumnPickerKeyDown(
    event: React.KeyboardEvent<HTMLFieldSetElement>
  ) {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeColumnPicker();
    }
  }

  function toggleColumnPicker() {
    if (showColumnPicker) {
      closeColumnPicker();
      return;
    }
    setShowColumnPicker(true);
  }

  function toggleColumn(key: ContributorColumnKey) {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function getAriaSort(key: SortKey): "ascending" | "descending" | "none" {
    if (sortKey !== key) return "none";
    return sortAsc ? "ascending" : "descending";
  }

  function isVisible(key: ContributorColumnKey) {
    return visibleColumns.has(key);
  }

  const visibleCount = visibleColumns.size;
  const emptyStateColSpan = visibleCount + 1 + (onRecheck ? 1 : 0);

  function SortHeader({
    sortable,
    label,
  }: {
    sortable: SortKey;
    label: string;
  }) {
    const direction = getAriaSort(sortable);

    return (
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-stellar-cyan"
        onClick={() => toggleSort(sortable)}
        aria-label={`${label}, sort ${direction === "ascending" ? "descending" : "ascending"}`}
      >
        {label}
        <ArrowUpDown className="h-3.5 w-3.5" />
      </button>
    );
  }

  if (isLoading) {
    return (
      <div className={cn("space-y-4", className)} aria-busy="true">
        <div
          className="flex items-center justify-center py-20 text-muted-foreground"
          role="status"
          data-testid="contributors-loading"
        >
          <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
          Loading contributors...
        </div>
      </div>
    );
  }

  if (contributors.length === 0) {
    return (
      <div className={cn("space-y-4", className)}>
        <ContributorsZeroEmptyState
          viewerRole={viewerRole}
          registerUrl={registerUrl}
        />
      </div>
    );
  }

  return (
    <section
      id="contributor-table"
      aria-labelledby={headingId}
      tabIndex={-1}
      className={cn("space-y-4 outline-none", className)}
      data-testid="contributor-table-region"
    >
      <h2 id={headingId} className="sr-only">
        Contributor payout readiness
      </h2>

      {/* Labelled so a screen reader announces "Contributor table controls"
          rather than an unnamed group of eleven buttons. */}
      <div
        className="flex flex-wrap items-end gap-3"
        role="group"
        aria-label="Contributor table controls"
      >
        <div className="relative min-w-[220px] max-w-sm flex-1">
          <label htmlFor={searchInputId} className="sr-only">
            Search contributors by GitHub username or Stellar address
          </label>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            id={searchInputId}
            type="search"
            placeholder="Search by username or address"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>

        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Filter contributors by readiness</legend>
          {(
            [
              ["all", "All"],
              ["ready", "Ready"],
              ["low_reserve", "Low reserve"],
              ["needs_attention", "Needs attention"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "stellar" : "outline"}
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
            >
              {label}
            </Button>
          ))}
        </fieldset>

        <Button
          ref={columnPickerToggleRef}
          size="sm"
          variant="outline"
          onClick={toggleColumnPicker}
          aria-expanded={showColumnPicker}
          aria-controls={columnPickerId}
        >
          <SlidersHorizontal className="h-4 w-4" />
          Columns
        </Button>

        {onExport && (
          <div className="flex flex-wrap gap-2">
            <Button
              ref={csvExportRef}
              size="sm"
              variant={staleSummary.stale ? "destructive" : "outline"}
              onClick={() => setPendingExport("csv")}
              title={staleSummary.warning}
            >
              <Download className="h-4 w-4" />
              {staleSummary.stale ? "Export CSV (stale)" : "Export CSV"}
            </Button>
            <Button
              ref={jsonExportRef}
              size="sm"
              variant={staleSummary.stale ? "destructive" : "outline"}
              onClick={() => setPendingExport("json")}
              title={staleSummary.warning}
            >
              <Download className="h-4 w-4" />
              {staleSummary.stale ? "Export JSON (stale)" : "Export JSON"}
            </Button>
          </div>
        )}
      </div>

      {showColumnPicker && (
        <fieldset
          id={columnPickerId}
          ref={columnPickerRef}
          tabIndex={-1}
          onKeyDown={handleColumnPickerKeyDown}
          className="rounded-lg border bg-card px-4 py-3 outline-none"
          data-testid="column-picker"
        >
          <legend className="mb-2 text-sm font-medium text-muted-foreground">
            Toggle visible columns
          </legend>
          <p className="sr-only">Press Escape to close and return to the Columns button.</p>
          <div className="flex flex-wrap gap-3">
            {CONTRIBUTOR_COLUMNS.map((col) => (
              <label
                key={col.key}
                className={cn(
                  "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium",
                  visibleColumns.has(col.key)
                    ? "border-stellar-purple bg-stellar-purple/10 text-stellar-purple"
                    : "border-muted bg-muted/30 text-muted-foreground"
                )}
              >
                <input
                  type="checkbox"
                  checked={visibleColumns.has(col.key)}
                  onChange={() => toggleColumn(col.key)}
                />
                {col.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {paletteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-background/60 px-4 pt-[15vh] backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPaletteOpen(false);
          }}
        >
          <div
            ref={paletteRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={paletteTitleId}
            onKeyDown={handlePaletteKeyDown}
            className="w-full max-w-lg rounded-xl border bg-card p-4 shadow-xl"
          >
            <div className="flex items-center justify-between gap-4">
              <h2 id={paletteTitleId} className="font-semibold">Command palette</h2>
              <kbd className="text-xs text-muted-foreground">Esc</kbd>
            </div>
            <div className="mt-3 grid gap-2">
              <Input
                aria-label="Command palette search"
                placeholder="Search contributors"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <p className="pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Filter readiness
              </p>
              {([
                ["all", "All contributors"],
                ["ready", "Ready"],
                ["low_reserve", "Low reserve"],
                ["needs_attention", "Needs attention"],
              ] as const).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant={filter === value ? "stellar" : "outline"}
                  className="justify-start"
                  aria-pressed={filter === value}
                  onClick={() => { setFilter(value); setPaletteOpen(false); }}
                >
                  {label}
                </Button>
              ))}
              <Button
                type="button"
                variant="outline"
                className="justify-start"
                onClick={() => { setPaletteOpen(false); searchInputRef.current?.focus(); }}
              >
                Focus table search
              </Button>
              {onExport && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="justify-start"
                    onClick={() => { setPaletteOpen(false); setPendingExport("csv"); }}
                  >
                    Export CSV
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="justify-start"
                    onClick={() => { setPaletteOpen(false); setPendingExport("json"); }}
                  >
                    Export JSON
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {staleSummary.stale && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">⚠️ Stale data detected</p>
          <p className="mt-1">{staleSummary.warning}</p>
        </div>
      )}

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {filtered.length === contributors.length
          ? `${contributors.length} contributor${contributors.length !== 1 ? "s" : ""}`
          : `${filtered.length} of ${contributors.length} contributors`}
        {search && ` matching "${search}"`}
      </p>

      <div className="space-y-4 md:hidden">
        {filtered.length === 0 ? (
          <ContributorsFilteredEmptyState search={search} />
        ) : (
          filtered.map((row) => (
            <MobileContributorCard
              key={row.id}
              row={row}
              onRecheck={onRecheck}
              recheckingId={recheckingId}
            />
          ))
        )}
      </div>

      <div className="hidden overflow-x-auto rounded-xl border md:block">
        <table className="w-full min-w-[880px] text-sm">
          <caption className="sr-only">
            Contributor payout readiness table with per-row Horizon debug details
            and Freighter proof guidance.
          </caption>
          <thead className="bg-muted/50">
            <tr className="text-left">
              {isVisible("githubUsername") && (
                <th
                  className="px-4 py-3 font-medium"
                  scope="col"
                  aria-sort={getAriaSort("githubUsername")}
                >
                  <SortHeader sortable="githubUsername" label="GitHub" />
                </th>
              )}
              {isVisible("stellarAddress") && (
                <th className="px-4 py-3 font-medium" scope="col">
                  Stellar address
                </th>
              )}
              {isVisible("readiness") && (
                <th
                  className="px-4 py-3 font-medium"
                  scope="col"
                  aria-sort={getAriaSort("readiness")}
                >
                  <SortHeader sortable="readiness" label="Status" />
                </th>
              )}
              {isVisible("verified") && (
                <th className="px-4 py-3 font-medium" scope="col">
                  Verified
                </th>
              )}
              {isVisible("xlmBalance") && (
                <th
                  className="px-4 py-3 font-medium"
                  scope="col"
                  aria-sort={getAriaSort("xlmBalance")}
                >
                  <SortHeader sortable="xlmBalance" label="XLM" />
                </th>
              )}
              {isVisible("spendableXlmBalance") && (
                <th className="px-4 py-3 font-medium" scope="col">
                  Spendable XLM
                </th>
              )}
              {isVisible("lastCheckedAt") && (
                <th
                  className="px-4 py-3 font-medium"
                  scope="col"
                  aria-sort={getAriaSort("lastCheckedAt")}
                >
                  <SortHeader sortable="lastCheckedAt" label="Last checked" />
                </th>
              )}
              <th className="px-4 py-3 font-medium" scope="col">
                Diagnostics
              </th>
              {onRecheck && (
                <th className="px-4 py-3 text-right font-medium" scope="col">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={emptyStateColSpan} className="p-0">
                  <ContributorsFilteredEmptyState search={search} />
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr
                  key={row.id}
                  className={cn("border-t bg-card/50 align-top", getRowAccent(row.readiness))}
                >
                  {isVisible("githubUsername") && (
                    <th className="px-4 py-3 font-medium" scope="row">
                      <span>{formatGithubHandle(row.githubUsername)}</span>
                      {row.banned && (
                        <span
                          className="ml-2 inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800 dark:bg-red-950/80 dark:text-red-300"
                          title={row.banReason ? `Banned: ${row.banReason}` : "Banned"}
                          data-testid={`banned-badge-${row.githubUsername}`}
                        >
                          🚫 Banned
                        </span>
                      )}
                    </th>
                  )}
                  {isVisible("stellarAddress") && (
                    <td className="px-4 py-3 font-mono text-xs" title={row.stellarAddress}>
                      {shortenAddress(row.stellarAddress)}
                    </td>
                  )}
                  {isVisible("readiness") && (
                    <td className="px-4 py-3">
                      <TrustlineStatusBadge status={row.readiness} />
                    </td>
                  )}
                  {isVisible("verified") && (
                    <td className="px-4 py-3">
                      <VerifiedBadge verified={row.verified} />
                    </td>
                  )}
                  {isVisible("xlmBalance") && (
                    <td className="px-4 py-3">{formatXlmBalance(row.xlmBalance)}</td>
                  )}
                  {isVisible("spendableXlmBalance") && (
                    <td className="px-4 py-3">
                      {formatXlmBalance(row.spendableXlmBalance)}
                    </td>
                  )}
                  {isVisible("lastCheckedAt") && (
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatRelativeTime(row.lastCheckedAt)}
                    </td>
                  )}
                  <td className="min-w-[280px] px-4 py-3">
                    <ContributorDebugPanel row={row} />
                  </td>
                  {(onRecheck || onBanToggle) && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {onRecheck && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onRecheck(row.id)}
                            disabled={recheckingId === row.id}
                            aria-label={`Re-check ${row.githubUsername} via Horizon`}
                          >
                            {recheckingId === row.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4" />
                            )}
                            Re-check
                          </Button>
                        )}
                        {onBanToggle && (
                          <Button
                            size="sm"
                            variant={row.banned ? "outline" : "destructive"}
                            onClick={() => {
                              setBanDialogAction(row.banned ? "unban" : "ban");
                              setBanReasonInput("");
                              setBanDialogRow(row);
                            }}
                            aria-label={`${row.banned ? "Unban" : "Ban"} ${row.githubUsername}`}
                            data-testid={`ban-toggle-${row.githubUsername}`}
                          >
                            {row.banned ? "Unban" : "Ban"}
                          </Button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {hasMore && onLoadMore && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            onClick={onLoadMore}
            disabled={isLoadingMore}
            aria-label="Load more contributors"
          >
            {isLoadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            {isLoadingMore ? "Loading contributors..." : "Load more contributors"}
          </Button>
        </div>
      )}

      {/*
        A contributor export carries GitHub handles, wallet addresses and
        balances, so it gets a real confirmation rather than the browser's
        `window.confirm()`. `force` is passed on confirm because the maintainer
        has now seen the staleness warning in the dialog — asking twice is how
        confirmations get click-through-ignored.
      */}
      <ConfirmDialog
        open={pendingExport !== null}
        title={
          pendingExport === "json"
            ? "Export contributor data as JSON?"
            : "Export contributor data as CSV?"
        }
        description={
          <>
            This downloads{" "}
            <strong className="text-foreground">
              {contributors.length} contributor
              {contributors.length === 1 ? "" : "s"}
            </strong>{" "}
            to your device, including GitHub handles, Stellar addresses and
            balances. Handle the file as personal data.
          </>
        }
        warning={staleSummary.stale ? staleSummary.warning : undefined}
        confirmLabel={
          pendingExport === "json" ? "Download JSON" : "Download CSV"
        }
        cancelLabel="Cancel"
        destructive={staleSummary.stale}
        onCancel={() => {
          const format = pendingExport;
          const ref = format === "json" ? jsonExportRef : csvExportRef;
          setPendingExport(null);
          ref.current?.focus();
        }}
        onConfirm={() => {
          const format = pendingExport;
          const ref = format === "json" ? jsonExportRef : csvExportRef;
          setPendingExport(null);
          runExport(() => {
            if (format === "json") {
              exportContributorsJson(contributors, true);
            } else {
              onExport?.();
            }
          }, ref);
        }}
      />

      <ConfirmDialog
        open={banDialogRow !== null}
        title={`${banDialogAction === "ban" ? "Ban" : "Unban"} Contributor @${banDialogRow?.githubUsername}?`}
        description={
          banDialogAction === "ban" ? (
            <div className="space-y-3 pt-2">
              <p>
                Banning this contributor will reject all current and future registration or recheck attempts for this GitHub account.
              </p>
              <div>
                <label htmlFor="ban-reason-input" className="block text-xs font-semibold text-foreground mb-1">
                  Reason for ban <span className="text-red-500">*</span>
                </label>
                <Input
                  id="ban-reason-input"
                  type="text"
                  placeholder="e.g. Abusive behavior, stolen wallet, TOS violation"
                  value={banReasonInput}
                  onChange={(e) => setBanReasonInput(e.target.value)}
                  data-testid="ban-reason-input"
                />
              </div>
            </div>
          ) : (
            <p>
              Unbanning removes this GitHub account from the ban list and allows future registration and re-check attempts.
            </p>
          )
        }
        confirmLabel={
          isSubmittingBan
            ? banDialogAction === "ban"
              ? "Banning..."
              : "Unbanning..."
            : banDialogAction === "ban"
              ? "Confirm Ban"
              : "Confirm Unban"
        }
        cancelLabel="Cancel"
        destructive={banDialogAction === "ban"}
        onCancel={() => {
          setBanDialogRow(null);
          setBanReasonInput("");
        }}
        onConfirm={async () => {
          if (!banDialogRow || isSubmittingBan || !onBanToggle) return;
          const reason = banReasonInput.trim();
          if (banDialogAction === "ban" && !reason) return;
          try {
            setIsSubmittingBan(true);
            await onBanToggle(
              banDialogRow.githubUsername,
              banDialogAction,
              banDialogAction === "ban" ? reason : undefined
            );
            setBanDialogRow(null);
            setBanReasonInput("");
          } finally {
            setIsSubmittingBan(false);
          }
        }}
      />
    </section>
  );
}

export function exportContributorsCsv(
  contributors: ContributorRow[],
  force = false,
  filterStale = false
): boolean {
  const summary = buildStalenessSummary(contributors);

  if (summary.stale && !force && !filterStale) {
    const confirmed = window.confirm(
      `${summary.warning}\n\nDo you want to export anyway?`
    );
    if (!confirmed) return false;
  }

  const headers = [
    "github_username",
    "stellar_address",
    "readiness",
    "funded",
    "trustline",
    "trustline_authorized",
    "verified",
    "xlm_balance",
    "spendable_xlm_balance",
    "horizon_debug_summary",
    "horizon_next_action",
    "freighter_proof_challenge",
  ];

  const normalizedRows = contributors.map((row) => {
    const horizonDebug =
      row.horizonDebug ??
      buildHorizonDebugInfo({
        funded: row.funded,
        trustlineReady: row.trustlineReady,
        trustlineAuthorized: row.trustlineAuthorized,
        readiness: row.readiness,
        xlmBalance: row.xlmBalance,
        spendableXlmBalance: row.spendableXlmBalance,
        lastCheckedAt: row.lastCheckedAt,
      });
    const walletProof =
      row.walletProof ?? buildWalletProofInfo(row.stellarAddress, row.githubUsername);

    return [
      row.githubUsername,
      row.stellarAddress,
      row.readiness,
      row.funded,
      row.trustlineReady,
      row.trustlineAuthorized,
      row.verified,
      row.xlmBalance,
      row.lastCheckedAt ?? "",
      row.spendableXlmBalance,
      horizonDebug.summary,
      horizonDebug.nextAction,
      walletProof.challenge,
    ];
  });

  const csv = buildCsv(headers, normalizedRows);
  downloadCsv(buildCsvFilename("trustbridge-wave"), csv);
  return true;
}

export function exportContributorsJson(contributors: ContributorRow[], force = false, filterStale = false): boolean {
  const toExport = filterStale ? contributors.filter((c) => c.lastCheckedAt !== null && c.lastCheckedAt !== "") : contributors;
  const summary = buildStalenessSummary(contributors);

  if (summary.stale && !force && !filterStale) {
    const confirmed = window.confirm(
      `${summary.warning}\n\nDo you want to export anyway?`
    );
    if (!confirmed) return false;
  }

  const headers = [
    "github_username",
    "stellar_address",
    "readiness",
    "funded",
    "trustline",
    "trustline_authorized",
    "verified",
    "xlm_balance",
    "spendable_xlm_balance",
    "usdc_balance",
    "last_checked_at",
    "horizon_latency_ms",
  ];

  const rows = toExport.map((row) => [
    row.githubUsername,
    row.stellarAddress,
    row.readiness,
    row.funded,
    row.trustlineReady,
    row.trustlineAuthorized,
    row.verified,
    row.xlmBalance,
    row.spendableXlmBalance,
    row.usdcBalance,
    row.lastCheckedAt ?? "",
    row.horizonLatencyMs ?? "",
  ]);

  const json = buildJson(headers, rows);
  downloadJson(buildJsonFilename("trustbridge-wave"), json);
  return true;
}
