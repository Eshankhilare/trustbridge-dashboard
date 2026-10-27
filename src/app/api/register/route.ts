import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";

import { recordAuditLog } from "@/lib/audit";
import { authOptions } from "@/lib/auth";
import { DEFAULT_ASSET } from "@/lib/constants";
import { assertSameOrigin } from "@/lib/csrf";
import { checkStellarAddress } from "@/lib/horizon";
import { prisma } from "@/lib/prisma";
import {
  buildWalletProofInfo,
  buildHorizonDebugInfo,
} from "@/lib/registration-insights";
import { validateRegistrationInput } from "@/lib/register-validation";
import { computeReadiness } from "@/lib/readiness";
import { OnboardingChecklistState, parseChecklistState } from "@/types";
import { captureException } from "@/lib/sentry";
import { mirrorRegistrationToSoroban } from "@/lib/soroban-register";
import { recordInitialAddress, recordAddressChange } from "@/lib/address-history";
import { enforceFreezeWindowGuard } from "@/lib/freeze-window";
import { evaluateAndAuditAddressChangeAnomaly } from "@/lib/address-anomaly";
import { isUserBanned } from "@/lib/ban-service";
import {
  trackServerRegistrationCreated,
  trackServerRegistrationUpdated,
} from "@/lib/analytics";
import {
  checkRateLimit,
  buildRateLimitHeaders,
  extractClientIp,
} from "@/lib/rate-limit";
import { invalidateContributorListCaches } from "@/lib/cache-tags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Machine-readable failure reasons for `POST /api/register`.
 *
 * The client rolls an optimistic save back differently depending on *why* the
 * server said no: a taken address means keep the form, show the conflict, and
 * let the contributor try another wallet; an expired session means the whole
 * page is stale and re-authenticating is the only useful next step. Matching
 * on the human-readable `error` string to tell those apart would break the
 * moment someone reworded it, so the reason travels as a stable code
 * alongside the message.
 *
 * `error` is unchanged and stays the string a human reads.
 *
 * Module-local: route modules may only export handlers, so this is not
 * exported (Next.js route-type validation rejects extra exports).
 */
const REGISTER_ERROR_CODES = {
  /** Not signed in, or the session expired mid-form. */
  unauthorized: "UNAUTHORIZED",
  /** Request failed the same-origin check. */
  forbiddenOrigin: "FORBIDDEN_ORIGIN",
  /** Address is missing or is not a well-formed G-address. */
  validationFailed: "VALIDATION_FAILED",
  /** The unique constraint on `Registration.stellarAddress` rejected it. */
  addressTaken: "ADDRESS_TAKEN",
  /** Anything else — the cause stays in Sentry, not in the response. */
  serverError: "SERVER_ERROR",
} as const;

export type RegisterErrorCode =
  (typeof REGISTER_ERROR_CODES)[keyof typeof REGISTER_ERROR_CODES];

/**
 * Is this Prisma's unique-constraint error for `Registration.stellarAddress`?
 *
 * Matched structurally (`code === "P2002"` plus the offending target) rather
 * than by message text, which Prisma is free to reword between versions.
 */
function isUniqueAddressViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== "P2002") return false;

  const target = candidate.meta?.target;
  if (typeof target === "string") return target.includes("stellarAddress");
  if (Array.isArray(target)) return target.includes("stellarAddress");
  // P2002 with no usable target: still a uniqueness conflict, and the only
  // unique column this route writes is the address.
  return true;
}

export async function POST(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  // Validated Stellar address for this request. Assigned inside `try` after
  // input validation; read by the racing-writer handler in `catch`.
  let stellarAddress = "";

  // Per-IP rate limit — mirrors the pattern used by POST /api/check.
  // Contributors registering an address rarely need more than a handful of
  // saves per minute; the limit protects Horizon and the database from
  // automated hammering without affecting normal usage.
  const clientIp = extractClientIp(request);
  const rateLimit = checkRateLimit(clientIp, {
    // Register calls are less frequent than check calls; use the global defaults
    // (10 req/min) but allow the caller to override via env vars.
  });
  const rateLimitHeaders = buildRateLimitHeaders(rateLimit, 10);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many registration attempts. Please try again later.", code: REGISTER_ERROR_CODES.serverError },
      { status: 429, headers: { ...rateLimitHeaders } }
    );
  }

  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Unauthorized", code: REGISTER_ERROR_CODES.unauthorized },
      { status: 401 }
    );
  }

  // Check if contributor is banned
  const banStatus = await isUserBanned(
    session.user.id,
    session.user.githubUsername ?? null
  );
  if (banStatus.banned) {
    return NextResponse.json(
      {
        error: `Account is suspended from registration: ${banStatus.reason}`,
        code: "USER_BANNED",
      },
      { status: 403 }
    );
  }

  try {
    const body = (await request.json()) as { stellarAddress?: string };

    // Validate input
    const validationErrors = validateRegistrationInput(body);
    if (validationErrors.length > 0) {
      return NextResponse.json(
        {
          error: validationErrors[0].message,
          code: REGISTER_ERROR_CODES.validationFailed,
          validationErrors,
        },
        { status: 400 }
      );
    }

    // Hoisted for the racing-writer handler in `catch` below, which needs the
    // validated address even when the upsert throws.
    stellarAddress = body.stellarAddress!.trim();

    const existing = await prisma.registration.findFirst({
      where: { stellarAddress },
      orderBy: { createdAt: "desc" },
    });

    const userRegistration = await prisma.registration.findUnique({
      where: { userId: session.user.id },
    });
    const activeUserRegistration =
      userRegistration && !userRegistration.deletedAt
        ? userRegistration
        : null;

    if (existing && existing.userId !== session.user.id) {
      await Promise.all([
        prisma.registrationConflict.create({
          data: {
            attemptedAddress: stellarAddress,
            attemptedUserId: session.user.id,
            existingUserId: existing.userId,
          },
        }),
        recordAuditLog({
          action: "registration.conflict",
          actorId: session.user.id,
          actorLogin: session.user.githubUsername ?? null,
          targetId: existing.id,
          targetLabel: stellarAddress,
          metadata: { attemptedAddress: stellarAddress },
        }),
      ]);

      return NextResponse.json(
        {
          error: "This Stellar address is already registered to another user",
          code: REGISTER_ERROR_CODES.addressTaken,
        },
        { status: 409 }
      );
    }

    // Check if user is updating their address (different from current)
    const isAddressChange =
      activeUserRegistration &&
      activeUserRegistration.stellarAddress !== stellarAddress;

    if (isAddressChange) {
      const freezeGuard = await enforceFreezeWindowGuard({
        request,
        isMaintainer: Boolean(session.user.isMaintainer),
        userId: session.user.id,
        userLogin: session.user.githubUsername ?? null,
        actionLabel: "address_change",
      });
      if (freezeGuard.blocked && freezeGuard.response) {
        return freezeGuard.response;
      }
    }

    const horizonResult = await checkStellarAddress(
      stellarAddress,
      DEFAULT_ASSET.code,
      DEFAULT_ASSET.issuer
    );

    // Merge existing checklist state if available
    const existingChecklist = parseChecklistState(
      userRegistration?.checklistCompleted
    );
    const updatedChecklist: OnboardingChecklistState = {
      ...existingChecklist,
      register_address: true,
    };

    const registration = await prisma.registration.upsert({
      where: { userId: session.user.id },
      create: {
        userId: session.user.id,
        stellarAddress,
        funded: horizonResult.funded,
        trustlineReady: horizonResult.trustline,
        trustlineAuthorized: horizonResult.trustline_authorized,
        xlmBalance: horizonResult.xlm_balance,
        spendableXlmBalance: horizonResult.spendable_xlm_balance,
        checklistCompleted: updatedChecklist,
        lastCheckedAt: new Date(),
      },
      update: {
        stellarAddress,
        deletedAt: null,
        funded: horizonResult.funded,
        trustlineReady: horizonResult.trustline,
        trustlineAuthorized: horizonResult.trustline_authorized,
        xlmBalance: horizonResult.xlm_balance,
        spendableXlmBalance: horizonResult.spendable_xlm_balance,
        checklistCompleted: updatedChecklist,
        lastCheckedAt: new Date(),
      },
    });

    // Also update User record's checklist cache if user model is available
    if (prisma.user?.update) {
      await prisma.user
        .update({
          where: { id: session.user.id },
          data: { checklistCompleted: updatedChecklist },
        })
        .catch(() => {});
    }

    // Record address history
    if (!activeUserRegistration) {
      // First registration — record initial address
      await recordInitialAddress(session.user.id, stellarAddress);
    } else if (isAddressChange) {
      // Address changed — record the change
      await recordAddressChange(
        session.user.id,
        activeUserRegistration.stellarAddress,
        stellarAddress
      );
      // Check for sudden mass address change anomaly (non-blocking)
      void evaluateAndAuditAddressChangeAnomaly(
        session.user.id,
        session.user.githubUsername ?? null
      ).catch((err) => console.error("Anomaly evaluation error:", err));
    }

    // Mirror registration to Soroban contract (best-effort, non-blocking).
    // Fire-and-forget: don't await or let failures affect the response.
    void Promise.resolve(
      mirrorRegistrationToSoroban({
        githubUsername: session.user.githubUsername ?? "",
        stellarAddress,
        registrationId: registration.id,
      })
    ).catch((error) => {
      console.error("Soroban registration mirror failed:", error);
      captureException(error, {
        route: "/api/register",
        method: "POST",
        operation: "soroban-mirror",
        registrationId: registration.id,
      });
    });

    await recordAuditLog({
      action: activeUserRegistration
        ? "registration.update"
        : "registration.create",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      targetId: registration.id,
      targetLabel: registration.stellarAddress,
      metadata: { readiness: horizonResult.readiness },
    });

    // Track analytics event (fire-and-forget, no-op when key is absent)
    if (activeUserRegistration) {
      trackServerRegistrationUpdated({
        userId: session.user.id,
        stellarAddress: registration.stellarAddress,
        fieldsChanged: isAddressChange ? ["stellarAddress"] : [],
      });
    } else {
      trackServerRegistrationCreated({
        userId: session.user.id,
        stellarAddress: registration.stellarAddress,
      });
    }

    // Invalidate the contributor list caches so maintainers see the new
    // registration (or updated readiness) immediately on the next dashboard load.
    await invalidateContributorListCaches();

    return NextResponse.json({
      success: true,
      registration: {
        id: registration.id,
        stellarAddress: registration.stellarAddress,
        readiness: horizonResult.readiness,
        funded: registration.funded,
        trustline: registration.trustlineReady,
        trustline_authorized: registration.trustlineAuthorized,
        verified: horizonResult.verified,
        xlm_balance: registration.xlmBalance,
        spendable_xlm_balance: registration.spendableXlmBalance,
        checklistCompleted: updatedChecklist,
        walletProof: buildWalletProofInfo(
          registration.stellarAddress,
          session.user.githubUsername ?? null
        ),
        horizonDebug: buildHorizonDebugInfo({
          funded: registration.funded,
          trustlineReady: registration.trustlineReady,
          trustlineAuthorized: registration.trustlineAuthorized,
          readiness: horizonResult.readiness,
          xlmBalance: registration.xlmBalance,
          spendableXlmBalance: registration.spendableXlmBalance,
          lastCheckedAt: registration.lastCheckedAt?.toISOString() ?? null,
        }),
      },
      checklistCompleted: updatedChecklist,
    }, {
      headers: { ...rateLimitHeaders },
    });
  } catch (error) {
    // The response stays deliberately vague — the caller learns nothing about
    // why this failed — so Sentry is the only place the real cause survives.
    captureException(error, {
      route: "/api/register",
      method: "POST",
      userId: session.user.id,
    });
    // A racing writer can slip between the `findUnique` above and this upsert
    // and claim the address first; Postgres then rejects the unique index.
    // That is the same conflict as the pre-check, so it gets the same answer
    // rather than a generic 500 the client cannot act on.
    if (isUniqueAddressViolation(error)) {
      const winner = await prisma.registration.findFirst({
        where: { stellarAddress },
        orderBy: { createdAt: "desc" },
      });

      if (winner && winner.userId !== session.user.id) {
        await Promise.all([
          prisma.registrationConflict
            .create({
              data: {
                attemptedAddress: stellarAddress,
                attemptedUserId: session.user.id,
                existingUserId: winner.userId,
              },
            })
            .catch((err) =>
              console.error("Failed to record racing RegistrationConflict:", err)
            ),
          recordAuditLog({
            action: "registration.conflict",
            actorId: session.user.id,
            actorLogin: session.user.githubUsername ?? null,
            targetId: winner.id,
            targetLabel: stellarAddress,
            metadata: { attemptedAddress: stellarAddress, racing: true },
          }),
        ]);
      }

      return NextResponse.json(
        {
          error: "This Stellar address is already registered to another user",
          code: REGISTER_ERROR_CODES.addressTaken,
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: "Failed to save registration", code: REGISTER_ERROR_CODES.serverError },
      { status: 500 }
    );
  }
}

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Unauthorized", code: REGISTER_ERROR_CODES.unauthorized },
      { status: 401 }
    );
  }

  const registration = await prisma.registration.findUnique({
    where: { userId: session.user.id },
  });

  if (!registration || registration.deletedAt) {
    let checklistCompleted: OnboardingChecklistState = {};
    if (registration?.checklistCompleted) {
      checklistCompleted = parseChecklistState(registration.checklistCompleted);
    } else if (prisma.user?.findUnique) {
      const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { checklistCompleted: true },
      });
      checklistCompleted = parseChecklistState(user?.checklistCompleted);
    }

    return NextResponse.json({
      registration: null,
      checklistCompleted,
    });
  }

  const readiness = computeReadiness(
    registration.funded,
    registration.trustlineReady,
    registration.xlmBalance,
    {
      authorized: registration.trustlineAuthorized,
      spendableBalance: registration.spendableXlmBalance,
    }
  );

  const checklistCompleted = parseChecklistState(registration.checklistCompleted);

  return NextResponse.json({
    registration: {
      ...registration,
      readiness,
      checklistCompleted,
      walletProof: buildWalletProofInfo(
        registration.stellarAddress,
        session.user.githubUsername ?? null
      ),
      horizonDebug: buildHorizonDebugInfo({
        funded: registration.funded,
        trustlineReady: registration.trustlineReady,
        trustlineAuthorized: registration.trustlineAuthorized,
        readiness,
        xlmBalance: registration.xlmBalance,
        spendableXlmBalance: registration.spendableXlmBalance,
        lastCheckedAt: registration.lastCheckedAt?.toISOString() ?? null,
      }),
    },
    checklistCompleted,
  });
}
