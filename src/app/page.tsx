import Link from "next/link";
import type { Session } from "next-auth";
import {
  ArrowRight,
  CheckCircle2,
  Code2,
  Shield,
  Wallet,
  Zap,
} from "lucide-react";

import { GitHubIcon } from "@/components/icons/GitHubIcon";
import { SignInButton } from "@/components/SignInButton";

import { WaveReadinessBar } from "@/components/WaveReadinessBar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getDemoDashboardStats } from "@/lib/demo-data";
import { isDemoModeEnabled } from "@/lib/demo-mode";
import type { DashboardStats } from "@/types";

export const dynamic = "force-dynamic";

async function loadStats() {
  try {
    // Loaded lazily so demo mode never initialises Prisma or requires a
    // DATABASE_URL just to render the public landing page.
    const { getDashboardStats } = await import("@/lib/registrations");
    return await getDashboardStats();
  } catch {
    return { totalContributors: 0, readyCount: 0, readyPercent: 0 };
  }
}

export default async function HomePage() {
  const demoMode = isDemoModeEnabled();
  let session: Session | null = null;
  let stats: DashboardStats;

  if (demoMode) {
    stats = getDemoDashboardStats();
  } else {
    const { getServerSession } = await import("next-auth");
    const { authOptions } = await import("@/lib/auth");
    session = await getServerSession(authOptions);
    stats = await loadStats();
  }

  return (
    <div className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-stellar-purple/[0.07] blur-3xl" />
        <div className="absolute top-48 right-0 h-72 w-72 rounded-full bg-stellar-cyan/[0.05] blur-3xl" />
      </div>

      {/* Hero — centered, focused */}
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-7xl px-6 pb-20 pt-20 sm:px-8 lg:pb-24 lg:pt-24">
        <div className="mx-auto max-w-2xl text-center">
          <p className="mb-5 inline-flex items-center rounded-full border border-border bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground">
            {demoMode
              ? "Public demo · Synthetic data · No sign-in required"
              : "Open source · Stellar · GitHub OAuth"}
          </p>
          <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl sm:leading-[1.12] lg:text-6xl">
            Bridge open-source work to{" "}
            <span className="bg-stellar-gradient bg-clip-text text-transparent">
              Stellar payouts
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-muted-foreground/90 sm:text-lg sm:leading-8">
            TrustBridge solves the{" "}
            <strong className="font-medium text-foreground">
              PAYMENT_NO_TRUST
            </strong>{" "}
            problem: maintainers need a verified mapping from GitHub
            contributors to funded Stellar accounts with the correct USDC
            trustline before a Wave payout can succeed.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {demoMode ? (
              <>
                <Button
                  asChild
                  size="lg"
                  variant="stellar"
                  className="h-12 px-8 text-base"
                >
                  <Link href="/demo">
                    Explore the live demo
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="h-12 px-6"
                >
                  <Link href="#how-it-works">How it works</Link>
                </Button>
              </>
            ) : session ? (
              <Button
                asChild
                size="lg"
                variant="stellar"
                className="h-12 px-8 text-base"
              >
                <Link href="/register">
                  Register your Stellar address
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            ) : (
              <SignInButton
                size="lg"
                variant="stellar"
                callbackUrl="/register"
                className="h-12 px-8 text-base"
              >
                <GitHubIcon className="h-4 w-4" />
                Register your Stellar address
              </SignInButton>
            )}
            {!demoMode && session?.user?.isMaintainer && (
              <Button asChild size="lg" variant="outline" className="h-12 px-6">
                <Link href="/dashboard">Maintainer dashboard</Link>
              </Button>
            )}
          </div>
        </div>
      </main>

      {/* Stats — structured full-width grid, spacious cards */}
      <section className="border-y bg-muted/30">
        <div className="mx-auto grid max-w-7xl grid-cols-1 items-stretch gap-5 px-6 py-14 sm:grid-cols-3 sm:px-8 lg:gap-6 lg:py-16">
          <Card className="flex h-full min-h-[160px] flex-col border-border/60">
            <CardHeader className="flex-1 p-8 text-left">
              <CardDescription className="text-xs font-medium uppercase tracking-wide">
                Registered contributors
              </CardDescription>
              <CardTitle className="mt-3 text-4xl tabular-nums tracking-tight">
                {stats.totalContributors}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card className="flex h-full min-h-[160px] flex-col border-stellar-purple/25 shadow-md shadow-stellar-purple/[0.08]">
            <CardHeader className="p-8 pb-3 text-left">
              <CardDescription className="text-xs font-medium uppercase tracking-wide text-stellar-purple dark:text-primary">
                Ready for payout
              </CardDescription>
              <CardTitle className="mt-3 text-5xl tabular-nums tracking-tight">
                {stats.readyPercent}%
              </CardTitle>
            </CardHeader>
            <CardContent className="mt-auto p-8 pt-0 text-left">
              <WaveReadinessBar
                readyCount={stats.readyCount}
                totalCount={stats.totalContributors}
              />
            </CardContent>
          </Card>
          <Card className="flex h-full min-h-[160px] flex-col border-border/60">
            <CardHeader className="p-8 pb-3 text-left">
              <CardDescription className="text-xs font-medium uppercase tracking-wide">
                Validation
              </CardDescription>
              <CardTitle className="mt-3 text-xl font-semibold tracking-tight">
                Live Horizon checks
              </CardTitle>
            </CardHeader>
            <CardContent className="mt-auto p-8 pt-0 text-left text-sm leading-relaxed text-muted-foreground">
              Trustline, funding, and XLM reserve verified on every registration.
            </CardContent>
          </Card>
        </div>
        {demoMode && (
          <p className="mx-auto max-w-3xl px-6 pb-12 text-center text-sm text-muted-foreground sm:px-8">
            The public demo uses synthetic contributors and activity. No real
            wallets, balances, transactions, or maintainer records are shown.
          </p>
        )}
      </section>

      {/* How it works — structured, left-aligned copy */}
      <section
        id="how-it-works"
        className="mx-auto max-w-7xl scroll-mt-24 px-6 py-20 sm:px-8 lg:py-24"
      >
        <div className="max-w-2xl text-left">
          <h2 className="text-3xl font-bold tracking-tight">
            How TrustBridge works
          </h2>
          <p className="mt-3 max-w-xl leading-relaxed text-muted-foreground/90">
            A lightweight registry plus Horizon validation so Wave maintainers
            never send USDC to accounts that cannot receive it.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4 lg:gap-6">
          {[
            {
              icon: Code2,
              title: "Sign in with GitHub",
              body: "Contributors authenticate with GitHub OAuth. Your handle is the payout identity.",
            },
            {
              icon: Wallet,
              title: "Register G-address",
              body: "Submit your Stellar public key. We validate format and query Horizon in real time.",
            },
            {
              icon: Shield,
              title: "Trustline readiness",
              body: "We confirm USDC trustline, account funding, and minimum XLM reserve.",
            },
            {
              icon: Zap,
              title: "Wave-ready export",
              body: "Maintainers batch re-check accounts and export CSV for payout preparation.",
            },
          ].map(({ icon: Icon, title, body }) => (
            <Card key={title} className="h-full border-border/60">
              <CardHeader className="p-8 text-left">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-stellar-purple/[0.08] text-stellar-purple dark:bg-primary/10 dark:text-primary">
                  <Icon className="h-5 w-5" />
                </div>
                <CardTitle className="text-base font-semibold">{title}</CardTitle>
                <CardDescription className="mt-1.5 leading-relaxed">
                  {body}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      {/* Closing CTA — centered */}
      <section className="border-t bg-muted/20">
        <div className="mx-auto max-w-7xl px-6 py-16 text-center sm:px-8 lg:py-20">
          <CheckCircle2 className="mx-auto h-8 w-8 text-stellar-cyan/80" />
          <h2 className="mx-auto mt-5 max-w-xl text-2xl font-bold tracking-tight">
            Ready to join the Wave?
          </h2>
          <p className="mx-auto mt-3 max-w-md leading-relaxed text-muted-foreground/90">
            Registration takes less than two minutes once your Stellar wallet is
            funded and your USDC trustline is active.
          </p>
          {demoMode ? (
            <Button
              asChild
              className="mt-8 h-12 px-8 text-base"
              variant="stellar"
              size="lg"
            >
              <Link href="/demo">Open the public demo</Link>
            </Button>
          ) : session ? (
            <Button
              asChild
              className="mt-8 h-12 px-8 text-base"
              variant="stellar"
              size="lg"
            >
              <Link href="/register">Get started</Link>
            </Button>
          ) : (
            <SignInButton
              className="mt-8 h-12 px-8 text-base"
              variant="stellar"
              size="lg"
              callbackUrl="/register"
            >
              Get started
            </SignInButton>
          )}
        </div>
      </section>
    </div>
  );
}
