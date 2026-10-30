"use client";

import * as React from "react";
import Link from "next/link";
import type { Session } from "next-auth";
import { signIn, signOut, useSession } from "next-auth/react";
import {
  LayoutDashboard,
  Menu,
  Moon,
  Settings,
  Sun,
  UserPlus,
  X,
} from "lucide-react";
import { useTheme } from "next-themes";

import { GitHubIcon } from "@/components/icons/GitHubIcon";
import { NotificationBell } from "@/components/NotificationBell";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { SignInButton } from "@/components/SignInButton";
import { isDemoModeEnabled } from "@/lib/demo-mode";
import { useI18n } from "@/lib/i18n-context";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Mobile navigation drawer (issue #144).
 *
 * Below md the center nav is hidden; a hamburger opens a sheet with the same
 * links. Focus trap + ESC mirror confirm-dialog.tsx — no modal library.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const navLinkClass =
  "text-muted-foreground transition-colors hover:text-foreground";

/** Minimal locale switcher — cycles through supported locales. */
const LOCALES = ["en", "es", "pt"] as const;
type Locale = (typeof LOCALES)[number];
const LOCALE_LABELS: Record<Locale, string> = { en: "EN", es: "ES", pt: "PT" };

function LocaleSwitcher() {
  const { locale, setLocale } = useI18n();

  const cycleLocale = React.useCallback(() => {
    const idx = LOCALES.indexOf(locale as Locale);
    const next = LOCALES[(idx + 1) % LOCALES.length];
    setLocale(next);
  }, [locale, setLocale]);

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Switch language, current: ${LOCALE_LABELS[locale as Locale] ?? locale}`}
      onClick={cycleLocale}
      className="hidden w-10 px-0 text-xs font-semibold sm:inline-flex"
    >
      {LOCALE_LABELS[locale as Locale] ?? locale.toUpperCase()}
    </Button>
  );
}

function LocaleSwitcherMobile() {
  const { locale, setLocale } = useI18n();


  return (
    <div className="flex gap-1">
      {LOCALES.map((l) => (
        <Button
          key={l}
          variant={locale === l ? "stellar" : "outline"}
          size="sm"
          className="flex-1 text-xs font-semibold"
          aria-pressed={locale === l}
          onClick={() => setLocale(l)}
        >
          {LOCALE_LABELS[l]}
        </Button>
      ))}
    </div>
  );
}

function HeaderContent({
  session,
  demoMode,
}: {
  session: Session | null;
  demoMode: boolean;
}) {
  const { theme, setTheme } = useTheme();
  const [menuOpen, setMenuOpen] = React.useState(false);

  const menuButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const drawerRef = React.useRef<HTMLDivElement | null>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);

  const titleId = React.useId();

  const closeMenu = React.useCallback(() => {
    setMenuOpen(false);
  }, []);

  const toggleTheme = React.useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [setTheme, theme]);

  React.useEffect(() => {
    if (!menuOpen) return;

    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeButtonRef.current?.focus();

    const opener = menuButtonRef.current ?? openerRef.current;
    return () => {
      opener?.focus();
    };
  }, [menuOpen]);

  function handleDrawerKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeMenu();
      return;
    }

    if (event.key !== "Tab") return;

    const focusable = Array.from(
      drawerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []
    ).filter((element) => !element.hasAttribute("aria-hidden"));

    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (
      event.shiftKey &&
      (active === first || !drawerRef.current?.contains(active))
    ) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/85 shadow-[0_1px_2px_0_rgb(0_0_0_/_0.03)] backdrop-blur-lg">
      <div className="grid h-16 w-full grid-cols-[1fr_auto_1fr] items-center px-6 sm:px-8">
        {/* Left — logo at the edge */}
        <div className="justify-self-start">
          <Link href="/" className="flex items-center gap-2.5 font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-stellar-purple to-stellar-cyan text-sm font-semibold text-white">
              TB
            </span>
            <span className="tracking-tight">TrustBridge</span>
            {demoMode && (
              <span className="rounded-full border border-amber-400 bg-amber-100 px-2 py-0.5 text-[10px] font-bold tracking-wide text-amber-900 dark:border-amber-700 dark:bg-amber-950/70 dark:text-amber-200">
                DEMO
              </span>
            )}
          </Link>
        </div>

        {/* Center — desktop nav */}
        <nav
          className="hidden items-center gap-6 text-sm font-medium md:flex"
          aria-label="Main"
        >
          <Link href="/" className={navLinkClass}>
            Home
          </Link>
          {demoMode && (
            <Link href="/demo" className={navLinkClass}>
              Live demo
            </Link>
          )}
          {!demoMode &&
            (session ? (
              <Link href="/register" className={navLinkClass}>
                Register
              </Link>
            ) : (
              <button
                type="button"
                className={navLinkClass}
                onClick={() => signIn("github", { callbackUrl: "/register" })}
              >
                Register
              </button>
            ))}
          {session?.user?.isMaintainer && (
            <Link href="/dashboard" className={navLinkClass}>
              Dashboard
            </Link>
          )}
          {session?.user?.isMaintainer && (
            <Link href="/dashboard/queue" className={navLinkClass}>
              Failed jobs
            </Link>
          )}
          {session?.user?.isMaintainer && (
            <Link href="/dashboard/settings" className={navLinkClass}>
              Settings
            </Link>
          )}
        </nav>

        {/* Right — actions at the edge */}
        <div className="flex items-center justify-self-end gap-1.5">
          <Button
            ref={menuButtonRef}
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-expanded={menuOpen}
            aria-controls="mobile-nav-drawer"
            aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? (
              <X className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Menu className="h-5 w-5" aria-hidden="true" />
            )}
          </Button>

          <LocaleSwitcher />

          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            onClick={toggleTheme}
          >
            <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          </Button>

          {session && <NotificationBell />}
          {session?.user?.isMaintainer && <OrgSwitcher />}

          {session ? (
            <div className="flex items-center gap-1.5">
              <span className="hidden px-1.5 text-sm text-muted-foreground sm:inline">
                @{session.user.githubUsername}
              </span>
              <Button variant="outline" size="sm" onClick={() => signOut()}>
                Sign out
              </Button>
            </div>
          ) : demoMode ? (
            <Button asChild variant="stellar" size="sm">
              <Link href="/demo">Live demo</Link>
            </Button>
          ) : (
            <SignInButton variant="stellar" size="sm" callbackUrl="/register">
              <GitHubIcon className="h-4 w-4" />
              Sign in with GitHub
            </SignInButton>
          )}

          {!demoMode &&
            (session ? (
              <Button
                asChild
                variant="cyan"
                size="sm"
                className="hidden sm:inline-flex"
              >
                <Link href="/register">
                  <UserPlus className="h-4 w-4" />
                  Register
                </Link>
              </Button>
            ) : (
              <SignInButton
                variant="cyan"
                size="sm"
                className="hidden sm:inline-flex"
                callbackUrl="/register"
              >
                <UserPlus className="h-4 w-4" />
                Register
              </SignInButton>
            ))}

          {session?.user?.isMaintainer && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="hidden sm:inline-flex"
            >
              <Link href="/dashboard">
                <LayoutDashboard className="h-4 w-4" />
                Dashboard
              </Link>
            </Button>
          )}
          {session?.user?.isMaintainer && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="hidden sm:inline-flex"
            >
              <Link href="/dashboard/settings">
                <Settings className="h-4 w-4" />
                Settings
              </Link>
            </Button>
          )}
        </div>
      </div>

      {menuOpen && (
        <div
          className="fixed inset-0 z-[60] md:hidden"
          data-testid="mobile-nav-backdrop"
          onMouseDown={closeMenu}
        >
          <div
            ref={drawerRef}
            id="mobile-nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onKeyDown={handleDrawerKeyDown}
            onMouseDown={(event) => event.stopPropagation()}
            className={cn(
              "absolute right-0 top-0 flex h-full w-[min(100%,20rem)] flex-col",
              "border-l border-border bg-background shadow-xl"
            )}
            data-testid="mobile-nav-drawer"
          >
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <h2 id={titleId} className="text-sm font-semibold">
                Menu
              </h2>
              <Button
                ref={closeButtonRef}
                variant="ghost"
                size="icon"
                aria-label="Close navigation menu"
                onClick={closeMenu}
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </Button>
            </div>

            <nav
              className="flex flex-col gap-1 px-4 py-4 text-sm font-medium"
              aria-label="Mobile"
            >
              <Link href="/" className={cn(navLinkClass, "rounded-md px-3 py-2")} onClick={closeMenu}>
                Home
              </Link>
              {demoMode && (
                <Link
                  href="/demo"
                  className={cn(navLinkClass, "rounded-md px-3 py-2")}
                  onClick={closeMenu}
                >
                  Live demo
                </Link>
              )}
              {!demoMode &&
                (session ? (
                  <Link
                    href="/register"
                    className={cn(navLinkClass, "rounded-md px-3 py-2")}
                    onClick={closeMenu}
                  >
                    Register
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={cn(navLinkClass, "rounded-md px-3 py-2 text-left")}
                    onClick={() => {
                      closeMenu();
                      signIn("github", { callbackUrl: "/register" });
                    }}
                  >
                    Register
                  </button>
                ))}
              {session?.user?.isMaintainer && (
                <Link
                  href="/dashboard"
                  className={cn(navLinkClass, "rounded-md px-3 py-2")}
                  onClick={closeMenu}
                >
                  Dashboard
                </Link>
              )}
              {session?.user?.isMaintainer && (
                <Link
                  href="/dashboard/queue"
                  className={cn(navLinkClass, "rounded-md px-3 py-2")}
                  onClick={closeMenu}
                >
                  Failed jobs
                </Link>
              )}
              {session?.user?.isMaintainer && (
                <Link
                  href="/dashboard/settings"
                  className={cn(navLinkClass, "rounded-md px-3 py-2")}
                  onClick={closeMenu}
                >
                  Settings
                </Link>
              )}
            </nav>

            <div className="mt-auto border-t border-border px-4 py-4">
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-start"
                  onClick={toggleTheme}
                >
                  <Sun className="mr-2 h-4 w-4 dark:hidden" aria-hidden="true" />
                  <Moon className="mr-2 hidden h-4 w-4 dark:block" aria-hidden="true" />
                  Toggle theme
                </Button>

                <LocaleSwitcherMobile />

                {session ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="justify-start"
                    onClick={() => {
                      closeMenu();
                      signOut();
                    }}
                  >
                    Sign out
                  </Button>
                ) : demoMode ? (
                  <Button asChild variant="stellar" size="sm" className="justify-start">
                    <Link href="/demo" onClick={closeMenu}>
                      Open the live demo
                    </Link>
                  </Button>
                ) : (
                  <Button
                    variant="stellar"
                    size="sm"
                    className="justify-start"
                    onClick={() => {
                      closeMenu();
                      signIn("github", { callbackUrl: "/register" });
                    }}
                  >
                    <GitHubIcon className="h-4 w-4" />
                    Sign in with GitHub
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

/** Production header: reads the live NextAuth session. */
export function Header() {
  const { data: session } = useSession();
  return (
    <HeaderContent session={session ?? null} demoMode={isDemoModeEnabled()} />
  );
}

/** Public demo header: no SessionProvider or session API call required. */
export function DemoHeader() {
  return <HeaderContent session={null} demoMode />;
}
