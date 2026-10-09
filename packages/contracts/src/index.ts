import { z } from 'zod';

export const permissionPresetSchema = z.enum(['read-only', 'workspace-write', 'full-access']);
export type PermissionPreset = z.infer<typeof permissionPresetSchema>;

export const approvalPolicySchema = z.enum(['untrusted', 'on-request', 'never']);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const runtimePreferencesSchema = z.object({
  model: z.string().min(1).max(120).nullable(),
  reasoningEffort: z.string().min(1).max(40).nullable(),
  permissionPreset: permissionPresetSchema,
  approvalPolicy: approvalPolicySchema,
  updatedAt: z.string().datetime(),
});
export type RuntimePreferences = z.infer<typeof runtimePreferencesSchema>;

export const updateRuntimePreferencesRequestSchema = runtimePreferencesSchema.omit({
  updatedAt: true,
});

const nullableCpuCoresSchema = z.number().finite().min(0.25).max(4_096).nullable();
const nullableResourceIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();

export const resourceLimitPolicySchema = z
  .object({
    mode: z.enum(['auto', 'custom']),
    cpuCores: nullableCpuCoresSchema,
    memoryBytes: nullableResourceIntegerSchema,
    tasks: z.number().int().min(64).max(4_194_304).nullable(),
    maxParallelAgents: z.number().int().min(1).max(64).nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.mode === 'auto' &&
      [value.cpuCores, value.memoryBytes, value.tasks, value.maxParallelAgents].some(
        (item) => item !== null,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Automatic resource policy cannot contain custom ceilings',
      });
    if (
      value.mode === 'custom' &&
      [value.cpuCores, value.memoryBytes, value.tasks].some((item) => item === null)
    )
      context.addIssue({
        code: 'custom',
        message: 'Custom resource policy requires CPU, memory and task ceilings',
      });
  });
export type ResourceLimitPolicy = z.infer<typeof resourceLimitPolicySchema>;

export const resourceLimitSnapshotSchema = z.object({
  capacity: z.object({
    cpuCores: z.number().finite().positive(),
    memoryBytes: z.number().int().positive(),
    memoryAvailableBytes: z.number().int().nonnegative(),
    tasks: z.number().int().positive(),
    measuredAt: z.string().datetime(),
  }),
  desired: resourceLimitPolicySchema,
  effective: z.object({
    cpuCores: z.number().finite().positive(),
    memoryBytes: z.number().int().positive(),
    tasks: z.number().int().positive(),
    maxParallelAgents: z.number().int().min(1).max(64),
  }),
  state: z.enum(['applied', 'pending-idle', 'applying', 'degraded']),
  version: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  appliedAt: z.string().datetime().nullable(),
  warning: z.string().max(2_000).nullable(),
});
export type ResourceLimitSnapshot = z.infer<typeof resourceLimitSnapshotSchema>;

export const updateResourceLimitsRequestSchema = z.object({
  desired: resourceLimitPolicySchema,
  expectedVersion: z.number().int().nonnegative(),
});

export const applyResourceLimitsRequestSchema = z.object({
  idempotencyKey: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
});

export const codexUpdateResultSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'rollback_failed']),
  message: z.string().min(1).max(2_000),
  completedAt: z.string().datetime(),
});

export const codexUpdateSnapshotSchema = z.object({
  state: z.enum(['unavailable', 'ready', 'applying', 'current', 'failed', 'rollback_failed']),
  currentVersion: z.string().regex(/^codex-cli \d+\.\d+\.\d+$/),
  availableVersion: z
    .string()
    .regex(/^codex-cli \d+\.\d+\.\d+$/)
    .nullable(),
  candidateReleaseId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/)
    .nullable(),
  lastResult: codexUpdateResultSchema.nullable(),
});
export type CodexUpdateSnapshot = z.infer<typeof codexUpdateSnapshotSchema>;

export const applyCodexUpdateRequestSchema = z.object({}).strict();
export type ApplyCodexUpdateRequest = z.infer<typeof applyCodexUpdateRequestSchema>;

export const codexVersionDiscoverySchema = z.object({
  state: z.enum(['current', 'available', 'failed']),
  currentVersion: z.string().regex(/^codex-cli \d+\.\d+\.\d+$/),
  latestVersion: z
    .string()
    .regex(/^codex-cli \d+\.\d+\.\d+$/)
    .nullable(),
  checkedAt: z.string().datetime(),
});
export type CodexVersionDiscovery = z.infer<typeof codexVersionDiscoverySchema>;

export const subagentStatusSchema = z.enum([
  'pendingInit',
  'running',
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound',
]);
export type SubagentStatus = z.infer<typeof subagentStatusSchema>;

export const subagentSchema = z.object({
  id: z.string().min(1).max(200),
  rootThreadId: z.string().min(1).max(200),
  parentThreadId: z.string().min(1).max(200),
  agentPath: z.string().min(1).max(500).nullable(),
  nickname: z.string().min(1).max(120).nullable(),
  role: z.string().min(1).max(120).nullable(),
  model: z.string().min(1).max(120).nullable(),
  reasoningEffort: z.string().min(1).max(40).nullable(),
  status: subagentStatusSchema,
  message: z.string().max(2_000).nullable(),
  startedAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type Subagent = z.infer<typeof subagentSchema>;

export const loginRequestSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(12).max(1024),
});

export const sessionSchema = z.object({
  authenticated: z.literal(true),
  username: z.string(),
  csrfToken: z.string(),
  expiresAt: z.string().datetime(),
});
export type Session = z.infer<typeof sessionSchema>;

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  path: z.string().min(1),
  archived: z.boolean(),
  defaultModel: z.string().nullable(),
  defaultReasoningEffort: z.string().nullable(),
  defaultPermissionPreset: permissionPresetSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectListQuerySchema = z.object({
  archived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const createProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(4096),
  defaultModel: z.string().trim().min(1).max(120).nullable().optional(),
  defaultReasoningEffort: z.string().trim().min(1).max(40).nullable().optional(),
  defaultPermissionPreset: permissionPresetSchema.default('workspace-write'),
});

export const modelOptionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  isDefault: z.boolean(),
  defaultReasoningEffort: z.string().nullable(),
  supportedReasoningEfforts: z.array(
    z.object({
      reasoningEffort: z.string(),
      description: z.string().nullable(),
    }),
  ),
});
export type ModelOption = z.infer<typeof modelOptionSchema>;

export const threadStatusSchema = z.enum(['notLoaded', 'idle', 'active', 'systemError', 'unknown']);
export const threadSchema = z.object({
  id: z.string(),
  projectId: z.string().uuid(),
  name: z.string().nullable(),
  preview: z.string(),
  model: z.string().nullable(),
  status: threadStatusSchema,
  activeTurnId: z.string().nullable(),
  archived: z.boolean(),
  instructionSources: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Thread = z.infer<typeof threadSchema>;

export const turnNavigationEntrySchema = z.object({
  id: z.number().int().positive(),
  threadId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  label: z.string().min(1).max(2_000),
});
export type TurnNavigationEntry = z.infer<typeof turnNavigationEntrySchema>;

export const threadListQuerySchema = z.object({
  projectId: z.string().uuid(),
  archived: z.coerce.boolean().default(false),
  cursor: z.string().optional(),
});

export const startThreadRequestSchema = z.object({
  projectId: z.string().uuid(),
  model: z.string().min(1).max(120).optional(),
  reasoningEffort: z.string().min(1).max(40).optional(),
  permissionPreset: permissionPresetSchema.optional(),
  approvalPolicy: approvalPolicySchema.default('on-request'),
});

export const startTurnRequestSchema = z
  .object({
    text: z.string().trim().max(100_000),
    attachmentIds: z.array(z.string().uuid()).max(8).default([]),
    model: z.string().min(1).max(120).optional(),
    reasoningEffort: z.string().min(1).max(40).optional(),
    permissionPreset: permissionPresetSchema.optional(),
    approvalPolicy: approvalPolicySchema.optional(),
    idempotencyKey: z.string().uuid(),
  })
  .refine((value) => value.text.length > 0 || value.attachmentIds.length > 0, {
    message: 'A turn requires text or at least one attachment',
  });
export type StartTurnRequest = z.infer<typeof startTurnRequestSchema>;

const queuedTurnBaseSchema = z.object({
  id: z.number().int().positive(),
  threadId: z.string().min(1).max(200),
  textPreview: z.string().max(240),
  attachmentCount: z.number().int().min(0).max(8),
  createdAt: z.string().datetime(),
});
export const queuedTurnSchema = z.discriminatedUnion('status', [
  queuedTurnBaseSchema.extend({
    status: z.literal('queued'),
    position: z.number().int().positive(),
    errorCode: z.null(),
  }),
  queuedTurnBaseSchema.extend({
    status: z.literal('needsReview'),
    position: z.null(),
    errorCode: z.string().min(1).max(120),
  }),
]);
export type QueuedTurn = z.infer<typeof queuedTurnSchema>;

export const reconcileQueuedTurnRequestSchema = z
  .object({
    action: z.enum(['check', 'dismissLocal']).default('check'),
  })
  .default({ action: 'check' });
export type ReconcileQueuedTurnRequest = z.infer<typeof reconcileQueuedTurnRequestSchema>;

export const reconcileQueuedTurnResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('resolved'), turnId: z.string().min(1) }),
  z.object({ status: z.literal('dismissed') }),
  z.object({
    status: z.literal('stillNeedsReview'),
    reason: z.enum(['notFound', 'readFailed', 'startMayStillArrive']),
    canDismissLocal: z.boolean().default(false),
  }),
]);
export type ReconcileQueuedTurnResult = z.infer<typeof reconcileQueuedTurnResultSchema>;

export const startTurnResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('started'), turnId: z.string().min(1) }),
  z.object({ status: z.literal('queued'), queuedTurn: queuedTurnSchema }),
]);
export type StartTurnResult = z.infer<typeof startTurnResultSchema>;

export const attachmentKindSchema = z.enum(['image', 'file']);
export const attachmentSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().min(1).max(200),
  name: z.string().min(1).max(180),
  mediaType: z.string().min(1).max(120),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(20 * 1_024 * 1_024),
  kind: attachmentKindSchema,
  createdAt: z.string().datetime(),
  url: z.string().startsWith('/api/threads/'),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const steerTurnRequestSchema = z
  .object({
    text: z.string().trim().max(100_000),
    attachmentIds: z.array(z.string().uuid()).max(8).default([]),
    expectedTurnId: z.string().min(1),
  })
  .refine((value) => value.text.length > 0 || value.attachmentIds.length > 0, {
    message: 'A steer requires text or at least one attachment',
  });

export const eventKindSchema = z.enum([
  'thread',
  'turn',
  'user-message',
  'agent-message',
  'plan',
  'command',
  'file-change',
  'tool',
  'approval',
  'user-input',
  'permission-approval',
  'usage',
  'warning',
  'error',
  'subagent',
]);

export const safeEventSchema = z.object({
  id: z.number().int().nonnegative(),
  threadId: z.string(),
  turnId: z.string().nullable(),
  kind: eventKindSchema,
  phase: z.enum(['started', 'delta', 'completed', 'failed', 'state']),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type SafeEvent = z.infer<typeof safeEventSchema>;

export const pendingApprovalSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string(),
  turnId: z.string().nullable(),
  rpcRequestId: z.union([z.string(), z.number()]),
  method: z.string(),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'accepted', 'declined', 'cancelled']),
  createdAt: z.string().datetime(),
});
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

export const userInputQuestionSchema = z.object({
  id: z.string().min(1).max(200),
  header: z.string().max(200),
  question: z.string().min(1).max(4_000),
  options: z
    .array(z.object({ label: z.string().max(500), description: z.string().max(2_000) }))
    .max(20)
    .nullable(),
  isOther: z.boolean(),
  isSecret: z.boolean(),
});
export type UserInputQuestion = z.infer<typeof userInputQuestionSchema>;

export const resolveUserInputRequestSchema = z.object({
  answers: z.record(
    z.string().min(1).max(200),
    z.object({ answers: z.array(z.string().max(8_000)).max(20) }),
  ),
});
export type ResolveUserInputRequest = z.infer<typeof resolveUserInputRequestSchema>;

export const resolvePermissionRequestSchema = z.object({
  decision: z.enum(['grant', 'deny']),
  scope: z.literal('turn').default('turn'),
});
export type ResolvePermissionRequest = z.infer<typeof resolvePermissionRequestSchema>;

export const resolveApprovalRequestSchema = z.object({
  decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
});

const pushKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .min(16)
  .max(512);

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().startsWith('https://').max(2_048),
  expirationTime: z.number().int().nonnegative().nullable(),
  keys: z.object({
    p256dh: pushKeySchema,
    auth: pushKeySchema,
  }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

export const pushSubscriptionStatusRequestSchema = z.object({
  endpoint: z.string().url().startsWith('https://').max(2_048),
});

export const rateLimitWindowSchema = z.object({
  usedPercent: z.number().int().min(0).max(100),
  windowDurationMins: z.number().int().positive().nullable(),
  resetsAt: z.number().int().nonnegative().nullable(),
});

export const accountRateLimitSchema = z.object({
  limitId: z.string().min(1).max(120).nullable(),
  limitName: z.string().min(1).max(200).nullable(),
  planType: z.string().min(1).max(80).nullable(),
  primary: rateLimitWindowSchema.nullable(),
  secondary: rateLimitWindowSchema.nullable(),
});

export const accountUsageSchema = z.object({
  summary: z.object({
    lifetimeTokens: z.number().int().nonnegative().nullable(),
    currentStreakDays: z.number().int().nonnegative().nullable(),
    longestStreakDays: z.number().int().nonnegative().nullable(),
    peakDailyTokens: z.number().int().nonnegative().nullable(),
    longestRunningTurnSec: z.number().int().nonnegative().nullable(),
  }),
  dailyUsageBuckets: z
    .array(
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        tokens: z.number().int().nonnegative(),
      }),
    )
    .max(366)
    .nullable(),
});

export const threadUsageSchema = z.object({
  threadId: z.string().min(1).max(200),
  estimated: z.literal(true),
  inputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  netNewInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
});

export const turnPerformanceSampleSchema = z.object({
  turnId: z.string().min(1).max(200),
  completedAt: z.string().datetime(),
  outputTokens: z.number().int().nonnegative().nullable(),
  timeToFirstOutputMs: z.number().int().nonnegative().nullable(),
  generationDurationMs: z.number().int().nonnegative().nullable(),
  totalDurationMs: z.number().int().nonnegative(),
  generationTokensPerSecond: z.number().finite().nonnegative().max(1_000_000).nullable(),
  effectiveTokensPerSecond: z.number().finite().nonnegative().max(1_000_000).nullable(),
});

export const threadPerformanceSchema = z.object({
  threadId: z.string().min(1).max(200),
  last: turnPerformanceSampleSchema.nullable(),
  recent: z.object({
    sampleSize: z.number().int().nonnegative().max(20),
    medianGenerationTokensPerSecond: z.number().finite().nonnegative().max(1_000_000).nullable(),
    medianTimeToFirstOutputMs: z.number().int().nonnegative().nullable(),
  }),
});

export const codexAccountSchema = z.object({
  type: z.enum(['chatgpt', 'apiKey', 'amazonBedrock', 'unknown']),
  email: z.string().email().max(320).nullable(),
  planType: z.string().min(1).max(80).nullable(),
});
export type CodexAccount = z.infer<typeof codexAccountSchema>;

export const codexAccountLoginSchema = z.object({
  state: z.enum(['idle', 'pending', 'succeeded', 'failed']),
  loginId: z.string().min(1).max(200).nullable(),
  userCode: z.string().min(1).max(64).nullable(),
  verificationUrl: z.string().url().startsWith('https://').max(2_048).nullable(),
  expiresAt: z.string().datetime().nullable(),
  message: z.string().min(1).max(240).nullable(),
});
export type CodexAccountLogin = z.infer<typeof codexAccountLoginSchema>;

export const autoRateLimitResetSnapshotSchema = z.object({
  supported: z.boolean(),
  accountBinding: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  enabled: z.boolean(),
  availableCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  state: z.enum(['idle', 'waiting', 'redeeming', 'recovering', 'failed']),
  version: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  lastOutcome: z
    .enum(['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit', 'failed'])
    .nullable(),
  lastOutcomeAt: z.string().datetime().nullable(),
  resumedTaskCount: z.number().int().nonnegative(),
  message: z.string().min(1).max(240).nullable(),
});
export type AutoRateLimitResetSnapshot = z.infer<typeof autoRateLimitResetSnapshotSchema>;

export const updateAutoRateLimitResetRequestSchema = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
  accountBinding: z.string().regex(/^[a-f0-9]{64}$/),
});

export const capabilitySchema = z.object({
  codexVersion: z.string(),
  authenticated: z.boolean(),
  account: codexAccountSchema.nullable(),
  appServerReady: z.boolean(),
  projectRoots: z.array(z.string()),
  skills: z.array(z.object({ name: z.string(), path: z.string(), enabled: z.boolean() })),
  rateLimits: z.array(accountRateLimitSchema).nullable(),
  rateLimitReset: autoRateLimitResetSnapshotSchema,
  usage: accountUsageSchema.nullable(),
  threadUsage: threadUsageSchema.nullable().optional(),
  threadPerformance: threadPerformanceSchema.nullable().optional(),
  transcription: z
    .object({
      available: z.boolean(),
      model: z.string().min(1).max(120),
      maxBytes: z.number().int().positive(),
      maxDurationSeconds: z.number().int().positive(),
    })
    .optional(),
  notifications: z
    .object({
      available: z.boolean(),
      vapidPublicKey: z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .min(32)
        .max(512)
        .nullable(),
    })
    .optional(),
  warnings: z.array(z.string()),
});
export type Capability = z.infer<typeof capabilitySchema>;
