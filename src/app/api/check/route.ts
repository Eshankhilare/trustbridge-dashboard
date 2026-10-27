import { NextRequest, NextResponse } from "next/server";

import { assertSameOrigin } from "@/lib/csrf";
import {
  extractClientIp,
  checkRateLimit,
  buildRateLimitHeaders,
} from "@/lib/rate-limit";
import { jsonCheckError, jsonCheckResult } from "@/lib/check-api";
import { DEFAULT_ASSET } from "@/lib/constants";
import { checkStellarAddress } from "@/lib/horizon";
import { checkCache, buildCacheKey } from "@/lib/cache";
import { captureException } from "@/lib/sentry";
import { publicOptionsResponse, withPublicCors } from "@/lib/public-cors";
import type { CheckAddressPayload, HorizonCheckResult } from "@/types";

export const runtime = "nodejs";

/**
 * Build the cache key used by the /api/check route layer.
 * Distinct prefix ("check") from the internal horizon cache ("horizon") so
 * the two layers can be invalidated independently.
 */
function buildCheckCacheKey(
  address: string,
  assetCode: string,
  assetIssuer: string
): string {
  return buildCacheKey("check", address, assetCode, assetIssuer);
}

/**
 * Whether the request has explicitly requested a cache bypass.
 * Accepted signals:
 *  - `X-Cache-Bypass: 1` header  (maintainer tooling / batch re-check flows)
 *  - `cache_bypass=1` query param (convenience for direct API consumers)
 */
function isCacheBypass(request: NextRequest): boolean {
  if (request.headers.get("x-cache-bypass") === "1") return true;
  if (request.nextUrl.searchParams.get("cache_bypass") === "1") return true;
  return false;
}

export async function POST(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return withPublicCors(csrf);

  const clientIp = extractClientIp(request);
  const rateLimit = checkRateLimit(clientIp);
  const rateLimitHeaders = buildRateLimitHeaders(rateLimit, 10);

  if (!rateLimit.allowed) {
    return withPublicCors(
      NextResponse.json(
        { errors: ["Rate limit exceeded. Please try again later."] },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateLimit.retryAfter),
            ...rateLimitHeaders,
          },
        }
      )
    );
  }

  try {
    const body = (await request.json()) as CheckAddressPayload;
    const address = body.address?.trim();

    if (!address) {
      return withPublicCors(
        jsonCheckError(["Address is required"], 400, "not_ready", rateLimitHeaders)
      );
    }

    const assetCode = body.asset_code ?? DEFAULT_ASSET.code;
    const assetIssuer = body.asset_issuer ?? DEFAULT_ASSET.issuer;
    const bypass = isCacheBypass(request);
    const cacheKey = buildCheckCacheKey(address, assetCode, assetIssuer);

    if (!bypass) {
      const cached = checkCache.get(cacheKey) as HorizonCheckResult | null;
      if (cached) {
        return withPublicCors(jsonCheckResult(cached, 200, rateLimitHeaders));
      }
    }

    const result = await checkStellarAddress(address, assetCode, assetIssuer, {
      useCache: !bypass,
    });

    const isTransient =
      result.errors?.some(
        (e) =>
          e.includes("temporarily unavailable") ||
          e.startsWith("Horizon error:")
      ) ?? false;

    if (!bypass && !isTransient) {
      checkCache.set(cacheKey, result);
    }

    return withPublicCors(jsonCheckResult(result, 200, rateLimitHeaders));
  } catch (error) {
    captureException(error, { route: "/api/check", method: "POST" });
    return withPublicCors(
      jsonCheckError(["Failed to check address"], 500, "not_ready", rateLimitHeaders)
    );
  }
}

export function OPTIONS() {
  return publicOptionsResponse("POST, OPTIONS");
}