/**
 * Public demo mode is opt-in at build time via `NEXT_PUBLIC_DEMO_MODE=true`.
 *
 * Demo mode only enables the isolated `/demo` experience and demo-aware public
 * landing page. It never relaxes authentication, authorization, CSRF checks, or
 * API scoping for real maintainer routes.
 */
export function isDemoModeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === "true";
}
