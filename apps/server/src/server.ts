import {
  accountRateLimitSchema,
  accountUsageSchema,
  applyCodexUpdateRequestSchema,
  attachmentSchema,
  capabilitySchema,
  codexAccountLoginSchema,
  codexAccountSchema,
  codexUpdateSnapshotSchema,
  codexVersionDiscoverySchema,
  createProjectRequestSchema,
  loginRequestSchema,
  modelOptionSchema,
  resolvePermissionRequestSchema,
  resolveApprovalRequestSchema,
  resolveUserInputRequestSchema,
  resourceLimitSnapshotSchema,
  pushSubscriptionSchema,
  pushSubscriptionStatusRequestSchema,
  startThreadRequestSchema,
  startTurnRequestSchema,
  startTurnResultSchema,
  steerTurnRequestSchema,
  threadUsageSchema,
  threadListQuerySchema,
  updateRuntimePreferencesRequestSchema,
  updateResourceLimitsRequestSchema,
  applyResourceLimitsRequestSchema,
  userInputQuestionSchema,
  type PermissionPreset,
  type Attachment,
  type CodexAccount,
  type CodexAccountLogin,
  type CodexUpdateSnapshot,
  type PendingApproval,
  type Project,
  type ResourceLimitSnapshot,
  type SafeEvent,
  type Subagent,
  type Thread,
  type TurnNavigationEntry,
  type QueuedTurn,
  type PushSubscriptionInput,
} from '@codex-web/contracts';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, lstatSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { AppServerClient, AppServerInbound, AppServerLifecycleEvent } from './app-server.js';
import { CodexUpdateBrokerError, type CodexUpdateBroker } from './codex-update-broker.js';
import type { CodexVersionChecker } from './codex-version-checker.js';
import {
  MAX_TRANSCRIPTION_BYTES,
  MAX_TRANSCRIPTION_DURATION_SECONDS,
  parseAudioMultipart,
  type AudioTranscriptionClient,
} from './audio-transcription.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_THREAD_ATTACHMENT_BYTES,
  type AttachmentStore,
  parseSingleFileMultipart,
} from './attachment-store.js';
import { AuthService, HttpError, type AuthContext } from './auth.js';
import type { ServerConfig } from './config.js';
import {
  PushStorageLimitError,
  TurnQueueStorageLimitError,
  type AttachmentRecord,
  type QueuedTurnRecord,
  type SqliteRepository,
} from './database.js';
import {
  normalizeApproval,
  normalizeNotification,
  sanitizeEventPayload,
} from './event-normalizer.js';
import {
  normalizeThreadHistory,
  normalizeTurnNavigation,
  normalizeTurnNavigationLabel,
} from './history-normalizer.js';
import {
  normalizePermissionRequest,
  normalizeUserInputRequest,
  validatePermissionProfile,
  validateUserInputAnswers,
} from './interaction-normalizer.js';
import type { ProjectPathPolicy } from './path-policy.js';
import { ProjectPathBrokerError } from './project-path-broker.js';
import {
  PushNotificationDispatcher,
  isAllowedPushEndpoint,
  type PushNotificationPayload,
  type PushSender,
} from './push-notifications.js';
import {
  ResourceBrokerError,
  type BrokerResourceSnapshot,
  type ResourceBroker,
} from './resource-broker.js';
import { createSseDelivery } from './sse.js';
import { normalizeSubagentNotification } from './subagents.js';

const idParamsSchema = z.object({ id: z.string().min(1).max(200) });
const attachmentParamsSchema = z.object({
  id: z.string().min(1).max(200),
  attachmentId: z.string().uuid(),
});
const projectFileQuerySchema = z.object({ path: z.string().min(1).max(4_096) });
const MAX_PROJECT_FILE_DOWNLOAD_BYTES = 100 * 1_024 * 1_024;
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
const threadStatusChangedSchema = z.object({
  threadId: z.string().min(1),
  status: z.object({ type: z.enum(['notLoaded', 'idle', 'active', 'systemError']) }).passthrough(),
});
const threadNameUpdatedSchema = z.object({
  threadId: z.string().min(1),
  threadName: z.string().nullable().optional(),
});
const eventCursorSchema = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const TRANSCRIPTION_RATE_LIMIT = 10;
const TRANSCRIPTION_RATE_WINDOW_MS = 10 * 60 * 1_000;
const TRANSCRIPTION_IDEMPOTENCY_TTL_MS = 10 * 60 * 1_000;
const MAX_TRANSCRIPTION_IDEMPOTENCY_ENTRIES = 200;
const transcriptionIdempotencyKeySchema = z.string().uuid();
const CODEX_ACCOUNT_LOGIN_TTL_MS = 15 * 60 * 1_000;
const codexAccountLoginRequestSchema = z.object({ type: z.literal('chatgptDeviceCode') }).strict();
const accountLoginIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim());
const upstreamAccountLoginResponseSchema = z
  .object({
    type: z.literal('chatgptDeviceCode'),
    loginId: accountLoginIdSchema,
    userCode: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9-]+$/),
    verificationUrl: z
      .string()
      .url()
      .max(2_048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.origin === 'https://auth.openai.com' &&
            url.username.length === 0 &&
            url.password.length === 0 &&
            url.pathname === '/codex/device' &&
            url.search.length === 0 &&
            url.hash.length === 0
          );
        } catch {
          return false;
        }
      }),
  })
  .passthrough();
const accountLoginCompletedSchema = z
  .object({
    loginId: accountLoginIdSchema.nullable().optional(),
    success: z.boolean(),
  })
  .passthrough();
const accountLoginCancelResponseSchema = z
  .object({ status: z.enum(['canceled', 'notFound']) })
  .passthrough();

const requireConfirmedAccountLoginCancellation = (response: unknown): void => {
  const parsed = accountLoginCancelResponseSchema.parse(response);
  if (parsed.status !== 'canceled')
    throw new HttpError(
      409,
      'CODEX_ACCOUNT_LOGIN_CANCEL_UNCONFIRMED',
      'Codex did not confirm account login cancellation',
    );
};

interface TranscriptionIdempotencyEntry {
  readonly requestHash: string;
  readonly expiresAt: number;
  readonly result: Promise<{ text: string }>;
}

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

const upstreamThreadUsageGroupSchema = z.object({
  inputTokens: nullableUsageIntegerSchema.optional(),
  cachedInputTokens: nullableUsageIntegerSchema.optional(),
  netNewInputTokens: nullableUsageIntegerSchema.optional(),
  outputTokens: nullableUsageIntegerSchema.optional(),
  totalTokens: nullableUsageIntegerSchema.optional(),
});

const threadUsageResponseSchema = z.object({
  threadUsage: z
    .object({
      threadId: z.string().min(1).max(200),
      groups: z.array(upstreamThreadUsageGroupSchema.passthrough()).max(1_000),
    })
    .passthrough()
    .nullable(),
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
  readonly resourceBroker?: ResourceBroker;
  readonly codexUpdateBroker?: CodexUpdateBroker;
  readonly codexVersionChecker?: CodexVersionChecker;
  readonly transcriptionClient?: AudioTranscriptionClient;
  readonly pushSender?: PushSender;
  readonly upgradeDrainPath?: string;
  readonly accountLoginTimeoutMs?: number;
  readonly codexUpdateStartupRetryMs?: number;
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

function attachmentUserInput(
  text: string,
  attachments: readonly AttachmentRecord[],
  localPath: (attachment: AttachmentRecord) => string,
): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  const fileReferences = attachments
    .filter((attachment) => attachment.kind === 'file')
    .map((attachment) => `${attachment.name}: ${localPath(attachment)}`);
  const appText =
    fileReferences.length === 0
      ? text
      : `${text}${text.length > 0 ? '\n\n' : ''}[Codex Web attachment references (server-local; do not repeat paths):\n${fileReferences.join('\n')}\n]`;
  if (appText.length > 0) input.push({ type: 'text', text: appText, text_elements: [] });
  for (const attachment of attachments) {
    if (attachment.kind === 'image')
      input.push({
        type: 'localImage',
        path: localPath(attachment),
      });
  }
  return input;
}

function inputRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function publicCodexAccount(value: unknown): CodexAccount | null {
  const account = inputRecord(value);
  if (!account) return null;
  const knownType = z.enum(['chatgpt', 'apiKey', 'amazonBedrock']).safeParse(account.type);
  const email = z.string().email().max(320).safeParse(account.email);
  const planType = z.string().trim().min(1).max(80).safeParse(account.planType);
  return codexAccountSchema.parse({
    type: knownType.success ? knownType.data : 'unknown',
    email: email.success ? email.data : null,
    planType: planType.success ? planType.data : null,
  });
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
  const messagePhase =
    item.phase === 'commentary' || item.phase === 'final_answer' ? item.phase : null;
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    kind: 'agent-message',
    phase: 'completed',
    payload: sanitizeEventPayload(
      { text: item.text, ...(messagePhase ? { messagePhase } : {}) },
      maxBytes,
    ),
  };
}

function recoverableCompletedHistory(
  events: readonly Omit<SafeEvent, 'id' | 'createdAt'>[],
): Omit<SafeEvent, 'id' | 'createdAt'>[] {
  const successfullyCompletedTurns = new Set(
    events
      .filter(
        (event) =>
          event.kind === 'turn' && event.turnId !== null && event.payload.status === 'completed',
      )
      .map((event) => event.turnId as string),
  );
  const lastAgentMessageByTurn = new Map<string, Omit<SafeEvent, 'id' | 'createdAt'>>();
  for (const event of events) {
    if (event.kind === 'agent-message' && event.turnId !== null)
      lastAgentMessageByTurn.set(event.turnId, event);
  }
  return events.flatMap((event) => {
    if (event.kind === 'turn')
      return event.phase === 'completed' || event.phase === 'failed' ? [event] : [];
    if (event.kind === 'file-change') return event.phase !== 'delta' ? [event] : [];
    if (event.kind !== 'agent-message' || event.turnId === null) return [];
    if (event.payload.messagePhase === 'final_answer') return [event];
    if (
      event.payload.messagePhase === undefined &&
      successfullyCompletedTurns.has(event.turnId) &&
      lastAgentMessageByTurn.get(event.turnId) === event
    )
      return [{ ...event, payload: { ...event.payload, messagePhase: 'final_answer' } }];
    return [];
  });
}

function terminalPushStatus(message: AppServerInbound): PushNotificationPayload['status'] {
  const params = inputRecord('params' in message ? message.params : null);
  const turn = inputRecord(params?.turn);
  if (turn?.status === 'interrupted') return 'interrupted';
  if (turn?.status === 'failed') return 'failed';
  return 'completed';
}

function safeContentDisposition(name: string, inline: boolean): string {
  const encoded = encodeURIComponent(name).replaceAll("'", '%27');
  return `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encoded}`;
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function downloadableProjectFile(
  projectRoot: string,
  requestedPath: string,
): Promise<{ canonical: string; name: string; size: number }> {
  if (
    requestedPath.includes('\0') ||
    path.posix.isAbsolute(requestedPath) ||
    path.win32.isAbsolute(requestedPath)
  )
    throw new HttpError(400, 'PROJECT_FILE_PATH_INVALID');
  let canonical: string;
  try {
    canonical = await realpath(path.resolve(projectRoot, requestedPath));
  } catch {
    throw new HttpError(404, 'PROJECT_FILE_NOT_FOUND');
  }
  if (!pathIsInside(projectRoot, canonical)) throw new HttpError(404, 'PROJECT_FILE_NOT_FOUND');
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(canonical);
  } catch {
    throw new HttpError(404, 'PROJECT_FILE_NOT_FOUND');
  }
  if (!metadata.isFile()) throw new HttpError(400, 'PROJECT_FILE_NOT_DOWNLOADABLE');
  if (metadata.size > MAX_PROJECT_FILE_DOWNLOAD_BYTES)
    throw new HttpError(413, 'PROJECT_FILE_TOO_LARGE');
  return { canonical, name: path.basename(canonical), size: metadata.size };
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

function activeTurnIdFromHistory(turns: unknown): string | null {
  if (!Array.isArray(turns)) return null;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = inputRecord(turns[index]);
    if (turn?.status === 'inProgress' && typeof turn.id === 'string' && turn.id.length > 0)
      return turn.id;
  }
  return null;
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

function publicThreadUsage(
  requestedThreadId: string,
  input: Exclude<z.infer<typeof threadUsageResponseSchema>['threadUsage'], null>,
) {
  if (input.threadId !== requestedThreadId) throw new Error('THREAD_USAGE_ID_MISMATCH');
  const aggregate = (
    metric: keyof z.infer<typeof upstreamThreadUsageGroupSchema>,
  ): number | null => {
    if (input.groups.length === 0) return null;
    let total = 0;
    for (const group of input.groups) {
      const value = group[metric];
      if (typeof value !== 'number') return null;
      total += value;
      if (!Number.isSafeInteger(total)) return null;
    }
    return total;
  };
  return threadUsageSchema.parse({
    threadId: requestedThreadId,
    estimated: true,
    inputTokens: aggregate('inputTokens'),
    cachedInputTokens: aggregate('cachedInputTokens'),
    netNewInputTokens: aggregate('netNewInputTokens'),
    outputTokens: aggregate('outputTokens'),
    totalTokens: aggregate('totalTokens'),
  });
}

function mapThread(
  rpcThread: z.infer<typeof rpcThreadSchema>,
  projectId: string,
  archived: boolean,
  instructionSources: readonly string[] = [],
  responseModel?: string,
  existing?: Thread,
  liveActiveTurnId?: string | null,
  treeBusy = false,
): Thread {
  const status = liveActiveTurnId || treeBusy ? 'active' : statusType(rpcThread.status);
  return {
    id: rpcThread.id,
    projectId,
    name: rpcThread.name ?? null,
    preview: rpcThread.preview,
    model: responseModel ?? rpcThread.model ?? null,
    status,
    activeTurnId: status === 'active' ? (liveActiveTurnId ?? existing?.activeTurnId ?? null) : null,
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
  } catch (error) {
    if (error instanceof ProjectPathBrokerError) throw error;
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
  const pushDispatcher = dependencies.pushSender
    ? new PushNotificationDispatcher(repository, dependencies.pushSender)
    : undefined;
  const sseListeners = new Map<string, Set<SseListener>>();
  const activeTurns = new Set<string>();
  const treeBusyThreads = new Set<string>();
  const nativeActiveThreads = new Set<string>();
  const nativeActivityVersions = new Map<string, number>();
  let nativeActivityVersion = 0;
  const markNativeActive = (threadId: string): void => {
    nativeActiveThreads.add(threadId);
    nativeActivityVersions.set(threadId, ++nativeActivityVersion);
  };
  const clearNativeActive = (threadId: string): void => {
    nativeActiveThreads.delete(threadId);
    nativeActivityVersions.set(threadId, ++nativeActivityVersion);
  };
  const activeTurnIdForThread = (threadId: string): string | null => {
    const prefix = `${threadId}:`;
    for (const activeTurn of activeTurns) {
      if (activeTurn.startsWith(prefix)) return activeTurn.slice(prefix.length);
    }
    return null;
  };
  const setActiveTurn = (threadId: string, turnId: string): void => {
    const prefix = `${threadId}:`;
    for (const activeTurn of activeTurns) {
      if (activeTurn.startsWith(prefix)) activeTurns.delete(activeTurn);
    }
    activeTurns.add(`${threadId}:${turnId}`);
  };
  const clearActiveTurns = (threadId: string): void => {
    const prefix = `${threadId}:`;
    for (const activeTurn of activeTurns) {
      if (activeTurn.startsWith(prefix)) activeTurns.delete(activeTurn);
    }
  };
  const activeTurnEntries = (): { threadId: string; turnId: string }[] =>
    [...activeTurns].map((entry) => {
      const separator = entry.indexOf(':');
      return { threadId: entry.slice(0, separator), turnId: entry.slice(separator + 1) };
    });
  const activeRootCount = (): number => {
    const roots = new Set(activeTurnEntries().map((entry) => entry.threadId));
    for (const threadId of nativeActiveThreads) roots.add(threadId);
    return roots.size;
  };
  const syncThreadExecutionStatus = (threadId: string): void => {
    const liveActiveTurnId = activeTurnIdForThread(threadId);
    const treeBusy = repository.countActiveSubagentsForRoot(threadId) > 0;
    if (liveActiveTurnId || treeBusy) {
      if (liveActiveTurnId) treeBusyThreads.delete(threadId);
      else if (!nativeActiveThreads.has(threadId)) treeBusyThreads.add(threadId);
      repository.updateThreadRuntime(threadId, {
        status: 'active',
        activeTurnId: liveActiveTurnId,
      });
      return;
    }
    if (treeBusyThreads.delete(threadId) && repository.getThread(threadId)?.status === 'active')
      repository.updateThreadRuntime(threadId, { status: 'idle', activeTurnId: null });
  };
  const threadRuntimePayload = (
    threadId: string,
  ): { status: Thread['status']; activeTurnId: string | null } | null => {
    const thread = repository.getThread(threadId);
    return thread ? { status: thread.status, activeTurnId: thread.activeTurnId } : null;
  };
  const approvalGenerations = new Map<string, number>();
  const loadedThreadGenerations = new Map<string, number>();
  const historyHydrations = new Map<string, Promise<Thread>>();
  const turnNavigationGenerations = new Map<string, number>();
  const turnNavigationMutationVersions = new Map<string, number>();
  const turnNavigationRefreshes = new Map<
    string,
    { generation: number; result: Promise<Thread> }
  >();
  const appendTurnNavigation = (entry: Omit<TurnNavigationEntry, 'id'>): TurnNavigationEntry => {
    const persisted = repository.appendTurnNavigation(entry);
    turnNavigationMutationVersions.set(
      entry.threadId,
      (turnNavigationMutationVersions.get(entry.threadId) ?? 0) + 1,
    );
    return persisted;
  };
  repository.markPendingIdempotencyUnknown();
  repository.resetActiveThreadRuntime();
  repository.resetActiveSubagentRuntime();
  let pendingTurnStarts = 0;
  let pendingThreadStarts = 0;
  let queuedTurnRetry: NodeJS.Timeout | null = null;
  let queuedTurnDispatch: Promise<void> | null = null;
  let queuedTurnDispatchRequested = false;
  let requestQueuedTurnDispatch: () => void = () => {};
  let accountLogin: CodexAccountLogin = codexAccountLoginSchema.parse({
    state: 'idle',
    loginId: null,
    userCode: null,
    verificationUrl: null,
    expiresAt: null,
    message: null,
  });
  let accountLoginTimer: NodeJS.Timeout | null = null;
  let accountLoginInterlocked = false;
  let accountLoginStartInFlight = false;
  let accountLoginAttempt = 0;
  let earlyAccountLoginCompletion: { loginId: string; success: boolean } | null = null;
  const takeEarlyAccountLoginCompletion = (): {
    loginId: string;
    success: boolean;
  } | null => {
    const completion = earlyAccountLoginCompletion;
    earlyAccountLoginCompletion = null;
    return completion;
  };
  const clearAccountLoginTimer = (): void => {
    if (accountLoginTimer) clearTimeout(accountLoginTimer);
    accountLoginTimer = null;
  };
  const setTerminalAccountLogin = (
    state: 'succeeded' | 'failed',
    message: string,
    expectedLoginId?: string,
  ): boolean => {
    if (
      expectedLoginId !== undefined &&
      (accountLogin.state !== 'pending' ||
        (accountLogin.loginId !== null && accountLogin.loginId !== expectedLoginId))
    )
      return false;
    clearAccountLoginTimer();
    accountLoginInterlocked = false;
    earlyAccountLoginCompletion = null;
    accountLogin = codexAccountLoginSchema.parse({
      state,
      loginId: expectedLoginId ?? accountLogin.loginId,
      userCode: null,
      verificationUrl: null,
      expiresAt: null,
      message,
    });
    return true;
  };
  const resetAccountLogin = (expectedLoginId?: string): boolean => {
    if (
      expectedLoginId !== undefined &&
      (accountLogin.state !== 'pending' || accountLogin.loginId !== expectedLoginId)
    )
      return false;
    clearAccountLoginTimer();
    accountLoginInterlocked = false;
    earlyAccountLoginCompletion = null;
    accountLogin = codexAccountLoginSchema.parse({
      state: 'idle',
      loginId: null,
      userCode: null,
      verificationUrl: null,
      expiresAt: null,
      message: null,
    });
    return true;
  };
  let activeTranscriptions = 0;
  const transcriptionAttempts = new Map<string, number[]>();
  const transcriptionIdempotency = new Map<string, TranscriptionIdempotencyEntry>();
  let resourceApplyPromise: Promise<ResourceLimitSnapshot> | null = null;
  let resourceApplyVersion: number | null = null;
  // When the privileged broker is configured, admission starts fail-closed
  // until its durable worker state has been reconciled below.
  let codexUpdateInterlocked = dependencies.codexUpdateBroker !== undefined;
  let codexUpdateApplyPending = false;
  let codexUpdateGeneration = 0;
  let codexUpdateStartupReconciled = dependencies.codexUpdateBroker === undefined;
  let resourceStartupRetry: NodeJS.Timeout | null = null;
  let codexUpdateStartupRetry: NodeJS.Timeout | null = null;
  let serverClosing = false;
  let lastHandledDisconnectGeneration = 0;
  let appServerDisconnectEpoch = 0;
  const upgradeDrainPath = dependencies.upgradeDrainPath ?? '/run/codex-web-ui/upgrade-drain';
  const accountLoginTimeoutMs = dependencies.accountLoginTimeoutMs ?? CODEX_ACCOUNT_LOGIN_TTL_MS;
  const codexUpdateStartupRetryMs = dependencies.codexUpdateStartupRetryMs ?? 1_000;
  const upgradeDrainRequested = (): boolean => {
    try {
      return lstatSync(upgradeDrainPath).isFile();
    } catch {
      return false;
    }
  };

  const safeParallelAgents = (cpuQuotaPercent: number, memoryBytes: number): number =>
    Math.max(
      1,
      Math.min(
        8,
        Math.floor(cpuQuotaPercent / 100),
        Math.floor(memoryBytes / (2 * 1_024 * 1_024 * 1_024)),
      ),
    );

  const autoParallelAgents = (snapshot: BrokerResourceSnapshot): number =>
    safeParallelAgents(snapshot.effective.cpuQuotaPercent, snapshot.effective.memoryMaxBytes);

  const publicResourceSnapshot = (broker: BrokerResourceSnapshot): ResourceLimitSnapshot => {
    const stored = repository.getResourceLimits();
    return resourceLimitSnapshotSchema.parse({
      capacity: {
        cpuCores: broker.capacity.cpuQuotaPercent / 100,
        memoryBytes: broker.capacity.memoryBytes,
        memoryAvailableBytes: broker.capacity.memoryAvailableBytes,
        tasks: broker.capacity.tasks,
        measuredAt: broker.capacity.measuredAt,
      },
      desired: stored.desired,
      effective: {
        cpuCores: broker.effective.cpuQuotaPercent / 100,
        memoryBytes: broker.effective.memoryMaxBytes,
        tasks: broker.effective.tasksMax,
        maxParallelAgents: stored.desired.maxParallelAgents ?? autoParallelAgents(broker),
      },
      state: stored.state,
      version: stored.version,
      updatedAt: stored.updatedAt,
      appliedAt: stored.appliedAt,
      warning: stored.warning,
    });
  };

  const brokerSnapshot = async (): Promise<BrokerResourceSnapshot> => {
    if (!dependencies.resourceBroker)
      throw new HttpError(503, 'RESOURCE_BROKER_UNAVAILABLE', 'Resource broker is unavailable');
    try {
      return await dependencies.resourceBroker.snapshot();
    } catch (error) {
      if (error instanceof ResourceBrokerError) throw new HttpError(503, error.code, error.message);
      throw error;
    }
  };

  const codexUpdateStatus = async (): Promise<CodexUpdateSnapshot> => {
    if (!dependencies.codexUpdateBroker)
      throw new HttpError(503, 'CODEX_UPDATE_UNAVAILABLE', 'Codex update broker is unavailable');
    try {
      const observedGeneration = codexUpdateGeneration;
      const mayClearInterlock = !codexUpdateApplyPending;
      const snapshot = codexUpdateSnapshotSchema.parse(
        await dependencies.codexUpdateBroker.status(),
      );
      if (
        observedGeneration === codexUpdateGeneration &&
        mayClearInterlock &&
        !codexUpdateApplyPending
      ) {
        codexUpdateInterlocked =
          snapshot.state === 'applying' || snapshot.state === 'rollback_failed';
      } else if (snapshot.state === 'applying' || snapshot.state === 'rollback_failed') {
        codexUpdateInterlocked = true;
      }
      codexUpdateStartupReconciled = true;
      if (codexUpdateStartupRetry !== null) {
        clearTimeout(codexUpdateStartupRetry);
        codexUpdateStartupRetry = null;
      }
      return snapshot;
    } catch (error) {
      if (error instanceof CodexUpdateBrokerError)
        throw new HttpError(503, error.code, error.message);
      throw error;
    }
  };

  const reconcileStartupCodexUpdate = async (): Promise<void> => {
    try {
      await codexUpdateStatus();
    } catch {
      if (serverClosing || codexUpdateStartupReconciled) return;
      codexUpdateInterlocked = true;
      if (codexUpdateStartupRetry !== null) return;
      codexUpdateStartupRetry = setTimeout(() => {
        codexUpdateStartupRetry = null;
        if (!serverClosing) void reconcileStartupCodexUpdate();
      }, codexUpdateStartupRetryMs);
      codexUpdateStartupRetry.unref();
    }
  };

  const resourceWorkActive = (): boolean =>
    activeRootCount() > 0 || pendingTurnStarts > 0 || repository.countActiveSubagents() > 0;

  const codexUpdateWorkActive = (): boolean =>
    resourceWorkActive() ||
    pendingThreadStarts > 0 ||
    resourceApplyPromise !== null ||
    activeTranscriptions > 0 ||
    accountLoginInterlocked;

  const applyPendingResources = async (): Promise<ResourceLimitSnapshot> => {
    if (resourceApplyPromise) {
      const inFlightVersion = resourceApplyVersion;
      try {
        const snapshot = await resourceApplyPromise;
        if (repository.getResourceLimits().version === inFlightVersion) return snapshot;
      } catch (error) {
        if (repository.getResourceLimits().version === inFlightVersion) throw error;
      }
      return applyPendingResources();
    }
    const applyingVersion = repository.getResourceLimits().version;
    resourceApplyVersion = applyingVersion;
    resourceApplyPromise = (async () => {
      const stored = repository.getResourceLimits();
      const before = await brokerSnapshot();
      if (stored.state === 'applied') return publicResourceSnapshot(before);
      if (resourceWorkActive()) {
        repository.setResourceLimitState(stored.version, 'pending-idle', { warning: null });
        return publicResourceSnapshot(before);
      }
      repository.setResourceLimitState(stored.version, 'applying', { warning: null });
      try {
        const desired = stored.desired;
        const applied = await dependencies.resourceBroker!.apply({
          mode: desired.mode,
          cpuQuotaPercent:
            desired.mode === 'custom' && desired.cpuCores !== null
              ? Math.round(desired.cpuCores * 100)
              : null,
          memoryMaxBytes: desired.mode === 'custom' ? desired.memoryBytes : null,
          tasksMax: desired.mode === 'custom' ? desired.tasks : null,
        });
        repository.setResourceLimitState(stored.version, 'applied', {
          appliedAt: new Date().toISOString(),
          warning: null,
        });
        repository.audit('resource_limits.apply', 'succeeded', {
          version: stored.version,
          mode: desired.mode,
          generation: applied.generation,
        });
        return publicResourceSnapshot(applied);
      } catch (error) {
        const message =
          error instanceof Error ? error.message.slice(0, 2_000) : 'Resource broker failed';
        repository.setResourceLimitState(stored.version, 'degraded', { warning: message });
        repository.audit('resource_limits.apply', 'failed', { version: stored.version });
        if (error instanceof ResourceBrokerError)
          throw new HttpError(503, error.code, error.message);
        throw error;
      }
    })().finally(() => {
      resourceApplyPromise = null;
      resourceApplyVersion = null;
    });
    try {
      const snapshot = await resourceApplyPromise;
      if (repository.getResourceLimits().version === applyingVersion) return snapshot;
    } catch (error) {
      if (repository.getResourceLimits().version === applyingVersion) throw error;
    }
    return applyPendingResources();
  };

  const applyPendingResourcesWhenIdle = async (): Promise<void> => {
    if (repository.getResourceLimits().state === 'applied' || resourceWorkActive()) return;
    await applyPendingResources().catch(() => {
      // The failure is persisted as degraded state and exposed through the resource endpoint.
    });
  };

  const reconcileStartupResources = async (): Promise<void> => {
    await applyPendingResourcesWhenIdle();
    if (serverClosing || repository.getResourceLimits().state === 'applied') return;
    resourceStartupRetry = setTimeout(() => {
      resourceStartupRetry = null;
      if (!serverClosing) void applyPendingResourcesWhenIdle();
    }, 1_000);
    resourceStartupRetry.unref();
  };

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
    reconcileTurnId?: string,
  ): Promise<{ thread: Thread; turns: unknown }> => {
    const project = repository.getProject(existing.projectId);
    if (!project) throw new HttpError(409, 'THREAD_PROJECT_MISSING');
    const cwd = await canonicalProjectPath(pathPolicy, project);
    const nativeVersionBeforeRead = nativeActivityVersions.get(existing.id) ?? null;
    let result = threadResponseSchema.parse(
      await appServer.request('thread/read', { threadId: existing.id, includeTurns }),
    );
    if (result.thread.cwd !== cwd) throw new HttpError(502, 'APP_SERVER_CWD_MISMATCH');
    let liveActiveTurnId = activeTurnIdForThread(existing.id);
    let authoritativeStatus = statusType(result.thread.status);
    if (
      authoritativeStatus === 'active' &&
      liveActiveTurnId === null &&
      !Array.isArray(result.thread.turns)
    ) {
      result = threadResponseSchema.parse(
        await appServer.request('thread/read', { threadId: existing.id, includeTurns: true }),
      );
      if (result.thread.cwd !== cwd) throw new HttpError(502, 'APP_SERVER_CWD_MISMATCH');
      authoritativeStatus = statusType(result.thread.status);
    }
    const turnHistoryAvailable = Array.isArray(result.thread.turns);
    let recoveredTurnId: string | null = null;
    if (authoritativeStatus === 'active' && liveActiveTurnId === null && turnHistoryAvailable) {
      recoveredTurnId = activeTurnIdFromHistory(result.thread.turns);
      if (recoveredTurnId) {
        liveActiveTurnId = recoveredTurnId;
      } else if (
        repository.listSubagents(existing.id).length > 0 &&
        repository.countActiveSubagentsForRoot(existing.id) === 0
      ) {
        const confirmation = threadResponseSchema.parse(
          await appServer.request('thread/read', { threadId: existing.id, includeTurns: true }),
        );
        if (confirmation.thread.cwd !== cwd) throw new HttpError(502, 'APP_SERVER_CWD_MISMATCH');
        const confirmationTurnId = activeTurnIdFromHistory(confirmation.thread.turns);
        const stableNativeSnapshot =
          statusType(confirmation.thread.status) === 'active' &&
          confirmation.thread.updatedAt === result.thread.updatedAt;
        result = confirmation;
        authoritativeStatus = statusType(confirmation.thread.status);
        if (confirmationTurnId) {
          recoveredTurnId = confirmationTurnId;
          liveActiveTurnId = confirmationTurnId;
        } else if (stableNativeSnapshot) {
          // `thread/read(includeTurns)` is one native snapshot. Confirm the same terminal
          // tree twice so a fresh root that materializes between reads wins instead.
          authoritativeStatus = 'idle';
        }
      }
    }
    const nativeObservationUnchanged =
      (nativeActivityVersions.get(existing.id) ?? null) === nativeVersionBeforeRead;
    if (nativeObservationUnchanged) {
      if (recoveredTurnId) setActiveTurn(existing.id, recoveredTurnId);
      if (authoritativeStatus === 'active' && liveActiveTurnId === null)
        markNativeActive(existing.id);
      else clearNativeActive(existing.id);
    }
    const preserveLiveRuntime =
      reconcileTurnId === undefined ||
      (liveActiveTurnId !== null && liveActiveTurnId !== reconcileTurnId);
    const preserveTreeRuntime =
      reconcileTurnId === undefined && repository.countActiveSubagentsForRoot(existing.id) > 0;
    const preserveNativeRuntime = nativeActiveThreads.has(existing.id);
    const reconciledRpcThread = {
      ...result.thread,
      status: authoritativeStatus === 'unknown' ? result.thread.status : authoritativeStatus,
    };
    let mappedThread = mapThread(
      reconciledRpcThread,
      project.id,
      existing.archived,
      existing.instructionSources,
      result.model,
      existing,
      preserveLiveRuntime ? liveActiveTurnId : null,
      preserveTreeRuntime || preserveNativeRuntime,
    );
    if (!nativeObservationUnchanged) {
      const current = repository.getThread(existing.id) ?? existing;
      mappedThread = {
        ...mappedThread,
        status: current.status,
        activeTurnId: current.activeTurnId,
      };
    }
    const previousThread = repository.getThread(existing.id) ?? existing;
    const thread = repository.upsertThread(mappedThread);
    if (
      nativeObservationUnchanged &&
      (thread.status !== previousThread.status ||
        thread.activeTurnId !== previousThread.activeTurnId)
    ) {
      publish(
        repository.appendEvent({
          threadId: thread.id,
          turnId: thread.activeTurnId,
          kind: 'thread',
          phase: 'state',
          payload: {
            threadRuntime: threadRuntimePayload(thread.id),
            appServerReconciled: true,
          },
        }),
      );
    }
    return { thread, turns: result.thread.turns };
  };

  const reconcileStaleExecutionCapacity = async (): Promise<void> => {
    const affectedRoots = new Set<string>();
    const reconciledSubagents = new Set<string>();
    for (const snapshot of activeTurnEntries()) {
      const existing = repository.getThread(snapshot.threadId);
      if (!existing || activeTurnIdForThread(snapshot.threadId) !== snapshot.turnId) continue;
      try {
        const reconciled = await readThreadFromAppServer(existing, false, snapshot.turnId);
        if (
          reconciled.thread.status === 'active' ||
          activeTurnIdForThread(snapshot.threadId) !== snapshot.turnId
        )
          continue;
        clearActiveTurns(snapshot.threadId);
        affectedRoots.add(snapshot.threadId);
        repository.audit('turn.capacity_reconcile', 'succeeded', {
          threadId: snapshot.threadId,
          turnId: snapshot.turnId,
        });
      } catch {
        repository.audit('turn.capacity_reconcile', 'failed', {
          threadId: snapshot.threadId,
          turnId: snapshot.turnId,
        });
      }
    }
    for (const [threadId, expectedVersion] of [...nativeActivityVersions]) {
      if (!nativeActiveThreads.has(threadId)) continue;
      const existing = repository.getThread(threadId);
      const project = existing && repository.getProject(existing.projectId);
      if (!existing || !project) continue;
      try {
        const cwd = await canonicalProjectPath(pathPolicy, project);
        const result = threadResponseSchema.parse(
          await appServer.request('thread/read', { threadId, includeTurns: false }),
        );
        if (result.thread.id !== threadId || result.thread.cwd !== cwd)
          throw new Error('NATIVE_THREAD_MISMATCH');
        if (statusType(result.thread.status) === 'active') continue;
        if (
          nativeActiveThreads.has(threadId) &&
          nativeActivityVersions.get(threadId) === expectedVersion
        ) {
          clearNativeActive(threadId);
          repository.upsertThread(
            mapThread(
              result.thread,
              project.id,
              existing.archived,
              existing.instructionSources,
              result.model,
              existing,
              null,
              repository.countActiveSubagentsForRoot(threadId) > 0,
            ),
          );
          affectedRoots.add(threadId);
        }
      } catch {
        repository.audit('turn.native_capacity_reconcile', 'failed', { threadId });
      }
    }
    for (const snapshot of repository.listActiveSubagents()) {
      if (snapshot.status !== 'pendingInit' && snapshot.status !== 'running') continue;
      const rootThread = repository.getThread(snapshot.rootThreadId);
      const project = rootThread && repository.getProject(rootThread.projectId);
      if (!rootThread || !project) continue;
      try {
        const cwd = await canonicalProjectPath(pathPolicy, project);
        const result = threadResponseSchema.parse(
          await appServer.request('thread/read', {
            threadId: snapshot.id,
            includeTurns: false,
          }),
        );
        if (result.thread.id !== snapshot.id || result.thread.cwd !== cwd)
          throw new Error('SUBAGENT_THREAD_MISMATCH');
        if (statusType(result.thread.status) === 'active') continue;
        if (
          repository.reconcileActiveSubagent(
            snapshot.id,
            snapshot.status,
            snapshot.lastActivityAt,
            new Date().toISOString(),
          )
        ) {
          affectedRoots.add(snapshot.rootThreadId);
          reconciledSubagents.add(snapshot.id);
        }
      } catch {
        repository.audit('subagent.capacity_reconcile', 'failed', {
          rootThreadId: snapshot.rootThreadId,
          subagentId: snapshot.id,
        });
      }
    }
    for (const rootThreadId of affectedRoots) {
      syncThreadExecutionStatus(rootThreadId);
      const threadRuntime = threadRuntimePayload(rootThreadId);
      if (threadRuntime)
        publish(
          repository.appendEvent({
            threadId: rootThreadId,
            turnId: null,
            kind: 'thread',
            phase: 'state',
            payload: { threadRuntime, capacityReconciled: true },
          }),
        );
    }
    for (const subagentId of reconciledSubagents) {
      const subagent = repository.getSubagent(subagentId);
      if (!subagent) continue;
      const threadRuntime = threadRuntimePayload(subagent.rootThreadId);
      publish(
        repository.appendEvent({
          threadId: subagent.rootThreadId,
          turnId: null,
          kind: 'subagent',
          phase: 'state',
          payload: { subagent, ...(threadRuntime ? { threadRuntime } : {}) },
        }),
      );
    }
  };

  const hydrateThreadHistory = async (existing: Thread): Promise<Thread> => {
    if (repository.isThreadHistoryHydrated(existing.id)) return existing;
    const activeHydration = historyHydrations.get(existing.id);
    if (activeHydration) return activeHydration;
    const hydration = (async () => {
      if (repository.isThreadHistoryHydrated(existing.id))
        return repository.getThread(existing.id) ?? existing;
      const generation = appServer.generation;
      const navigationMutationVersion = turnNavigationMutationVersions.get(existing.id) ?? 0;
      const result = await readThreadFromAppServer(existing, true);
      const safeTurns = redactAttachmentStorage(result.turns, attachmentStore.root);
      for (const event of repository.reconcileThreadHistoryEvents(
        existing.id,
        normalizeThreadHistory(existing.id, safeTurns, config.maxEventBytes),
      ))
        publish(event);
      if ((turnNavigationMutationVersions.get(existing.id) ?? 0) === navigationMutationVersion) {
        repository.replaceTurnNavigation(
          existing.id,
          normalizeTurnNavigation(existing.id, safeTurns, config.maxEventBytes),
        );
        if (appServer.generation === generation)
          turnNavigationGenerations.set(existing.id, generation);
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

  const refreshTurnNavigation = async (existing: Thread): Promise<Thread> => {
    const generation = appServer.generation;
    if (turnNavigationGenerations.get(existing.id) === generation) return existing;
    const activeRefresh = turnNavigationRefreshes.get(existing.id);
    if (activeRefresh?.generation === generation) return activeRefresh.result;
    const result = (async () => {
      const mutationVersion = turnNavigationMutationVersions.get(existing.id) ?? 0;
      const read = await readThreadFromAppServer(existing, true);
      const safeTurns = redactAttachmentStorage(read.turns, attachmentStore.root);
      for (const event of repository.reconcileThreadHistoryEvents(
        existing.id,
        recoverableCompletedHistory(
          normalizeThreadHistory(existing.id, safeTurns, config.maxEventBytes),
        ),
      ))
        publish(event);
      if ((turnNavigationMutationVersions.get(existing.id) ?? 0) !== mutationVersion)
        return read.thread;
      repository.replaceTurnNavigation(
        existing.id,
        normalizeTurnNavigation(existing.id, safeTurns, config.maxEventBytes),
      );
      if (appServer.generation === generation)
        turnNavigationGenerations.set(existing.id, generation);
      return read.thread;
    })();
    turnNavigationRefreshes.set(existing.id, { generation, result });
    try {
      return await result;
    } finally {
      if (turnNavigationRefreshes.get(existing.id)?.result === result)
        turnNavigationRefreshes.delete(existing.id);
    }
  };

  const throwTurnCommandFailure = async (
    thread: Thread,
    error: unknown,
    expectedTurnId: string,
    onOutcomeUnknown?: () => void,
    onConfirmedInactive?: () => void,
  ): Promise<never> => {
    if (error instanceof Error && error.message === 'APP_SERVER_UNAVAILABLE') throw error;
    let confirmedInactive = false;
    try {
      const reconciled = await readThreadFromAppServer(thread, false, expectedTurnId);
      if (reconciled.thread.status !== 'active') {
        confirmedInactive = true;
        clearActiveTurns(thread.id);
      }
    } catch {
      // An unavailable reread cannot safely classify the command as rejected.
    }
    if (confirmedInactive) {
      onConfirmedInactive?.();
      throw new HttpError(
        409,
        'TURN_NOT_ACTIVE',
        'Активная задача уже завершена или недоступна. Обновите чат.',
      );
    }
    onOutcomeUnknown?.();
    throw new HttpError(
      502,
      'TURN_COMMAND_OUTCOME_UNKNOWN',
      'Codex не подтвердил команду. Задача всё ещё активна; обновите чат перед повтором.',
    );
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
    const requestDisconnectEpoch = appServerDisconnectEpoch;
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
      if (
        !appServer.ready ||
        appServer.generation !== requestGeneration ||
        appServerDisconnectEpoch !== requestDisconnectEpoch
      )
        return;
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
      if (
        appServer.ready &&
        appServer.generation === requestGeneration &&
        appServerDisconnectEpoch === requestDisconnectEpoch
      )
        appServer.respondError(message.id, -32602, 'Unsafe permission request');
    }
  };

  const onAppServerMessage = (message: AppServerInbound): void => {
    if (message.id === undefined && message.method === 'account/login/completed') {
      const completed = accountLoginCompletedSchema.safeParse(message.params);
      if (!completed.success || completed.data.loginId == null) return;
      if (
        accountLoginInterlocked &&
        accountLogin.state === 'pending' &&
        accountLogin.loginId === null
      ) {
        if (accountLoginStartInFlight)
          earlyAccountLoginCompletion = {
            loginId: completed.data.loginId,
            success: completed.data.success,
          };
        return;
      }
      setTerminalAccountLogin(
        completed.data.success ? 'succeeded' : 'failed',
        completed.data.success ? 'Account connected.' : 'Account login failed.',
        completed.data.loginId,
      );
      return;
    }
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
    for (const projection of normalizeSubagentNotification(redactedMessage, {
      findAgent: (agentThreadId) => {
        const existing = repository.getSubagent(agentThreadId);
        return existing
          ? { agentThreadId: existing.id, rootThreadId: existing.rootThreadId }
          : null;
      },
      maxMessageLength: 1_024,
    })) {
      if (!repository.getThread(projection.rootThreadId)) continue;
      const existing = repository.getSubagent(projection.agentThreadId);
      const subagent: Subagent = {
        id: projection.agentThreadId,
        rootThreadId: projection.rootThreadId,
        parentThreadId: projection.parentThreadId,
        agentPath: projection.agentPath ?? existing?.agentPath ?? null,
        nickname: projection.nickname ?? existing?.nickname ?? null,
        role: projection.role ?? existing?.role ?? null,
        model: projection.model ?? existing?.model ?? null,
        reasoningEffort: projection.reasoningEffort ?? existing?.reasoningEffort ?? null,
        status: projection.status ?? existing?.status ?? 'pendingInit',
        message: projection.statusMessage ?? existing?.message ?? null,
        startedAt: projection.startedAt ?? existing?.startedAt ?? projection.lastActivityAt,
        lastActivityAt: projection.lastActivityAt,
        completedAt:
          projection.completedAt ??
          (projection.status && ['pendingInit', 'running'].includes(projection.status)
            ? null
            : (existing?.completedAt ?? null)),
      };
      const persisted = repository.upsertSubagent(subagent);
      syncThreadExecutionStatus(persisted.rootThreadId);
      const threadRuntime = threadRuntimePayload(persisted.rootThreadId);
      publish(
        repository.appendEvent({
          threadId: persisted.rootThreadId,
          turnId: null,
          kind: 'subagent',
          phase: 'state',
          payload: {
            subagent: persisted,
            ...(threadRuntime ? { threadRuntime } : {}),
          },
        }),
      );
      void applyPendingResourcesWhenIdle();
      requestQueuedTurnDispatch();
    }
    const normalized =
      completedAgentMessage(redactedMessage, config.maxEventBytes) ??
      normalizeNotification(redactedMessage, config.maxEventBytes);
    if (!normalized || !repository.getThread(normalized.threadId)) return;
    if (normalized.phase === 'delta') return;
    let runtimeTurnEvent = true;
    if (message.method === 'turn/started' && normalized.turnId) {
      setActiveTurn(normalized.threadId, normalized.turnId);
      treeBusyThreads.delete(normalized.threadId);
      clearNativeActive(normalized.threadId);
      repository.updateThreadRuntime(normalized.threadId, {
        status: 'active',
        activeTurnId: normalized.turnId,
      });
    }
    if (message.method === 'turn/completed' && normalized.turnId) {
      const currentTurnId =
        repository.getThread(normalized.threadId)?.activeTurnId ??
        activeTurnIdForThread(normalized.threadId);
      activeTurns.delete(`${normalized.threadId}:${normalized.turnId}`);
      runtimeTurnEvent = currentTurnId === null || currentTurnId === normalized.turnId;
      const treeBusy = repository.countActiveSubagentsForRoot(normalized.threadId) > 0;
      if (runtimeTurnEvent) clearNativeActive(normalized.threadId);
      if (runtimeTurnEvent && treeBusy) treeBusyThreads.add(normalized.threadId);
      if (runtimeTurnEvent && !treeBusy) treeBusyThreads.delete(normalized.threadId);
      const thread = runtimeTurnEvent
        ? repository.updateThreadRuntime(
            normalized.threadId,
            treeBusy
              ? { status: 'active', activeTurnId: null }
              : { status: 'idle', activeTurnId: null },
          )
        : repository.getThread(normalized.threadId);
      if (thread)
        if (runtimeTurnEvent)
          pushDispatcher?.enqueue(thread.id, normalized.turnId, terminalPushStatus(message));
      void applyPendingResourcesWhenIdle();
      requestQueuedTurnDispatch();
    }
    if (message.method === 'thread/status/changed') {
      const status = threadStatusChangedSchema.safeParse(message.params);
      if (status.success) {
        const nextStatus = statusType(status.data.status);
        const liveActiveTurnId = activeTurnIdForThread(normalized.threadId);
        const treeBusy = repository.countActiveSubagentsForRoot(normalized.threadId) > 0;
        if (nextStatus === 'active') {
          treeBusyThreads.delete(normalized.threadId);
          if (liveActiveTurnId === null) markNativeActive(normalized.threadId);
        } else {
          clearNativeActive(normalized.threadId);
        }
        if (nextStatus !== 'active' && treeBusy && liveActiveTurnId === null)
          treeBusyThreads.add(normalized.threadId);
        const preserveActive =
          (liveActiveTurnId !== null || treeBusy) &&
          (nextStatus === 'idle' || nextStatus === 'notLoaded');
        repository.updateThreadRuntime(
          normalized.threadId,
          preserveActive
            ? { status: 'active', activeTurnId: liveActiveTurnId }
            : {
                status: nextStatus,
                ...(nextStatus === 'active' ? {} : { activeTurnId: null }),
              },
        );
        if (nextStatus !== 'active' && !preserveActive) {
          clearActiveTurns(normalized.threadId);
          void applyPendingResourcesWhenIdle();
          requestQueuedTurnDispatch();
        }
      }
    }
    if (message.method === 'thread/name/updated') {
      const name = threadNameUpdatedSchema.safeParse(message.params);
      if (name.success && name.data.threadName !== undefined)
        repository.updateThreadRuntime(normalized.threadId, { name: name.data.threadName });
    }
    if (message.method === 'thread/archived')
      repository.setThreadArchived(normalized.threadId, true);
    if (message.method === 'thread/unarchived')
      repository.setThreadArchived(normalized.threadId, false);
    const persistedNotification =
      message.method === 'turn/started' ||
      message.method === 'turn/completed' ||
      message.method === 'thread/status/changed'
        ? {
            ...normalized,
            payload: {
              ...normalized.payload,
              runtime: runtimeTurnEvent,
              threadRuntime: threadRuntimePayload(normalized.threadId),
            },
          }
        : normalized;
    publish(repository.appendEvent(persistedNotification));
  };
  const onAppServerLifecycle = (event: AppServerLifecycleEvent): void => {
    if (
      serverClosing ||
      event.type !== 'disconnected' ||
      event.generation !== appServer.generation ||
      event.generation <= lastHandledDisconnectGeneration
    )
      return;
    lastHandledDisconnectGeneration = event.generation;
    appServerDisconnectEpoch += 1;
    const activeSubagents = repository.listActiveSubagents();
    const affectedRoots = new Set(activeTurnEntries().map((entry) => entry.threadId));
    for (const threadId of nativeActiveThreads) affectedRoots.add(threadId);
    for (const threadId of treeBusyThreads) affectedRoots.add(threadId);
    for (const subagent of activeSubagents) affectedRoots.add(subagent.rootThreadId);

    activeTurns.clear();
    nativeActiveThreads.clear();
    treeBusyThreads.clear();
    for (const threadId of repository.resetActiveThreadRuntime()) affectedRoots.add(threadId);
    repository.resetActiveSubagentRuntime();
    for (const approval of repository.listUnfinishedApprovals()) {
      if (repository.cancelUnfinishedApproval(approval.id))
        appendInteractionTerminal(approval, 'cancelled');
    }
    approvalGenerations.clear();
    if (accountLoginInterlocked) setTerminalAccountLogin('failed', 'Connection to Codex was lost.');

    for (const rootThreadId of affectedRoots) {
      const threadRuntime = threadRuntimePayload(rootThreadId);
      if (!threadRuntime) continue;
      publish(
        repository.appendEvent({
          threadId: rootThreadId,
          turnId: null,
          kind: 'thread',
          phase: 'state',
          payload: { threadRuntime, appServerDisconnected: true },
        }),
      );
    }
    for (const snapshot of activeSubagents) {
      const subagent = repository.getSubagent(snapshot.id);
      if (!subagent) continue;
      const threadRuntime = threadRuntimePayload(subagent.rootThreadId);
      publish(
        repository.appendEvent({
          threadId: subagent.rootThreadId,
          turnId: null,
          kind: 'subagent',
          phase: 'state',
          payload: { subagent, ...(threadRuntime ? { threadRuntime } : {}) },
        }),
      );
    }
    repository.audit('app_server.disconnected', 'succeeded', {
      generation: event.generation,
      affectedRootCount: affectedRoots.size,
      interruptedSubagentCount: activeSubagents.length,
    });
    void applyPendingResourcesWhenIdle();
    requestQueuedTurnDispatch();
  };
  const unsubscribe = appServer.subscribe(onAppServerMessage);
  const unsubscribeLifecycle = appServer.subscribeLifecycle(onAppServerLifecycle);

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((error, request, reply) => {
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
    if (error instanceof ProjectPathBrokerError) {
      void reply.code(503).send({
        error: { code: error.code, message: 'Project path validation is unavailable' },
      });
      return;
    }
    if ('statusCode' in error && error.statusCode === 413) {
      const code = request.url.startsWith('/api/audio/transcriptions')
        ? 'AUDIO_TOO_LARGE'
        : 'ATTACHMENT_TOO_LARGE';
      void reply.code(413).send({ error: { code, message: 'Request failed' } });
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

  app.addHook('onReady', async () => {
    await appServer.start();
    pushDispatcher?.start();
    if (dependencies.resourceBroker) void reconcileStartupResources();
    requestQueuedTurnDispatch();
  });
  app.addHook('onClose', async () => {
    serverClosing = true;
    if (resourceStartupRetry) clearTimeout(resourceStartupRetry);
    if (codexUpdateStartupRetry) clearTimeout(codexUpdateStartupRetry);
    if (queuedTurnRetry) clearTimeout(queuedTurnRetry);
    clearAccountLoginTimer();
    unsubscribe();
    unsubscribeLifecycle();
    await queuedTurnDispatch?.catch(() => undefined);
    await pushDispatcher?.close();
    await appServer.stop();
    repository.close();
  });

  app.get('/api/health', (_request, reply) => {
    const ready = appServer.ready;
    const requested = upgradeDrainRequested();
    const activeTurnCount = activeRootCount();
    const activeSubagents = repository.countActiveSubagents();
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      appServerReady: ready,
      upgradeDrain: {
        supported: true,
        requested,
        acceptingNewTurns: !requested,
        activeTurns: activeTurnCount,
        activeSubagents,
        activeExecutionUnits: activeTurnCount + pendingTurnStarts + activeSubagents,
        pendingTurnStarts,
        idle:
          requested && activeTurnCount === 0 && pendingTurnStarts === 0 && activeSubagents === 0,
      },
      resources: { state: repository.getResourceLimits().state },
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

  app.post(
    '/api/audio/transcriptions',
    { bodyLimit: MAX_TRANSCRIPTION_BYTES + 16_384 },
    async (request) => {
      const context = csrfGuard(auth, request);
      if (codexUpdateInterlocked || upgradeDrainRequested())
        throw new HttpError(409, 'CODEX_UPDATE_PENDING');
      const transcriptionClient = dependencies.transcriptionClient;
      if (!transcriptionClient)
        throw new HttpError(503, 'TRANSCRIPTION_UNAVAILABLE', 'Transcription is unavailable');
      if (!Buffer.isBuffer(request.body)) throw new HttpError(400, 'MULTIPART_FILE_REQUIRED');
      const contentType = request.headers['content-type'];
      if (typeof contentType !== 'string') throw new HttpError(400, 'MULTIPART_FILE_REQUIRED');
      const parsedIdempotencyKey = transcriptionIdempotencyKeySchema.safeParse(
        request.headers['idempotency-key'],
      );
      if (!parsedIdempotencyKey.success)
        throw new HttpError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency key is required');
      const upload = parseAudioMultipart(contentType, request.body);
      const now = Date.now();
      for (const [key, entry] of transcriptionIdempotency) {
        if (entry.expiresAt <= now) transcriptionIdempotency.delete(key);
      }
      for (const [sessionId, timestamps] of transcriptionAttempts) {
        const recent = timestamps.filter(
          (timestamp) => timestamp > now - TRANSCRIPTION_RATE_WINDOW_MS,
        );
        if (recent.length === 0) transcriptionAttempts.delete(sessionId);
        else transcriptionAttempts.set(sessionId, recent);
      }
      const attempts = transcriptionAttempts.get(context.sessionId) ?? [];
      if (attempts.length >= TRANSCRIPTION_RATE_LIMIT)
        throw new HttpError(429, 'TRANSCRIPTION_RATE_LIMITED', 'Transcription rate limit exceeded');
      attempts.push(now);
      transcriptionAttempts.set(context.sessionId, attempts);
      const idempotencyKey = `${context.sessionId}:${parsedIdempotencyKey.data}`;
      const transcriptionHash = createHash('sha256')
        .update(upload.mimeType)
        .update('\0')
        .update(upload.name)
        .update('\0')
        .update(upload.bytes)
        .digest('hex');
      const existing = transcriptionIdempotency.get(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== transcriptionHash)
          throw new HttpError(409, 'IDEMPOTENCY_CONFLICT');
        return await existing.result;
      }
      if (transcriptionIdempotency.size >= MAX_TRANSCRIPTION_IDEMPOTENCY_ENTRIES)
        throw new HttpError(503, 'TRANSCRIPTION_IDEMPOTENCY_CAPACITY');
      if (activeTranscriptions >= 1)
        throw new HttpError(429, 'TRANSCRIPTION_BUSY', 'Transcription is busy');
      const result = (async () => {
        activeTranscriptions += 1;
        try {
          return {
            text: await transcriptionClient.transcribe(upload, parsedIdempotencyKey.data),
          };
        } finally {
          activeTranscriptions -= 1;
        }
      })();
      transcriptionIdempotency.set(idempotencyKey, {
        requestHash: transcriptionHash,
        expiresAt: now + TRANSCRIPTION_IDEMPOTENCY_TTL_MS,
        result,
      });
      return await result;
    },
  );

  app.get('/api/preferences/runtime', (request) => {
    auth.authenticate(request);
    return { data: repository.getRuntimePreferences() };
  });

  app.put('/api/preferences/runtime', (request) => {
    csrfGuard(auth, request);
    const input = updateRuntimePreferencesRequestSchema.parse(request.body);
    const preferences = repository.setRuntimePreferences(input);
    repository.audit('runtime_preferences.update', 'succeeded');
    return { data: preferences };
  });

  app.get('/api/system/codex-update', async (request) => {
    auth.authenticate(request);
    return { data: await codexUpdateStatus() };
  });

  app.get('/api/system/codex-update/discovery', async (request) => {
    auth.authenticate(request);
    if (!dependencies.codexVersionChecker)
      throw new HttpError(503, 'CODEX_VERSION_CHECK_UNAVAILABLE');
    return {
      data: codexVersionDiscoverySchema.parse(
        await dependencies.codexVersionChecker.check(config.codexVersionPin),
      ),
    };
  });

  app.post('/api/system/codex-update/check', async (request) => {
    csrfGuard(auth, request);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    if (!dependencies.codexVersionChecker)
      throw new HttpError(503, 'CODEX_VERSION_CHECK_UNAVAILABLE');
    const discovery = codexVersionDiscoverySchema.parse(
      await dependencies.codexVersionChecker.check(config.codexVersionPin, true),
    );
    repository.audit('codex_update.check', 'succeeded', {
      state: discovery.state,
      latestVersion: discovery.latestVersion,
    });
    return { data: discovery };
  });

  app.post('/api/system/codex-update/apply', async (request, reply) => {
    csrfGuard(auth, request);
    applyCodexUpdateRequestSchema.parse(request.body ?? {});
    if (codexUpdateInterlocked) throw new HttpError(409, 'CODEX_UPDATE_PENDING');
    if (codexUpdateWorkActive() || upgradeDrainRequested())
      throw new HttpError(
        409,
        'CODEX_UPDATE_BUSY',
        'Codex update requires all work and account login to be idle',
      );
    if (!dependencies.codexUpdateBroker)
      throw new HttpError(503, 'CODEX_UPDATE_UNAVAILABLE', 'Codex update broker is unavailable');

    codexUpdateApplyPending = true;
    codexUpdateGeneration += 1;
    codexUpdateInterlocked = true;
    try {
      const before = await codexUpdateStatus();
      if (!['ready', 'failed', 'unavailable'].includes(before.state)) {
        codexUpdateApplyPending = false;
        codexUpdateInterlocked = before.state === 'applying' || before.state === 'rollback_failed';
        throw new HttpError(
          409,
          before.state === 'applying' ? 'CODEX_UPDATE_PENDING' : 'CODEX_UPDATE_NOT_READY',
        );
      }
      codexUpdateInterlocked = true;
      const snapshot = codexUpdateSnapshotSchema.parse(
        await dependencies.codexUpdateBroker.apply(),
      );
      codexUpdateApplyPending = false;
      if (snapshot.state !== 'applying') {
        codexUpdateInterlocked = true;
        throw new HttpError(502, 'CODEX_UPDATE_NOT_STARTED');
      }
      codexUpdateInterlocked = true;
      repository.audit('codex_update.apply', 'accepted', {
        currentVersion: snapshot.currentVersion,
        availableVersion: snapshot.availableVersion,
        candidateReleaseId: snapshot.candidateReleaseId,
      });
      return reply.code(202).send({ data: snapshot });
    } catch (error) {
      codexUpdateApplyPending = false;
      if (error instanceof CodexUpdateBrokerError)
        throw new HttpError(503, error.code, error.message);
      throw error;
    }
  });

  app.get('/api/system/resource-limits', async (request) => {
    auth.authenticate(request);
    const snapshot = await brokerSnapshot();
    return { data: publicResourceSnapshot(snapshot) };
  });

  app.put('/api/system/resource-limits', async (request, reply) => {
    csrfGuard(auth, request);
    if (codexUpdateInterlocked || upgradeDrainRequested())
      throw new HttpError(409, 'CODEX_UPDATE_PENDING');
    const input = updateResourceLimitsRequestSchema.parse(request.body);
    const capacity = await brokerSnapshot();
    if (input.desired.mode === 'custom') {
      if (
        input.desired.cpuCores! > capacity.capacity.cpuQuotaPercent / 100 ||
        input.desired.memoryBytes! > capacity.capacity.memoryBytes ||
        input.desired.tasks! > capacity.capacity.tasks
      )
        throw new HttpError(
          409,
          'RESOURCE_LIMIT_EXCEEDS_CAPACITY',
          'Requested resource limit exceeds current host capacity',
        );
      if (
        input.desired.maxParallelAgents !== null &&
        input.desired.maxParallelAgents >
          safeParallelAgents(Math.round(input.desired.cpuCores! * 100), input.desired.memoryBytes!)
      )
        throw new HttpError(
          409,
          'RESOURCE_AGENT_LIMIT_EXCEEDS_CAPACITY',
          'Agent concurrency exceeds the selected CPU and memory ceilings',
        );
    }
    const updated = repository.setResourceLimitDesired(
      input.desired,
      input.expectedVersion,
      'pending-idle',
    );
    if (!updated) throw new HttpError(409, 'RESOURCE_LIMIT_VERSION_CONFLICT');
    repository.audit('resource_limits.update', 'succeeded', {
      version: updated.version,
      mode: updated.desired.mode,
    });
    if (resourceWorkActive())
      return reply.code(202).send({ data: publicResourceSnapshot(capacity) });
    const applied = await applyPendingResources();
    return reply.code(200).send({ data: applied });
  });

  app.post('/api/system/resource-limits/apply', async (request, reply) => {
    csrfGuard(auth, request);
    if (codexUpdateInterlocked || upgradeDrainRequested())
      throw new HttpError(409, 'CODEX_UPDATE_PENDING');
    const input = applyResourceLimitsRequestSchema.parse(request.body);
    const stored = repository.getResourceLimits();
    if (stored.version !== input.expectedVersion)
      throw new HttpError(409, 'RESOURCE_LIMIT_VERSION_CONFLICT');
    const hash = requestHash({ version: input.expectedVersion });
    const operation = 'resource-limits:apply';
    const reservation = repository.reserveIdempotent(operation, input.idempotencyKey, hash);
    if (!reservation.reserved) {
      if (reservation.record.requestHash !== hash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT');
      if (reservation.record.state === 'completed')
        return reply.code(200).send(reservation.record.response);
      throw new HttpError(409, 'IDEMPOTENCY_PENDING');
    }
    if (resourceWorkActive()) {
      const snapshot = publicResourceSnapshot(await brokerSnapshot());
      const response = { data: snapshot };
      repository.completeIdempotent(operation, input.idempotencyKey, hash, response);
      repository.audit('resource_limits.apply', 'deferred', { version: stored.version });
      return reply.code(202).send(response);
    }
    try {
      const snapshot = await applyPendingResources();
      const response = { data: snapshot };
      repository.completeIdempotent(operation, input.idempotencyKey, hash, response);
      return reply.code(200).send(response);
    } catch (error) {
      repository.markIdempotentUnknown(operation, input.idempotencyKey, hash);
      throw error;
    }
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
          mapThread(
            rpcThread,
            project.id,
            query.archived,
            existing?.instructionSources ?? [],
            undefined,
            existing,
            activeTurnIdForThread(rpcThread.id),
            repository.countActiveSubagentsForRoot(rpcThread.id) > 0,
          ),
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
    if (codexUpdateInterlocked || upgradeDrainRequested())
      throw new HttpError(503, 'SERVICE_DRAINING');
    if (accountLoginInterlocked) throw new HttpError(409, 'CODEX_ACCOUNT_LOGIN_PENDING');
    pendingThreadStarts += 1;
    try {
      const cwd = await canonicalProjectPath(pathPolicy, project);
      const preset = input.permissionPreset ?? project.defaultPermissionPreset;
      const reasoningEffort = input.reasoningEffort ?? project.defaultReasoningEffort;
      const storedAgentLimit = repository.getResourceLimits().desired.maxParallelAgents;
      const configuredAgentLimit =
        storedAgentLimit ??
        (dependencies.resourceBroker ? autoParallelAgents(await brokerSnapshot()) : null);
      const result = threadResponseSchema.parse(
        await appServer.request('thread/start', {
          cwd,
          model: input.model ?? project.defaultModel,
          approvalPolicy: input.approvalPolicy,
          approvalsReviewer: 'user',
          sandbox: preset === 'full-access' ? 'danger-full-access' : preset,
          config:
            (reasoningEffort === null || reasoningEffort === undefined) &&
            configuredAgentLimit === null
              ? null
              : {
                  ...(reasoningEffort === null || reasoningEffort === undefined
                    ? {}
                    : { model_reasoning_effort: reasoningEffort }),
                  ...(configuredAgentLimit === null
                    ? {}
                    : { agents: { max_threads: configuredAgentLimit } }),
                },
          ephemeral: false,
          serviceName: 'codex-web-ui',
        }),
      );
      if (result.thread.cwd !== cwd) throw new HttpError(502, 'APP_SERVER_CWD_MISMATCH');
      const thread = repository.upsertThread(
        mapThread(result.thread, project.id, false, result.instructionSources, result.model),
      );
      repository.markThreadHistoryHydrated(thread.id);
      turnNavigationGenerations.set(thread.id, appServer.generation);
      loadedThreadGenerations.set(thread.id, appServer.generation);
      repository.audit('thread.start', 'succeeded', {
        projectId: project.id,
        threadId: thread.id,
        permissionPreset: preset,
      });
      return reply.code(201).send({ data: thread });
    } finally {
      pendingThreadStarts -= 1;
    }
  });

  app.get('/api/threads/:id', async (request) => {
    auth.authenticate(request);
    const id = parseId(request);
    const existing = repository.getThread(id);
    if (!existing) throw new HttpError(404, 'THREAD_NOT_FOUND');
    let thread = existing;
    if (!repository.isThreadHistoryHydrated(id)) {
      thread = await hydrateThreadHistory(existing);
    } else {
      try {
        if (turnNavigationGenerations.get(id) !== appServer.generation)
          thread = await refreshTurnNavigation(existing);
        else if (
          loadedThreadGenerations.get(id) !== appServer.generation ||
          (existing.status === 'active' && existing.activeTurnId === null)
        )
          thread = (await readThreadFromAppServer(existing, false)).thread;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        repository.audit('thread.refresh', 'failed', { threadId: id });
      }
    }
    const data = repository.getThread(id) ?? thread;
    const events = repository.listEvents(id, 0);
    return {
      data,
      events,
      eventCursor: events.at(-1)?.id ?? 0,
      turnNavigation: repository.listTurnNavigation(id),
      subagents: repository.listSubagents(id),
      queuedTurns: repository.listQueuedTurns(id).map(publicQueuedTurn),
    };
  });

  app.get('/api/threads/:id/subagents', (request) => {
    auth.authenticate(request);
    const id = parseId(request);
    if (!repository.getThread(id)) throw new HttpError(404, 'THREAD_NOT_FOUND');
    return { data: repository.listSubagents(id) };
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
    if (archived && repository.hasOutstandingQueuedTurns(id))
      throw new HttpError(409, 'QUEUED_TURNS_PENDING');
    if (thread.archived !== archived) {
      try {
        await appServer.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: id });
      } catch (error) {
        const hasUserContent = repository
          .listEvents(id, 0)
          .some((event) => event.kind === 'user-message');
        const isUnpersistedEmptyThread =
          error instanceof Error &&
          error.message === 'APP_SERVER_REQUEST_FAILED' &&
          !hasUserContent;
        if (!isUnpersistedEmptyThread) throw error;
        repository.audit(archived ? 'thread.archive' : 'thread.unarchive', 'degraded', {
          threadId: id,
          reason: 'empty_thread_not_persisted_upstream',
        });
      }
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

  app.get('/api/threads/:id/project-files/download', async (request, reply) => {
    auth.authenticate(request);
    const id = parseId(request);
    const query = projectFileQuerySchema.parse(request.query);
    const thread = repository.getThread(id);
    if (!thread) throw new HttpError(404, 'THREAD_NOT_FOUND');
    const project = repository.getProject(thread.projectId);
    if (!project) throw new HttpError(409, 'THREAD_PROJECT_MISSING');
    const projectRoot = await canonicalProjectPath(pathPolicy, project);
    const file = await downloadableProjectFile(projectRoot, query.path);
    repository.audit('project-file.download', 'succeeded', {
      threadId: id,
      size: file.size,
    });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', String(file.size));
    reply.header('Content-Disposition', safeContentDisposition(file.name, false));
    return reply.send(createReadStream(file.canonical));
  });

  const requirePushThread = (request: FastifyRequest): string => {
    csrfGuard(auth, request);
    const threadId = parseId(request);
    if (!repository.getThread(threadId)) throw new HttpError(404, 'THREAD_NOT_FOUND');
    if (!pushDispatcher) throw new HttpError(503, 'PUSH_NOTIFICATIONS_UNAVAILABLE');
    return threadId;
  };

  app.post('/api/threads/:id/push-subscriptions/status', (request) => {
    const threadId = requirePushThread(request);
    const input = pushSubscriptionStatusRequestSchema.parse(request.body);
    return { subscribed: repository.hasPushSubscription(threadId, input.endpoint) };
  });

  app.put('/api/threads/:id/push-subscriptions', (request) => {
    const threadId = requirePushThread(request);
    const input: PushSubscriptionInput = pushSubscriptionSchema.parse(request.body);
    if (!isAllowedPushEndpoint(input.endpoint))
      throw new HttpError(400, 'PUSH_ENDPOINT_NOT_ALLOWED', 'Push endpoint is not allowed');
    let subscriptionId: string;
    try {
      subscriptionId = repository.upsertPushSubscription(threadId, input);
    } catch (error) {
      if (error instanceof PushStorageLimitError)
        throw new HttpError(429, 'PUSH_SUBSCRIPTION_LIMIT_REACHED');
      throw error;
    }
    repository.audit('push.subscription', 'subscribed', { threadId, subscriptionId });
    return { subscribed: true };
  });

  app.delete('/api/threads/:id/push-subscriptions', (request) => {
    const threadId = requirePushThread(request);
    const input = pushSubscriptionStatusRequestSchema.parse(request.body);
    const subscriptionId = repository.removeThreadPushSubscription(threadId, input.endpoint);
    pushDispatcher?.cancel(threadId, subscriptionId);
    repository.audit('push.subscription', 'unsubscribed', { threadId, subscriptionId });
    return { subscribed: false };
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

  const publicQueuedTurn = (record: QueuedTurnRecord): QueuedTurn => ({
    id: record.id,
    threadId: record.threadId,
    status: 'queued',
    position: repository.queuedTurnPosition(record.id) ?? 1,
    textPreview: record.request.text.slice(0, 240),
    attachmentCount: record.request.attachmentIds.length,
    createdAt: record.createdAt,
  });

  const publishQueueChanged = (threadId: string): void => {
    publish(
      repository.appendEvent({
        threadId,
        turnId: null,
        kind: 'turn',
        phase: 'state',
        payload: { queueChanged: true },
      }),
    );
  };

  const enqueueReservedTurn = (
    threadId: string,
    input: z.infer<typeof startTurnRequestSchema>,
    requestHashValue: string,
  ): { data: z.infer<typeof startTurnResultSchema> } => {
    const claimToken = `queued:${threadId}:${input.idempotencyKey}`;
    try {
      const queued = repository.enqueueTurn({
        threadId,
        idempotencyKey: input.idempotencyKey,
        requestHash: requestHashValue,
        request: input,
        claimToken,
      }).record;
      repository.audit('turn.queue', 'succeeded', { threadId, queuedTurnId: queued.id });
      publishQueueChanged(threadId);
      return { data: { status: 'queued', queuedTurn: publicQueuedTurn(queued) } };
    } catch (error) {
      repository.releasePendingIdempotent(
        `turn:${threadId}`,
        input.idempotencyKey,
        requestHashValue,
      );
      if (error instanceof TurnQueueStorageLimitError)
        throw new HttpError(429, 'TURN_QUEUE_CAPACITY_EXHAUSTED', 'The safe task queue is full');
      if (error instanceof Error && error.message === 'ATTACHMENT_CLAIM_FAILED')
        throw new HttpError(409, 'ATTACHMENT_NOT_AVAILABLE');
      throw error;
    }
  };

  const queuedThreadIsEligible = (record: QueuedTurnRecord): boolean => {
    const thread = repository.getThread(record.threadId);
    if (!thread || thread.archived) return false;
    return (
      activeTurnIdForThread(record.threadId) === null &&
      !nativeActiveThreads.has(record.threadId) &&
      repository.countActiveSubagentsForRoot(record.threadId) === 0 &&
      thread.status !== 'active'
    );
  };

  const dispatchQueuedTurn = async (record: QueuedTurnRecord): Promise<'started' | 'wait'> => {
    if (
      serverClosing ||
      codexUpdateInterlocked ||
      upgradeDrainRequested() ||
      accountLoginInterlocked ||
      (dependencies.resourceBroker !== undefined &&
        repository.getResourceLimits().state !== 'applied')
    )
      return 'wait';
    if (!queuedThreadIsEligible(record)) return 'wait';

    let executionAgentLimit: number | undefined;
    if (!dependencies.resourceBroker) {
      if (activeRootCount() + pendingTurnStarts >= config.maxConcurrentTurns)
        await reconcileStaleExecutionCapacity();
      if (activeRootCount() + pendingTurnStarts >= config.maxConcurrentTurns) return 'wait';
      pendingTurnStarts += 1;
    } else {
      pendingTurnStarts += 1;
      try {
        const capacity = await brokerSnapshot();
        const maximumExecutionUnits =
          repository.getResourceLimits().desired.maxParallelAgents ?? autoParallelAgents(capacity);
        executionAgentLimit = maximumExecutionUnits;
        let activeExecutionUnits =
          activeRootCount() + pendingTurnStarts + repository.countActiveSubagents();
        if (activeExecutionUnits > maximumExecutionUnits) {
          await reconcileStaleExecutionCapacity();
          activeExecutionUnits =
            activeRootCount() + pendingTurnStarts + repository.countActiveSubagents();
        }
        if (
          activeExecutionUnits > maximumExecutionUnits ||
          capacity.capacity.memoryAvailableBytes < 512 * 1_024 * 1_024
        ) {
          pendingTurnStarts -= 1;
          return 'wait';
        }
      } catch {
        pendingTurnStarts -= 1;
        return 'wait';
      }
    }

    const claimed = repository.claimQueuedTurn(record.id);
    if (!claimed) {
      pendingTurnStarts -= 1;
      return 'wait';
    }
    const thread = repository.getThread(claimed.threadId);
    const project = thread && repository.getProject(thread.projectId);
    let turnStartIssued = false;
    try {
      if (!thread || thread.archived || !project) {
        repository.requeueTurn(claimed.id);
        return 'wait';
      }
      const resumeCwd = await canonicalProjectPath(pathPolicy, project);
      if (loadedThreadGenerations.get(thread.id) !== appServer.generation) {
        if (!repository.isThreadHistoryHydrated(thread.id)) await hydrateThreadHistory(thread);
        const resumed = threadResponseSchema.parse(
          await appServer.request('thread/resume', {
            threadId: thread.id,
            cwd: resumeCwd,
            excludeTurns: true,
            ...(executionAgentLimit === undefined
              ? {}
              : { config: { agents: { max_threads: executionAgentLimit } } }),
          }),
        );
        if (resumed.thread.cwd !== resumeCwd) throw new HttpError(502, 'APP_SERVER_CWD_MISMATCH');
        loadedThreadGenerations.set(thread.id, appServer.generation);
      }
      const attachments = claimed.request.attachmentIds.map((attachmentId) => {
        const attachment = repository.getAttachment(attachmentId);
        if (
          !attachment ||
          attachment.threadId !== thread.id ||
          attachment.turnId !== claimed.claimToken
        )
          throw new HttpError(409, 'ATTACHMENT_NOT_AVAILABLE');
        return attachment;
      });
      const turnCwd = await canonicalProjectPath(pathPolicy, project);
      const appInput = attachmentUserInput(claimed.request.text, attachments, (attachment) =>
        attachmentStore.localPath(project.id, thread.id, attachment.storageName),
      );
      turnStartIssued = true;
      const result = turnResponseSchema.parse(
        await appServer.request('turn/start', {
          threadId: thread.id,
          clientUserMessageId: claimed.idempotencyKey,
          input: appInput,
          cwd: turnCwd,
          model: claimed.request.model ?? project.defaultModel,
          effort: claimed.request.reasoningEffort ?? project.defaultReasoningEffort,
          approvalPolicy: claimed.request.approvalPolicy,
          approvalsReviewer: 'user',
          sandboxPolicy: sandboxPolicy(
            claimed.request.permissionPreset ?? project.defaultPermissionPreset,
            turnCwd,
          ),
        }),
      );
      if (!repository.completeQueuedTurn(claimed.id, result.turn.id))
        throw new HttpError(409, 'IDEMPOTENCY_OUTCOME_UNKNOWN');
      publishQueueChanged(thread.id);
      setActiveTurn(thread.id, result.turn.id);
      repository.updateThreadRuntime(thread.id, { status: 'active', activeTurnId: result.turn.id });
      const userEvent = repository.appendEvent({
        threadId: thread.id,
        turnId: result.turn.id,
        kind: 'user-message',
        phase: 'completed',
        payload: sanitizeEventPayload(
          { text: claimed.request.text, attachments: attachments.map(publicAttachment) },
          config.maxEventBytes,
        ),
      });
      appendTurnNavigation({
        threadId: thread.id,
        turnId: result.turn.id,
        label: normalizeTurnNavigationLabel(claimed.request.text, config.maxEventBytes),
      });
      publish(userEvent);
      repository.audit('turn.queue.dispatch', 'succeeded', {
        threadId: thread.id,
        turnId: result.turn.id,
        queuedTurnId: claimed.id,
      });
      return 'started';
    } catch {
      if (turnStartIssued) {
        repository.markQueuedTurnUnknown(claimed.id, 'IDEMPOTENCY_OUTCOME_UNKNOWN');
        publishQueueChanged(claimed.threadId);
      } else repository.requeueTurn(claimed.id);
      repository.audit('turn.queue.dispatch', turnStartIssued ? 'unknown' : 'deferred', {
        threadId: claimed.threadId,
        queuedTurnId: claimed.id,
      });
      return 'wait';
    } finally {
      pendingTurnStarts -= 1;
    }
  };

  const runQueuedTurnDispatch = async (): Promise<void> => {
    while (!serverClosing) {
      const candidates = repository.listQueuedTurns();
      if (candidates.length === 0) return;
      const candidate = candidates.find(queuedThreadIsEligible);
      if (!candidate) return;
      if ((await dispatchQueuedTurn(candidate)) !== 'started') return;
    }
  };

  requestQueuedTurnDispatch = () => {
    if (serverClosing) return;
    if (queuedTurnDispatch) {
      queuedTurnDispatchRequested = true;
      return;
    }
    queuedTurnDispatch = runQueuedTurnDispatch().finally(() => {
      queuedTurnDispatch = null;
      if (queuedTurnDispatchRequested) {
        queuedTurnDispatchRequested = false;
        queueMicrotask(requestQueuedTurnDispatch);
        return;
      }
      if (serverClosing || repository.listQueuedTurns().length === 0) return;
      if (queuedTurnRetry) clearTimeout(queuedTurnRetry);
      queuedTurnRetry = setTimeout(() => {
        queuedTurnRetry = null;
        requestQueuedTurnDispatch();
      }, 1_000);
      queuedTurnRetry.unref();
    });
  };

  app.get('/api/threads/:id/queued-turns', (request) => {
    auth.authenticate(request);
    const id = parseId(request);
    if (!repository.getThread(id)) throw new HttpError(404, 'THREAD_NOT_FOUND');
    return { data: repository.listQueuedTurns(id).map(publicQueuedTurn) };
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
    if (codexUpdateInterlocked || upgradeDrainRequested())
      throw new HttpError(503, 'SERVICE_DRAINING');
    if (accountLoginInterlocked) throw new HttpError(409, 'CODEX_ACCOUNT_LOGIN_PENDING');
    const operation = `turn:${id}`;
    const reservation = repository.reserveIdempotent(operation, input.idempotencyKey, hash);
    if (!reservation.reserved) {
      if (reservation.record.requestHash !== hash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT');
      if (reservation.record.state === 'completed') {
        const queued = repository.getQueuedTurnByIdempotency(id, input.idempotencyKey);
        if (queued?.status === 'queued')
          return reply.code(200).send({
            data: { status: 'queued', queuedTurn: publicQueuedTurn(queued) },
          });
        return reply.code(200).send(reservation.record.response);
      }
      throw new HttpError(
        409,
        reservation.record.state === 'pending'
          ? 'IDEMPOTENCY_PENDING'
          : 'IDEMPOTENCY_OUTCOME_UNKNOWN',
      );
    }
    if (upgradeDrainRequested()) {
      repository.releasePendingIdempotent(operation, input.idempotencyKey, hash);
      throw new HttpError(503, 'SERVICE_DRAINING');
    }
    if (attachments.some((attachment) => attachment.turnId !== null)) {
      repository.releasePendingIdempotent(operation, input.idempotencyKey, hash);
      throw new HttpError(409, 'ATTACHMENT_ALREADY_SENT');
    }
    if (
      repository.listQueuedTurns().length > 0 ||
      thread.status === 'active' ||
      activeTurnIdForThread(id) !== null ||
      nativeActiveThreads.has(id) ||
      repository.countActiveSubagentsForRoot(id) > 0
    ) {
      const response = enqueueReservedTurn(id, input, hash);
      requestQueuedTurnDispatch();
      return reply.code(202).send(response);
    }
    if (
      !dependencies.resourceBroker &&
      activeRootCount() + pendingTurnStarts >= config.maxConcurrentTurns
    ) {
      await reconcileStaleExecutionCapacity();
    }
    if (
      !dependencies.resourceBroker &&
      activeRootCount() + pendingTurnStarts >= config.maxConcurrentTurns
    ) {
      const response = enqueueReservedTurn(id, input, hash);
      requestQueuedTurnDispatch();
      return reply.code(202).send(response);
    }
    if (dependencies.resourceBroker) {
      const resourceState = repository.getResourceLimits().state;
      if (resourceState !== 'applied') {
        repository.releasePendingIdempotent(operation, input.idempotencyKey, hash);
        throw new HttpError(
          503,
          'RESOURCE_RECONFIGURING',
          'Resource policy must be applied before a new task can start',
        );
      }
    }
    if (codexUpdateInterlocked || upgradeDrainRequested()) {
      repository.releasePendingIdempotent(operation, input.idempotencyKey, hash);
      throw new HttpError(503, 'SERVICE_DRAINING');
    }
    if (accountLoginInterlocked) {
      repository.releasePendingIdempotent(operation, input.idempotencyKey, hash);
      throw new HttpError(409, 'CODEX_ACCOUNT_LOGIN_PENDING');
    }
    pendingTurnStarts += 1;
    let executionAgentLimit: number | undefined;
    if (dependencies.resourceBroker) {
      try {
        const capacity = await brokerSnapshot();
        const maximumExecutionUnits =
          repository.getResourceLimits().desired.maxParallelAgents ?? autoParallelAgents(capacity);
        executionAgentLimit = maximumExecutionUnits;
        let activeExecutionUnits =
          activeRootCount() + pendingTurnStarts + repository.countActiveSubagents();
        if (activeExecutionUnits > maximumExecutionUnits) {
          await reconcileStaleExecutionCapacity();
          activeExecutionUnits =
            activeRootCount() + pendingTurnStarts + repository.countActiveSubagents();
        }
        if (activeExecutionUnits > maximumExecutionUnits)
          throw new HttpError(
            429,
            'RESOURCE_CAPACITY_EXHAUSTED',
            'All resource-safe execution slots are currently in use',
          );
        if (capacity.capacity.memoryAvailableBytes < 512 * 1_024 * 1_024)
          throw new HttpError(
            429,
            'RESOURCE_CAPACITY_EXHAUSTED',
            'The host does not have enough free memory to start another task safely',
          );
      } catch (error) {
        pendingTurnStarts -= 1;
        if (error instanceof HttpError && error.code === 'RESOURCE_CAPACITY_EXHAUSTED') {
          const response = enqueueReservedTurn(id, input, hash);
          requestQueuedTurnDispatch();
          return reply.code(202).send(response);
        }
        repository.releasePendingIdempotent(operation, input.idempotencyKey, hash);
        throw error;
      }
    }
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
        let resumed: z.infer<typeof threadResponseSchema>;
        try {
          resumed = threadResponseSchema.parse(
            await appServer.request('thread/resume', {
              threadId: id,
              cwd: resumeCwd,
              excludeTurns: true,
              ...(executionAgentLimit === undefined
                ? {}
                : { config: { agents: { max_threads: executionAgentLimit } } }),
            }),
          );
        } catch (error) {
          const emptyLocalThread = repository.listEvents(id, 0, 1).length === 0;
          if (
            emptyLocalThread &&
            error instanceof Error &&
            error.message === 'APP_SERVER_REQUEST_FAILED'
          )
            throw new HttpError(
              409,
              'EMPTY_THREAD_NOT_PERSISTED',
              'Этот пустой чат был создан до перезапуска сервера и недоступен в Codex. Создайте новый чат — вложения в текущем чате можно удалить или оставить.',
            );
          throw error;
        }
        if (resumed.thread.cwd !== resumeCwd) throw new HttpError(502, 'APP_SERVER_CWD_MISMATCH');
        loadedThreadGenerations.set(id, appServer.generation);
      }
      const turnCwd = await canonicalProjectPath(pathPolicy, project);
      const appInput = attachmentUserInput(input.text, attachments, (attachment) =>
        attachmentStore.localPath(project.id, id, attachment.storageName),
      );
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
      setActiveTurn(id, result.turn.id);
      repository.updateThreadRuntime(id, { status: 'active', activeTurnId: result.turn.id });
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
    const response = { data: { status: 'started' as const, turnId: result.turn.id } };
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
    appendTurnNavigation({
      threadId: id,
      turnId: result.turn.id,
      label: normalizeTurnNavigationLabel(input.text, config.maxEventBytes),
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
    const thread = repository.getThread(id);
    if (!thread) throw new HttpError(404, 'THREAD_NOT_FOUND');
    const input = steerTurnRequestSchema.parse(request.body);
    if (new Set(input.attachmentIds).size !== input.attachmentIds.length)
      throw new HttpError(400, 'ATTACHMENT_IDS_DUPLICATED');
    const attachments = input.attachmentIds.map((attachmentId) => {
      const attachment = repository.getAttachment(attachmentId);
      if (!attachment || attachment.threadId !== id)
        throw new HttpError(400, 'ATTACHMENT_NOT_AVAILABLE');
      if (attachment.turnId !== null) throw new HttpError(409, 'ATTACHMENT_ALREADY_SENT');
      return attachment;
    });
    const project = attachments.length === 0 ? undefined : repository.getProject(thread.projectId);
    if (attachments.length > 0 && !project) throw new HttpError(409, 'THREAD_PROJECT_MISSING');
    const attachmentClaim = `pending:steer:${randomUUID()}`;
    if (!repository.claimAttachments(id, input.attachmentIds, attachmentClaim))
      throw new HttpError(409, 'ATTACHMENT_NOT_AVAILABLE');
    let result: { turnId: string };
    let steerIssued = false;
    try {
      const appInput = attachmentUserInput(input.text, attachments, (attachment) =>
        attachmentStore.localPath(project!.id, id, attachment.storageName),
      );
      steerIssued = true;
      result = z.object({ turnId: z.string() }).parse(
        await appServer.request('turn/steer', {
          threadId: id,
          expectedTurnId: input.expectedTurnId,
          input: appInput,
        }),
      );
    } catch (error) {
      if (!steerIssued || (error instanceof Error && error.message === 'APP_SERVER_UNAVAILABLE'))
        repository.releaseAttachmentClaims(id, attachmentClaim);
      return throwTurnCommandFailure(
        thread,
        error,
        input.expectedTurnId,
        () => {
          publish(
            repository.appendEvent({
              threadId: id,
              turnId: input.expectedTurnId,
              kind: 'user-message',
              phase: 'state',
              payload: {
                ...sanitizeEventPayload(
                  { text: input.text, attachments: attachments.map(publicAttachment) },
                  config.maxEventBytes,
                ),
                outcomeUnknown: true,
              },
            }),
          );
        },
        () => repository.releaseAttachmentClaims(id, attachmentClaim),
      );
    }
    if (attachments.length > 0)
      repository.finalizeAttachmentClaims(id, attachmentClaim, result.turnId);
    const userEvent = repository.appendEvent({
      threadId: id,
      turnId: result.turnId,
      kind: 'user-message',
      phase: 'completed',
      payload: sanitizeEventPayload(
        { text: input.text, attachments: attachments.map(publicAttachment) },
        config.maxEventBytes,
      ),
    });
    appendTurnNavigation({
      threadId: id,
      turnId: result.turnId,
      label: normalizeTurnNavigationLabel(input.text, config.maxEventBytes),
    });
    publish(userEvent);
    repository.audit('turn.steer', 'succeeded', { threadId: id, turnId: result.turnId });
    return reply.code(202).send({ data: result });
  });

  app.post('/api/threads/:id/interrupt', async (request) => {
    csrfGuard(auth, request);
    const id = parseId(request);
    const thread = repository.getThread(id);
    if (!thread) throw new HttpError(404, 'THREAD_NOT_FOUND');
    const input = interruptBodySchema.parse(request.body);
    try {
      await appServer.request('turn/interrupt', { threadId: id, turnId: input.turnId });
    } catch (error) {
      return throwTurnCommandFailure(thread, error, input.turnId);
    }
    const event = repository.appendEvent({
      threadId: id,
      turnId: input.turnId,
      kind: 'turn',
      phase: 'state',
      payload: { status: 'interruptRequested', runtime: true },
    });
    publish(event);
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

  app.get('/api/system/codex-account/login', (request) => {
    auth.authenticate(request);
    return { data: codexAccountLoginSchema.parse(accountLogin) };
  });

  app.post('/api/system/codex-account/login', async (request, reply) => {
    csrfGuard(auth, request);
    const input = codexAccountLoginRequestSchema.parse(request.body);
    if (codexUpdateInterlocked || upgradeDrainRequested())
      throw new HttpError(409, 'CODEX_UPDATE_PENDING');
    if (accountLoginInterlocked) throw new HttpError(409, 'CODEX_ACCOUNT_LOGIN_PENDING');
    if (resourceWorkActive() || pendingThreadStarts > 0)
      throw new HttpError(
        409,
        'CODEX_ACCOUNT_LOGIN_BUSY',
        'Account login requires all tasks and subagents to be idle',
      );

    accountLoginInterlocked = true;
    accountLoginStartInFlight = true;
    const loginAttempt = ++accountLoginAttempt;
    earlyAccountLoginCompletion = null;
    accountLogin = codexAccountLoginSchema.parse({
      state: 'pending',
      loginId: null,
      userCode: null,
      verificationUrl: null,
      expiresAt: null,
      message: null,
    });
    let loginResponse: unknown;
    try {
      loginResponse = await appServer.request('account/login/start', input);
      accountLoginStartInFlight = false;
    } catch (error) {
      accountLoginStartInFlight = false;
      takeEarlyAccountLoginCompletion();
      // A rejected or timed-out start RPC is ambiguous: Codex may have accepted the
      // login before the transport failed. Without a returned id, no completion
      // can be correlated safely, so keep admission fail-closed until restart.
      throw error;
    }
    const parsed = upstreamAccountLoginResponseSchema.safeParse(loginResponse);
    if (loginAttempt !== accountLoginAttempt || !accountLoginInterlocked) {
      if (parsed.success)
        void appServer
          .request('account/login/cancel', { loginId: parsed.data.loginId })
          .catch(() => undefined);
      throw new HttpError(409, 'CODEX_ACCOUNT_LOGIN_CANCELLED');
    }
    if (!parsed.success) {
      const safeLoginId = accountLoginIdSchema.safeParse(
        typeof loginResponse === 'object' && loginResponse !== null
          ? (loginResponse as { loginId?: unknown }).loginId
          : undefined,
      );
      const earlyCompletion = takeEarlyAccountLoginCompletion();
      if (safeLoginId.success) {
        accountLogin = codexAccountLoginSchema.parse({
          state: 'pending',
          loginId: safeLoginId.data,
          userCode: null,
          verificationUrl: null,
          expiresAt: null,
          message: 'Account login response was invalid; cancellation is required.',
        });
        if (earlyCompletion?.loginId === safeLoginId.data) {
          setTerminalAccountLogin(
            earlyCompletion.success ? 'succeeded' : 'failed',
            earlyCompletion.success ? 'Account connected.' : 'Account login failed.',
            safeLoginId.data,
          );
        } else {
          try {
            requireConfirmedAccountLoginCancellation(
              await appServer.request('account/login/cancel', { loginId: safeLoginId.data }),
            );
            setTerminalAccountLogin(
              'failed',
              'Account login could not be started.',
              safeLoginId.data,
            );
          } catch {
            // Keep admission fail-closed until a matching completion or process restart.
          }
        }
      }
      throw new HttpError(502, 'CODEX_ACCOUNT_LOGIN_INVALID_RESPONSE');
    }
    const expiresAt = new Date(Date.now() + accountLoginTimeoutMs).toISOString();
    accountLogin = codexAccountLoginSchema.parse({
      state: 'pending',
      loginId: parsed.data.loginId,
      userCode: parsed.data.userCode,
      verificationUrl: parsed.data.verificationUrl,
      expiresAt,
      message: null,
    });
    const earlyCompletion = takeEarlyAccountLoginCompletion();
    if (earlyCompletion?.loginId === parsed.data.loginId) {
      setTerminalAccountLogin(
        earlyCompletion.success ? 'succeeded' : 'failed',
        earlyCompletion.success ? 'Account connected.' : 'Account login failed.',
        parsed.data.loginId,
      );
    } else {
      accountLoginTimer = setTimeout(() => {
        if (accountLogin.state !== 'pending' || accountLogin.loginId !== parsed.data.loginId)
          return;
        void (async () => {
          try {
            requireConfirmedAccountLoginCancellation(
              await appServer.request('account/login/cancel', {
                loginId: parsed.data.loginId,
              }),
            );
            setTerminalAccountLogin('failed', 'Account login expired.', parsed.data.loginId);
          } catch {
            // Keep admission fail-closed until Codex reports this login complete or the process restarts.
          }
        })();
      }, accountLoginTimeoutMs);
      accountLoginTimer.unref();
    }
    return reply.code(202).send({ data: codexAccountLoginSchema.parse(accountLogin) });
  });

  app.delete('/api/system/codex-account/login', async (request) => {
    csrfGuard(auth, request);
    if (accountLogin.state === 'pending' && accountLogin.loginId === null)
      throw new HttpError(409, 'CODEX_ACCOUNT_LOGIN_STARTING');
    if (accountLogin.state !== 'pending') {
      accountLoginAttempt += 1;
      resetAccountLogin();
      return { data: codexAccountLoginSchema.parse(accountLogin) };
    }
    const loginId = accountLogin.loginId;
    if (loginId === null) throw new HttpError(409, 'CODEX_ACCOUNT_LOGIN_STARTING');
    requireConfirmedAccountLoginCancellation(
      await appServer.request('account/login/cancel', { loginId }),
    );
    accountLoginAttempt += 1;
    resetAccountLogin(loginId);
    return { data: codexAccountLoginSchema.parse(accountLogin) };
  });

  app.get('/api/system/capabilities', async (request) => {
    auth.authenticate(request);
    const query = z
      .object({ threadId: z.string().min(1).max(200).optional() })
      .parse(request.query);
    if (query.threadId !== undefined && !repository.getThread(query.threadId))
      throw new HttpError(404, 'THREAD_NOT_FOUND');
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
    let threadUsage: z.infer<typeof threadUsageSchema> | null = null;
    const [rateLimitsResult, usageResult, threadUsageResult] = await Promise.allSettled([
      appServer.request('account/rateLimits/read', null),
      appServer.request('account/usage/read', null),
      query.threadId === undefined
        ? Promise.resolve(null)
        : appServer.request('account/usage/read', { threadId: query.threadId }),
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
    if (query.threadId !== undefined && threadUsageResult.status === 'fulfilled') {
      try {
        const parsed = threadUsageResponseSchema.parse(threadUsageResult.value);
        threadUsage =
          parsed.threadUsage === null
            ? null
            : publicThreadUsage(query.threadId, parsed.threadUsage);
      } catch {
        warnings.push('Codex thread usage is unavailable.');
      }
    } else if (query.threadId !== undefined) {
      warnings.push('Codex thread usage is unavailable.');
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
      authenticated: account.account != null,
      account: publicCodexAccount(account.account),
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
      threadUsage,
      transcription: {
        available: dependencies.transcriptionClient !== undefined,
        model: config.transcriptionModel,
        maxBytes: MAX_TRANSCRIPTION_BYTES,
        maxDurationSeconds: MAX_TRANSCRIPTION_DURATION_SECONDS,
      },
      notifications: {
        available: pushDispatcher !== undefined,
        vapidPublicKey: config.vapid?.publicKey ?? null,
      },
      warnings,
    });
  });

  if (dependencies.codexUpdateBroker) {
    // Keep admission closed after an unavailable/ambiguous broker read, but
    // reconcile automatically once the socket-activated broker is ready.
    await reconcileStartupCodexUpdate();
  }

  return app;
}
