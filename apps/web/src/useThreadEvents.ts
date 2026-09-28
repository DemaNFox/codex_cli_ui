import { useCallback, useEffect, useRef, useState } from 'react';

import type { SafeEvent } from './api.js';

export type StreamState = 'connecting' | 'open' | 'offline';

const safeEventKinds = [
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
] as const satisfies readonly SafeEvent['kind'][];

const safeEventKindSet = new Set<string>(safeEventKinds);

function isSafeEvent(value: unknown): value is SafeEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === 'number' &&
    typeof event.threadId === 'string' &&
    typeof event.kind === 'string' &&
    safeEventKindSet.has(event.kind) &&
    typeof event.phase === 'string' &&
    typeof event.createdAt === 'string' &&
    !!event.payload &&
    typeof event.payload === 'object'
  );
}

export function useThreadEvents(threadId: string | null): {
  events: SafeEvent[];
  streamState: StreamState;
  mergeEvents: (incoming: SafeEvent[], expectedThreadId?: string) => void;
} {
  const [events, setEvents] = useState<SafeEvent[]>([]);
  const [streamState, setStreamState] = useState<StreamState>('offline');
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const mergeEvents = useCallback((incoming: SafeEvent[], expectedThreadId?: string) => {
    const activeThreadId = threadIdRef.current;
    if (!activeThreadId || (expectedThreadId && expectedThreadId !== activeThreadId)) return;
    const accepted = incoming.filter(
      (event) => isSafeEvent(event) && event.threadId === activeThreadId,
    );
    if (!accepted.length) return;
    setEvents((current) => {
      const byId = new Map(current.map((event) => [event.id, event]));
      for (const event of accepted) byId.set(event.id, event);
      return [...byId.values()].sort((left, right) => left.id - right.id);
    });
  }, []);

  useEffect(() => {
    setEvents([]);
    if (!threadId) {
      setStreamState('offline');
      return;
    }

    setStreamState('connecting');
    const source = new EventSource(`/api/threads/${encodeURIComponent(threadId)}/events?after=0`, {
      withCredentials: true,
    });

    const handleOpen = () => setStreamState('open');
    const handleTransportError = (event: Event) => {
      // A domain SafeEvent can legitimately be named `error`. Only the native
      // EventSource transport error (which is not a MessageEvent) means offline.
      if (!(event instanceof MessageEvent)) setStreamState('offline');
    };
    const handleMessage: EventListener = (message) => {
      if (!(message instanceof MessageEvent)) return;
      try {
        const raw: unknown = message.data;
        if (typeof raw !== 'string') return;
        const event: unknown = JSON.parse(raw);
        if (!isSafeEvent(event) || event.threadId !== threadId) return;
        if (message.type !== 'message' && message.type !== event.kind) return;
        mergeEvents([event], threadId);
      } catch {
        // Unknown or malformed events are intentionally ignored.
      }
    };

    source.addEventListener('open', handleOpen);
    source.addEventListener('error', handleTransportError);
    source.addEventListener('message', handleMessage);
    for (const kind of safeEventKinds) source.addEventListener(kind, handleMessage);

    return () => {
      source.removeEventListener('open', handleOpen);
      source.removeEventListener('error', handleTransportError);
      source.removeEventListener('message', handleMessage);
      for (const kind of safeEventKinds) source.removeEventListener(kind, handleMessage);
      source.close();
    };
  }, [mergeEvents, threadId]);

  return { events, streamState, mergeEvents };
}
