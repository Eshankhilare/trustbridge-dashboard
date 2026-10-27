/**
 * Issue #144 — mobile navigation drawer in the header.
 *
 * Below md the center nav is hidden; the hamburger opens a sheet with the same
 * links. These tests lock in open/close, ESC dismissal, focus return, and
 * maintainer-only links.
 */

import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockSignIn = vi.fn();
const mockSignOut = vi.fn();
const mockSetTheme = vi.fn();

let mockSession: {
  user: {
    id: string;
    githubUsername?: string;
    isMaintainer?: boolean;
  };
} | null = null;

let mockTheme = "light";

vi.mock("next-auth/react", () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
  signOut: (...args: unknown[]) => mockSignOut(...args),
  useSession: () => ({ data: mockSession }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    theme: mockTheme,
    setTheme: mockSetTheme,
  }),
}));

vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ locale: "en", setLocale: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    onClick,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    onClick?: () => void;
  }) => (
    <a href={href} onClick={onClick} {...props}>
      {children}
    </a>
  ),
}));

import { Header } from "@/components/Header";

function setContributorSession() {
  mockSession = {
    user: {
      id: "user-1",
      githubUsername: "alice",
      isMaintainer: false,
    },
  };
}

function setMaintainerSession() {
  mockSession = {
    user: {
      id: "user-2",
      githubUsername: "maintainer",
      isMaintainer: true,
    },
  };
}

// Header embeds NotificationBell (react-query), so every render needs a client.
function renderHeader() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Header />
    </QueryClientProvider>
  );
}

async function openMobileMenu() {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Open navigation menu" })
  );
  return user;
}

describe("Header — mobile navigation drawer", () => {
  beforeEach(() => {
    mockSession = null;
    mockTheme = "light";
    vi.clearAllMocks();
  });

  it("shows the hamburger control for opening the drawer", () => {
    renderHeader();

    expect(
      screen.getByRole("button", { name: "Open navigation menu" })
    ).toBeInTheDocument();
  });

  it("keeps Sign in visible in the header when signed out", () => {
    renderHeader();

    expect(
      screen.getByRole("button", { name: /sign in with github/i })
    ).toBeInTheDocument();
  });

  it("opens the drawer with primary nav links", async () => {
    renderHeader();
    await openMobileMenu();

    const drawer = screen.getByRole("dialog");
    expect(drawer).toHaveAttribute("aria-modal", "true");

    const mobileNav = within(drawer).getByRole("navigation", { name: "Mobile" });
    expect(within(mobileNav).getByRole("link", { name: "Home" })).toHaveAttribute(
      "href",
      "/"
    );
    expect(
      within(mobileNav).getByRole("button", { name: "Register" })
    ).toBeInTheDocument();
  });

  it("closes the drawer on Escape and returns focus to the menu button", async () => {
    renderHeader();
    const user = await openMobileMenu();

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open navigation menu" })
    ).toHaveFocus();
  });

  it("closes the drawer when the backdrop is clicked", async () => {
    renderHeader();
    await openMobileMenu();

    const user = userEvent.setup();
    await user.click(screen.getByTestId("mobile-nav-backdrop"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows maintainer Dashboard and Settings links in the drawer", async () => {
    setMaintainerSession();
    renderHeader();
    await openMobileMenu();

    const drawer = screen.getByRole("dialog");
    const mobileNav = within(drawer).getByRole("navigation", { name: "Mobile" });

    expect(
      within(mobileNav).getByRole("link", { name: "Dashboard" })
    ).toHaveAttribute("href", "/dashboard");
    expect(
      within(mobileNav).getByRole("link", { name: "Settings" })
    ).toHaveAttribute("href", "/dashboard/settings");
  });

  it("hides maintainer links for contributors in the drawer", async () => {
    setContributorSession();
    renderHeader();
    await openMobileMenu();

    const drawer = screen.getByRole("dialog");
    const mobileNav = within(drawer).getByRole("navigation", { name: "Mobile" });

    expect(
      within(mobileNav).queryByRole("link", { name: "Dashboard" })
    ).not.toBeInTheDocument();
    expect(
      within(mobileNav).queryByRole("link", { name: "Settings" })
    ).not.toBeInTheDocument();
  });

  it("shows Register as a link when signed in", async () => {
    setContributorSession();
    renderHeader();
    await openMobileMenu();

    const drawer = screen.getByRole("dialog");
    const mobileNav = within(drawer).getByRole("navigation", { name: "Mobile" });

    expect(
      within(mobileNav).getByRole("link", { name: "Register" })
    ).toHaveAttribute("href", "/register");
  });

  it("traps Tab focus inside the drawer", async () => {
    renderHeader();
    const user = await openMobileMenu();

    const drawer = screen.getByRole("dialog");
    const closeButton = within(drawer).getByRole("button", {
      name: "Close navigation menu",
    });
    expect(closeButton).toHaveFocus();

    const headerSignIn = screen.getAllByRole("button", {
      name: /sign in with github/i,
    })[0];

    await user.tab();
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(headerSignIn);

    const focusable = Array.from(
      drawer.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])'
      )
    );
    const lastFocusable = focusable[focusable.length - 1];

    while (
      document.activeElement !== lastFocusable &&
      drawer.contains(document.activeElement)
    ) {
      await user.tab();
    }

    await user.tab();
    expect(closeButton).toHaveFocus();
  });
});
