import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { recordAuditLog } from "@/lib/audit";
import { ApiKeyScope, hasApiKeyScope } from "@/lib/api-key-scopes";
import { hashApiKey, isValidApiKeyFormat } from "@/lib/api-key-crypto";
import { prisma } from "@/lib/prisma";
import {
  buildRateLimitHeaders,
  checkRateLimit,
  extractClientIp,
} from "@/lib/rate-limit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ApiKeyScope } from "@/lib/api-key-scopes";
export { API_KEY_SCOPES } from "@/lib/api-key-scopes";

/** The subset of the ApiKey row returned to callers after a successful auth. */
export interface AuthenticatedApiKey {
  id: string;
  name: string;
  scopes: string[];
  createdById: string;
  maintainerOrgId: string;
}

/**
 * Stable, machine-readable reasons a dual-auth request is rejected.  Routes
 * map these to HTTP status codes so the session-vs-API-key matrix is
 * deterministic and testable.
 */
export type DualAuthRejection =
  | "missing_credentials"
  | "conflicting_credentials"
  | "malformed_authorization";

/**
 * Result of inspecting a request for the session-vs-API-key credential matrix.
 *
 * - `api_key`  → an `Authorization: Bearer <token>` header is present.
 * - `session`  → no bearer token; caller should fall back to session auth.
 * - `rejected` → the combination is not allowed; return the mapped status.
 */
export type DualAuthMode =
  | { mode: "api_key"; token: string }
  | { mode: "session" }
  | { mode: "rejected"; reason: DualAuthRejection };

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

/**
 * Return true when the key's `scopes` list covers `required`.
 * The wildcard scope `"*"` is reserved for internal use and is intentionally
 * not creatable via the UI, but is recognised here for flexibility.
 */
export function hasScope(scopes: string[], required: ApiKeyScope): boolean {
  return hasApiKeyScope(scopes, required);
}

// ---------------------------------------------------------------------------
// Dual-auth matrix
// ---------------------------------------------------------------------------

/**
 * Classify a request against the explicit session-vs-API-key matrix.
 *
 * Allowed combinations:
 * - API-key-only: `Authorization: Bearer <token>` present, no session cookie.
 * - Session-only: no bearer token; caller resolves the session.
 *
 * Rejected combinations:
 * - Both a bearer token and a session cookie are present (ambiguous identity).
 * - A non-empty `Authorization` header that is not a well-formed bearer token.
 *
 * This helper does not touch the DB; it only decides which auth path to take
 * so routes stay consistent with `requireApiKeyScope`.
 */
export function resolveDualAuthMode(request: NextRequest): DualAuthMode {
  const authHeader = request.headers.get("authorization");
  const hasSessionCookie = Boolean(
    request.cookies.get("next-auth.session-token")?.value ||
      request.cookies.get("__Secure-next-auth.session-token")?.value
  );

  if (authHeader === null) {
    return { mode: "session" };
  }

  const trimmed = authHeader.trim();
  if (trimmed === "") {
    return { mode: "session" };
  }

  if (!trimmed.startsWith("Bearer ")) {
    return { mode: "rejected", reason: "malformed_authorization" };
  }

  const token = trimmed.slice(7).trim();
  if (!token) {
    return { mode: "rejected", reason: "malformed_authorization" };
  }

  if (hasSessionCookie) {
    return { mode: "rejected", reason: "conflicting_credentials" };
  }

  return { mode: "api_key", token };
}

/** Map a dual-auth rejection reason to the HTTP status a route should return. */
export function dualAuthRejectionStatus(reason: DualAuthRejection): number {
  switch (reason) {
    case "missing_credentials":
      return 401;
    case "conflicting_credentials":
      return 400;
    case "malformed_authorization":
      return 400;
  }
}

// ---------------------------------------------------------------------------
// Rate limiting constants
// ---------------------------------------------------------------------------

/**
 * API key endpoints are much less latency-sensitive than browser sessions,
 * but we still protect them from brute-force enumeration: 60 requests per
 * minute per IP.  Env vars `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS`
 * are the process-wide defaults; these override per-call for export routes.
 */
const API_KEY_RATE_LIMIT = {
  windowMs: 60_000,
  maxRequests: 60,
} as const;

// ---------------------------------------------------------------------------
// Main authenticator
// ---------------------------------------------------------------------------

/**
 * Extract the bearer token from `Authorization: Bearer <token>`, look it up
 * in the database by its SHA-256 hash, verify the key is active and has the
 * required scope, apply a per-IP rate limit, update `lastUsedAt`, and return
 * the key record.
 *
 * Returns `null` on any auth failure; the caller is responsible for returning
 * a 401/403.  A `RateLimitResult` is returned when the IP is rate-limited so
 * the route can set the appropriate response headers.
 *
 * @example
 * ```ts
 * const auth = await requireApiKeyScope(request, "export:read");
 * if ("rateLimited" in auth) {
 *   return NextResponse.json({ error: "Too many requests" }, {
 *     status: 429,
 *     headers: buildRateLimitHeaders(auth.result, API_KEY_MAX_REQUESTS),
 *   });
 * }
 * if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 * ```
 */
/**
 * Authenticate an API key without enforcing any scope.
 *
 * Runs the same rate-limit, format, lookup, and lifecycle (revoked/expired)
 * checks as {@link requireApiKeyScope}. Returns the key record so the caller
 * can enforce a scope explicitly and return a stable 403 when it is missing.
 * Returns `null` on any auth failure; the caller is responsible for returning
 * a 401. A `RateLimitResult` is returned when the IP is rate-limited.
 */
export async function authenticateApiKey(
  request: NextRequest
): Promise<
  | AuthenticatedApiKey
  | { rateLimited: true; result: { allowed: false; retryAfter: number; remaining: number } }
  | null
> {
  // ── 1. Rate-limit by IP before touching the DB ──────────────────────────
  const ip = extractClientIp(request);
  const rl = checkRateLimit(`api-key:${ip}`, API_KEY_RATE_LIMIT);
  if (!rl.allowed) {
    return { rateLimited: true, result: rl as { allowed: false; retryAfter: number; remaining: number } };
  }

  // ── 2. Extract bearer token ──────────────────────────────────────────────
  const authHeader = request.headers.get("authorization") ?? "";
  const raw = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  if (!raw || !isValidApiKeyFormat(raw)) {
    return null;
  }

  // ── 3. Hash and look up ──────────────────────────────────────────────────
  const keyHash = hashApiKey(raw);

  let key: {
    id: string;
    name: string;
    scopes: string[];
    createdById: string;
    maintainerOrgId: string;
    revokedAt: Date | null;
    expiresAt: Date | null;
  } | null;

  try {
    key = await prisma.apiKey.findUnique({
      where: { keyHash },
      select: {
        id: true,
        name: true,
        scopes: true,
        createdById: true,
        maintainerOrgId: true,
        revokedAt: true,
        expiresAt: true,
      },
    });
  } catch {
    // DB error: fail closed.
    return null;
  }

  if (!key) {
    return null;
  }

  // ── 4. Lifecycle checks ───────────────────────────────────────────────────
  const now = new Date();

  if (key.revokedAt) {
    await recordAuditLog({
      action: "api_key.use_rejected",
      targetId: key.id,
      targetLabel: key.name,
      metadata: { reason: "revoked" },
    });
    return null;
  }

  if (key.expiresAt && key.expiresAt < now) {
    await recordAuditLog({
      action: "api_key.use_rejected",
      targetId: key.id,
      targetLabel: key.name,
      metadata: { reason: "expired", expiredAt: key.expiresAt.toISOString() },
    });
    return null;
  }

  // ── 5. Update lastUsedAt (best-effort, non-blocking) ────────────────────
  prisma.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: now } })
    .catch(() => {/* best-effort */ });

  return {
    id: key.id,
    name: key.name,
    scopes: key.scopes,
    createdById: key.createdById,
    maintainerOrgId: key.maintainerOrgId,
  };
}

/**
 * Authenticate an API key and enforce that it carries `requiredScope`.
 * Thin wrapper over {@link authenticateApiKey}; returns `null` when the key
 * is missing/invalid/expired/revoked or lacks the scope, so existing callers
 * keep their 401 behaviour. Prefer {@link authenticateApiKey} plus
 * {@link insufficientScopeResponse} when a stable 403 is required.
 */
export async function requireApiKeyScope(
  request: NextRequest,
  requiredScope: ApiKeyScope
): Promise<
  | AuthenticatedApiKey
  | { rateLimited: true; result: { allowed: false; retryAfter: number; remaining: number } }
  | null
> {
  const auth = await authenticateApiKey(request);
  if (!auth || "rateLimited" in auth) return auth;
  if (!hasScope(auth.scopes, requiredScope)) {
    await recordAuditLog({
      action: "api_key.use_rejected",
      targetId: auth.id,
      targetLabel: auth.name,
      metadata: { reason: "insufficient_scope", required: requiredScope, actual: auth.scopes },
    });
    return null;
  }
  return auth;
}

/**
 * Stable 403 response for a valid API key that lacks the required scope.
 * No stack traces or key material — safe to return verbatim.
 */
export function insufficientScopeResponse(requiredScope: ApiKeyScope) {
  return NextResponse.json(
    {
      error: "Forbidden: API key lacks the required scope",
      code: "insufficient_scope",
      requiredScope,
    },
    { status: 403 }
  );
}

// Re-export so callers only need to import from this module.
export { buildRateLimitHeaders, API_KEY_RATE_LIMIT };
