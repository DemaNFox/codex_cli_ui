import type { SafeEvent } from './api.js';

const DATABASE_NAME = 'codex-web-ui-thread-history';
const STORE_NAME = 'threads';
const DATABASE_VERSION = 1;
const CACHE_SCHEMA_VERSION = 1;
const MAX_CACHED_THREADS = 20;
const MAX_EVENTS_PER_THREAD = 600;
const MAX_CACHE_BYTES = 10 * 1024 * 1024;
const DATABASE_OPEN_TIMEOUT_MS = 750;

const safeEventKinds = new Set([
  'thread',
  'turn',
  'user-message',
  'agent-message',
  'plan',
  'command',
  'file-change',
  'tool',
  'approval',
  'user-input',
  'permission-approval',
  'subagent',
  'usage',
  'warning',
  'error',
]);
const cacheableEventKinds = new Set([
  'user-message',
  'agent-message',
  'plan',
  'command',
  'file-change',
  'tool',
  'warning',
  'error',
]);

function isCacheableEvent(event: SafeEvent): boolean {
  if (cacheableEventKinds.has(event.kind)) return true;
  return (
    event.kind === 'turn' &&
    event.payload.runtime !== true &&
    (event.phase === 'completed' || event.phase === 'failed')
  );
}

export interface ThreadHistoryCacheEntry {
  username: string;
  threadId: string;
  events: SafeEvent[];
  oldestEventId: number | null;
  hasMore: boolean;
  savedAt: number;
}

interface StoredThreadHistory extends ThreadHistoryCacheEntry {
  key: string;
  schemaVersion: number;
  approximateBytes: number;
}

function cacheKey(username: string, threadId: string): string {
  return `${username}\u0000${threadId}`;
}

function isSafeEvent(value: unknown, threadId: string): value is SafeEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(event.id) &&
    typeof event.id === 'number' &&
    event.id >= 0 &&
    event.threadId === threadId &&
    typeof event.kind === 'string' &&
    safeEventKinds.has(event.kind) &&
    typeof event.phase === 'string' &&
    typeof event.createdAt === 'string' &&
    !!event.payload &&
    typeof event.payload === 'object'
  );
}

function normalizeEvents(events: SafeEvent[], threadId: string): SafeEvent[] {
  const retained = new Map<string, SafeEvent>();
  for (const event of events) {
    if (!isSafeEvent(event, threadId) || !isCacheableEvent(event)) continue;
    const nestedRequest =
      event.payload.request && typeof event.payload.request === 'object'
        ? (event.payload.request as Record<string, unknown>)
        : null;
    const syntheticId =
      typeof event.payload.id === 'string'
        ? event.payload.id
        : typeof nestedRequest?.id === 'string'
          ? nestedRequest.id
          : `${event.turnId ?? ''}:${event.createdAt}`;
    const key = event.id > 0 ? `event:${event.id}` : `synthetic:${event.kind}:${syntheticId}`;
    retained.set(key, event);
  }
  return [...retained.values()]
    .sort((left, right) => left.id - right.id)
    .slice(-MAX_EVENTS_PER_THREAD);
}

function validateStored(
  value: unknown,
  username: string,
  threadId: string,
): StoredThreadHistory | null {
  if (!value || typeof value !== 'object') return null;
  const stored = value as Partial<StoredThreadHistory>;
  if (
    stored.schemaVersion !== CACHE_SCHEMA_VERSION ||
    stored.key !== cacheKey(username, threadId) ||
    stored.username !== username ||
    stored.threadId !== threadId ||
    !Array.isArray(stored.events) ||
    typeof stored.hasMore !== 'boolean' ||
    typeof stored.savedAt !== 'number' ||
    !Number.isFinite(stored.savedAt) ||
    !(
      stored.oldestEventId === null ||
      (typeof stored.oldestEventId === 'number' &&
        Number.isSafeInteger(stored.oldestEventId) &&
        stored.oldestEventId > 0)
    )
  )
    return null;
  const events = normalizeEvents(stored.events, threadId);
  if (events.length !== stored.events.length) return null;
  return { ...(stored as StoredThreadHistory), events };
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;
    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(database);
    };
    const timeout = setTimeout(() => finish(null), DATABASE_OPEN_TIMEOUT_MS);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('savedAt', 'savedAt');
      }
    };
    request.onsuccess = () => finish(request.result);
    request.onblocked = () => finish(null);
    request.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function readThreadHistoryCache(
  username: string,
  threadId: string,
): Promise<ThreadHistoryCacheEntry | null> {
  try {
    const database = await openDatabase();
    if (!database) return null;
    try {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const stored: unknown = await requestResult(
        transaction
          .objectStore(STORE_NAME)
          .get(cacheKey(username, threadId)) as IDBRequest<unknown>,
      );
      const validated = validateStored(stored, username, threadId);
      if (!validated) return null;
      return {
        username: validated.username,
        threadId: validated.threadId,
        events: validated.events,
        oldestEventId: validated.oldestEventId,
        hasMore: validated.hasMore,
        savedAt: validated.savedAt,
      };
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

export async function writeThreadHistoryCache(entry: ThreadHistoryCacheEntry): Promise<void> {
  try {
    const events = normalizeEvents(entry.events, entry.threadId);
    const cacheableEventCount = entry.events.filter(
      (event) => isSafeEvent(event, entry.threadId) && isCacheableEvent(event),
    ).length;
    const cachedOldestEventId = events.find((event) => event.id > 0)?.id ?? null;
    const base = {
      key: cacheKey(entry.username, entry.threadId),
      schemaVersion: CACHE_SCHEMA_VERSION,
      username: entry.username,
      threadId: entry.threadId,
      events,
      oldestEventId: cachedOldestEventId ?? entry.oldestEventId,
      hasMore: entry.hasMore || cacheableEventCount > events.length,
      savedAt: entry.savedAt,
    };
    const stored: StoredThreadHistory = {
      ...base,
      approximateBytes: JSON.stringify(base).length * 2,
    };
    const database = await openDatabase();
    if (!database) return;
    try {
      const write = database.transaction(STORE_NAME, 'readwrite');
      write.objectStore(STORE_NAME).put(stored);
      await transactionDone(write);

      const read = database.transaction(STORE_NAME, 'readonly');
      const all = (await requestResult(
        read.objectStore(STORE_NAME).getAll(),
      )) as StoredThreadHistory[];
      const newestFirst = all.sort((left, right) => right.savedAt - left.savedAt);
      let bytes = 0;
      const removals: string[] = [];
      newestFirst.forEach((candidate, index) => {
        bytes += candidate.approximateBytes || 0;
        if (index >= MAX_CACHED_THREADS || bytes > MAX_CACHE_BYTES) removals.push(candidate.key);
      });
      if (removals.length) {
        const trim = database.transaction(STORE_NAME, 'readwrite');
        const store = trim.objectStore(STORE_NAME);
        removals.forEach((key) => store.delete(key));
        await transactionDone(trim);
      }
    } finally {
      database.close();
    }
  } catch {
    // Browser cache is an optional acceleration layer.
  }
}

export async function clearThreadHistoryCache(): Promise<void> {
  try {
    const database = await openDatabase();
    if (!database) return;
    try {
      const clear = database.transaction(STORE_NAME, 'readwrite');
      clear.objectStore(STORE_NAME).clear();
      await transactionDone(clear);
    } finally {
      database.close();
    }
  } catch {
    // Logout must succeed even when private browsing disables IndexedDB.
  }
}
