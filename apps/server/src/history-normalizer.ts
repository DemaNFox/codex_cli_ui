import type { SafeEvent } from '@codex-web/contracts';
import path from 'node:path';

import { sanitizeEventPayload } from './event-normalizer.js';

type JournalEvent = Omit<SafeEvent, 'id' | 'createdAt'>;
const ATTACHMENT_REFERENCE_MARKER =
  '\n\n[Codex Web attachment references (server-local; do not repeat paths):\n';

function stripServerAttachmentSuffix(value: string): string {
  const marker = value.lastIndexOf(ATTACHMENT_REFERENCE_MARKER);
  if (marker < 0) return value;
  const suffix = value.slice(marker + ATTACHMENT_REFERENCE_MARKER.length);
  if (!suffix.endsWith('\n]')) return value;
  const references = suffix.slice(0, -2).split('\n');
  if (
    references.length === 0 ||
    references.some((reference) => !/^.{1,180}: (?:[A-Za-z]:[\\/]|\/)/u.test(reference))
  )
    return value;
  return value.slice(0, marker);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function phaseForStatus(status: string): SafeEvent['phase'] {
  if (status === 'inProgress') return 'started';
  if (status === 'failed' || status === 'declined') return 'failed';
  return 'completed';
}

function safeRelativePath(value: string): string | null {
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  const segments = value.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => segment === '..')) return null;
  return value;
}

function textEvent(
  threadId: string,
  turnId: string,
  kind: 'user-message' | 'agent-message' | 'plan',
  field: 'text' | 'summary',
  text: string,
  maxBytes: number,
): JournalEvent | null {
  if (text.length === 0) return null;
  return {
    threadId,
    turnId,
    kind,
    phase: 'completed',
    payload: sanitizeEventPayload({ [field]: text }, maxBytes),
  };
}

function normalizeItem(
  threadId: string,
  turnId: string,
  value: unknown,
  maxBytes: number,
): JournalEvent | null {
  const item = record(value);
  if (!item || typeof item.type !== 'string') return null;

  if (item.type === 'userMessage') {
    if (!Array.isArray(item.content)) return null;
    const text = item.content
      .map(record)
      .filter(
        (input): input is Record<string, unknown> =>
          input !== null && input.type === 'text' && typeof input.text === 'string',
      )
      .map((input) => stripServerAttachmentSuffix(input.text as string))
      .filter((part) => part.length > 0)
      .join('\n');
    return textEvent(threadId, turnId, 'user-message', 'text', text, maxBytes);
  }

  if (item.type === 'agentMessage' && typeof item.text === 'string') {
    return textEvent(threadId, turnId, 'agent-message', 'text', item.text, maxBytes);
  }

  if (item.type === 'plan' && typeof item.text === 'string') {
    return textEvent(threadId, turnId, 'plan', 'text', item.text, maxBytes);
  }

  if (item.type === 'reasoning') {
    if (!Array.isArray(item.summary)) return null;
    const summary = item.summary
      .filter((part): part is string => typeof part === 'string')
      .join('\n');
    return textEvent(threadId, turnId, 'plan', 'summary', summary, maxBytes);
  }

  if (
    item.type === 'commandExecution' &&
    typeof item.command === 'string' &&
    typeof item.status === 'string' &&
    ['inProgress', 'completed', 'failed', 'declined'].includes(item.status)
  ) {
    return {
      threadId,
      turnId,
      kind: 'command',
      phase: phaseForStatus(item.status),
      payload: sanitizeEventPayload(
        {
          command: item.command,
          status: item.status,
          ...(typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput } : {}),
        },
        maxBytes,
      ),
    };
  }

  if (
    item.type === 'fileChange' &&
    typeof item.status === 'string' &&
    ['inProgress', 'completed', 'failed', 'declined'].includes(item.status) &&
    Array.isArray(item.changes)
  ) {
    const changes = item.changes.slice(0, 200).flatMap((value) => {
      const change = record(value);
      const kind = record(change?.kind);
      if (!change || typeof change.path !== 'string' || typeof kind?.type !== 'string') return [];
      const safePath = safeRelativePath(change.path);
      return safePath === null ? [] : [{ path: safePath, kind: kind.type }];
    });
    return {
      threadId,
      turnId,
      kind: 'file-change',
      phase: phaseForStatus(item.status),
      payload: sanitizeEventPayload(
        { status: item.status, summary: `${changes.length} file change(s)`, changes },
        maxBytes,
      ),
    };
  }

  return null;
}

export function normalizeThreadHistory(
  threadId: string,
  turns: unknown,
  maxBytes: number,
): JournalEvent[] {
  if (!Array.isArray(turns)) return [];
  const events: JournalEvent[] = [];
  for (const value of turns) {
    const turn = record(value);
    if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items)) continue;
    for (const item of turn.items) {
      const event = normalizeItem(threadId, turn.id, item, maxBytes);
      if (event) events.push(event);
    }
    if (
      typeof turn.status === 'string' &&
      ['inProgress', 'completed', 'failed', 'interrupted'].includes(turn.status)
    ) {
      events.push({
        threadId,
        turnId: turn.id,
        kind: 'turn',
        phase:
          turn.status === 'inProgress'
            ? 'started'
            : turn.status === 'failed'
              ? 'failed'
              : 'completed',
        payload: sanitizeEventPayload({ status: turn.status }, maxBytes),
      });
    }
  }
  return events;
}
