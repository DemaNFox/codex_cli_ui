import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SafeEvent } from './api.js';
import {
  clearThreadHistoryCache,
  readThreadHistoryCache,
  writeThreadHistoryCache,
} from './threadHistoryCache.js';

type RequestShape<T> = {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
};

class MemoryTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: DOMException | null = null;

  constructor(private readonly records: Map<string, unknown>) {}

  objectStore() {
    return {
      get: (key: string) => request(this.records.get(key)),
      getAll: () => request([...this.records.values()]),
      put: (value: unknown) => {
        const key = (value as { key: string }).key;
        this.records.set(key, structuredClone(value));
        queueMicrotask(() => this.oncomplete?.());
        return request(key);
      },
      delete: (key: string) => {
        this.records.delete(key);
        queueMicrotask(() => this.oncomplete?.());
        return request(undefined);
      },
      clear: () => {
        this.records.clear();
        queueMicrotask(() => this.oncomplete?.());
        return request(undefined);
      },
    };
  }
}

function request<T>(result: T): IDBRequest<T> {
  const target: RequestShape<T> = { result, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => target.onsuccess?.());
  return target as unknown as IDBRequest<T>;
}

function memoryIndexedDb() {
  const records = new Map<string, unknown>();
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({ createIndex: vi.fn() }),
    transaction: () => new MemoryTransaction(records),
    close: vi.fn(),
  };
  return {
    open: () => {
      const target = {
        result: database,
        error: null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => target.onsuccess?.());
      return target;
    },
  };
}

function event(id: number, text = `Event ${id}`): SafeEvent {
  return {
    id,
    threadId: 'thread-1',
    turnId: `turn-${id}`,
    kind: 'agent-message',
    phase: 'completed',
    payload: { text },
    createdAt: '2026-10-11T12:00:00.000Z',
  };
}

function completedTurn(id: number): SafeEvent {
  return {
    id,
    threadId: 'thread-1',
    turnId: `turn-${id}`,
    kind: 'turn',
    phase: 'completed',
    payload: { status: 'completed' },
    createdAt: '2026-10-11T12:00:00.000Z',
  };
}

describe('threadHistoryCache', () => {
  beforeEach(() => vi.stubGlobal('indexedDB', memoryIndexedDb()));
  afterEach(() => vi.unstubAllGlobals());

  it('returns a cached transcript without waiting for a delayed server refresh', async () => {
    await writeThreadHistoryCache({
      username: 'nick',
      threadId: 'thread-1',
      events: [event(1, 'Cached answer')],
      oldestEventId: 1,
      hasMore: true,
      savedAt: 10,
    });
    let releaseServer!: () => void;
    const serverRefresh = new Promise<void>((resolve) => {
      releaseServer = resolve;
    });

    const cached = await Promise.race([
      readThreadHistoryCache('nick', 'thread-1'),
      serverRefresh.then(() => null),
    ]);

    expect(cached?.events[0]?.payload.text).toBe('Cached answer');
    expect(cached?.hasMore).toBe(true);
    releaseServer();
  });

  it('scopes entries by authenticated username and clears them on sign-out', async () => {
    await writeThreadHistoryCache({
      username: 'nick',
      threadId: 'thread-1',
      events: [event(1)],
      oldestEventId: 1,
      hasMore: false,
      savedAt: 10,
    });

    expect(await readThreadHistoryCache('other-user', 'thread-1')).toBeNull();
    expect(await readThreadHistoryCache('nick', 'thread-1')).not.toBeNull();
    await clearThreadHistoryCache();
    expect(await readThreadHistoryCache('nick', 'thread-1')).toBeNull();
  });

  it('bounds a cached thread to the newest 600 normalized events', async () => {
    await writeThreadHistoryCache({
      username: 'nick',
      threadId: 'thread-1',
      events: Array.from({ length: 700 }, (_, index) => event(index + 1)),
      oldestEventId: 1,
      hasMore: true,
      savedAt: 10,
    });

    const cached = await readThreadHistoryCache('nick', 'thread-1');
    expect(cached?.events).toHaveLength(600);
    expect(cached?.events[0]?.id).toBe(101);
    expect(cached?.events.at(-1)?.id).toBe(700);
    expect(cached?.oldestEventId).toBe(101);
    expect(cached?.hasMore).toBe(true);
  });

  it('keeps terminal turn evidence but excludes stale live runtime projections', async () => {
    const runtime: SafeEvent = {
      ...completedTurn(3),
      phase: 'state',
      payload: { runtime: true, status: 'active' },
    };
    await writeThreadHistoryCache({
      username: 'nick',
      threadId: 'thread-1',
      events: [event(1), completedTurn(2), runtime],
      oldestEventId: 1,
      hasMore: false,
      savedAt: 10,
    });

    const cached = await readThreadHistoryCache('nick', 'thread-1');
    expect(cached?.events.map((item) => item.id)).toEqual([1, 2]);
  });
});
