import { z } from 'zod';

import type { AppServerClient } from './app-server.js';

const PAGE_SIZE = 25;
const MAX_PAGES = 400;

const pageSchema = z.object({
  data: z
    .array(
      z
        .object({
          id: z.string().min(1),
          status: z.enum(['inProgress', 'completed', 'failed', 'interrupted']),
          items: z.array(z.unknown()),
          itemsView: z.enum(['full', 'summary', 'notLoaded']).optional(),
        })
        .passthrough(),
    )
    .max(PAGE_SIZE),
  nextCursor: z.string().min(1).nullable().optional(),
});

/** Read history in bounded native RPC frames. An incomplete page must never mark history hydrated. */
export async function readNativeThreadHistory(
  appServer: Pick<AppServerClient, 'request'>,
  threadId: string,
): Promise<unknown[]> {
  const seenCursors = new Set<string>();
  const seenTurns = new Set<string>();
  const newestFirst: unknown[] = [];
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = pageSchema.parse(
      await appServer.request('thread/turns/list', {
        threadId,
        sortDirection: 'desc',
        itemsView: 'full',
        limit: PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      }),
    );
    for (const turn of page.data) {
      if (turn.itemsView !== undefined && turn.itemsView !== 'full')
        throw new Error('NATIVE_HISTORY_ITEMS_INCOMPLETE');
      if (seenTurns.has(turn.id)) throw new Error('NATIVE_HISTORY_DUPLICATE_TURN');
      seenTurns.add(turn.id);
      newestFirst.push(turn);
    }
    if (page.nextCursor == null) return newestFirst.reverse();
    if (page.data.length === 0 || seenCursors.has(page.nextCursor))
      throw new Error('NATIVE_HISTORY_CURSOR_INVALID');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('NATIVE_HISTORY_PAGE_LIMIT');
}

/** Recover the latest root-turn state without loading a long transcript. */
export async function readNativeTurnHead(
  appServer: Pick<AppServerClient, 'request'>,
  threadId: string,
): Promise<unknown[]> {
  const page = pageSchema.parse(
    await appServer.request('thread/turns/list', {
      threadId,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
      limit: PAGE_SIZE,
    }),
  );
  return page.data.reverse();
}

/** Search exact user-message evidence without retaining a long native transcript in memory. */
export async function findNativeClientMessageEvidence(
  appServer: Pick<AppServerClient, 'request'>,
  threadId: string,
  clientId: string,
): Promise<{ turnId: string | null; matchingTurnIsInProgress: boolean }> {
  const seenCursors = new Set<string>();
  const seenTurns = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = pageSchema.parse(
      await appServer.request('thread/turns/list', {
        threadId,
        sortDirection: 'desc',
        itemsView: 'full',
        limit: PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      }),
    );
    for (const turn of page.data) {
      if (turn.itemsView !== undefined && turn.itemsView !== 'full')
        throw new Error('NATIVE_HISTORY_ITEMS_INCOMPLETE');
      if (seenTurns.has(turn.id)) throw new Error('NATIVE_HISTORY_DUPLICATE_TURN');
      seenTurns.add(turn.id);
      for (const itemValue of turn.items) {
        if (!itemValue || typeof itemValue !== 'object') continue;
        const item = itemValue as Record<string, unknown>;
        if (item.type === 'userMessage' && item.clientId === clientId) {
          return { turnId: turn.id, matchingTurnIsInProgress: turn.status === 'inProgress' };
        }
      }
    }
    if (page.nextCursor == null) return { turnId: null, matchingTurnIsInProgress: false };
    if (page.data.length === 0 || seenCursors.has(page.nextCursor))
      throw new Error('NATIVE_HISTORY_CURSOR_INVALID');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('NATIVE_HISTORY_PAGE_LIMIT');
}
