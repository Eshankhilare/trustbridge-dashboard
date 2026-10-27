import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { isMaintainer, listRegistrationConflicts } from "@/lib/maintainers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allowed = await isMaintainer(session.user);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const maintainerOrgId = session.user.maintainerOrgId;
  const conflicts = await listRegistrationConflicts({ maintainerOrgId });

  return NextResponse.json({ conflicts });
}
