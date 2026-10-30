import { afterEach, describe, expect, it } from "vitest";

import { isDemoModeEnabled } from "@/lib/demo-mode";

const ORIGINAL = process.env.NEXT_PUBLIC_DEMO_MODE;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  } else {
    process.env.NEXT_PUBLIC_DEMO_MODE = ORIGINAL;
  }
});

describe("isDemoModeEnabled", () => {
  it("is disabled unless explicitly set to true", () => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    expect(isDemoModeEnabled()).toBe(false);

    process.env.NEXT_PUBLIC_DEMO_MODE = "false";
    expect(isDemoModeEnabled()).toBe(false);

    process.env.NEXT_PUBLIC_DEMO_MODE = "1";
    expect(isDemoModeEnabled()).toBe(false);
  });

  it("is enabled only by the exact value true", () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "true";
    expect(isDemoModeEnabled()).toBe(true);
  });
});
