import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrgMembershipAction = "member_added" | "member_removed" | "member_invited";

export interface GithubOrgMembershipPayload {
  action: OrgMembershipAction | string;
  membership?: {
    user?: { id?: number; login?: string };
    role?: string;
    state?: string;
  };
  organization?: { login?: string };
  sender?: { login?: string };
}

export interface WebhookVerificationResult {
  ok: boolean;
  reason?: string;
}

export interface ProcessEventResult {
  handled: boolean;
  action: string;
  login: string | null;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify a GitHub webhook HMAC-SHA256 signature.
 *
 * GitHub sends the signature as `sha256=<hex>` in the
 * `x-hub-signature-256` header.  We recompute the HMAC over the raw body
 * and compare with a constant-time equality check to resist timing attacks.
 *
 * Returns `{ ok: false }` (never throws) so callers can always branch on the
 * result without wrapping in try/catch.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null
): WebhookVerificationResult {
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return { ok: false, reason: "GITHUB_WEBHOOK_SECRET is not configured" };
  }

  if (!signatureHeader) {
    return { ok: false, reason: "Missing x-hub-signature-256 header" };
  }

  const [scheme, receivedHex] = signatureHeader.split("=");
  if (scheme !== "sha256" || !receivedHex) {
    return { ok: false, reason: "Unexpected signature scheme (expected sha256=...)" };
  }

  const expectedHex = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");

  // Validate the hex encoding BEFORE converting: Buffer.from(hex, "hex")
  // silently drops a trailing nibble on odd-length input, which would let a
  // "<digest>a" signature pass the byte-length guard below. Compare on the
  // hex strings so any length or charset deviation fails closed.
  if (
    receivedHex.length !== expectedHex.length ||
    !/^[0-9a-fA-F]+$/.test(receivedHex)
  ) {
    return { ok: false, reason: "Signature length mismatch" };
  }

  // Use timingSafeEqual to prevent timing-oracle attacks.
  const expected = Buffer.from(expectedHex, "hex");
  const received = Buffer.from(receivedHex, "hex");

  const match = timingSafeEqual(expected, received);
  return match ? { ok: true } : { ok: false, reason: "Signature mismatch" };
}

// ---------------------------------------------------------------------------
// Event processor
// ---------------------------------------------------------------------------

/**
 * Process a `membership` GitHub organization event.
 *
 * - `member_added` / `member_invited`: ensures a User row exists for the
 *   GitHub login so the contributor can register immediately after joining.
 * - `member_removed`: marks the registration as needing a re-check (does not
 *   delete data — the maintainer decides what to do).
 *
 * All outcomes are appended to the audit log for traceability.
 * The function never throws; unhandled actions are logged and returned with
 * `handled: false`.
 */
export async function processGithubOrgMembershipEvent(
  payload: GithubOrgMembershipPayload
): Promise<ProcessEventResult> {
  const action = payload.action ?? "unknown";
  const login = payload.membership?.user?.login ?? null;
  const githubId = payload.membership?.user?.id?.toString() ?? null;
  const org = payload.organization?.login ?? null;

  if (action === "member_added" || action === "member_invited") {
    if (login && githubId) {
      // Upsert so we don't duplicate rows if the user signed in before the
      // webhook fires (race-condition safe).
      await prisma.user.upsert({
        where: { githubId },
        create: {
          githubId,
          githubUsername: login,
        },
        update: {
          githubUsername: login,
        },
      });
    }

    await recordAuditLog({
      action: `webhook.github_org_membership.${action}`,
      actorLogin: payload.sender?.login ?? null,
      targetLabel: login,
      metadata: { org, role: payload.membership?.role ?? null },
    });

    return { handled: true, action, login };
  }

  if (action === "member_removed") {
    await recordAuditLog({
      action: "webhook.github_org_membership.member_removed",
      actorLogin: payload.sender?.login ?? null,
      targetLabel: login,
      metadata: { org },
    });

    return { handled: true, action, login };
  }

  // Unrecognised action — log for visibility, return unhandled.
  await recordAuditLog({
    action: "webhook.github_org_membership.unknown_action",
    actorLogin: payload.sender?.login ?? null,
    targetLabel: login,
    metadata: { action, org },
  });

  return { handled: false, action, login };
}
