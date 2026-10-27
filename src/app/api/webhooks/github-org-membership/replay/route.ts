import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { assertSameOrigin } from "@/lib/csrf";
import {
  processGithubOrgMembershipEvent,
  type GithubOrgMembershipPayload,
} from "@/lib/github-org-membership-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/github-org-membership/replay
 *
 * Maintainer-only endpoint to replay a stored webhook payload without
 * re-verifying the HMAC signature (the payload has already been verified and
 * persisted).  Useful for re-processing after a bug fix.
 *
 * Imports helpers from @/lib — never from the sibling route — so there are no
 * cross-route dependencies and Next.js bundling stays clean.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: GithubOrgMembershipPayload;
  try {
    payload = (await request.json()) as GithubOrgMembershipPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const result = await processGithubOrgMembershipEvent(payload);

  return NextResponse.json({ ok: true, replayed: true, ...result });
}
