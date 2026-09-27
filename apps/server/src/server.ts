import {
  accountRateLimitSchema,
  accountUsageSchema,
  attachmentSchema,
  capabilitySchema,
  createProjectRequestSchema,
  loginRequestSchema,
  modelOptionSchema,
  resolvePermissionRequestSchema,
  resolveApprovalRequestSchema,
  resolveUserInputRequestSchema,
  startThreadRequestSchema,
  startTurnRequestSchema,
  steerTurnRequestSchema,
  threadListQuerySchema,
  userInputQuestionSchema,
  type PermissionPreset,
  type Attachment,
  type PendingApproval,
  type Project,
  type SafeEvent,
  type Thread,
} from '@codex-web/contracts';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { AppServerClient, AppServerInbound } from './app-server.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_THREAD_ATTACHMENT_BYTES,
  type AttachmentStore,
  parseSingleFileMultipart,
} from './attachment-store.js';
import { AuthService, HttpError, type AuthContext } from './auth.js';
import type { ServerConfig } from './config.js';
import type { AttachmentRecord, SqliteRepository } from './database.js';
import {
  normalizeApproval,
  normalizeNotification,
  sanitizeEventPayload,
} from './event-normalizer.js';
import { normalizeThreadHistory } from './history-normalizer.js';
import {
  normalizePermissionRequest,
  normalizeUserInputRequest,
  validatePermissionProfile,
  validateUserInputAnswers,
} from './interaction-normalizer.js';
import type { ProjectPathPolicy } from './path-policy.js';
import { createSseDelivery } from './sse.js';

const idParamsSchema = z.object({ id: z.string().min(1).max(200) });
const attachmentParamsSchema = z.object({
  id: z.string().min(1).max(200),
  attachmentId: z.string().uuid(),
});
const projectPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    defaultModel: z.string().trim().min(1).max(120).nullable().optional(),
    defaultReasoningEffort: z.string().trim().min(1).max(40).nullable().optional(),
    defaultPermissionPreset: z.enum(['read-only', 'workspace-write', 'full-access']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
const threadPatchSchema = z.object({ name: z.string().trim().min(1).max(200) });
const interruptBodySchema = z.object({ turnId: z.string().min(1).max(200) });
const eventCursorSchema = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));

const rpcThreadSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable().optional(),
    preview: z.string().default(''),
    model: z.string().nullable().optional(),
    status: z
      .union([
        z.object({ type: z.enum(['notLoaded', 'idle', 'active', 'systemError']) }).passthrough(),
        z.string(),
      ])
      .optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    cwd: z.string(),
  })
  .passthrough();

const threadResponseSchema = z
  .object({
    thread: rpcThreadSchema,
    instructionSources: z.array(z.string()).optional().default([]),
    model: z.string().optional(),
  })
  .passthrough();

const turnResponseSchema = z
  .object({
    turn: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const modelResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string(),
          model: z.string(),
          displayName: z.string(),
          isDefault: z.boolean(),
          defaultReasoningEffort: z.string().nullable(),
          supportedReasoningEfforts: z.array(
            z.object({
              reasoningEffort: z.string(),
              description: z.string().nullable().optional(),
            }),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const skillsResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          cwd: z.string(),
          skills: z.array(
            z
              .object({
                name: z.string(),
                path: z.string(),
                enabled: z.boolean(),
              })
              .passthrough(),
          ),
          errors: z.array(z.unknown()).optional().default([]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const accountResponseSchema = z
  .object({
    account: z.unknown().nullable().optional(),
    requiresOpenaiAuth: z.boolean(),
  })
  .passthrough();

const upstreamRateLimitWindowSchema = z.object({
  usedPercent: z.number().int().min(0).max(100),
  windowDurationMins: z.number().int().positive().nullable().optional(),
  resetsAt: z.number().int().nonnegative().nullable().optional(),
});

const upstreamRateLimitSchema = z.object({
  limitId: z.string().min(1).max(120).nullable().optional(),
  limitName: z.string().min(1).max(200).nullable().optional(),
  planType: z.string().min(1).max(80).nullable().optional(),
  primary: upstreamRateLimitWindowSchema.nullable().optional(),
  secondary: upstreamRateLimitWindowSchema.nullable().optional(),
});

const rateLimitsResponseSchema = z.object({
  rateLimits: upstreamRateLimitSchema.passthrough(),
  rateLimitsByLimitId: z
    .record(z.string(), upstreamRateLimitSchema.passthrough())
    .nullable()
    .optional(),
});

const nullableUsageIntegerSchema = z.number().int().nonnegative().nullable();
const usageResponseSchema = z.object({
  summary: z.object({
    lifetimeTokens: nullableUsageIntegerSchema.optional(),
    currentStreakDays: nullableUsageIntegerSchema.optional(),
    longestStreakDays: nullableUsageIntegerSchema.optional(),
    peakDailyTokens: nullableUsageIntegerSchema.optional(),
    longestRunningTurnSec: nullableUsageIntegerSchema.optional(),
  }),
  dailyUsageBuckets: z
    .array(
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        tokens: z.number().int().nonnegative(),
      }),
    )
    .max(366)
    .nullable()
    .optional(),
});

const storedUserInputDetailsSchema = z.object({
  itemId: z.string(),
  isBlocking: z.boolean(),
  questions: z.array(userInputQuestionSchema),
});
const storedPermissionDetailsSchema = z.object({
  itemId: z.string(),
  cwd: z.string(),
  reason: z.string().nullable(),
  permissions: z.record(z.string(), z.unknown()),
});

type SseListener = (event: SafeEvent) => void;

export interface ServerDependencies {
  readonly config: ServerConfig;
  readonly repository: SqliteRepository;
  readonly pathPolicy: ProjectPathPolicy;
  readonly appServer: AppServerClient;
  readonly attachmentStore: AttachmentStore;
}

function publicAttachment(record: AttachmentRecord): Attachment {
  return attachmentSchema.parse({
    id: record.id,
    threadId: record.threadId,
    name: record.name,
    mediaType: record.mimeType,
    sizeBytes: record.size,
    kind: record.kind,
    createdAt: record.createdAt,
    url: `/api/threads/${encodeURIComponent(record.threadId)}/attachments/${record.id}/content`,
  });
}

function inputRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isUserMessageLifecycle(message: AppServerInbound): boolean {
  if (!('method' in message) || !['item/started', 'item/completed'].includes(message.method))
    return false;
  const params = inputRecord(message.params);
  return inputRecord(params?.item)?.type === 'userMessage';
}

function completedAgentMessage(
  message: AppServerInbound,
  maxBytes: number,
): Omit<SafeEvent, 'id' | 'createdAt'> | null {
  if (!('method' in message) || message.method !== 'item/completed') return null;
  const params = inputRecord(message.params);
  const item = inputRecord(params?.item);
  if (
    typeof params?.threadId !== 'string' ||
    typeof params.turnId !== 'string' ||
    item?.type !== 'agentMessage' ||
    typeof item.text !== 'string'
  )
    return null;
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    kind: 'agent-message',
    phase: 'completed',
    payload: sanitizeEventPayload({ text: item.text }, maxBytes),
  };
}

function safeContentDisposition(name: string, inline: boolean): string {
  const encoded = encodeURIComponent(name).replaceAll("'", '%27');
  return `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encoded}`;
}

function redactAttachmentStorage(value: unknown, storageRoot: string): unknown {
  if (typeof value === 'string') {
    const variants = new Set([
      storageRoot,
      storageRoot.replaceAll('\\', '/'),
      storageRoot.replaceAll('/', '\\'),
    ]);
    let redacted = value;
    for (const variant of variants) redacted = redacted.replaceAll(variant, '[attachment-storage]');
    return redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redactAttachmentStorage(item, storageRoot));
  const record = inputRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, redactAttachmentStorage(item, storageRoot)]),
  );
}

function statusType(value: z.infer<typeof rpcThreadSchema>['status']): Thread['status'] {
  const raw = typeof value === 'string' ? value : value?.type;
  return raw === 'notLoaded' || raw === 'idle' || raw === 'active' || raw === 'systemError'
    ? raw
    : 'unknown';
}

function dateFromSeconds(value: number): string {
  return new Date(value * 1_000).toISOString();
}

function publicRateLimit(
  snapshot: z.infer<typeof upstreamRateLimitSchema>,
  fallbackLimitId?: string,
) {
  const window = (value: z.infer<typeof upstreamRateLimitWindowSchema> | null | undefined) =>
    value === null || value === undefined
      ? null
      : {
          usedPercent: value.usedPercent,
          windowDurationMins: value.windowDurationMins ?? null,
          resetsAt: value.resetsAt ?? null,
        };
  return accountRateLimitSchema.parse({
    limitId: snapshot.limitId ?? fallbackLimitId ?? null,
    limitName: snapshot.limitName ?? null,
    planType: snapshot.planType ?? null,
    primary: window(snapshot.primary),
    secondary: window(snapshot.secondary),
  });
}

function publicUsage(input: z.infer<typeof usageResponseSchema>) {
  return accountUsageSchema.parse({
    summary: {
      lifetimeTokens: input.summary.lifetimeTokens ?? null,
      currentStreakDays: input.summary.currentStreakDays ?? null,
      longestStreakDays: input.summary.longestStreakDays ?? null,
      peakDailyTokens: input.summary.peakDailyTokens ?? null,
      longestRunningTurnSec: input.summary.longestRunningTurnSec ?? null,
    },
    dailyUsageBuckets: input.dailyUsageBuckets ?? null,
  });
}

function mapThread(
  rpcThread: z.infer<typeof rpcThreadSchema>,
  projectId: string,
  archived: boolean,
  instructionSources: readonly string[] = [],
  responseModel?: string,
): Thread {
  return {
    id: rpcThread.id,
    projectId,
    name: rpcThread.name ?? null,
    preview: rpcThread.preview,
    model: responseModel ?? rpcThread.model ?? null,
    status: statusType(rpcThread.status),
    archived,
    instructionSources: [...instructionSources],
    createdAt: dateFromSeconds(rpcThread.createdAt),
    updatedAt: dateFromSeconds(rpcThread.updatedAt),
  };
}

function sandboxPolicy(preset: PermissionPreset, projectPath: string): Record<string, unknown> {
  if (preset === 'read-only') return { type: 'readOnly', networkAccess: true };
  if (preset === 'full-access') return { type: 'dangerFullAccess' };
  return {
    type: 'workspaceWrite',
    writableRoots: [projectPath],
    networkAccess: true,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseId(request: FastifyRequest): string {
  return idParamsSchema.parse(request.params).id;
}

function csrfGuard(auth: AuthService, request: FastifyRequest): AuthContext {
  const context = auth.authenticate(request);
  auth.assertOrigin(request);
  auth.assertCsrf(request, context);
  return context;
}

async function canonicalProjectPath(
  pathPolicy: ProjectPathPolicy,
  project: Pick<Project, 'path'>,
): Promise<string> {
  let canonical: string;
  try {
    canonical = await pathPolicy.canonicalize(project.path);
  } catch {
    throw new HttpError(409, 'PROJECT_PATH_NO_LONGER_ALLOWED');
  }
  if (canonical !== project.path) throw new HttpError(409, 'PROJECT_PATH_CHANGED');
  return canonical;
}

export async function buildServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const { config, repository, pathPolicy, appServer, attachmentStore } = dependencies;
  const app = Fastify({
    logger: false,
    bodyLimit: 128 * 1_024,
    trustProxy: (address) =>
      address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1',
  });
  const auth = new AuthService(config, repository);
  const sseListeners = new Map<string, Set<SseListener>>();
  const activeTurns = new Set<string>();
  const approvalGenerations = new Map<string, number>();
  const loadedThreadGenerations = new Map<string, number>();
  const historyHydrations = new Map<string, Promise<Thread>>();
  repository.markPendingIdempotencyUnknown();
  let pendingTurnStarts = 0;

  await app.register(cookie);
  app.addContentTypeParser(
    /^multipart\/form-data(?:;.*)?$/i,
    { parseAs: 'buffer', bodyLimit: MAX_ATTACHMENT_BYTES + 16_384 },
    (_request, body, done) => done(null, body),
  );

  const publish = (event: SafeEvent): void => {
    for (const listener of sseListeners.get(event.threadId) ?? []) listener(event);
  };

  const appendInteractionTerminal = (
    approval: Pick<PendingApproval, 'id' | 'threadId' | 'turnId' | 'method'>,
    status: 'accepted' | 'declined' | 'cancelled',
  ): SafeEvent => {
    const kind =
      approval.method === 'item/tool/requestUserInput'
        ? 'user-input'
        : approval.method === 'item/permissions/requestApproval'
          ? 'permission-approval'
          : 'approval';
    const key = kind === 'approval' ? 'approval' : 'request';
    const event = repository.appendEvent({
      threadId: approval.threadId,
      turnId: approval.turnId,
      kind,
      phase: status === 'accepted' ? 'completed' : 'failed',
      payload: { [key]: { id: approval.id, status } },
    });
    publish(event);
    return event;
  };

  for (const approval of repository.listUnfinishedApprovals()) {
    if (repository.cancelUnfinishedApproval(approval.id))
      appendInteractionTerminal(approval, 'cancelled');
  }

  const readThreadFromAppServer = async (
    existing: Thread,
    includeTurns: boolean,
  ): Promise<{ thread: Thread; turns: unknown }> => {
    const project = repository.getProject(existing.projectId);
    if (!project) throw new HttpError(409, 'THREAD_PROJECT_MISSING');
    const cwd = await canonicalProjectPath(pathPolicy, project);
    const result = threadResponseSchema.parse(
      await appServer.request('thread/read', { threadId: existing.id, includeTurns }),
    );
    if (result.thread.cwd !== cwd) throw new HttpError(502, 'APP_SERVER_CWD_MISMATCH');
    const thread = repository.upsertThread(
      mapThread(
        result.thread,
        project.id,
        existing.archived,
        existing.instructionSources,
        result.model,
      ),
    );
    return { thread, turns: result.thread.turns };
  };

  const hydrateThreadHistory = async (existing: Thread): Promise<Thread> => {
    if (repository.isThreadHistoryHydrated(existing.id)) return existing;
    const activeHydration = historyHydrations.get(existing.id);
    if (activeHydration) return activeHydration;
    const hydration = (async () => {
      if (repository.isThreadHistoryHydrated(existing.id))
        return repository.getThread(existing.id) ?? existing;
      const result = await readThreadFromAppServer(existing, true);
      const safeTurns = redactAttachmentStorage(result.turns, attachmentStore.root);
      for (const event of normalizeThreadHistory(existing.id, safeTurns, config.maxEventBytes)) {
        publish(repository.appendEvent(event));
      }
      repository.markThreadHistoryHydrated(existing.id);
      return result.thread;
    })();
    historyHydrations.set(existing.id, hydration);
    try {
      return await hydration;
    } finally {
      if (historyHydrations.get(existing.id) === hydration) historyHydrations.delete(existing.id);
    }
  };

  const persistInteractionRequest = (
    input: Omit<PendingApproval, 'id' | 'createdAt' | 'status'>,
    kind: 'user-input' | 'permission-approval',
    requestPayload: Record<string, unknown>,
  ): boolean => {
    const payload = sanitizeEventPayload(
      {
        request: {
          id: '00000000-0000-4000-8000-000000000000',
          ...requestPayload,
          status: 'pending',
        },
      },
      config.maxEventBytes,
    );
    if (payload.truncated === true || !('request' in payload)) return false;
    const persisted = repository.createApproval(input);
    approvalGenerations.set(persisted.id, appServer.generation);
    const request = payload.request as Record<string, unknown>;
    publish(
      repository.appendEvent({
        threadId: persisted.threadId,
        turnId: persisted.turnId,
        kind,
        phase: 'state',
        payload: { request: { ...request, id: persisted.id } },
      }),
    );
    return true;
  };

  const handlePermissionRequest = async (message: AppServerInbound): Promise<void> => {
    if (message.id === undefined) return;
    const requestGeneration = appServer.generation;
    const request = normalizePermissionRequest(message.params);
    if (!request) {
      appServer.respondError(message.id, -32602, 'Invalid permission request');
      return;
    }
    const thread = repository.getThread(request.threadId);
    const project = thread && repository.getProject(thread.projectId);
    if (!thread || !project) {
      appServer.respondError(message.id, -32602, 'Unregistered permission request');
      return;
    }
    try {
      const cwd = await canonicalProjectPath(pathPolicy, project);
      if (request.cwd !== cwd) throw new Error('PERMISSION_CWD_MISMATCH');
      const permissions = await validatePermissionProfile(request.permissions, cwd, pathPolicy);
      if (appServer.generation !== requestGeneration) return;
      if (
        !persistInteractionRequest(
          {
            threadId: request.threadId,
            turnId: request.turnId,
            rpcRequestId: message.id,
            method: message.method,
            summary: request.reason ?? 'Permission requested',
            details: {
              itemId: request.itemId,
              cwd,
              reason: request.reason,
              permissions,
            },
          },
          'permission-approval',
          {
            method: message.method,
            itemId: request.itemId,
            cwd,
            reason: request.reason,
            permissions,
          },
        )
      )
        throw new Error('PERMISSION_REQUEST_TOO_LARGE');
    } catch {
      if (appServer.generation === requestGeneration)
        appServer.respondError(message.id, -32602, 'Unsafe permission request');
    }
  };

  const onAppServerMessage = (message: AppServerInbound): void => {
    if (message.id !== undefined) {
      if (message.method === 'item/tool/requestUserInput') {
        const request = normalizeUserInputRequest(message.params);
        if (!request || !repository.getThread(request.threadId)) {
          appServer.respondError(message.id, -32602, 'Invalid user input request');
          return;
        }
        if (
          !persistInteractionRequest(
            {
              threadId: request.threadId,
              turnId: request.turnId,
              rpcRequestId: message.id,
              method: message.method,
              summary: 'User input requested',
              details: {
                itemId: request.itemId,
                isBlocking: request.isBlocking,
                questions: request.questions,
              },
            },
            'user-input',
            {
              method: message.method,
              itemId: request.itemId,
              isBlocking: request.isBlocking,
              questions: request.questions,
            },
          )
        )
          appServer.respondError(message.id, -32602, 'User input request too large');
        return;
      }
      if (message.method === 'item/permissions/requestApproval') {
        void handlePermissionRequest(message);
        return;
      }
      const approval = normalizeApproval(message.method, message.id, message.params);
      if (!approval || !repository.getThread(approval.threadId)) {
        appServer.respondError(message.id, -32601, 'Unsupported or unregistered approval request');
        return;
      }
      const persisted = repository.createApproval(approval);
      approvalGenerations.set(persisted.id, appServer.generation);
      const fullApprovalPayload = sanitizeEventPayload(
        { approval: persisted },
        config.maxEventBytes,
      );
      const approvalPayload =
        fullApprovalPayload.truncated === true
          ? sanitizeEventPayload(
              {
                approval: {
                  id: persisted.id,
                  threadId: persisted.threadId,
                  turnId: persisted.turnId,
                  method: persisted.method,
                  status: persisted.status,
                  createdAt: persisted.createdAt,
                  summary: 'Approval details truncated',
                },
              },
              config.maxEventBytes,
            )
          : fullApprovalPayload;
      const event = repository.appendEvent({
        threadId: persisted.threadId,
        turnId: persisted.turnId,
        kind: 'approval',
        phase: 'state',
        payload: approvalPayload,
      });
      publish(event);
      return;
    }
    // App-server echoes localImage and server-local file paths in userMessage lifecycle items.
    // The safe user event is authored below from browser text plus public attachment metadata.
    if (isUserMessageLifecycle(message)) return;
    // Delta fragments cannot be redacted safely in isolation because a private path may span messages.
    // Publish only completed/state snapshots after exact path redaction.
    const redactedMessage = redactAttachmentStorage(
      message,
      attachmentStore.root,
    ) as AppServerInbound;
    const normalized =
      completedAgentMessage(redactedMessage, config.maxEventBytes) ??
      normalizeNotification(redactedMessage, config.maxEventBytes);
    if (!normalized || !repository.getThread(normalized.threadId)) return;
    if (normalized.phase === 'delta') return;
    if (message.method === 'turn/started' && normalized.turnId)
      activeTurns.add(`${normalized.threadId}:${normalized.turnId}`);
    if (message.method === 'turn/completed' && normalized.turnId) {
      activeTurns.delete(`${normalized.threadId}:${normalized.turnId}`);
    }
    if (message.method === 'thread/archived')
      repository.setThreadArchived(normalized.threadId, true);
    if (message.method === 'thread/unarchived')
      repository.setThreadArchived(normalized.threadId, false);
    publish(repository.appendEvent(normalized));
  };
  const unsubscribe = appServer.subscribe(onAppServerMessage);

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      void reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof z.ZodError) {
      void reply
        .code(400)
        .send({ error: { code: 'INVALID_REQUEST', message: 'Request validation failed' } });
      return;
    }
    if ('statusCode' in error && error.statusCode === 413) {
      void reply
        .code(413)
        .send({ error: { code: 'ATTACHMENT_TOO_LARGE', message: 'Request failed' } });
      return;
    }
    const code = error.message === 'APP_SERVER_UNAVAILABLE' ? 503 : 500;
    void reply.code(code).send({
      error: {
        code: code === 503 ? 'APP_SERVER_UNAVAILABLE' : 'INTERNAL_ERROR',
        message: 'Request failed',
      },
    });
  });

  app.addHook('onReady', async () => appServer.start());
  app.addHook('onClose', async () => {
    unsubscribe();
    await appServer.stop();
    repository.close();
  });

  app.get('/api/health', (_request, reply) => {
    const ready = appServer.ready;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      appServerReady: ready,
      codexVersion: config.codexVersionPin,
    });
  });

  app.post('/api/auth/login', async (request, reply) => {
    auth.assertOrigin(request);
    const input = loginRequestSchema.parse(request.body);
    const result = await auth.login(input.username, input.password, request.ip);
    auth.setSessionCookie(reply, result.token, result.csrfToken, result.expiresAt);
    return {
      authenticated: true,
      username: config.username,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt,
    };
  });

  app.get('/api/auth/session', (request) => {
    const context = auth.authenticate(request);
    const csrfToken = request.cookies[`${config.cookieName}_csrf`];
    if (typeof csrfToken !== 'string') throw new HttpError(403, 'CSRF_REQUIRED');
    auth.assertCsrfToken(csrfToken, context);
    return {
      authenticated: true,
      username: config.username,
      csrfToken,
      expiresAt: context.expiresAt,
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const context = csrfGuard(auth, request);
    repository.revokeSession(context.sessionId);
    auth.clearSessionCookie(reply);
    repository.audit('auth.logout', 'succeeded');
    return { loggedOut: true };
  });

  app.get('/api/projects', (request) => {
    auth.authenticate(request);
    return { data: repository.listProjects() };
  });

  app.post('/api/projects', async (request, reply) => {
    csrfGuard(auth, request);
    const input = createProjectRequestSchema.parse(request.body);
    const canonicalPath = await pathPolicy.canonicalize(input.path);
    const project = repository.createProject({
      name: input.name,
      path: canonicalPath,
      defaultModel: input.defaultModel ?? null,
      defaultReasoningEffort: input.defaultReasoningEffort ?? null,
      defaultPermissionPreset: input.defaultPermissionPreset,
    });
    repository.audit('project.create', 'succeeded', { projectId: project.id });
    return reply.code(201).send({ data: project });
  });

  app.patch('/api/projects/:id', (request) => {
    csrfGuard(auth, request);
    const id = parseId(request);
    const parsed = projectPatchSchema.parse(request.body);
    const patch = {
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.defaultModel === undefined ? {} : { defaultModel: parsed.defaultModel }),
      ...(parsed.defaultReasoningEffort === undefined
        ? {}
        : { defaultReasoningEffort: parsed.defaultReasoningEffort }),
      ...(parsed.defaultPermissionPreset === undefined
        ? {}
        : { defaultPermissionPreset: parsed.defaultPermissionPreset }),
    };
    const project = repository.updateProject(id, patch);
    if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND');
    repository.audit('project.update', 'succeeded', { projectId: id });
    return { data: project };
  });

  app.delete('/api/projects/:id', async (request, reply) => {
    csrfGuard(auth, request);
    const id = parseId(request);
    if (!repository.getProject(id)) throw new HttpError(404, 'PROJECT_NOT_FOUND');
    if (!repository.deleteProject(id)) throw new HttpError(409, 'PROJECT_HAS_THREADS');
    repository.audit('project.delete', 'succeeded', { projectId: id });
    return reply.code(204).send();
  });

  app.get('/api/models', async (request) => {
    auth.authenticate(request);
    const result = modelResponseSchema.parse(
      await appServer.request('model/list', { includeHidden: false, limit: 100 }),
    );
    return {
      data: result.data.map((model) =>
        modelOptionSchema.parse({
          id: model.model,
          displayName: model.displayName,
          isDefault: model.isDefault,
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
            reasoningEffort: effort.reasoningEffort,
            description: effort.description ?? null,
          })),
        }),
      ),
    };
  });

  app.get('/api/threads', async (request) => {
    auth.authenticate(request);
    const raw = z
      .object({
        projectId: z.string(),
        archived: z.string().optional(),
        cursor: z.string().optional(),
      })
      .parse(request.query);
    const query = threadListQuerySchema.parse({
      projectId: raw.projectId,
      archived: raw.archived === 'true',
      ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }),
    });
    const project = repository.getProject(query.projectId);
    if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND');
    const pageSchema = z
      .object({ data: z.array(rpcThreadSchema), nextCursor: z.string().nullable().optional() })
      .passthrough();
    let cursor = query.cursor ?? null;
    const seenCursors = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const cwd = await canonicalProjectPath(pathPolicy, project);
      const remote = pageSchema.parse(
        await appServer.request('thread/list', {
          cwd,
          archived: query.archived,
          cursor,
          limit: 100,
          sourceKinds: ['cli', 'vscode', 'appServer', 'exec'],
        }),
      );
      for (const rpcThread of remote.data) {
        if (rpcThread.cwd !== cwd) throw new HttpError(502, 'APP_SERVER_CWD_MISMATCH');
        const existing = repository.getThread(rpcThread.id);
        repository.upsertThread(
          mapThread(rpcThread, project.id, query.archived, existing?.instructionSources ?? []),
        );
      }
      const nextCursor = remote.nextCursor ?? null;
      if (nextCursor === null) {
        cursor = null;
        break;
      }
      if (seenCursors.has(nextCursor)) throw new HttpError(502, 'APP_SERVER_CURSOR_LOOP');
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (page === 99) throw new HttpError(502, 'APP_SERVER_PAGINATION_LIMIT');
    }
    return {
      data: repository.listThreads(project.id, query.archived),
      nextCursor: cursor,
    };
  });

  app.post('/api/threads', async (request, reply) => {
    csrfGuard(auth, request);
    const input = startThreadRequestSchema.parse(request.body);
    const project = repository.getProject(input.projectId);
    if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND');
    const cwd = await canonicalProjectPath(pathPolicy, project);
    const preset = input.permissionPreset ?? project.defaultPermissionPreset;
    const reasoningEffort = input.reasoningEffort ?? project.defaultReasoningEffort;
    const result = threadResponseSchema.parse(
      await appServer.request('thread/start', {
        cwd,
        model: input.model ?? project.defaultModel,
        approvalPolicy: input.approvalPolicy,
        approvalsReviewer: 'user',
        sandbox: preset === 'full-access' ? 'danger-full-access' : preset,
        config:
          reasoningEffort === null || reasoningEffort === undefined
            ? null
            : { model_reasoning_effort: reasoningEffort },
        ephemeral: false,
        serviceName: 'codex-web-ui',
      }),
    );
    if (result.thread.cwd !== cwd) throw new HttpError(502, 'APP_SERVER_CWD_MISMATCH');
    const thread = repository.upsertThread(
      mapThread(result.thread, project.id, false, result.instructionSources, result.model),
    );
    repository.markThreadHistoryHydrated(thread.id);
    loadedThreadGenerations.set(thread.id, appServer.generation);
    repository.audit('thread.start', 'succeeded', {
      projectId: project.id,
      threadId: thread.id,
      permissionPreset: preset,
    });
    return reply.code(201).send({ data: thread });
  });

  app.get('/api/threads/:id', async (request) => {
    auth.authenticate(request);
    const id = parseId(request);
    const existing = repository.getThread(id);
    if (!existing) throw new HttpError(404, 'THREAD_NOT_FOUND');
    let thread = existing;
    if (!repository.isThreadHistoryHydrated(id)) {
      thread = await hydrateThreadHistory(existing);
    } else if (loadedThreadGenerations.get(id) !== appServer.generation) {
      try {
        thread = (await readThreadFromAppServer(existing, false)).thread;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        repository.audit('thread.refresh', 'failed', { threadId: id });
      }
    }
    return { data: thread, events: repository.listEvents(id, 0) };
  });

  app.patch('/api/threads/:id', async (request) => {
    csrfGuard(auth, request);
    const id = parseId(request);
    const existing = repository.getThread(id);
    if (!existing) throw new HttpError(404, 'THREAD_NOT_FOUND');
    const input = threadPatchSchema.parse(request.body);
    await appServer.request('thread/name/set', { threadId: id, name: input.name });
    const updated = repository.upsertThread({
      ...existing,
      name: input.name,
      updatedAt: new Date().toISOString(),
    });
    return { data: updated };
  });

  const setArchive = async (
    request: FastifyRequest,
    archived: boolean,
  ): Promise<{ data: Thread }> => {
    csrfGuard(auth, request);
    const id = parseId(request);
    const thread = repository.getThread(id);
    if (!thread) throw new HttpError(404, 'THREAD_NOT_FOUND');
    if (thread.archived !== archived) {
      await appServer.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: id });
    }
    const updated = repository.setThreadArchived(id, archived)!;
    repository.audit(archived ? 'thread.archive' : 'thread.unarchive', 'succeeded', {
      threadId: id,
    });
    return { data: updated };
  };
  app.post('/api/threads/:id/archive', async (request) => setArchive(request, true));
  app.post('/api/threads/:id/unarchive', async (request) => setArchive(request, false));

  app.post(
    '/api/threads/:id/attachments',
    { bodyLimit: MAX_ATTACHMENT_BYTES + 16_384 },
    async (request, reply) => {
      csrfGuard(auth, request);
      const id = parseId(request);
      const thread = repository.getThread(id);
      if (!thread) throw new HttpError(404, 'THREAD_NOT_FOUND');
      if (thread.archived) throw new HttpError(409, 'THREAD_ARCHIVED');
      const project = repository.getProject(thread.projectId);
      if (!project) throw new HttpError(409, 'THREAD_PROJECT_MISSING');
      if (!Buffer.isBuffer(request.body)) throw new HttpError(400, 'MULTIPART_FILE_REQUIRED');
      const contentType = request.headers['content-type'];
      if (typeof contentType !== 'string') throw new HttpError(415, 'ATTACHMENT_TYPE_REQUIRED');
      const upload = parseSingleFileMultipart(contentType, request.body);
      const record = await attachmentStore.withThreadLock(id, async () => {
        if (
          repository.attachmentBytesForThread(id) + upload.bytes.length >
          MAX_THREAD_ATTACHMENT_BYTES
        )
          throw new HttpError(413, 'THREAD_ATTACHMENT_STORAGE_EXHAUSTED');
        const stored = await attachmentStore.write(project.id, id, upload.name, upload.bytes);
        try {
          return repository.createAttachment({
            ...stored,
            threadId: id,
            name: upload.name,
            mimeType: upload.mimeType,
            kind: upload.kind,
            size: upload.bytes.length,
          });
        } catch (error) {
          await attachmentStore.remove(project.id, id, stored.storageName);
          throw error;
        }
      });
      repository.audit('attachment.upload', 'succeeded', {
        threadId: id,
        attachmentId: record.id,
        kind: record.kind,
        size: record.size,
      });
      return reply.code(201).send({ data: publicAttachment(record) });
    },
  );

  app.get('/api/threads/:id/attachments', (request) => {
    auth.authenticate(request);
    const id = parseId(request);
    if (!repository.getThread(id)) throw new HttpError(404, 'THREAD_NOT_FOUND');
    return { data: repository.listAttachments(id).map(publicAttachment) };
  });

  app.get('/api/threads/:id/attachments/:attachmentId/content', async (request, reply) => {
    auth.authenticate(request);
    const params = attachmentParamsSchema.parse(request.params);
    const thread = repository.getThread(params.id);
    if (!thread) throw new HttpError(404, 'THREAD_NOT_FOUND');
    const record = repository.getAttachment(params.attachmentId);
    if (!record || record.threadId !== params.id) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND');
    const project = repository.getProject(thread.projectId);
    if (!project) throw new HttpError(409, 'THREAD_PROJECT_MISSING');
    let body: Buffer;
    try {
      body = await attachmentStore.read(project.id, thread.id, record.storageName);
    } catch {
      throw new HttpError(410, 'ATTACHMENT_CONTENT_MISSING');
    }
    const inline = record.kind === 'image';
    reply.header('Content-Type', record.mimeType);
    reply.header('Content-Length', String(body.length));
    reply.header('Content-Disposition', safeContentDisposition(record.name, inline));
    return reply.send(body);
  });

  app.delete('/api/threads/:id/attachments/:attachmentId', async (request, reply) => {
    csrfGuard(auth, request);
    const params = attachmentParamsSchema.parse(request.params);
    const thread = repository.getThread(params.id);
    if (!thread) throw new HttpError(404, 'THREAD_NOT_FOUND');
    const project = repository.getProject(thread.projectId);
    if (!project) throw new HttpError(409, 'THREAD_PROJECT_MISSING');
    await attachmentStore.withThreadLock(params.id, async () => {
      const existing = repository.getAttachment(params.attachmentId);
      if (!existing || existing.threadId !== params.id)
        throw new HttpError(404, 'ATTACHMENT_NOT_FOUND');
      if (existing.turnId !== null) throw new HttpError(409, 'ATTACHMENT_ALREADY_SENT');
      const deletionClaim = `deleting:${params.attachmentId}`;
      if (!repository.claimAttachmentDeletion(params.attachmentId, params.id, deletionClaim))
        throw new HttpError(409, 'ATTACHMENT_ALREADY_SENT');
      try {
        await attachmentStore.remove(project.id, params.id, existing.storageName);
      } catch (error) {
        repository.releaseAttachmentDeletion(params.attachmentId, params.id, deletionClaim);
        throw error;
      }
      if (!repository.completeAttachmentDeletion(params.attachmentId, params.id, deletionClaim))
        throw new HttpError(409, 'ATTACHMENT_DELETE_OUTCOME_UNKNOWN');
    });
    repository.audit('attachment.delete', 'succeeded', {
      threadId: params.id,
      attachmentId: params.attachmentId,
    });
    return reply.code(204).send();
  });

  app.post('/api/threads/:id/turns', async (request, reply) => {
    csrfGuard(auth, request);
    const id = parseId(request);
    const input = startTurnRequestSchema.parse(request.body);
    const thread = repository.getThread(id);
    if (!thread) throw new HttpError(404, 'THREAD_NOT_FOUND');
    if (thread.archived) throw new HttpError(409, 'THREAD_ARCHIVED');
    const project = repository.getProject(thread.projectId);
    if (!project) throw new HttpError(409, 'THREAD_PROJECT_MISSING');
    if (new Set(input.attachmentIds).size !== input.attachmentIds.length)
      throw new HttpError(400, 'ATTACHMENT_IDS_DUPLICATED');
    const attachments = input.attachmentIds.map((attachmentId) => {
      const attachment = repository.getAttachment(attachmentId);
      if (!attachment || attachment.threadId !== id)
        throw new HttpError(400, 'ATTACHMENT_NOT_AVAILABLE');
      return attachment;
    });
    const hash = requestHash(input);
    const operation = `turn:${id}`;
    const reservation = repository.reserveIdempotent(operation, input.idempotencyKey, hash);
    if (!reservation.reserved) {
      if (reservation.record.requestHash !== hash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT');
      if (reservation.record.state === 'completed')
        return reply.code(200).send(reservation.record.response);
      throw new HttpError(
        409,
        reservation.record.state === 'pending'
          ? 'IDEMPOTENCY_PENDING'
          : 'IDEMPOTENCY_OUTCOME_UNKNOWN',
      );
    }
    if (attachments.some((attachment) => attachment.turnId !== null)) {
      repository.releasePendingIdempotent(operation, input.idempotencyKey, hash);
      throw new HttpError(409, 'ATTACHMENT_ALREADY_SENT');
    }
    if (activeTurns.size + pendingTurnStarts >= config.maxConcurrentTurns) {
      repository.releasePendingIdempotent(operation, input.idempotencyKey, hash);
      throw new HttpError(429, 'TURN_CAPACITY_EXHAUSTED');
    }
    pendingTurnStarts += 1;
    const preset = input.permissionPreset ?? project.defaultPermissionPreset;
    const attachmentClaim = `pending:${input.idempotencyKey}`;
    if (!repository.claimAttachments(id, input.attachmentIds, attachmentClaim)) {
      pendingTurnStarts -= 1;
      repository.releasePendingIdempotent(operation, input.idempotencyKey, hash);
      throw new HttpError(409, 'ATTACHMENT_NOT_AVAILABLE');
    }
    let result: z.infer<typeof turnResponseSchema>;
    let turnStartIssued = false;
    try {
      const resumeCwd = await canonicalProjectPath(pathPolicy, project);
      if (loadedThreadGenerations.get(id) !== appServer.generation) {
        if (!repository.isThreadHistoryHydrated(id)) await hydrateThreadHistory(thread);
        const resumed = threadResponseSchema.parse(
          await appServer.request('thread/resume', {
            threadId: id,
            cwd: resumeCwd,
            excludeTurns: true,
          }),
        );
        if (resumed.thread.cwd !== resumeCwd) throw new HttpError(502, 'APP_SERVER_CWD_MISMATCH');
        loadedThreadGenerations.set(id, appServer.generation);
      }
      const turnCwd = await canonicalProjectPath(pathPolicy, project);
      const appInput: Record<string, unknown>[] = [];
      const fileReferences = attachments
        .filter((attachment) => attachment.kind === 'file')
        .map(
          (attachment) =>
            `${attachment.name}: ${attachmentStore.localPath(project.id, id, attachment.storageName)}`,
        );
      const appText =
        fileReferences.length === 0
          ? input.text
          : `${input.text}${input.text.length > 0 ? '\n\n' : ''}[Codex Web attachment references (server-local; do not repeat paths):\n${fileReferences.join('\n')}\n]`;
      if (appText.length > 0) appInput.push({ type: 'text', text: appText, text_elements: [] });
      for (const attachment of attachments) {
        if (attachment.kind === 'image')
          appInput.push({
            type: 'localImage',
            path: attachmentStore.localPath(project.id, id, attachment.storageName),
          });
      }
      turnStartIssued = true;
      result = turnResponseSchema.parse(
        await appServer.request('turn/start', {
          threadId: id,
          clientUserMessageId: input.idempotencyKey,
          input: appInput,
          cwd: turnCwd,
          model: input.model ?? project.defaultModel,
          effort: input.reasoningEffort ?? project.defaultReasoningEffort,
          approvalPolicy: input.approvalPolicy,
          approvalsReviewer: 'user',
          sandboxPolicy: sandboxPolicy(preset, turnCwd),
        }),
      );
      activeTurns.add(`${id}:${result.turn.id}`);
    } catch (error) {
      if (turnStartIssued) repository.markIdempotentUnknown(operation, input.idempotencyKey, hash);
      else {
        repository.releasePendingIdempotent(operation, input.idempotencyKey, hash);
        repository.releaseAttachmentClaims(id, attachmentClaim);
      }
      throw error;
    } finally {
      pendingTurnStarts -= 1;
    }
    const response = { data: { turnId: result.turn.id } };
    if (attachments.length > 0)
      repository.finalizeAttachmentClaims(id, attachmentClaim, result.turn.id);
    if (!repository.completeIdempotent(operation, input.idempotencyKey, hash, response))
      throw new HttpError(409, 'IDEMPOTENCY_OUTCOME_UNKNOWN');
    const userEvent = repository.appendEvent({
      threadId: id,
      turnId: result.turn.id,
      kind: 'user-message',
      phase: 'completed',
      payload: sanitizeEventPayload(
        { text: input.text, attachments: attachments.map(publicAttachment) },
        config.maxEventBytes,
      ),
    });
    publish(userEvent);
    repository.audit('turn.start', 'succeeded', {
      threadId: id,
      turnId: result.turn.id,
      permissionPreset: preset,
    });
    return reply.code(202).send(response);
  });

  app.post('/api/threads/:id/steer', async (request, reply) => {
    csrfGuard(auth, request);
    const id = parseId(request);
    if (!repository.getThread(id)) throw new HttpError(404, 'THREAD_NOT_FOUND');
    const input = steerTurnRequestSchema.parse(request.body);
    const result = z.object({ turnId: z.string() }).parse(
      await appServer.request('turn/steer', {
        threadId: id,
        expectedTurnId: input.expectedTurnId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
      }),
    );
    repository.audit('turn.steer', 'succeeded', { threadId: id, turnId: result.turnId });
    return reply.code(202).send({ data: result });
  });

  app.post('/api/threads/:id/interrupt', async (request) => {
    csrfGuard(auth, request);
    const id = parseId(request);
    if (!repository.getThread(id)) throw new HttpError(404, 'THREAD_NOT_FOUND');
    const input = interruptBodySchema.parse(request.body);
    await appServer.request('turn/interrupt', { threadId: id, turnId: input.turnId });
    activeTurns.delete(`${id}:${input.turnId}`);
    repository.audit('turn.interrupt', 'succeeded', { threadId: id, turnId: input.turnId });
    return { data: { interrupted: true } };
  });

  app.post('/api/approvals/:id/resolve', (request) => {
    csrfGuard(auth, request);
    const id = parseId(request);
    const input = resolveApprovalRequestSchema.parse(request.body);
    const approval = repository.getApproval(id);
    if (!approval) throw new HttpError(404, 'APPROVAL_NOT_FOUND');
    if (
      !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(
        approval.method,
      )
    )
      throw new HttpError(404, 'APPROVAL_NOT_FOUND');
    if (approvalGenerations.get(id) !== appServer.generation)
      throw new HttpError(409, 'APPROVAL_NO_LONGER_ACTIVE');
    if (approval.status !== 'pending') throw new HttpError(409, 'APPROVAL_ALREADY_RESOLVED');
    const status =
      input.decision === 'decline'
        ? 'declined'
        : input.decision === 'cancel'
          ? 'cancelled'
          : 'accepted';
    if (!repository.claimApproval(id)) throw new HttpError(409, 'APPROVAL_ALREADY_RESOLVED');
    approvalGenerations.delete(id);
    try {
      appServer.respond(approval.rpcRequestId, { decision: input.decision });
    } catch (error) {
      repository.finalizeApproval(id, 'cancelled');
      appendInteractionTerminal(approval, 'cancelled');
      repository.audit('approval.resolve', 'write_failed', { approvalId: id });
      throw error;
    }
    if (!repository.finalizeApproval(id, status))
      throw new HttpError(409, 'APPROVAL_RESOLUTION_UNKNOWN');
    appendInteractionTerminal(approval, status);
    repository.audit('approval.resolve', 'succeeded', { approvalId: id, decision: input.decision });
    return { data: { ...approval, status } };
  });

  app.post('/api/user-input-requests/:id/resolve', (request) => {
    csrfGuard(auth, request);
    const id = parseId(request);
    const input = resolveUserInputRequestSchema.parse(request.body);
    const approval = repository.getApproval(id);
    if (!approval || approval.method !== 'item/tool/requestUserInput')
      throw new HttpError(404, 'USER_INPUT_REQUEST_NOT_FOUND');
    if (approvalGenerations.get(id) !== appServer.generation)
      throw new HttpError(409, 'USER_INPUT_REQUEST_NO_LONGER_ACTIVE');
    if (approval.status !== 'pending')
      throw new HttpError(409, 'USER_INPUT_REQUEST_ALREADY_RESOLVED');
    const details = storedUserInputDetailsSchema.parse(approval.details);
    if (!validateUserInputAnswers(details, input.answers))
      throw new HttpError(400, 'USER_INPUT_ANSWERS_INVALID');
    if (!repository.claimApproval(id))
      throw new HttpError(409, 'USER_INPUT_REQUEST_ALREADY_RESOLVED');
    approvalGenerations.delete(id);
    try {
      appServer.respond(approval.rpcRequestId, { answers: input.answers });
    } catch (error) {
      repository.finalizeApproval(id, 'cancelled');
      appendInteractionTerminal(approval, 'cancelled');
      repository.audit('user-input.resolve', 'write_failed', { requestId: id });
      throw error;
    }
    if (!repository.finalizeApproval(id, 'accepted'))
      throw new HttpError(409, 'USER_INPUT_RESOLUTION_UNKNOWN');
    appendInteractionTerminal(approval, 'accepted');
    repository.audit('user-input.resolve', 'succeeded', { requestId: id });
    return { data: { id, status: 'accepted' } };
  });

  app.post('/api/permission-requests/:id/resolve', async (request) => {
    csrfGuard(auth, request);
    const id = parseId(request);
    const input = resolvePermissionRequestSchema.parse(request.body);
    const approval = repository.getApproval(id);
    if (!approval || approval.method !== 'item/permissions/requestApproval')
      throw new HttpError(404, 'PERMISSION_REQUEST_NOT_FOUND');
    if (approvalGenerations.get(id) !== appServer.generation)
      throw new HttpError(409, 'PERMISSION_REQUEST_NO_LONGER_ACTIVE');
    if (approval.status !== 'pending')
      throw new HttpError(409, 'PERMISSION_REQUEST_ALREADY_RESOLVED');
    const details = storedPermissionDetailsSchema.parse(approval.details);
    const thread = repository.getThread(approval.threadId);
    const project = thread && repository.getProject(thread.projectId);
    if (!thread || !project) throw new HttpError(409, 'PERMISSION_REQUEST_NO_LONGER_SAFE');
    const cwd = await canonicalProjectPath(pathPolicy, project);
    if (cwd !== details.cwd) throw new HttpError(409, 'PERMISSION_REQUEST_NO_LONGER_SAFE');
    let permissions: Record<string, unknown>;
    try {
      permissions = await validatePermissionProfile(details.permissions, cwd, pathPolicy);
    } catch {
      throw new HttpError(409, 'PERMISSION_REQUEST_NO_LONGER_SAFE');
    }
    if (JSON.stringify(permissions) !== JSON.stringify(details.permissions))
      throw new HttpError(409, 'PERMISSION_REQUEST_NO_LONGER_SAFE');
    if (approvalGenerations.get(id) !== appServer.generation)
      throw new HttpError(409, 'PERMISSION_REQUEST_NO_LONGER_ACTIVE');
    const status = input.decision === 'grant' ? 'accepted' : 'declined';
    if (!repository.claimApproval(id))
      throw new HttpError(409, 'PERMISSION_REQUEST_ALREADY_RESOLVED');
    approvalGenerations.delete(id);
    try {
      appServer.respond(approval.rpcRequestId, {
        permissions: input.decision === 'grant' ? permissions : {},
        scope: 'turn',
      });
    } catch (error) {
      repository.finalizeApproval(id, 'cancelled');
      appendInteractionTerminal(approval, 'cancelled');
      repository.audit('permission.resolve', 'write_failed', { requestId: id });
      throw error;
    }
    if (!repository.finalizeApproval(id, status))
      throw new HttpError(409, 'PERMISSION_RESOLUTION_UNKNOWN');
    appendInteractionTerminal(approval, status);
    repository.audit('permission.resolve', 'succeeded', {
      requestId: id,
      decision: input.decision,
      scope: 'turn',
    });
    return { data: { id, status } };
  });

  app.get('/api/threads/:id/events', async (request, reply) => {
    auth.authenticate(request);
    const id = parseId(request);
    const existing = repository.getThread(id);
    if (!existing) throw new HttpError(404, 'THREAD_NOT_FOUND');
    if (!repository.isThreadHistoryHydrated(id)) await hydrateThreadHistory(existing);
    const query = z.object({ after: eventCursorSchema.optional() }).parse(request.query);
    const header = request.headers['last-event-id'];
    const headerAfter =
      typeof header === 'string' && /^\d+$/.test(header)
        ? eventCursorSchema.parse(header)
        : undefined;
    const afterId = Math.max(query.after ?? 0, headerAfter ?? 0);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const listeners = sseListeners.get(id) ?? new Set<SseListener>();
    const highWater = repository.eventHighWater(id);
    const delivery = createSseDelivery(reply.raw, highWater);
    const writeLive = (event: SafeEvent): void => delivery.deliverLive(event);
    listeners.add(writeLive);
    sseListeners.set(id, listeners);
    const connectionTimers: { keepalive?: NodeJS.Timeout } = {};
    request.raw.once('close', () => {
      if (connectionTimers.keepalive) clearInterval(connectionTimers.keepalive);
      delivery.markClosed();
      listeners.delete(writeLive);
      if (listeners.size === 0) sseListeners.delete(id);
    });
    let cursor = afterId;
    while (cursor < highWater) {
      const page = repository.listEventPage(id, cursor, highWater);
      if (page.length === 0) break;
      for (const event of page) {
        if (!(await delivery.writeReplay(event))) break;
      }
      if (delivery.closed) break;
      cursor = page.at(-1)!.id;
    }
    await delivery.finishReplay();
    if (delivery.closed) return;
    connectionTimers.keepalive = setInterval(() => delivery.deliverComment('keepalive'), 15_000);
  });

  app.get('/api/system/capabilities', async (request) => {
    auth.authenticate(request);
    const projectPaths = await Promise.all(
      repository.listProjects().map(async (project) => canonicalProjectPath(pathPolicy, project)),
    );
    const [accountRaw, skillsRaw] = await Promise.all([
      appServer.request('account/read', { refreshToken: false }),
      appServer.request('skills/list', { cwds: projectPaths, forceReload: false }),
    ]);
    const account = accountResponseSchema.parse(accountRaw);
    const skills = skillsResponseSchema.parse(skillsRaw);
    if (skills.data.some((entry) => !projectPaths.includes(entry.cwd)))
      throw new HttpError(502, 'APP_SERVER_CWD_MISMATCH');
    const warnings: string[] = [];
    let rateLimits: z.infer<typeof accountRateLimitSchema>[] | null = null;
    let usage: z.infer<typeof accountUsageSchema> | null = null;
    const [rateLimitsResult, usageResult] = await Promise.allSettled([
      appServer.request('account/rateLimits/read', null),
      appServer.request('account/usage/read', null),
    ]);
    if (rateLimitsResult.status === 'fulfilled') {
      try {
        const parsed = rateLimitsResponseSchema.parse(rateLimitsResult.value);
        const buckets = parsed.rateLimitsByLimitId
          ? Object.entries(parsed.rateLimitsByLimitId).sort(([left], [right]) =>
              left.localeCompare(right),
            )
          : [];
        rateLimits =
          buckets.length > 0
            ? buckets.map(([limitId, snapshot]) => publicRateLimit(snapshot, limitId))
            : [publicRateLimit(parsed.rateLimits)];
      } catch {
        warnings.push('Codex rate limits are unavailable.');
      }
    } else {
      warnings.push('Codex rate limits are unavailable.');
    }
    if (usageResult.status === 'fulfilled') {
      try {
        usage = publicUsage(usageResponseSchema.parse(usageResult.value));
      } catch {
        warnings.push('Codex account usage is unavailable.');
      }
    } else {
      warnings.push('Codex account usage is unavailable.');
    }
    if (skills.data.some((entry) => entry.errors.length > 0))
      warnings.push('One or more project skill scans reported errors.');
    const names = new Set(skills.data.flatMap((entry) => entry.skills.map((skill) => skill.name)));
    for (const required of [
      'multi-agent-orchestrator',
      'project-change-workflow',
      'systematic-debugging',
    ]) {
      if (!names.has(required)) warnings.push(`Required project skill is missing: ${required}`);
    }
    return capabilitySchema.parse({
      codexVersion: config.codexVersionPin,
      authenticated: account.account !== null,
      appServerReady: appServer.ready,
      projectRoots: pathPolicy.roots,
      skills: skills.data.flatMap((entry) =>
        entry.skills.map((skill) => ({
          name: skill.name,
          path: skill.path,
          enabled: skill.enabled,
        })),
      ),
      rateLimits,
      usage,
      warnings,
    });
  });

  return app;
}
