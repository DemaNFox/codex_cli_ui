import type { SafeEvent, ThreadContinuationDraft } from '@codex-web/contracts';

import type { QueuedTurnRecord } from './database.js';

const MAX_DRAFT_CHARS = 24_000;
const MAX_VISIBLE_FIELD_CHARS = 4_000;
const MAX_UNRESOLVED_TURNS = 8;
const MAX_QUEUED_TURNS = 20;
const MAX_COMPLETED_TURNS = 10;

interface TurnSummary {
  readonly turnId: string;
  readonly userMessages: string[];
  readonly finalAnswers: string[];
  lastEventId: number;
  terminalStatus: string | null;
}

export interface ThreadContinuationInput {
  readonly sourceThreadId: string;
  readonly projectId: string;
  readonly generatedAt: string;
  readonly historyHydrated: boolean;
  readonly rootActive: boolean;
  readonly activeSubagents: number;
  readonly events: readonly SafeEvent[];
  readonly queuedTurns: readonly QueuedTurnRecord[];
}

function visibleText(value: unknown, maxChars = MAX_VISIBLE_FIELD_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  if (normalized.length === 0) return null;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function eventTurns(events: readonly SafeEvent[]): TurnSummary[] {
  const turns = new Map<string, TurnSummary>();
  for (const event of events) {
    if (event.turnId === null) continue;
    let turn = turns.get(event.turnId);
    if (!turn) {
      turn = {
        turnId: event.turnId,
        userMessages: [],
        finalAnswers: [],
        lastEventId: event.id,
        terminalStatus: null,
      };
      turns.set(event.turnId, turn);
    }
    turn.lastEventId = Math.max(turn.lastEventId, event.id);
    if (event.kind === 'user-message') {
      const text = visibleText(event.payload.text);
      if (text) turn.userMessages.push(text);
    } else if (event.kind === 'agent-message' && event.payload.messagePhase === 'final_answer') {
      const text = visibleText(event.payload.text);
      if (text) turn.finalAnswers.push(text);
    } else if (event.kind === 'turn') {
      const status = event.payload.status;
      if (typeof status === 'string') turn.terminalStatus = status;
    }
  }
  return [...turns.values()].sort((left, right) => right.lastEventId - left.lastEventId);
}

function taskBlock(title: string, turn: TurnSummary): string {
  const task = turn.userMessages.join('\n\n') || '(локальная формулировка задачи не сохранена)';
  const answer = turn.finalAnswers.at(-1);
  return [
    `### ${title}`,
    `Задача:\n${task}`,
    ...(answer ? [`Последний итоговый ответ Codex:\n${answer}`] : []),
    ...(!answer && turn.terminalStatus
      ? [`Локальное состояние хода: ${turn.terminalStatus}. Итоговый ответ не сохранён.`]
      : []),
  ].join('\n\n');
}

function boundedJoin(sections: readonly string[]): string {
  const joined = sections.filter((section) => section.length > 0).join('\n\n');
  if (joined.length <= MAX_DRAFT_CHARS) return joined;
  return `${joined.slice(0, MAX_DRAFT_CHARS - 1).trimEnd()}…`;
}

export function buildThreadContinuationDraft(
  input: ThreadContinuationInput,
): ThreadContinuationDraft {
  const turns = eventTurns(input.events);
  const completed = turns.filter((turn) => turn.finalAnswers.length > 0);
  const unresolved = turns.filter(
    (turn) => turn.userMessages.length > 0 && turn.finalAnswers.length === 0,
  );
  const queued = input.queuedTurns.filter((turn) => turn.status === 'queued');
  const needsReview = input.queuedTurns.filter((turn) => turn.status === 'unknown');
  const queuedWithText = input.queuedTurns.flatMap((turn) => {
    const text = visibleText(turn.request.text, 1_500);
    return text ? [{ turn, text }] : [];
  });
  const hasUsableContent =
    completed.length > 0 || unresolved.length > 0 || queuedWithText.length > 0;
  const warnings: string[] = [];

  if (!input.historyHydrated)
    warnings.push(
      'Нативная история Codex недоступна или ещё не загружена: перенос основан только на локально сохранённых сообщениях.',
    );
  if (input.rootActive)
    warnings.push(
      'В исходном чате ещё выполняется корневая задача; её результат может отсутствовать.',
    );
  if (input.activeSubagents > 0)
    warnings.push(`В исходном чате ещё работают сабагенты: ${input.activeSubagents}.`);
  if (queued.length > 0)
    warnings.push(`В исходном чате остаются задачи в очереди: ${queued.length}.`);
  if (needsReview.length > 0)
    warnings.push(`Есть задачи с неопределённым результатом запуска: ${needsReview.length}.`);
  if (unresolved.length > MAX_UNRESOLVED_TURNS)
    warnings.push(
      `Показаны ${MAX_UNRESOLVED_TURNS} последних незавершённых задач из ${unresolved.length}.`,
    );
  if (queuedWithText.length > MAX_QUEUED_TURNS)
    warnings.push(
      `Показаны ${MAX_QUEUED_TURNS} последних задач очереди из ${queuedWithText.length}.`,
    );

  const unresolvedSections = unresolved
    .slice(0, MAX_UNRESOLVED_TURNS)
    .map((turn, index) => taskBlock(`Незавершённая или неопределённая задача ${index + 1}`, turn));
  const queuedSections = queuedWithText
    .slice(-MAX_QUEUED_TURNS)
    .map(({ turn, text }, index) =>
      [
        `### Задача очереди ${index + 1}`,
        text,
        `Состояние: ${turn.status === 'unknown' ? 'требует проверки запуска' : 'ожидает запуска'}.`,
      ].join('\n\n'),
    );

  const prefixSections = [
    '# Продолжение работы из предыдущего чата',
    'Это локальная выжимка подтверждённых пользовательских сообщений и итоговых ответов Codex. Проверь незавершённые пункты перед выполнением.',
    ...(warnings.length > 0
      ? [`## Важные предупреждения\n${warnings.map((warning) => `- ${warning}`).join('\n')}`]
      : []),
    ...(unresolvedSections.length > 0
      ? [`## Незавершённые или неопределённые задачи\n\n${unresolvedSections.join('\n\n')}`]
      : []),
    ...(queuedSections.length > 0
      ? [`## Задачи, оставшиеся в очереди\n\n${queuedSections.join('\n\n')}`]
      : []),
  ];
  let text = boundedJoin(prefixSections);
  let includedCompleted = 0;
  for (const turn of completed.slice(0, MAX_COMPLETED_TURNS)) {
    const section = `## Последняя завершённая задача ${includedCompleted + 1}\n\n${taskBlock('Подтверждённый контекст', turn)}`;
    const candidate = boundedJoin([text, section]);
    if (candidate.length >= MAX_DRAFT_CHARS && text.length + section.length + 2 > MAX_DRAFT_CHARS)
      break;
    text = candidate;
    includedCompleted += 1;
  }
  const omittedCompletedTurns = completed.length - includedCompleted;
  if (omittedCompletedTurns > 0) {
    const notice = `Завершённые задачи, не включённые из-за ограничения размера: ${omittedCompletedTurns}.`;
    if (!warnings.includes(notice)) warnings.push(notice);
    text = boundedJoin([text, `## Ограничение выжимки\n${notice}`]);
  }

  return {
    sourceThreadId: input.sourceThreadId,
    projectId: input.projectId,
    generatedAt: input.generatedAt,
    completeness: hasUsableContent
      ? input.historyHydrated
        ? 'complete'
        : 'local-fallback'
      : 'insufficient',
    text: hasUsableContent ? text : '',
    omittedCompletedTurns,
    sourceWork: {
      rootActive: input.rootActive,
      activeSubagents: input.activeSubagents,
      queued: queued.length,
      needsReview: needsReview.length,
    },
    warnings: warnings.slice(0, 8),
  };
}
