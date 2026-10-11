import { describe, expect, it } from 'vitest';

import type { QueuedTurnRecord } from './database.js';
import { buildThreadContinuationDraft } from './thread-continuation.js';
import type { SafeEvent } from '@codex-web/contracts';

function event(
  id: number,
  turnId: string,
  kind: SafeEvent['kind'],
  payload: Record<string, unknown>,
): SafeEvent {
  return {
    id,
    threadId: 'thread-1',
    turnId,
    kind,
    phase: 'completed',
    payload,
    createdAt: '2026-10-11T10:00:00.000Z',
  };
}

function queuedTurn(
  id: number,
  status: QueuedTurnRecord['status'],
  text: string,
): QueuedTurnRecord {
  return {
    id,
    threadId: 'thread-1',
    idempotencyKey: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    requestHash: `hash-${id}`,
    request: {
      text,
      attachmentIds: [],
      approvalPolicy: 'on-request',
      idempotencyKey: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    },
    claimToken: `claim-${id}`,
    status,
    errorCode: status === 'unknown' ? 'IDEMPOTENCY_OUTCOME_UNKNOWN' : null,
    dismissedAt: null,
    createdAt: '2026-10-11T10:00:00.000Z',
    updatedAt: '2026-10-11T10:00:00.000Z',
    source: 'user',
    originTurnId: null,
    accountFingerprint: null,
    blocked: false,
  };
}

describe('thread continuation draft', () => {
  it('uses only user messages and final answers while flagging unresolved work', () => {
    const draft = buildThreadContinuationDraft({
      sourceThreadId: 'thread-1',
      projectId: '11111111-1111-4111-8111-111111111111',
      generatedAt: '2026-10-11T10:00:00.000Z',
      historyHydrated: true,
      rootActive: false,
      activeSubagents: 0,
      events: [
        event(1, 'turn-1', 'user-message', { text: 'Сделай отчёт' }),
        event(2, 'turn-1', 'plan', { text: 'PRIVATE PLAN' }),
        event(3, 'turn-1', 'command', { command: 'PRIVATE COMMAND' }),
        event(4, 'turn-1', 'tool', { item: { text: 'PRIVATE TOOL' } }),
        event(5, 'turn-1', 'agent-message', {
          text: 'PRIVATE COMMENTARY',
          messagePhase: 'commentary',
        }),
        event(6, 'turn-1', 'agent-message', {
          text: 'Отчёт готов',
          messagePhase: 'final_answer',
        }),
        event(7, 'turn-2', 'user-message', { text: 'Проверь незавершённую задачу' }),
        event(8, 'turn-2', 'turn', { status: 'interrupted' }),
      ],
      queuedTurns: [],
    });

    expect(draft.completeness).toBe('complete');
    expect(draft.text).toContain('Сделай отчёт');
    expect(draft.text).toContain('Отчёт готов');
    expect(draft.text).toContain('Проверь незавершённую задачу');
    expect(draft.text).toContain('Итоговый ответ не сохранён');
    expect(draft.text).not.toContain('PRIVATE PLAN');
    expect(draft.text).not.toContain('PRIVATE COMMAND');
    expect(draft.text).not.toContain('PRIVATE TOOL');
    expect(draft.text).not.toContain('PRIVATE COMMENTARY');
  });

  it('reports fallback completeness, queued previews, active work, and review warnings', () => {
    const draft = buildThreadContinuationDraft({
      sourceThreadId: 'thread-1',
      projectId: '11111111-1111-4111-8111-111111111111',
      generatedAt: '2026-10-11T10:00:00.000Z',
      historyHydrated: false,
      rootActive: true,
      activeSubagents: 2,
      events: [event(1, 'turn-1', 'user-message', { text: 'Текущая задача' })],
      queuedTurns: [
        queuedTurn(1, 'queued', 'Следующая задача'),
        queuedTurn(2, 'unknown', 'Проверь неопределённый запуск'),
      ],
    });

    expect(draft.completeness).toBe('local-fallback');
    expect(draft.sourceWork).toEqual({
      rootActive: true,
      activeSubagents: 2,
      queued: 1,
      needsReview: 1,
    });
    expect(draft.text).toContain('Следующая задача');
    expect(draft.text).toContain('Проверь неопределённый запуск');
    expect(draft.warnings.join(' ')).toContain('локально сохранённых');
    expect(draft.warnings.join(' ')).toContain('сабагенты: 2');
    expect(draft.warnings.join(' ')).toContain('неопределённым результатом запуска: 1');
  });

  it('bounds output to 24k and counts completed turns omitted from the draft', () => {
    const events: SafeEvent[] = [];
    for (let index = 0; index < 20; index += 1) {
      events.push(
        event(index * 2 + 1, `turn-${index}`, 'user-message', {
          text: `task-${index}-${'x'.repeat(3_000)}`,
        }),
        event(index * 2 + 2, `turn-${index}`, 'agent-message', {
          text: `answer-${index}-${'y'.repeat(3_000)}`,
          messagePhase: 'final_answer',
        }),
      );
    }
    const draft = buildThreadContinuationDraft({
      sourceThreadId: 'thread-1',
      projectId: '11111111-1111-4111-8111-111111111111',
      generatedAt: '2026-10-11T10:00:00.000Z',
      historyHydrated: true,
      rootActive: false,
      activeSubagents: 0,
      events,
      queuedTurns: [],
    });

    expect(draft.text.length).toBeLessThanOrEqual(24_000);
    expect(draft.omittedCompletedTurns).toBeGreaterThan(0);
    expect(draft.warnings.join(' ')).toContain('не включённые');
    expect(draft.text).toContain('task-19');
  });

  it('marks an empty local journal as insufficient', () => {
    const draft = buildThreadContinuationDraft({
      sourceThreadId: 'thread-1',
      projectId: '11111111-1111-4111-8111-111111111111',
      generatedAt: '2026-10-11T10:00:00.000Z',
      historyHydrated: false,
      rootActive: false,
      activeSubagents: 0,
      events: [event(1, 'turn-1', 'plan', { text: 'must not be exposed' })],
      queuedTurns: [],
    });

    expect(draft.completeness).toBe('insufficient');
    expect(draft.text).toBe('');
    expect(draft.text).not.toContain('must not be exposed');
  });
});
