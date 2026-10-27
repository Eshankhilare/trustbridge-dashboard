import { NextRequest, NextResponse } from "next/server";

import { buildActionLookupResult } from "@/lib/action-lookup";
import { buildCacheKey, buildLookupCacheHeaders, verificationCache } from "@/lib/cache";
import { DEFAULT_ASSET } from "@/lib/constants";
import { checkStellarAddress } from "@/lib/horizon";
import { isValidStellarAddress } from "@/lib/stellar";
import { publicOptionsResponse, withPublicCors } from "@/lib/public-cors";
import {
  checkRateLimit,
  extractClientIp,
  buildRateLimitHeaders,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Short TTL: fresh enough for the registration wizard, long enough to
// absorb bursts against Horizon rate limits.
const LOOKUP_CACHE_TTL_MS = 30_000;

/** Generous limit for the public lookup endpoint (60 req/min default). */
const LOOKUP_MAX_REQUESTS = 60;

export async function GET(request: NextRequest) {
  // ── Rate limit ─────────────────────────────────────────────────────────────
  const clientIp = extractClientIp(request);
  const rateLimit = checkRateLimit(clientIp, {
    maxRequests: LOOKUP_MAX_REQUESTS,
  });
  const rateLimitHeaders = buildRateLimitHeaders(rateLimit, LOOKUP_MAX_REQUESTS);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please try again later." },
      { status: 429, headers: rateLimitHeaders }
    );
  }

  const address = request.nextUrl.searchParams.get("address")?.trim();

  if (!address) {
    return withPublicCors(NextResponse.json(
      { error: "address query parameter is required" },
      { status: 400 }
    ));
  }

  if (!isValidStellarAddress(address)) {
    return withPublicCors(NextResponse.json(
      { error: "Invalid Stellar public key (must be a valid G-address)" },
      { status: 400 }
    ));
  }

  const assetCode =
    request.nextUrl.searchParams.get("asset_code")?.trim() || DEFAULT_ASSET.code;
  const assetIssuer =
    request.nextUrl.searchParams.get("asset_issuer")?.trim() ||
    DEFAULT_ASSET.issuer;

  const cacheKey = buildCacheKey("action-lookup", address, assetCode, assetIssuer);

  try {
    const result = await verificationCache.getOrCompute(
      cacheKey,
      async () =>
        buildActionLookupResult(
          await checkStellarAddress(address, assetCode, assetIssuer)
        ),
      LOOKUP_CACHE_TTL_MS
    );

    return withPublicCors(NextResponse.json(result, {
      headers: {
        ...rateLimitHeaders,
        ...buildLookupCacheHeaders(LOOKUP_CACHE_TTL_MS),
      },
    }));
  } catch {
    return withPublicCors(NextResponse.json({ error: "Lookup failed" }, { status: 500 }));
  }
}

export function OPTIONS() {
  return publicOptionsResponse("GET, OPTIONS");
}
