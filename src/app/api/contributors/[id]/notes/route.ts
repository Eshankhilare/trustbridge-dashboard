import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { recordAuditLog } from "@/lib/audit";
import { authOptions } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { isMaintainer } from "@/lib/maintainers";
import { prisma } from "@/lib/prisma";
import { sanitizeMarkdown } from "@/lib/markdown-sanitizer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Zod schema for the PATCH /api/contributors/[id]/notes request body.
 *
 * - notes: optional free-text / markdown field, max 1 000 chars after sanitisation.
 *          Sanitisation is markdown-aware: safe inline formatting (bold, italic,
 *          code, links to https:// URLs) is preserved; raw HTML, javascript: URIs,
 *          data: URIs, and all event-handler attributes are stripped.
 * - tags:  optional array of short labels, max 10 items, each max 30 chars.
 *          Tags are plain-text only — no markdown or HTML.
 *
 * Input length is checked after sanitisation so a payload composed entirely of
 * HTML markup cannot sneak past the character limit.
 */
const NotesBodySchema = z.object({
  notes: z
    .string()
    .transform((input) => sanitizeMarkdown(input))
    .pipe(
      z
        .string()
        .max(1000, "Note exceeds 1,000 character limit")
    )
    .nullable()
    .optional(),
  tags: z
    .array(
      z
        .string()
        // Tags are plain-text; strip all markup including markdown syntax.
        .transform((s) => sanitizeMarkdown(s, { plainTextOnly: true }))
        .pipe(
          z
            .string()
            .min(1, "Tag must not be empty after sanitisation")
            .max(30, "Each tag must be 30 characters or fewer")
        )
    )
    .max(10, "Maximum 10 tags allowed")
    .optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allowed = await isMaintainer(session.user);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const registrationId = params.id;
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
  });

  if (!registration) {
    return NextResponse.json(
      { error: "Registration not found" },
      { status: 404 }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = NotesBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        validationErrors: parsed.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
  }

  const { notes, tags } = parsed.data;

  // Coerce undefined → null / [] so Prisma always receives defined values.
  const sanitizedNotes: string | null = notes ?? null;
  const sanitizedTags: string[] = tags ?? [];

  try {
    const updated = await prisma.registration.update({
      where: { id: registrationId },
      data: {
        notes: sanitizedNotes,
        tags: sanitizedTags,
      },
    });

    await recordAuditLog({
      action: "CONTRIBUTOR_NOTES_UPDATED",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      targetId: updated.id,
      targetLabel: updated.stellarAddress,
      metadata: {
        notesLength: sanitizedNotes?.length ?? 0,
        tagsCount: sanitizedTags.length,
      },
    });

    return NextResponse.json({
      success: true,
      registration: {
        id: updated.id,
        notes: updated.notes,
        tags: updated.tags,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to update contributor notes" },
      { status: 500 }
    );
  }
}
