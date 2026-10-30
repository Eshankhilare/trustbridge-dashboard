import { withAuth } from "next-auth/middleware";
import { NextRequest, NextResponse } from "next/server";

import { recordAuditLog } from "@/lib/audit";
import {
  getMaintenanceMessage,
  shouldBlockForMaintenance,
} from "@/lib/maintenance";
import { extractRequestId, generateRequestId } from "@/lib/request-id";

const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

/**
 * RBAC path rules (default deny):
 *
 * /dashboard          -> viewer+
 * /dashboard/settings -> operator+
 * /register           -> authenticated (any role)
 * /api/contributors   -> operator+ (POST = admin-only for batch recheck)
 * /api/invites        -> admin-only
 */
/**
 * Demo-only middleware. It intentionally does not invoke `withAuth`, so demo
 * deployments do not need NEXTAUTH_SECRET, OAuth, or a database. Real
 * dashboard/register routes are redirected to the isolated `/demo` page.
 */
function demoMiddleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const requestId = extractRequestId(req.headers) ?? generateRequestId();
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-request-id", requestId);

  if (shouldBlockForMaintenance(req.method, path)) {
    const maintenanceResponse = NextResponse.json(
      { error: "maintenance_mode", message: getMaintenanceMessage() },
      { status: 503, headers: { "Retry-After": "120" } }
    );
    maintenanceResponse.headers.set("x-request-id", requestId);
    return maintenanceResponse;
  }

  if (path.startsWith("/dashboard") || path.startsWith("/register")) {
    const redirectResponse = NextResponse.redirect(new URL("/demo", req.url));
    redirectResponse.headers.set("x-request-id", requestId);
    return redirectResponse;
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("x-request-id", requestId);
  return response;
}

const authMiddleware = withAuth(
  function middleware(req) {
    const token = req.nextauth.token;
    const isMaintainer = token?.isMaintainer;
    // Maintainers without an explicit role default to "viewer" per the RBAC
    // hierarchy defined in src/lib/api-auth.ts.
    const role = (token?.role as string | undefined) ?? (isMaintainer ? "viewer" : undefined);
    const path = req.nextUrl.pathname;

    // Propagate or generate a request ID for distributed tracing.
    // Incoming `x-request-id` is trusted only when it is a valid UUID v4;
    // any other value is replaced with a fresh one.
    const requestId =
      extractRequestId(req.headers) ?? generateRequestId();
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set("x-request-id", requestId);

    // Maintenance mode (issue #202): during a deploy, mutating API requests are
    // rejected with a 503 while reads stay up. `/api/auth`, `/api/webhooks` and
    // `/api/health` are exempt (see src/lib/maintenance.ts). The kill switch is
    // the env var only, so a bad DB can't strand maintainers.
    //
    // Deliberately no audit write here: maintenance mode often coincides with a
    // migration, and a blocked client retrying would amplify writes against a
    // database that may be mid-deploy. The 503 response is the signal.
    if (shouldBlockForMaintenance(req.method, path)) {
      const maintenanceResponse = NextResponse.json(
        { error: "maintenance_mode", message: getMaintenanceMessage() },
        { status: 503, headers: { "Retry-After": "120" } }
      );
      maintenanceResponse.headers.set("x-request-id", requestId);
      return maintenanceResponse;
    }

    // /dashboard requires viewer+
    if (path.startsWith("/dashboard")) {
      if (!isMaintainer) {
        const redirectResponse = NextResponse.redirect(
          new URL("/register?error=maintainer", req.url)
        );
        redirectResponse.headers.set("x-request-id", requestId);
        return redirectResponse;
      }

      // /dashboard/settings requires operator+
      if (path.startsWith("/dashboard/settings") && role !== "admin" && role !== "operator") {
        recordAuditLog({
          action: "rbac_middleware_denied",
          metadata: { path, requiredRole: "operator", actualRole: role },
        }).catch(() => {});
        const redirectResponse = NextResponse.redirect(
          new URL("/dashboard?error=insufficient_role", req.url)
        );
        redirectResponse.headers.set("x-request-id", requestId);
        return redirectResponse;
      }
    }

    // /api/invites is admin-only. A single, explicit check replaces the
    // previous nested condition which was logically equivalent to "always
    // block unless role === admin" but was much harder to read.
    if (path.startsWith("/api/invites")) {
      if (role !== "admin") {
        recordAuditLog({
          action: "rbac_middleware_denied",
          metadata: { path, requiredRole: "admin", actualRole: role ?? null },
        }).catch(() => {});
        const forbiddenResponse = NextResponse.json(
          { error: "Forbidden" },
          { status: 403 }
        );
        forbiddenResponse.headers.set("x-request-id", requestId);
        return forbiddenResponse;
      }
    }

    // Pass the request ID forward in both request headers (for server-side
    // handlers to read via headers()) and response headers (for clients to
    // log or display in error UIs).
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    response.headers.set("x-request-id", requestId);
    return response;
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        const path = req.nextUrl.pathname;

        if (path.startsWith("/dashboard")) {
          return !!token;
        }

        if (path.startsWith("/register")) {
          return !!token;
        }

        return true;
      },
    },
  }
);

export default demoMode ? demoMiddleware : authMiddleware;

export const config = {
  // `/api/:path*` is matched so maintenance mode can 503 mutating API calls.
  // The `authorized` callback returns true for API paths, so this does not add
  // an auth gate — each route keeps doing its own authorization.
  matcher: [
    "/dashboard/:path*",
    "/register/:path*",
    // All API routes except NextAuth's own endpoints, so maintenance mode can
    // 503 mutating calls without wrapping the auth flow.
    "/api/((?!auth).*)",
  ],
};