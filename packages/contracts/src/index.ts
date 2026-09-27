import { z } from 'zod';

export const permissionPresetSchema = z.enum(['read-only', 'workspace-write', 'full-access']);
export type PermissionPreset = z.infer<typeof permissionPresetSchema>;

export const approvalPolicySchema = z.enum(['untrusted', 'on-request', 'never']);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

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
  defaultModel: z.string().nullable(),
  defaultReasoningEffort: z.string().nullable(),
  defaultPermissionPreset: permissionPresetSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Project = z.infer<typeof projectSchema>;

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
  archived: z.boolean(),
  instructionSources: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Thread = z.infer<typeof threadSchema>;

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

export const startTurnRequestSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
  model: z.string().min(1).max(120).optional(),
  reasoningEffort: z.string().min(1).max(40).optional(),
  permissionPreset: permissionPresetSchema.optional(),
  approvalPolicy: approvalPolicySchema.optional(),
  idempotencyKey: z.string().uuid(),
});

export const steerTurnRequestSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
  expectedTurnId: z.string().min(1),
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

export const capabilitySchema = z.object({
  codexVersion: z.string(),
  authenticated: z.boolean(),
  appServerReady: z.boolean(),
  projectRoots: z.array(z.string()),
  skills: z.array(z.object({ name: z.string(), path: z.string(), enabled: z.boolean() })),
  warnings: z.array(z.string()),
});
export type Capability = z.infer<typeof capabilitySchema>;
