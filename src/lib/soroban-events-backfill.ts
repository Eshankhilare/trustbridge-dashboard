import "server-only";

import { prisma } from "@/lib/prisma";
import type { SorobanEventRow } from "@/types";

export interface EventBackfillOptions {
  eventType?: string;
  maintainerOrgId?: string;
  limit?: number;
}

export interface EventBackfillResult {
  eventType: string;
  eventsSynced: number;
  newCursor: string | null;
}

export async function getStoredEventCursor(eventType = "contract", maintainerOrgId = "default"): Promise<string | null> {
  const record = await prisma.sorobanEventCursor.findUnique({
    where: {
      maintainerOrgId_eventType: {
        maintainerOrgId,
        eventType,
      },
    },
  });
  return record?.cursor ?? null;
}

export async function updateStoredEventCursor(
  cursor: string,
  eventType = "contract",
  lastPagingToken?: string,
  maintainerOrgId = "default"
) {
  return prisma.sorobanEventCursor.upsert({
    where: {
      maintainerOrgId_eventType: {
        maintainerOrgId,
        eventType,
      },
    },
    create: {
      maintainerOrgId,
      eventType,
      cursor,
      lastPagingToken: lastPagingToken ?? null,
      lastSyncedAt: new Date(),
    },
    update: {
      cursor,
      lastPagingToken: lastPagingToken ?? null,
      lastSyncedAt: new Date(),
    },
  });
}

export async function backfillSorobanEvents(
  // RPC-fetched events carry a paging token for cursor tracking; the stored
  // timeline row shape (`SorobanEventRow`) does not, so it is optional here.
  fetchedEvents: Array<SorobanEventRow & { pagingToken?: string }>,
  options: EventBackfillOptions = {}
): Promise<EventBackfillResult> {
  const eventType = options.eventType ?? "contract";
  const maintainerOrgId = options.maintainerOrgId ?? "default";

  if (fetchedEvents.length === 0) {
    const existingCursor = await getStoredEventCursor(eventType, maintainerOrgId);
    return { eventType, eventsSynced: 0, newCursor: existingCursor };
  }

  // Idempotently process events and extract latest paging token / cursor
  const lastEvent = fetchedEvents[fetchedEvents.length - 1];
  const newCursor = lastEvent.pagingToken || String(lastEvent.ledger);

  await updateStoredEventCursor(newCursor, eventType, lastEvent.pagingToken, maintainerOrgId);

  return {
    eventType,
    eventsSynced: fetchedEvents.length,
    newCursor,
  };
}
