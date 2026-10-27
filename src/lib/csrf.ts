import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function getAllowedHosts(request: NextRequest): Set<string> {
  const hosts = new Set<string>();

  const forwarded = request.headers.get("x-forwarded-host");
  if (forwarded) {
    forwarded.split(",").forEach((h) => hosts.add(h.trim().toLowerCase()));
  }

  const host = request.headers.get("host");
  if (host) {
    hosts.add(host.trim().toLowerCase());
  }

  // Fallback to URL host (e.g., in test environments where Host header is absent)
  const urlHost = request.nextUrl.host;
  if (urlHost) {
    hosts.add(urlHost.trim().toLowerCase());
  }

  const nextauthUrl = process.env.NEXTAUTH_URL;
  if (nextauthUrl) {
    try {
      const { host: nh } = new URL(nextauthUrl);
      if (nh) hosts.add(nh.trim().toLowerCase());
    } catch {
      // Malformed NEXTAUTH_URL: ignore gracefully (invalid env config edge case)
    }
  }

  return hosts;
}

function parseHostFromOrigin(origin: string): string | null {
  try {
    const { host } = new URL(origin);
    return host ? host.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Validates that a mutating request originates from the same origin
 * as the application. Safe methods (GET, HEAD, OPTIONS) bypass.
 *
 * Policy:
 * - If Origin header is present → must match allowed host(s)
 * - If Origin absent → check Referer → must match allowed host(s)
 * - If both absent → allow (non-browser/API client; no cookie-based CSRF risk)
 *
 * Returns a 403 NextResponse when rejected, or null when allowed.
 */
export function assertSameOrigin(request: NextRequest): NextResponse | null {
  if (SAFE_METHODS.has(request.method)) {
    return null;
  }

  const allowedHosts = getAllowedHosts(request);

  const origin = request.headers.get("origin");
  if (origin) {
    const host = parseHostFromOrigin(origin);
    if (!host || !allowedHosts.has(host)) {
      return NextResponse.json(
        { error: "Invalid request origin" },
        { status: 403 }
      );
    }
    return null;
  }

  const referer = request.headers.get("referer");
  if (referer) {
    const host = parseHostFromOrigin(referer);
    if (!host || !allowedHosts.has(host)) {
      return NextResponse.json(
        { error: "Invalid request origin" },
        { status: 403 }
      );
    }
    return null;
  }

  // No Origin and no Referer → allow (non-browser client)
  return null;
}

/**
 * Enforces CSRF protection for mutating requests by requiring a valid
 * same-origin Origin/Referer (via {@link assertSameOrigin}) AND a matching
 * double-submit CSRF token.
 *
 * Token source (matches existing mutating-route patterns):
 * - Header: `x-csrf-token`
 * - Cookie: `csrf_token`
 *
 * Safe methods (GET, HEAD, OPTIONS) bypass entirely.
 *
 * Returns a 403 NextResponse when rejected, or null when allowed.
 */
export function assertCsrf(request: NextRequest): NextResponse | null {
  if (SAFE_METHODS.has(request.method)) {
    return null;
  }

  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  const headerToken = request.headers.get("x-csrf-token");
  const cookieToken = request.cookies.get("csrf_token")?.value;

  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return NextResponse.json(
      { error: "Invalid CSRF token" },
      { status: 403 }
    );
  }

  return null;
}

const CSRF_SECRET =
  process.env.NEXTAUTH_SECRET ||
  process.env.CSRF_SECRET ||
  "trustbridge-csrf-default-secret-key-32";

const CSRF_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Issues a signed, timestamped CSRF token bound to the specified userId.
 */
export function generateCsrfToken(userId: string): string {
  if (!userId) {
    throw new Error("userId is required to generate a CSRF token");
  }
  const timestamp = Date.now().toString();
  const salt = crypto.randomBytes(16).toString("hex");
  const data = `${userId}:${timestamp}:${salt}`;
  const hmac = crypto
    .createHmac("sha256", CSRF_SECRET)
    .update(data)
    .digest("hex");
  return `${timestamp}.${salt}.${hmac}`;
}

export const issueCsrfToken = generateCsrfToken;

/**
 * Validates a signed CSRF token against the user's ID.
 * Returns true if valid and not expired, false otherwise.
 */
export function validateCsrfToken(userId: string, token: string): boolean {
  if (!userId || !token || typeof token !== "string") {
    return false;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return false;
  }
  const [timestampStr, salt, providedHmac] = parts;
  const timestamp = parseInt(timestampStr, 10);
  if (Number.isNaN(timestamp)) {
    return false;
  }
  const now = Date.now();
  // Fails closed if expired or if timestamp is in the future beyond 60s
  if (now - timestamp > CSRF_EXPIRY_MS || timestamp > now + 60_000) {
    return false;
  }
  const data = `${userId}:${timestampStr}:${salt}`;
  const expectedHmac = crypto
    .createHmac("sha256", CSRF_SECRET)
    .update(data)
    .digest("hex");

  try {
    const providedBuf = Buffer.from(providedHmac, "hex");
    const expectedBuf = Buffer.from(expectedHmac, "hex");
    if (providedBuf.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Enforces CSRF protection for mutating requests using the signed,
 * user-bound token issued by {@link generateCsrfToken}.
 *
 * Unlike {@link assertCsrf} (double-submit cookie), this variant binds the
 * token to the authenticated user so a token minted for one user cannot be
 * replayed by another. Used by sensitive mutating endpoints such as the
 * address-history export.
 *
 * Token source:
 * - Header: `x-csrf-token`
 *
 * Safe methods (GET, HEAD, OPTIONS) bypass entirely.
 *
 * Returns a 403 NextResponse when rejected, or null when allowed.
 */
export function assertSignedCsrf(
  request: NextRequest,
  userId: string
): NextResponse | null {
  if (SAFE_METHODS.has(request.method)) {
    return null;
  }

  const originError = assertSameOrigin(request);
  if (originError) {
    return originError;
  }

  const headerToken = request.headers.get("x-csrf-token");
  if (!headerToken || !userId || !validateCsrfToken(userId, headerToken)) {
    return NextResponse.json(
      { error: "Invalid CSRF token" },
      { status: 403 }
    );
  }

  return null;
}
