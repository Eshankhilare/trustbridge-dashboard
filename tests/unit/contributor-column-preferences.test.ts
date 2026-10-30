import { describe, expect, it } from "vitest";

import {
  CONTRIBUTOR_COLUMNS,
  defaultContributorColumnPreferences,
  resolveContributorColumnPreferences,
  validateContributorColumnPreferences,
  type ContributorColumnPreference,
} from "@/lib/contributors";

function validPreferences(): ContributorColumnPreference[] {
  return defaultContributorColumnPreferences();
}

describe("contributor column preferences", () => {
  it("provides a complete default order with the existing default visibility", () => {
    const defaults = defaultContributorColumnPreferences();

    expect(defaults.map((entry) => entry.key)).toEqual(
      CONTRIBUTOR_COLUMNS.map((column) => column.key),
    );
    expect(
      defaults.find((entry) => entry.key === "spendableXlmBalance")?.visible,
    ).toBe(false);
    expect(
      defaults.find((entry) => entry.key === "githubUsername")?.visible,
    ).toBe(true);
  });

  it("accepts reordering and hiding columns", () => {
    const reordered = validPreferences();
    const stellarIndex = reordered.findIndex(
      (entry) => entry.key === "stellarAddress",
    );
    const [stellar] = reordered.splice(stellarIndex, 1);
    reordered.unshift(stellar);
    const lastChecked = reordered.find(
      (entry) => entry.key === "lastCheckedAt",
    );
    if (lastChecked) lastChecked.visible = false;

    const result = validateContributorColumnPreferences(reordered);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.preferences[0].key).toBe("stellarAddress");
    expect(
      result.preferences.find((entry) => entry.key === "lastCheckedAt")
        ?.visible,
    ).toBe(false);
  });

  it("rejects unknown columns", () => {
    const invalid = [
      ...validPreferences().slice(0, -1),
      { key: "unknownColumn", visible: true },
    ];

    const result = validateContributorColumnPreferences(invalid);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.join(" ")).toMatch(/Unknown column/i);
  });

  it("rejects duplicate columns", () => {
    const invalid = [...validPreferences()];
    invalid[invalid.length - 1] = { ...invalid[0] };

    const result = validateContributorColumnPreferences(invalid);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.join(" ")).toMatch(/Duplicate column/i);
  });

  it("rejects an incomplete ordering", () => {
    const result = validateContributorColumnPreferences(
      validPreferences().slice(0, -1),
    );

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.join(" ")).toMatch(/exactly once/i);
  });

  it("rejects an extra ordering entry", () => {
    const result = validateContributorColumnPreferences([
      ...validPreferences(),
      ...validPreferences().slice(0, 1),
    ]);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.join(" ")).toMatch(
      /exactly once|Duplicate column/i,
    );
  });

  it("rejects non-boolean visibility", () => {
    const invalid = validPreferences().map((entry) =>
      entry.key === "githubUsername"
        ? { key: entry.key, visible: "yes" }
        : entry,
    );

    const result = validateContributorColumnPreferences(invalid);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.join(" ")).toMatch(/boolean visible flag/i);
  });

  it("rejects a table with every column hidden", () => {
    const invalid = validPreferences().map((entry) => ({
      ...entry,
      visible: false,
    }));

    const result = validateContributorColumnPreferences(invalid);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.join(" ")).toMatch(/At least one column/i);
  });

  it("rejects a non-array payload", () => {
    const result = validateContributorColumnPreferences({ columns: [] });

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.join(" ")).toMatch(/must be an array/i);
  });

  it("falls back to defaults for invalid stored values", () => {
    expect(resolveContributorColumnPreferences("broken")).toEqual(
      defaultContributorColumnPreferences(),
    );
  });
});
