import { describe, expect, it } from 'vitest';

import {
  applyCodexUpdateRequestSchema,
  createProjectRequestSchema,
  attachmentSchema,
  codexAccountLoginSchema,
  codexUpdateSnapshotSchema,
  codexVersionDiscoverySchema,
  capabilitySchema,
  pushSubscriptionSchema,
  resolvePermissionRequestSchema,
  resolveUserInputRequestSchema,
  resourceLimitPolicySchema,
  steerTurnRequestSchema,
  subagentSchema,
  updateRuntimePreferencesRequestSchema,
  startTurnRequestSchema,
  turnNavigationEntrySchema,
} from './index.js';

describe('contracts', () => {
  it('rejects traversal-like empty project values before filesystem policy', () => {
    expect(createProjectRequestSchema.safeParse({ name: '', path: '' }).success).toBe(false);
  });

  it('requires an idempotency key for a turn', () => {
    expect(startTurnRequestSchema.safeParse({ text: 'test' }).success).toBe(false);
  });

  it('bounds persisted turn-navigation labels', () => {
    const entry = {
      id: 1,
      threadId: 'thread-1',
      turnId: 'turn-1',
      label: 'Проверить сохранение переходов',
    };
    expect(turnNavigationEntrySchema.safeParse(entry).success).toBe(true);
    expect(
      turnNavigationEntrySchema.safeParse({ ...entry, label: 'x'.repeat(2_001) }).success,
    ).toBe(false);
  });

  it('validates the complete account runtime preference tuple', () => {
    expect(
      updateRuntimePreferencesRequestSchema.safeParse({
        model: 'gpt-test',
        reasoningEffort: 'high',
        permissionPreset: 'full-access',
        approvalPolicy: 'never',
      }).success,
    ).toBe(true);
    expect(
      updateRuntimePreferencesRequestSchema.safeParse({
        model: 'gpt-test',
        reasoningEffort: 'high',
        permissionPreset: 'root',
        approvalPolicy: 'never',
      }).success,
    ).toBe(false);
  });

  it('accepts only bounded Codex update projections', () => {
    expect(
      codexUpdateSnapshotSchema.safeParse({
        state: 'ready',
        currentVersion: 'codex-cli 0.153.4',
        availableVersion: 'codex-cli 0.154.0',
        candidateReleaseId: '20261001-update-a1b2c3d4',
        lastResult: null,
      }).success,
    ).toBe(true);
    expect(
      codexUpdateSnapshotSchema.safeParse({
        state: 'ready',
        currentVersion: '0.153.4',
        availableVersion: 'latest',
        candidateReleaseId: '../../tmp',
        lastResult: { status: 'succeeded', message: '', completedAt: 'not-a-date' },
      }).success,
    ).toBe(false);
  });

  it('keeps Codex update apply requests empty', () => {
    expect(applyCodexUpdateRequestSchema.safeParse({}).success).toBe(true);
    expect(
      applyCodexUpdateRequestSchema.safeParse({
        version: 'codex-cli 0.159.3',
        url: 'https://example.test/codex.tgz',
        path: '/tmp/codex.tgz',
      }).success,
    ).toBe(false);
  });

  it('accepts only bounded Codex version discovery projections', () => {
    expect(
      codexVersionDiscoverySchema.safeParse({
        state: 'available',
        currentVersion: 'codex-cli 0.153.4',
        latestVersion: 'codex-cli 0.159.3',
        checkedAt: '2026-10-01T16:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      codexVersionDiscoverySchema.safeParse({
        state: 'available',
        currentVersion: 'codex-cli 0.153.4',
        latestVersion: 'latest',
        checkedAt: 'not-a-date',
      }).success,
    ).toBe(false);
  });

  it('keeps automatic limits unbounded by user values and requires a complete custom policy', () => {
    expect(
      resourceLimitPolicySchema.safeParse({
        mode: 'auto',
        cpuCores: null,
        memoryBytes: null,
        tasks: null,
        maxParallelAgents: null,
      }).success,
    ).toBe(true);
    expect(
      resourceLimitPolicySchema.safeParse({
        mode: 'auto',
        cpuCores: 4,
        memoryBytes: null,
        tasks: null,
        maxParallelAgents: null,
      }).success,
    ).toBe(false);
    expect(
      resourceLimitPolicySchema.safeParse({
        mode: 'custom',
        cpuCores: 4,
        memoryBytes: 8 * 1_024 * 1_024 * 1_024,
        tasks: 1_024,
        maxParallelAgents: 3,
      }).success,
    ).toBe(true);
  });

  it('accepts only bounded public subagent projections', () => {
    const subagent = {
      id: 'agent-1',
      rootThreadId: 'thread-1',
      parentThreadId: 'thread-1',
      agentPath: '/root/reviewer',
      nickname: 'Reviewer',
      role: 'review',
      model: 'gpt-6-sol',
      reasoningEffort: 'medium',
      status: 'running',
      message: null,
      startedAt: '2026-09-28T10:00:00.000Z',
      lastActivityAt: '2026-09-28T10:01:00.000Z',
      completedAt: null,
    };
    expect(subagentSchema.safeParse(subagent).success).toBe(true);
    expect(subagentSchema.safeParse({ ...subagent, status: 'invented' }).success).toBe(false);
  });

  it('allows attachment-only turns and bounds safe attachment metadata', () => {
    expect(
      startTurnRequestSchema.safeParse({
        text: '',
        attachmentIds: ['00000000-0000-4000-8000-000000000001'],
        idempotencyKey: '00000000-0000-4000-8000-000000000002',
      }).success,
    ).toBe(true);
    expect(
      startTurnRequestSchema.safeParse({
        text: '',
        idempotencyKey: '00000000-0000-4000-8000-000000000002',
      }).success,
    ).toBe(false);
    expect(
      startTurnRequestSchema.safeParse({
        text: 'too many',
        attachmentIds: Array.from(
          { length: 9 },
          (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        ),
        idempotencyKey: '00000000-0000-4000-8000-000000000002',
      }).success,
    ).toBe(false);
    expect(
      attachmentSchema.safeParse({
        id: '00000000-0000-4000-8000-000000000001',
        threadId: 'thread-1',
        name: 'safe.png',
        mediaType: 'image/png',
        sizeBytes: 123,
        kind: 'image',
        createdAt: '2026-09-27T18:00:00.000Z',
        url: '/api/threads/thread-1/attachments/id/content',
        localPath: '/private/path',
      }).success,
    ).toBe(true);
  });

  it('allows attachment-only steering and bounds attachment identifiers', () => {
    const base = {
      text: '',
      expectedTurnId: 'turn-active',
      attachmentIds: ['00000000-0000-4000-8000-000000000001'],
    };
    expect(steerTurnRequestSchema.safeParse(base).success).toBe(true);
    expect(
      steerTurnRequestSchema.safeParse({ text: '', expectedTurnId: 'turn-active' }).success,
    ).toBe(false);
    expect(
      steerTurnRequestSchema.safeParse({
        ...base,
        attachmentIds: Array.from(
          { length: 9 },
          (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        ),
      }).success,
    ).toBe(false);
  });

  it('bounds typed user-input answers and one-turn permission decisions', () => {
    expect(
      resolveUserInputRequestSchema.safeParse({
        answers: { choice: { answers: ['Safe option'] } },
      }).success,
    ).toBe(true);
    expect(resolvePermissionRequestSchema.parse({ decision: 'grant' }).scope).toBe('turn');
    expect(
      resolvePermissionRequestSchema.safeParse({ decision: 'grant', scope: 'session' }).success,
    ).toBe(false);
  });

  it('accepts only bounded Web Push subscription material', () => {
    expect(
      pushSubscriptionSchema.safeParse({
        endpoint: 'https://push.example.test/send/device-token',
        expirationTime: null,
        keys: {
          p256dh: 'A'.repeat(87),
          auth: 'B'.repeat(22),
        },
      }).success,
    ).toBe(true);
    expect(
      pushSubscriptionSchema.safeParse({
        endpoint: 'javascript:alert(1)',
        expirationTime: null,
        keys: { p256dh: 'short', auth: 'short' },
      }).success,
    ).toBe(false);
  });

  it('accepts only bounded safe account status aggregates', () => {
    const parsed = capabilitySchema.parse({
      codexVersion: 'codex-cli 0.153.4',
      authenticated: true,
      account: { type: 'chatgpt', email: 'owner@example.test', planType: 'plus' },
      appServerReady: true,
      projectRoots: ['/srv/projects'],
      skills: [],
      rateLimits: [
        {
          limitId: 'codex',
          limitName: 'Codex',
          planType: 'plus',
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: null,
          accountId: 'must-not-survive',
        },
      ],
      usage: {
        summary: {
          lifetimeTokens: 10_000,
          currentStreakDays: 2,
          longestStreakDays: 5,
          peakDailyTokens: 2_000,
          longestRunningTurnSec: 60,
          email: 'private@example.test',
        },
        dailyUsageBuckets: [{ startDate: '2026-09-27', tokens: 500 }],
      },
      threadUsage: {
        threadId: 'thread-1',
        estimated: true,
        inputTokens: 1_000,
        cachedInputTokens: 400,
        netNewInputTokens: 600,
        outputTokens: 200,
        totalTokens: 1_200,
        estimatedUsageCreditsMicros: 123_000,
        model: 'must-not-survive',
      },
      transcription: {
        available: true,
        model: 'onnx-community/whisper-base',
        maxBytes: 10 * 1_024 * 1_024,
        maxDurationSeconds: 120,
      },
      notifications: {
        available: true,
        vapidPublicKey: 'A'.repeat(87),
      },
      warnings: [],
    });
    expect(parsed.rateLimits?.[0]).not.toHaveProperty('accountId');
    expect(parsed.account).toEqual({
      type: 'chatgpt',
      email: 'owner@example.test',
      planType: 'plus',
    });
    expect(parsed.usage?.summary).not.toHaveProperty('email');
    expect(parsed.threadUsage).toEqual({
      threadId: 'thread-1',
      estimated: true,
      inputTokens: 1_000,
      cachedInputTokens: 400,
      netNewInputTokens: 600,
      outputTokens: 200,
      totalTokens: 1_200,
    });
    expect(parsed.threadUsage).not.toHaveProperty('estimatedUsageCreditsMicros');
    expect(parsed.threadUsage).not.toHaveProperty('model');
    expect(parsed.transcription).toEqual({
      available: true,
      model: 'onnx-community/whisper-base',
      maxBytes: 10 * 1_024 * 1_024,
      maxDurationSeconds: 120,
    });
    expect(parsed.notifications).toEqual({
      available: true,
      vapidPublicKey: 'A'.repeat(87),
    });
    expect(capabilitySchema.safeParse({ ...parsed, transcription: undefined }).success).toBe(true);
    expect(capabilitySchema.safeParse({ ...parsed, threadUsage: null }).success).toBe(true);
    expect(
      capabilitySchema.safeParse({
        ...parsed,
        threadUsage: { ...parsed.threadUsage, inputTokens: -1 },
      }).success,
    ).toBe(false);
    expect(
      capabilitySchema.safeParse({
        ...parsed,
        rateLimits: [{ ...parsed.rateLimits?.[0], primary: { usedPercent: 101 } }],
      }).success,
    ).toBe(false);
  });

  it('bounds the transient Codex device-login projection', () => {
    expect(
      codexAccountLoginSchema.safeParse({
        state: 'pending',
        loginId: 'login-1',
        userCode: 'ABCD-EFGH',
        verificationUrl: 'https://auth.openai.com/device',
        expiresAt: '2026-10-01T12:15:00.000Z',
        message: null,
      }).success,
    ).toBe(true);
    expect(
      codexAccountLoginSchema.safeParse({
        state: 'pending',
        loginId: 'login-1',
        userCode: 'ABCD-EFGH',
        verificationUrl: 'javascript:alert(1)',
        expiresAt: null,
        message: null,
      }).success,
    ).toBe(false);
  });
});
