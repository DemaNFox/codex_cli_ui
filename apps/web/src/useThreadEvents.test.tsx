import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SafeEvent } from './api.js';
import {
  PINNED_INTERACTION_RETENTION_LIMIT,
  THREAD_EVENT_RETENTION_LIMIT,
  useThreadEvents,
} from './useThreadEvents.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  private readonly target = new EventTarget();
  close = vi.fn();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.target.addEventListener(type, listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.target.removeEventListener(type, listener);
  }

  dispatchEvent(event: Event) {
    return this.target.dispatchEvent(event);
  }

  emit(event: SafeEvent) {
    this.dispatchEvent(
      new MessageEvent(event.kind, {
        data: JSON.stringify(event),
      }),
    );
  }
}

function event(id: number): SafeEvent {
  return {
    id,
    threadId: 'thread-1',
    turnId: `turn-${id}`,
    kind: 'agent-message',
    phase: 'completed',
    payload: { text: `Event ${id}` },
    createdAt: '2026-10-11T12:00:00.000Z',
  };
}

function approvalEvent(
  id: number,
  phase: 'started' | 'completed',
  approvalId = '22222222-2222-4222-8222-222222222222',
): SafeEvent {
  return {
    id,
    threadId: 'thread-1',
    turnId: 'turn-approval',
    kind: 'approval',
    phase,
    payload: {
      id: approvalId,
      ...(phase === 'started' ? { summary: 'Разрешить запуск тестов?' } : {}),
    },
    createdAt: '2026-10-11T12:00:00.000Z',
  };
}

describe('useThreadEvents', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  it('retains the newest 120 snapshot and SSE events without changing the stream cursor', async () => {
    const { result } = renderHook(() => useThreadEvents('thread-1', 150));

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/threads/thread-1/events?after=150');

    act(() => {
      result.current.mergeEvents(
        Array.from({ length: 150 }, (_, index) => event(index + 1)),
        'thread-1',
      );
    });
    expect(result.current.events).toHaveLength(THREAD_EVENT_RETENTION_LIMIT);
    expect(result.current.events[0]?.id).toBe(31);
    expect(result.current.events.at(-1)?.id).toBe(150);

    act(() => {
      source.dispatchEvent(new Event('open'));
    });
    expect(result.current.streamState).toBe('open');
    act(() => source.emit(event(151)));

    await waitFor(() => expect(result.current.events.at(-1)?.id).toBe(151));
    expect(result.current.events).toHaveLength(THREAD_EVENT_RETENTION_LIMIT);
    expect(result.current.events[0]?.id).toBe(32);
    expect(source.url).toBe('/api/threads/thread-1/events?after=150');
  });

  it('pins an unresolved interaction beyond the 120-event tail until its terminal event arrives', async () => {
    const { result } = renderHook(() => useThreadEvents('thread-1', 131));
    const source = FakeEventSource.instances[0]!;

    act(() => {
      result.current.mergeEvents(
        [
          approvalEvent(1, 'started'),
          ...Array.from({ length: 130 }, (_, index) => event(index + 2)),
        ],
        'thread-1',
      );
    });
    expect(result.current.events).toHaveLength(THREAD_EVENT_RETENTION_LIMIT + 1);
    expect(result.current.events.some((candidate) => candidate.id === 1)).toBe(true);
    expect(result.current.events.at(-1)?.id).toBe(131);

    act(() => source.emit(approvalEvent(132, 'completed')));

    await waitFor(() => expect(result.current.events.at(-1)?.id).toBe(132));
    expect(result.current.events).toHaveLength(THREAD_EVENT_RETENTION_LIMIT);
    expect(result.current.events.some((candidate) => candidate.id === 1)).toBe(false);
    expect(result.current.events[0]?.id).toBe(13);
  });

  it('keeps distinct synthetic pending interactions and removes only the matching terminal one', async () => {
    const approvalId = '33333333-3333-4333-8333-333333333333';
    const syntheticInteractions: SafeEvent[] = [
      approvalEvent(0, 'started', approvalId),
      {
        id: 0,
        threadId: 'thread-1',
        turnId: 'turn-input',
        kind: 'user-input',
        phase: 'started',
        payload: { request: { id: 'input-1', status: 'pending', questions: [] } },
        createdAt: '2026-10-11T12:00:00.000Z',
      },
      {
        id: 0,
        threadId: 'thread-1',
        turnId: 'turn-permission',
        kind: 'permission-approval',
        phase: 'started',
        payload: { request: { id: 'permission-1', status: 'pending' } },
        createdAt: '2026-10-11T12:00:00.000Z',
      },
    ];
    const { result } = renderHook(() => useThreadEvents('thread-1', 131));
    const source = FakeEventSource.instances[0]!;

    act(() => {
      result.current.mergeEvents(
        [...syntheticInteractions, ...Array.from({ length: 130 }, (_, index) => event(index + 2))],
        'thread-1',
      );
    });
    expect(result.current.events.filter((candidate) => candidate.id === 0)).toHaveLength(3);
    expect(result.current.events).toHaveLength(THREAD_EVENT_RETENTION_LIMIT + 3);
    expect(result.current.events.at(-1)?.id).toBe(131);

    act(() => source.emit(approvalEvent(132, 'completed', approvalId)));

    await waitFor(() => expect(result.current.events.at(-1)?.id).toBe(132));
    const remainingSynthetic = result.current.events.filter((candidate) => candidate.id === 0);
    expect(remainingSynthetic).toHaveLength(2);
    expect(remainingSynthetic.map((candidate) => candidate.kind).sort()).toEqual([
      'permission-approval',
      'user-input',
    ]);
    expect(result.current.events).toHaveLength(THREAD_EVENT_RETENTION_LIMIT + 2);
  });

  it('retains 64 synthetic interactions alongside the full normal event tail', () => {
    const syntheticInteractions = Array.from({ length: 64 }, (_, index) =>
      approvalEvent(0, 'started', `approval-${index + 1}`),
    );
    const { result } = renderHook(() => useThreadEvents('thread-1', 130));

    act(() => {
      result.current.mergeEvents(
        [...syntheticInteractions, ...Array.from({ length: 130 }, (_, index) => event(index + 1))],
        'thread-1',
      );
    });

    expect(PINNED_INTERACTION_RETENTION_LIMIT).toBe(120);
    expect(result.current.events.filter((candidate) => candidate.id === 0)).toHaveLength(64);
    const normalTail = result.current.events.filter((candidate) => candidate.id > 0);
    expect(normalTail).toHaveLength(THREAD_EVENT_RETENTION_LIMIT);
    expect(normalTail[0]?.id).toBe(11);
    expect(normalTail.at(-1)?.id).toBe(130);
  });
});
