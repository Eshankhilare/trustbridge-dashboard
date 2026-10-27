/**
 * Dashboard section layout (server component).
 *
 * The dashboard is authenticated and per-user, driven by URL search params
 * (pagination via useSearchParams). Prerendering is meaningless, so the
 * whole section always renders on demand. (Route segment config cannot live
 * in the client-component page itself, hence this layout.)
 */
export const dynamic = "force-dynamic";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
