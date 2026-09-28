import { z } from 'zod';

import type { RpcNotification } from './event-normalizer.js';

/* eslint-disable no-control-regex -- terminal control bytes must be stripped before persistence. */
const ANSI_PATTERN = new RegExp(
  '[\\u001b\\u009b][[\\]\\()#;?]*(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*)?\\u0007|(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~])',
  'g',
);
/* eslint-enable no-control-regex */
const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /\b(password|token|secret|authorization|cookie|api[_-]?key|private[_-]?key)\b\s*[:=]\s*([^\s,;]+)/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
];

export const collabAgentStatusSchema = z.enum([
  'pendingInit',
  'running',
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound',
]);
export type CollabAgentStatus = z.infer<typeof collabAgentStatusSchema>;

const collabToolSchema = z.enum([
  'spawnAgent',
  'sendInput',
  'resumeAgent',
  'wait',
  'closeAgent',
  'sendMessage',
  'followupTask',
  'interruptAgent',
  'listAgents',
]);
const collabToolStatusSchema = z.enum(['inProgress', 'completed', 'failed', 'interrupted']);
const reasoningEffortSchema = z.string().min(1).max(40);
const collabAgentStateSchema = z
  .object({
    status: collabAgentStatusSchema,
    message: z.string().nullable().optional(),
  })
  .strict();
const collabAgentToolCallSchema = z
  .object({
    type: z.literal('collabAgentToolCall'),
    id: z.string().min(1),
    tool: collabToolSchema,
    status: collabToolStatusSchema,
    senderThreadId: z.string().min(1),
    receiverThreadIds: z.array(z.string().min(1)).max(64),
    agentsStates: z.record(z.string().min(1), collabAgentStateSchema),
    model: z.string().min(1).max(120).nullable().optional(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
    prompt: z.string().nullable().optional(),
  })
  .strict();

const subagentActivityKindSchema = z.enum(['started', 'interacted', 'interrupted', 'completed']);
const subagentActivitySchema = z
  .object({
    type: z.literal('subAgentActivity'),
    id: z.string().min(1),
    agentThreadId: z.string().min(1),
    agentPath: z.string().min(1).max(500),
    kind: subagentActivityKindSchema,
  })
  .strict();

const itemLifecycleSchema = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('item/started'),
      params: z
        .object({
          threadId: z.string().min(1),
          turnId: z.string().min(1),
          startedAtMs: z.number().int().nonnegative().max(8_640_000_000_000_000),
          item: z.union([collabAgentToolCallSchema, subagentActivitySchema]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal('item/completed'),
      params: z
        .object({
          threadId: z.string().min(1),
          turnId: z.string().min(1),
          completedAtMs: z.number().int().nonnegative().max(8_640_000_000_000_000),
          item: z.union([collabAgentToolCallSchema, subagentActivitySchema]),
        })
        .strict(),
    })
    .strict(),
]);

const threadSpawnSourceSchema = z
  .object({
    thread_spawn: z
      .object({
        parent_thread_id: z.string().min(1),
        depth: z.number().int().nonnegative(),
        agent_path: z.string().min(1).max(500).nullable().optional(),
        agent_nickname: z.string().min(1).max(200).nullable().optional(),
        agent_role: z.string().min(1).max(200).nullable().optional(),
      })
      .strict(),
  })
  .strict();
const childThreadSchema = z
  .object({
    id: z.string().min(1),
    parentThreadId: z.string().min(1),
    sessionId: z.string().min(1),
    source: z
      .object({
        subAgent: z.union([
          z.literal('review'),
          z.literal('compact'),
          z.literal('memory_consolidation'),
          threadSpawnSourceSchema,
          z.object({ other: z.string().min(1) }).strict(),
        ]),
      })
      .strict(),
    agentNickname: z.string().min(1).max(200).nullable().optional(),
    agentRole: z.string().min(1).max(200).nullable().optional(),
    model: z.string().min(1).max(120).nullable().optional(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
    createdAt: z.number().int().nonnegative().max(8_640_000_000_000),
    updatedAt: z.number().int().nonnegative().max(8_640_000_000_000),
    status: z
      .object({ type: z.enum(['notLoaded', 'idle', 'active', 'systemError']) })
      .passthrough(),
  })
  .passthrough();
const threadStartedSchema = z
  .object({
    method: z.literal('thread/started'),
    params: z.object({ thread: childThreadSchema }).strict(),
  })
  .strict();

export interface KnownSubagent {
  readonly agentThreadId: string;
  readonly rootThreadId: string;
}

export interface SubagentProjectionUpsert {
  readonly agentThreadId: string;
  readonly parentThreadId: string;
  readonly rootThreadId: string;
  readonly sessionId?: string;
  readonly agentPath?: string;
  readonly depth?: number;
  readonly nickname?: string;
  readonly role?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly status?: CollabAgentStatus;
  readonly statusMessage?: string;
  readonly startedAt?: string;
  readonly lastActivityAt: string;
  readonly completedAt?: string;
}

export interface NormalizeSubagentOptions {
  readonly findAgent?: (agentThreadId: string) => KnownSubagent | null;
  readonly maxMessageLength?: number;
}

function boundedPublicMessage(value: string, maxLength: number): string {
  let output = value.replace(ANSI_PATTERN, '');
  for (const pattern of SECRET_PATTERNS)
    output = output.replace(pattern, (_match, prefix?: string) => `${prefix ?? ''}[REDACTED]`);
  return output.length <= maxLength
    ? output
    : `${output.slice(0, Math.max(0, maxLength - 13))}…[truncated]`;
}

function rootFor(parentThreadId: string, options: NormalizeSubagentOptions): string {
  return options.findAgent?.(parentThreadId)?.rootThreadId ?? parentThreadId;
}

function terminal(status: CollabAgentStatus): boolean {
  return ['interrupted', 'completed', 'errored', 'shutdown', 'notFound'].includes(status);
}

function isoFromMilliseconds(value: number): string {
  return new Date(value).toISOString();
}

function isoFromSeconds(value: number): string {
  return isoFromMilliseconds(value * 1_000);
}

function activityStatus(kind: z.infer<typeof subagentActivityKindSchema>): CollabAgentStatus {
  if (kind === 'interrupted') return 'interrupted';
  if (kind === 'completed') return 'completed';
  return 'running';
}

export function publicSubagentItem(
  value: unknown,
  maxMessageLength = 1_024,
): Record<string, unknown> | null {
  const collab = collabAgentToolCallSchema.safeParse(value);
  if (collab.success) {
    const { agentsStates } = collab.data;
    const item: Record<string, unknown> = { ...collab.data };
    delete item.prompt;
    delete item.agentsStates;
    return {
      ...item,
      agentsStates: Object.fromEntries(
        Object.entries(agentsStates).map(([agentThreadId, state]) => [
          agentThreadId,
          {
            status: state.status,
            ...(state.message
              ? { message: boundedPublicMessage(state.message, maxMessageLength) }
              : {}),
          },
        ]),
      ),
    };
  }
  const activity = subagentActivitySchema.safeParse(value);
  return activity.success ? activity.data : null;
}

export function normalizeSubagentNotification(
  notification: RpcNotification,
  options: NormalizeSubagentOptions = {},
): SubagentProjectionUpsert[] {
  const lifecycle = itemLifecycleSchema.safeParse(notification);
  if (lifecycle.success) {
    const observedAt = isoFromMilliseconds(
      lifecycle.data.method === 'item/started'
        ? lifecycle.data.params.startedAtMs
        : lifecycle.data.params.completedAtMs,
    );
    const { item, threadId } = lifecycle.data.params;
    if (item.type === 'subAgentActivity') {
      const status = activityStatus(item.kind);
      return [
        {
          agentThreadId: item.agentThreadId,
          parentThreadId: threadId,
          rootThreadId: rootFor(threadId, options),
          agentPath: item.agentPath,
          status,
          ...(item.kind === 'started' ? { startedAt: observedAt } : {}),
          lastActivityAt: observedAt,
          ...(terminal(status) ? { completedAt: observedAt } : {}),
        },
      ];
    }
    if (item.senderThreadId !== threadId) return [];

    const agentIds = [...new Set([...item.receiverThreadIds, ...Object.keys(item.agentsStates)])];
    return agentIds.map((agentThreadId) => {
      const state = item.agentsStates[agentThreadId];
      const status = state?.status ?? (item.tool === 'spawnAgent' ? 'pendingInit' : undefined);
      return {
        agentThreadId,
        parentThreadId: item.senderThreadId,
        rootThreadId: rootFor(item.senderThreadId, options),
        ...(item.model ? { model: item.model } : {}),
        ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
        ...(status ? { status } : {}),
        ...(state?.message
          ? {
              statusMessage: boundedPublicMessage(
                state.message,
                Math.min(options.maxMessageLength ?? 1_024, 4_096),
              ),
            }
          : {}),
        ...(item.tool === 'spawnAgent' ? { startedAt: observedAt } : {}),
        lastActivityAt: observedAt,
        ...(status && terminal(status) ? { completedAt: observedAt } : {}),
      };
    });
  }

  const started = threadStartedSchema.safeParse(notification);
  if (!started.success) return [];
  const thread = started.data.params.thread;
  const spawn =
    typeof thread.source.subAgent === 'object' && 'thread_spawn' in thread.source.subAgent
      ? thread.source.subAgent.thread_spawn
      : null;
  if (spawn && spawn.parent_thread_id !== thread.parentThreadId) return [];
  const status =
    thread.status.type === 'active'
      ? 'running'
      : thread.status.type === 'systemError'
        ? 'errored'
        : undefined;
  const updatedAt = isoFromSeconds(thread.updatedAt);
  const nickname = thread.agentNickname ?? spawn?.agent_nickname;
  const role = thread.agentRole ?? spawn?.agent_role;
  return [
    {
      agentThreadId: thread.id,
      parentThreadId: thread.parentThreadId,
      rootThreadId: rootFor(thread.parentThreadId, options),
      sessionId: thread.sessionId,
      ...(spawn?.agent_path ? { agentPath: spawn.agent_path } : {}),
      ...(spawn ? { depth: spawn.depth } : {}),
      ...(nickname ? { nickname } : {}),
      ...(role ? { role } : {}),
      ...(thread.model ? { model: thread.model } : {}),
      ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}),
      ...(status ? { status } : {}),
      startedAt: isoFromSeconds(thread.createdAt),
      lastActivityAt: updatedAt,
      ...(status && terminal(status) ? { completedAt: updatedAt } : {}),
    },
  ];
}
