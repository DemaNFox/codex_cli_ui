import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SafeEvent } from './api.js';
import { THREAD_EVENT_RETENTION_LIMIT, useThreadEvents } from './useThreadEvents.js';

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
});
