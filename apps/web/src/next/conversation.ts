import type { SafeEvent } from '../api.js';

export interface ConversationMessage {
  event: SafeEvent;
  role: 'user' | 'codex';
  text: string;
  finalState: 'complete' | 'working' | 'failed' | null;
}

function messageText(event: SafeEvent): string {
  return typeof event.payload.text === 'string' ? event.payload.text : '';
}

function turnState(events: readonly SafeEvent[]): Map<string, 'complete' | 'failed'> {
  const states = new Map<string, 'complete' | 'failed'>();
  for (const event of events) {
    if (event.kind !== 'turn' || !event.turnId) continue;
    if (event.phase !== 'completed' && event.phase !== 'failed') continue;
    const nested = event.payload.turn;
    const nestedStatus =
      nested && typeof nested === 'object' && 'status' in nested ? nested.status : null;
    const status = event.payload.status ?? nestedStatus;
    states.set(
      event.turnId,
      event.phase === 'failed' || status === 'failed' || status === 'interrupted'
        ? 'failed'
        : 'complete',
    );
  }
  return states;
}

export function conversationMessages(events: readonly SafeEvent[]): ConversationMessage[] {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const states = turnState(ordered);
  const legacyFinalByTurn = new Map<string, number>();
  const explicitFinalTurns = new Set<string>();
  for (const event of ordered) {
    if (
      event.kind === 'agent-message' &&
      event.phase === 'completed' &&
      event.turnId &&
      event.payload.messagePhase === 'final_answer'
    ) {
      explicitFinalTurns.add(event.turnId);
    }
    if (
      event.kind === 'agent-message' &&
      event.phase === 'completed' &&
      event.turnId &&
      states.get(event.turnId) === 'complete' &&
      event.payload.messagePhase !== 'commentary' &&
      event.payload.messagePhase !== 'final_answer'
    ) {
      // Historical events predate the explicit final_answer phase.
      legacyFinalByTurn.set(event.turnId, event.id);
    }
  }
  for (const turnId of explicitFinalTurns) legacyFinalByTurn.delete(turnId);
  const legacyFinalIds = new Set(legacyFinalByTurn.values());
  const hasFinal = new Set<string>();
  for (const event of ordered) {
    if (
      event.kind === 'agent-message' &&
      event.turnId &&
      (event.payload.messagePhase === 'final_answer' || legacyFinalIds.has(event.id)) &&
      states.get(event.turnId) === 'complete'
    ) {
      hasFinal.add(event.turnId);
    }
  }
  return ordered.flatMap((event): ConversationMessage[] => {
    if (event.kind === 'user-message' && event.phase === 'completed') {
      return [{ event, role: 'user', text: messageText(event), finalState: null }];
    }
    if (event.kind !== 'agent-message' || event.phase !== 'completed') return [];
    const state = event.turnId ? states.get(event.turnId) : undefined;
    const isFinal = event.payload.messagePhase === 'final_answer' || legacyFinalIds.has(event.id);
    if (event.turnId && state === 'complete' && hasFinal.has(event.turnId) && !isFinal) return [];
    return [
      {
        event,
        role: 'codex',
        text: messageText(event),
        finalState: isFinal
          ? state === 'complete'
            ? 'complete'
            : state === 'failed'
              ? 'failed'
              : 'working'
          : null,
      },
    ];
  });
}
