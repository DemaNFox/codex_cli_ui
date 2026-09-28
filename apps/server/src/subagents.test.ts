import { describe, expect, it } from 'vitest';

import { normalizeNotification } from './event-normalizer.js';
import { normalizeThreadHistory } from './history-normalizer.js';
import { normalizeSubagentNotification, publicSubagentItem } from './subagents.js';

const startedAtMs = Date.parse('2026-09-28T12:00:00.000Z');

describe('subagent protocol normalization', () => {
  it('projects a spawn without exposing its prompt and sanitizes status messages', () => {
    const notification = {
      method: 'item/completed',
      params: {
        threadId: 'root-thread',
        turnId: 'turn-1',
        completedAtMs: startedAtMs,
        item: {
          type: 'collabAgentToolCall',
          id: 'call-1',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'root-thread',
          receiverThreadIds: ['child-1'],
          agentsStates: {
            'child-1': { status: 'running', message: '\u001b[31mtoken=secret-value\u001b[0m' },
          },
          model: 'gpt-6-sol',
          reasoningEffort: 'medium',
          prompt: 'private delegated task',
        },
      },
    } as const;

    expect(normalizeSubagentNotification(notification)).toEqual([
      {
        agentThreadId: 'child-1',
        parentThreadId: 'root-thread',
        rootThreadId: 'root-thread',
        model: 'gpt-6-sol',
        reasoningEffort: 'medium',
        status: 'running',
        statusMessage: 'token[REDACTED]',
        startedAt: '2026-09-28T12:00:00.000Z',
        lastActivityAt: '2026-09-28T12:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(publicSubagentItem(notification.params.item))).not.toContain('prompt');
    expect(JSON.stringify(normalizeNotification(notification, 8_192))).not.toContain(
      'private delegated task',
    );
  });

  it('preserves exact terminal states and nested roots', () => {
    const notification = {
      method: 'item/completed',
      params: {
        threadId: 'child-1',
        turnId: 'turn-child',
        completedAtMs: startedAtMs + 5_000,
        item: {
          type: 'collabAgentToolCall',
          id: 'call-2',
          tool: 'wait',
          status: 'completed',
          senderThreadId: 'child-1',
          receiverThreadIds: ['grandchild-1'],
          agentsStates: { 'grandchild-1': { status: 'errored', message: 'failed' } },
        },
      },
    } as const;

    expect(
      normalizeSubagentNotification(notification, {
        findAgent: (id) =>
          id === 'child-1' ? { agentThreadId: id, rootThreadId: 'root-thread' } : null,
      }),
    ).toEqual([
      {
        agentThreadId: 'grandchild-1',
        parentThreadId: 'child-1',
        rootThreadId: 'root-thread',
        status: 'errored',
        statusMessage: 'failed',
        lastActivityAt: '2026-09-28T12:00:05.000Z',
        completedAt: '2026-09-28T12:00:05.000Z',
      },
    ]);
  });

  it('normalizes activity and child thread metadata while rejecting mismatched parents', () => {
    expect(
      normalizeSubagentNotification({
        method: 'item/started',
        params: {
          threadId: 'root-thread',
          turnId: 'turn-1',
          startedAtMs,
          item: {
            type: 'subAgentActivity',
            id: 'activity-1',
            agentThreadId: 'child-1',
            agentPath: '/root/research',
            kind: 'started',
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        agentThreadId: 'child-1',
        agentPath: '/root/research',
        status: 'running',
        startedAt: '2026-09-28T12:00:00.000Z',
      }),
    ]);

    const childStarted = {
      method: 'thread/started',
      params: {
        thread: {
          id: 'child-1',
          parentThreadId: 'root-thread',
          sessionId: 'session-1',
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: 'root-thread',
                depth: 1,
                agent_path: '/root/research',
                agent_nickname: 'Researcher',
                agent_role: 'audit',
              },
            },
          },
          agentNickname: null,
          agentRole: null,
          model: 'gpt-6-sol',
          reasoningEffort: 'high',
          createdAt: startedAtMs / 1_000,
          updatedAt: startedAtMs / 1_000 + 2,
          status: { type: 'active', activeFlags: [] },
        },
      },
    };
    expect(normalizeSubagentNotification(childStarted)).toEqual([
      expect.objectContaining({
        agentThreadId: 'child-1',
        parentThreadId: 'root-thread',
        rootThreadId: 'root-thread',
        sessionId: 'session-1',
        nickname: 'Researcher',
        role: 'audit',
        depth: 1,
        status: 'running',
        startedAt: '2026-09-28T12:00:00.000Z',
        lastActivityAt: '2026-09-28T12:00:02.000Z',
      }),
    ]);
    childStarted.params.thread.source.subAgent.thread_spawn.parent_thread_id = 'different-parent';
    expect(normalizeSubagentNotification(childStarted)).toEqual([]);
  });

  it('retains collab and activity items during history hydration without prompts', () => {
    const events = normalizeThreadHistory(
      'root-thread',
      [
        {
          id: 'turn-1',
          status: 'completed',
          items: [
            {
              type: 'collabAgentToolCall',
              id: 'call-1',
              tool: 'spawnAgent',
              status: 'completed',
              senderThreadId: 'root-thread',
              receiverThreadIds: ['child-1'],
              agentsStates: { 'child-1': { status: 'completed', message: 'done' } },
              prompt: 'do not persist me',
            },
            {
              type: 'subAgentActivity',
              id: 'activity-1',
              agentThreadId: 'child-1',
              agentPath: '/root/research',
              kind: 'completed',
            },
          ],
        },
      ],
      8_192,
    );

    expect(events.filter((event) => event.kind === 'tool')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'tool').map((event) => event.phase)).toEqual([
      'completed',
      'completed',
    ]);
    expect(JSON.stringify(events)).not.toContain('do not persist me');
  });

  it('default-denies unknown statuses and malformed protocol variants', () => {
    expect(
      normalizeSubagentNotification({
        method: 'item/completed',
        params: {
          threadId: 'root-thread',
          turnId: 'turn-1',
          completedAtMs: startedAtMs,
          item: {
            type: 'collabAgentToolCall',
            id: 'call-1',
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: 'root-thread',
            receiverThreadIds: ['child-1'],
            agentsStates: { 'child-1': { status: 'futureStatus' } },
          },
        },
      }),
    ).toEqual([]);
  });

  it.each([
    'pendingInit',
    'running',
    'interrupted',
    'completed',
    'errored',
    'shutdown',
    'notFound',
  ] as const)('preserves the pinned %s status', (status) => {
    const result = normalizeSubagentNotification({
      method: 'item/completed',
      params: {
        threadId: 'root-thread',
        turnId: 'turn-1',
        completedAtMs: startedAtMs,
        item: {
          type: 'collabAgentToolCall',
          id: 'call-1',
          tool: 'listAgents',
          status: 'completed',
          senderThreadId: 'root-thread',
          receiverThreadIds: ['child-1'],
          agentsStates: { 'child-1': { status } },
        },
      },
    });
    expect(result[0]?.status).toBe(status);
  });

  it('rejects a collab item whose sender does not match its lifecycle thread', () => {
    expect(
      normalizeSubagentNotification({
        method: 'item/completed',
        params: {
          threadId: 'root-thread',
          turnId: 'turn-1',
          completedAtMs: startedAtMs,
          item: {
            type: 'collabAgentToolCall',
            id: 'call-1',
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: 'different-thread',
            receiverThreadIds: ['child-1'],
            agentsStates: { 'child-1': { status: 'running' } },
          },
        },
      }),
    ).toEqual([]);
  });
});
