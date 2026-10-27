import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";
import { verifySignature } from "@/lib/trustbridge-action-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook receiver for trustbridge-action `validation_complete` events.
 *
 * Signature: POST /api/webhooks/trustbridge-action
 * Headers:
 *   X-TrustBridge-Signature: sha256=<hex-digest>
 *   Content-Type: application/json
 */
export async function POST(request: NextRequest) {
  try {
    // Collect raw body for signature verification
    const body = await request.arrayBuffer();
    const payload = Buffer.from(body);

    // Verify webhook signature
    const signature = request.headers.get("X-TrustBridge-Signature") || undefined;
    if (!verifySignature(payload, signature)) {
      console.warn("Webhook signature verification failed");
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Parse JSON
    const data = JSON.parse(payload.toString("utf-8"));

    // Validate payload schema version and event type
    if (data.schema_version !== "1") {
      return NextResponse.json({ error: "Unsupported schema version" }, { status: 400 });
    }
    if (data.event !== "validation_complete") {
      return NextResponse.json({ error: "Unsupported event type" }, { status: 400 });
    }

    // Extract redacted address parts for DB lookup
    const redactedAddress = data.stellar_address;
    if (!redactedAddress || !redactedAddress.includes("...")) {
      return NextResponse.json({ error: "Invalid stellar_address format" }, { status: 400 });
    }

    const parts = redactedAddress.split("...");
    if (parts.length !== 2 || parts[0].length !== 4 || parts[1].length !== 4) {
      return NextResponse.json({ error: "Invalid redacted stellar_address format" }, { status: 400 });
    }

    const [prefix, suffix] = parts;

    // Query registrations that share the same prefix
    const registrations = await prisma.registration.findMany({
      where: {
        deletedAt: null,
        stellarAddress: {
          startsWith: prefix,
        },
      },
      include: {
        user: true,
      },
    });

    // Filter by suffix in memory to verify exact match on first-4/last-4
    const matches = registrations.filter(
      (r) => r.stellarAddress.endsWith(suffix)
    );

    if (matches.length === 0) {
      console.log(`No registered contributor found for redacted address ${redactedAddress}`);
      return NextResponse.json(
        { status: "ignored", reason: "No matching registered stellar address found" },
        { status: 202 }
      );
    }

    if (matches.length > 1) {
      console.warn(`Ambiguous matches for redacted address ${redactedAddress}`);
      return NextResponse.json(
        { status: "ignored", reason: "Ambiguous stellar address matches" },
        { status: 202 }
      );
    }

    const registration = matches[0];
    const { valid, account_funded, trustline_exists, xlm_balance } = data.result;

    // Update registration status in PostgreSQL
    const updated = await prisma.registration.update({
      where: { id: registration.id },
      data: {
        funded: account_funded,
        trustlineReady: trustline_exists,
        trustlineAuthorized: valid,
        xlmBalance: xlm_balance,
        spendableXlmBalance: xlm_balance,
        lastCheckedAt: new Date(data.timestamp || new Date()),
      },
    });

    // Record audit trail
    await recordAuditLog({
      action: "webhook.trustbridge_action_validation",
      actorId: null,
      actorLogin: "trustbridge-action",
      targetId: registration.userId,
      targetLabel: registration.user.githubUsername,
      metadata: {
        repository: data.repository,
        issueNumber: data.issue_number,
        valid,
        account_funded,
        trustline_exists,
        xlm_balance,
        webhookDeliveryId: request.headers.get("X-GitHub-Delivery") || "unknown",
      },
    });

    console.log(
      `Webhook sync: Updated contributor ${registration.user.githubUsername} readiness status`
    );

    return NextResponse.json(
      {
        status: "accepted",
        updated: {
          githubUsername: registration.user.githubUsername,
          funded: updated.funded,
          trustlineReady: updated.trustlineReady,
          trustlineAuthorized: updated.trustlineAuthorized,
        },
      },
      { status: 202 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    console.error("Webhook processing error:", error);

    // Return 202 to avoid GitHub webhook retry storms on parsing or database errors
    return NextResponse.json(
      {
        status: "error",
        message,
      },
      { status: 202 }
    );
  }
}
