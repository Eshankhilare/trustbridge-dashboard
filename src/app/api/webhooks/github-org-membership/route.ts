import { NextRequest, NextResponse } from "next/server";

import {
  processGithubOrgMembershipEvent,
  verifyWebhookSignature,
  type GithubOrgMembershipPayload,
} from "@/lib/github-org-membership-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/github-org-membership
 *
 * Receives GitHub `membership` organization webhook events.
 * Only exports HTTP handler names — no helpers live here so Next.js App
 * Router static analysis sees a clean route surface.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-hub-signature-256");

  const verification = verifyWebhookSignature(rawBody, signatureHeader);
  if (!verification.ok) {
    return NextResponse.json(
      { error: "Unauthorized", reason: verification.reason },
      { status: 401 }
    );
  }

  let payload: GithubOrgMembershipPayload;
  try {
    payload = JSON.parse(rawBody) as GithubOrgMembershipPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const result = await processGithubOrgMembershipEvent(payload);

  return NextResponse.json({ ok: true, ...result });
}
