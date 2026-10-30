/**
 * Issue #143 — guards that the real shell files still carry the landmarks the
 * behavioural tests in `skip-links.test.tsx` model.
 *
 * `layout.tsx` and `Providers.tsx` cannot be rendered in isolation under
 * Vitest (next/font, SessionProvider, next-themes), so the contract is checked
 * against the source. Crude, but it fails loudly if someone deletes the skip
 * link, and that is the whole point.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

describe("src/app/layout.tsx", () => {
  const source = read("src/app/layout.tsx");

  it("renders a skip link", () => {
    expect(source).toContain('href="#main-content"');
    expect(source).toContain("Skip to main content");
  });

  it("puts the skip link before the app shell", () => {
    // It has to be the first focusable element, or it is not a skip link.
    expect(source.indexOf('href="#main-content"')).toBeLessThan(
      source.indexOf("<Providers")
    );
  });

  it("keeps the skip link hidden until focus", () => {
    expect(source).toContain("focus:not-sr-only");
  });
});

describe("src/components/Providers.tsx", () => {
  const source = read("src/components/Providers.tsx");

  it("gives main the skip-link target id", () => {
    expect(source).toContain('id="main-content"');
  });

  it("makes main programmatically focusable", () => {
    expect(source).toContain("tabIndex={-1}");
  });
});

describe("src/components/Header.tsx", () => {
  const source = read("src/components/Header.tsx");

  it("labels the navigation landmark", () => {
    // Two unnamed <nav> elements are indistinguishable in a landmark list.
    expect(source).toContain('aria-label="Main"');
  });
});

describe("src/app/dashboard/page.tsx", () => {
  const source = read("src/app/dashboard/page.tsx");

  it("offers a skip link straight to the contributor table", () => {
    expect(source).toContain('href="#contributor-table"');
    expect(source).toContain("Skip to contributor table");
  });

  it("has exactly one h1", () => {
    const h1Count = (source.match(/<h1[\s>]/g) ?? []).length;
    expect(h1Count).toBe(1);
  });

  it("labels its standalone regions", () => {
    expect(source).toContain('aria-labelledby="wave-overview-heading"');
    expect(source).toContain('aria-labelledby="soroban-timeline-heading"');
  });

  it("announces batch re-check progress in a live region", () => {
    expect(source).toContain('aria-live="polite"');
  });
});
