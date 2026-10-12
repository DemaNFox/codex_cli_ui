import { describe, expect, it } from 'vitest';

import type { SafeEvent } from '../api.js';
import { conversationMessages } from './conversation.js';

function event(
  id: number,
  turnId: string,
  kind: SafeEvent['kind'],
  payload: Record<string, unknown>,
  phase: SafeEvent['phase'] = 'completed',
): SafeEvent {
  return {
    id,
    threadId: 'thread-1',
    turnId,
    kind,
    phase,
    payload,
    createdAt: '2026-10-12T12:00:00.000Z',
  };
}

describe('v2 conversation projection', () => {
  it('keeps each completed prompt and final while hiding only its work commentary', () => {
    const messages = conversationMessages([
      event(1, 'turn-1', 'user-message', { text: 'First task' }),
      event(2, 'turn-1', 'agent-message', { text: 'Working', messagePhase: 'commentary' }),
      event(3, 'turn-1', 'agent-message', { text: 'First result', messagePhase: 'final_answer' }),
      event(4, 'turn-1', 'turn', { status: 'completed' }),
      event(5, 'turn-2', 'user-message', { text: 'Second task' }),
      event(6, 'turn-2', 'agent-message', { text: 'Second result', messagePhase: 'final_answer' }),
      event(7, 'turn-2', 'turn', { status: 'completed' }),
    ]);
    expect(messages.map((message) => message.text)).toEqual([
      'First task',
      'First result',
      'Second task',
      'Second result',
    ]);
    expect(messages.filter((message) => message.finalState === 'complete')).toHaveLength(2);
  });

  it('does not mark an answer final before a successful terminal event', () => {
    const messages = conversationMessages([
      event(1, 'turn-1', 'user-message', { text: 'Task' }),
      event(2, 'turn-1', 'agent-message', { text: 'Provisional', messagePhase: 'final_answer' }),
      event(3, 'turn-1', 'turn', { status: 'interrupted' }),
    ]);
    expect(messages[1]?.finalState).toBe('failed');
  });

  it('uses the last phase-less answer only for legacy completed turns', () => {
    const messages = conversationMessages([
      event(1, 'turn-1', 'user-message', { text: 'Task' }),
      event(2, 'turn-1', 'agent-message', { text: 'Early answer' }),
      event(3, 'turn-1', 'agent-message', { text: 'Final answer' }),
      event(4, 'turn-1', 'turn', { status: 'completed' }),
    ]);
    expect(messages.map((message) => message.text)).toEqual(['Task', 'Final answer']);
  });

  it('prefers an explicit final over a phase-less legacy candidate in the same turn', () => {
    const messages = conversationMessages([
      event(1, 'turn-1', 'user-message', { text: 'Task' }),
      event(2, 'turn-1', 'agent-message', { text: 'Unclassified' }),
      event(3, 'turn-1', 'agent-message', { text: 'Actual final', messagePhase: 'final_answer' }),
      event(4, 'turn-1', 'turn', { status: 'completed' }),
    ]);
    expect(messages.map((message) => message.text)).toEqual(['Task', 'Actual final']);
  });
});
