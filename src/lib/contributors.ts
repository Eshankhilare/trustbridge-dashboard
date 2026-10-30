import type { ContributorRow, ReadinessStatus } from "@/types";

export type ContributorSortKey = "githubUsername" | "xlmBalance" | "lastCheckedAt" | "readiness";
export type ContributorFilter = "all" | "ready" | "needs_attention" | "low_reserve";

/** Column identifiers for the contributor table. */
export type ContributorColumnKey =
  | "githubUsername"
  | "stellarAddress"
  | "readiness"
  | "verified"
  | "xlmBalance"
  | "spendableXlmBalance"
  | "lastCheckedAt";

export interface ContributorColumnDef {
  key: ContributorColumnKey;
  label: string;
  defaultVisible: boolean;
}

/** All available columns in their default display order. */
export const CONTRIBUTOR_COLUMNS: ContributorColumnDef[] = [
  { key: "githubUsername",     label: "GitHub",         defaultVisible: true },
  { key: "stellarAddress",     label: "Stellar address", defaultVisible: true },
  { key: "readiness",          label: "Status",         defaultVisible: true },
  { key: "verified",           label: "Verified",       defaultVisible: true },
  { key: "xlmBalance",         label: "XLM",            defaultVisible: true },
  { key: "spendableXlmBalance",label: "Spendable XLM",  defaultVisible: false },
  { key: "lastCheckedAt",      label: "Last checked",   defaultVisible: true },
];

/** Returns the set of column keys that are visible by default. */
export function defaultVisibleColumns(): Set<ContributorColumnKey> {
  return new Set(
    CONTRIBUTOR_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key),
  );
}

/**
 * A single contributor table column in the maintainer's chosen order.
 * Hidden columns stay in the list so re-showing them restores their position.
 */
export interface ContributorColumnPreference {
  key: ContributorColumnKey;
  visible: boolean;
}

export type ContributorColumnPreferencesValidation =
  | { valid: true; preferences: ContributorColumnPreference[] }
  | { valid: false; errors: string[] };

const CONTRIBUTOR_COLUMN_KEYS = new Set<string>(
  CONTRIBUTOR_COLUMNS.map((column) => column.key),
);

/** Default ordered preference list, preserving the canonical column order. */
export function defaultContributorColumnPreferences(): ContributorColumnPreference[] {
  return CONTRIBUTOR_COLUMNS.map((column) => ({
    key: column.key,
    visible: column.defaultVisible,
  }));
}

/**
 * Validate persisted/submitted column preferences.
 *
 * The preference list is the single source of truth for both visibility and
 * order, so it must contain every available column exactly once. Unknown keys,
 * duplicates, missing/extra entries and an all-hidden table are rejected.
 */
export function validateContributorColumnPreferences(
  input: unknown,
): ContributorColumnPreferencesValidation {
  if (!Array.isArray(input)) {
    return {
      valid: false,
      errors: ["Column preferences must be an array."],
    };
  }

  const errors: string[] = [];

  if (input.length !== CONTRIBUTOR_COLUMNS.length) {
    errors.push(
      `Column preferences must list all ${CONTRIBUTOR_COLUMNS.length} columns exactly once.`,
    );
  }

  const seen = new Set<string>();
  const preferences: ContributorColumnPreference[] = [];

  input.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`Column preference at position ${index + 1} must be an object.`);
      return;
    }

    const { key, visible } = entry as { key?: unknown; visible?: unknown };

    if (typeof key !== "string" || !CONTRIBUTOR_COLUMN_KEYS.has(key)) {
      errors.push(`Unknown column at position ${index + 1}.`);
      return;
    }

    if (seen.has(key)) {
      errors.push(`Duplicate column: ${key}.`);
      return;
    }

    if (typeof visible !== "boolean") {
      errors.push(`Column ${key} must include a boolean visible flag.`);
      return;
    }

    seen.add(key);
    preferences.push({ key: key as ContributorColumnKey, visible });
  });

  if (preferences.length > 0 && !preferences.some((entry) => entry.visible)) {
    errors.push("At least one column must remain visible.");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, preferences };
}

/**
 * Resolve persisted preferences, falling back to defaults when the stored value
 * is missing or no longer valid (for example after a column is renamed).
 */
export function resolveContributorColumnPreferences(
  input: unknown,
): ContributorColumnPreference[] {
  const result = validateContributorColumnPreferences(input);
  return result.valid
    ? result.preferences
    : defaultContributorColumnPreferences();
}

export function readinessNeedsAttention(readiness: ReadinessStatus): boolean {
  return readiness !== "ready";
}

export function filterContributors(
  contributors: ContributorRow[],
  filter: ContributorFilter,
): ContributorRow[] {
  if (filter === "ready") {
    return contributors.filter((row) => row.readiness === "ready");
  }
  if (filter === "needs_attention") {
    return contributors.filter((row) => readinessNeedsAttention(row.readiness));
  }
  if (filter === "low_reserve") {
    return contributors.filter((row) => row.readiness === "low_reserve");
  }
  return [...contributors];
}

/**
 * Normalizes contributor search values so matching is resilient to case,
 * whitespace, leading @ symbols, and punctuation-heavy addresses.
 */
function normalizeSearchValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9]/g, "");
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  const matrix = Array.from({ length: left.length + 1 }, () =>
    Array(right.length + 1).fill(0),
  );

  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );

      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + cost);
      }
    }
  }

  return matrix[left.length][right.length];
}

function fuzzyMatches(value: string, query: string): boolean {
  const normalizedValue = normalizeSearchValue(value);
  const normalizedQuery = normalizeSearchValue(query);

  if (!normalizedQuery) return true;
  if (normalizedValue.includes(normalizedQuery)) return true;

  const maxDistance = Math.max(1, Math.min(2, Math.floor(normalizedQuery.length * 0.2)));
  const vLen = normalizedValue.length;
  const qLen = normalizedQuery.length;
  if (Math.abs(vLen - qLen) > maxDistance + 2) return false;

  return levenshteinDistance(normalizedValue, normalizedQuery) <= maxDistance;
}

/**
 * Search contributors by GitHub username or Stellar address.
 * Performs case-insensitive matching and tolerates small typing errors.
 */
export function searchContributors(
  contributors: ContributorRow[],
  query: string,
): ContributorRow[] {
  const q = query.trim();
  if (!q) return contributors;

  return contributors.filter((row) => {
    const githubUsername = row.githubUsername ?? "";
    const stellarAddress = row.stellarAddress ?? "";

    return (
      fuzzyMatches(githubUsername, q) ||
      fuzzyMatches(stellarAddress, q) ||
      githubUsername.toLowerCase().includes(q.toLowerCase()) ||
      stellarAddress.toLowerCase().includes(q.toLowerCase())
    );
  });
}

export function compareContributors(
  a: ContributorRow,
  b: ContributorRow,
  sortKey: ContributorSortKey,
): number {
  if (sortKey === "githubUsername") {
    return a.githubUsername.localeCompare(b.githubUsername);
  }

  if (sortKey === "xlmBalance") {
    return Number.parseFloat(a.xlmBalance) - Number.parseFloat(b.xlmBalance);
  }

  if (sortKey === "readiness") {
    const order: Record<string, number> = { ready: 0, low_reserve: 1, not_ready: 2 };
    return (order[a.readiness] ?? 3) - (order[b.readiness] ?? 3);
  }

  const aTime = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
  const bTime = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
  return aTime - bTime;
}

export function sortContributors(
  contributors: ContributorRow[],
  sortKey: ContributorSortKey,
  ascending = true,
): ContributorRow[] {
  return [...contributors].sort((a, b) => {
    const comparison = compareContributors(a, b, sortKey);
    return ascending ? comparison : -comparison;
  });
}

export function countReadyContributors(contributors: ContributorRow[]): number {
  return contributors.filter((row) => row.readiness === "ready").length;
}
