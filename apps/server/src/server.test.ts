import {
  capabilitySchema,
  type Attachment,
  type CodexUpdateSnapshot,
  type SafeEvent,
  type Thread,
} from '@codex-web/contracts';
import { hash } from 'argon2';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  INITIALIZED_NOTIFICATION,
  INITIALIZE_PARAMS,
  CodexAppServerSocketClient,
  CodexAppServerSupervisor,
  buildCodexEnvironment,
  type AppServerClient,
  type AppServerInbound,
  type AppServerLifecycleEvent,
  type RpcId,
} from './app-server.js';
import { AttachmentStore } from './attachment-store.js';
import type { AudioTranscriptionClient, TranscriptionUpload } from './audio-transcription.js';
import type { CodexUpdateBroker } from './codex-update-broker.js';
import type { CodexVersionChecker } from './codex-version-checker.js';
import { loadConfig, type ServerConfig } from './config.js';
import { MAX_QUEUED_TURNS, SqliteRepository } from './database.js';
import { normalizeNotification, sanitizeEventPayload } from './event-normalizer.js';
import { normalizeThreadHistory } from './history-normalizer.js';
import { ProjectPathPolicy } from './path-policy.js';
import type { BrokerResourceSnapshot, ResourceBroker } from './resource-broker.js';
import type { PushNotificationPayload, PushSender } from './push-notifications.js';
import type { PushSubscriptionInput } from '@codex-web/contracts';
import { buildServer } from './server.js';
import { createSseDelivery } from './sse.js';
import type { ThreadTitleGenerator } from './thread-title-generator.js';

/* eslint-disable @typescript-eslint/require-await -- fake protocol methods intentionally implement async production interfaces. */

class FakeAppServer implements AppServerClient {
  ready = false;
  generation = 0;
  readonly requests: { method: string; params: unknown }[] = [];
  readonly responses: { id: RpcId; result: unknown }[] = [];
  readonly responseErrors: { id: RpcId; code: number; message: string }[] = [];
  private readonly listeners = new Set<(message: AppServerInbound) => void>();
  private readonly lifecycleListeners = new Set<(event: AppServerLifecycleEvent) => void>();
  private threadCounter = 0;
  private turnCounter = 0;
  private readonly threads = new Map<string, Record<string, unknown>>();
  private listPageSize = Number.POSITIVE_INFINITY;
  private turnStartGate: Promise<void> | null = null;
  private signalTurnStart: (() => void) | null = null;
  private threadReadGate: Promise<void> | null = null;
  private signalThreadRead: (() => void) | null = null;
  private accountLoginStartGate: Promise<void> | null = null;
  private signalAccountLoginStart: (() => void) | null = null;
  private threadStartGate: Promise<void> | null = null;
  private signalThreadStart: (() => void) | null = null;
  private threadListGate: Promise<void> | null = null;
  private signalThreadList: (() => void) | null = null;
  private failArchiveAfterMutation = false;
  private failArchiveReconciliationList = false;
  private readonly archivedThreadIds = new Set<string>();
  private readonly unloadedThreadIds = new Set<string>();
  failNextRequestWith: Error | null = null;
  failTurnStartWith: Error | null = null;
  failNextResponseWith: Error | null = null;
  failAccountStatusReads = false;
  failThreadUsageReads = false;
  failAccountLoginCancels = false;
  accountLoginCancelStatus: 'canceled' | 'notFound' = 'canceled';
  beforeThreadReadReturn: (() => Promise<void>) | null = null;
  account: Record<string, unknown> | null = {
    type: 'chatgpt',
    email: 'owner@example.test',
    planType: 'plus',
    accessToken: 'must-not-leak',
  };
  accountLoginResponse: Record<string, unknown> = {
    type: 'chatgptDeviceCode',
    loginId: 'login-1',
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://auth.openai.com/codex/device',
  };
  threadUsageResponse: unknown = null;

  blockTurnStarts(): { entered: Promise<void>; release: () => void } {
    let releaseGate!: () => void;
    let signalEntered!: () => void;
    this.turnStartGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    this.signalTurnStart = signalEntered;
    return { entered, release: releaseGate };
  }

  blockThreadReads(): { entered: Promise<void>; release: () => void } {
    let releaseGate!: () => void;
    let signalEntered!: () => void;
    this.threadReadGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    this.signalThreadRead = signalEntered;
    return { entered, release: releaseGate };
  }

  blockAccountLoginStarts(): { entered: Promise<void>; release: () => void } {
    let releaseGate!: () => void;
    let signalEntered!: () => void;
    this.accountLoginStartGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    this.signalAccountLoginStart = signalEntered;
    return { entered, release: releaseGate };
  }

  blockThreadStarts(): { entered: Promise<void>; release: () => void } {
    let releaseGate!: () => void;
    let signalEntered!: () => void;
    this.threadStartGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    this.signalThreadStart = signalEntered;
    return { entered, release: releaseGate };
  }

  blockThreadLists(): { entered: Promise<void>; release: () => void } {
    let releaseGate!: () => void;
    let signalEntered!: () => void;
    this.threadListGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    this.signalThreadList = signalEntered;
    return { entered, release: releaseGate };
  }

  failNextArchiveResponseAfterMutation(): void {
    this.failArchiveAfterMutation = true;
  }

  failNextArchiveResponseAndReconciliation(): void {
    this.failArchiveAfterMutation = true;
    this.failArchiveReconciliationList = true;
  }

  setThreadTurns(threadId: string, turns: unknown[]): void {
    const thread = this.threads.get(threadId);
    if (thread) thread.turns = turns;
  }

  setThreadStatus(threadId: string, type: 'notLoaded' | 'idle' | 'active' | 'systemError'): void {
    const thread = this.threads.get(threadId);
    if (thread) thread.status = { type };
  }

  setThreadUpdatedAt(threadId: string, updatedAt: number): void {
    const thread = this.threads.get(threadId);
    if (thread) thread.updatedAt = updatedAt;
  }

  setThreadCwd(threadId: string, cwd: string): void {
    const thread = this.threads.get(threadId);
    if (thread) thread.cwd = cwd;
  }

  setThreadListPageSize(size: number): void {
    this.listPageSize = size;
  }

  restart(): void {
    this.ready = true;
    this.generation += 1;
  }

  disconnect(): void {
    this.ready = false;
    const event: AppServerLifecycleEvent = {
      type: 'disconnected',
      generation: this.generation,
    };
    for (const listener of this.lifecycleListeners) listener(event);
  }

  addExternalThread(cwd: string): string {
    const id = `external-${++this.threadCounter}`;
    const now = Math.floor(Date.now() / 1_000);
    this.threads.set(id, {
      id,
      name: 'Existing CLI chat',
      preview: 'existing',
      model: 'gpt-test',
      status: { type: 'notLoaded' },
      createdAt: now,
      updatedAt: now,
      cwd,
      turns: [],
    });
    return id;
  }

  addSubagentThread(
    id: string,
    cwd: string,
    status: 'notLoaded' | 'idle' | 'active' | 'systemError',
  ): void {
    const now = Math.floor(Date.now() / 1_000);
    this.threads.set(id, {
      id,
      name: null,
      preview: '',
      model: 'gpt-test',
      status: { type: status },
      createdAt: now,
      updatedAt: now,
      cwd,
      turns: [],
    });
  }

  async start(): Promise<void> {
    this.ready = true;
    this.generation += 1;
  }
  async stop(): Promise<void> {
    this.ready = false;
  }
  subscribe(listener: (message: AppServerInbound) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeLifecycle(listener: (event: AppServerLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }
  emit(message: AppServerInbound): void {
    for (const listener of this.listeners) listener(message);
  }
  respond(id: RpcId, result: unknown): void {
    if (this.failNextResponseWith) {
      const error = this.failNextResponseWith;
      this.failNextResponseWith = null;
      throw error;
    }
    this.responses.push({ id, result });
  }
  respondError(id: RpcId, code: number, message: string): void {
    this.responseErrors.push({ id, code, message });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (this.failNextRequestWith) {
      const error = this.failNextRequestWith;
      this.failNextRequestWith = null;
      throw error;
    }
    const values = params as Record<string, unknown>;
    if (method === 'thread/start') {
      this.signalThreadStart?.();
      this.signalThreadStart = null;
      if (this.threadStartGate) await this.threadStartGate;
      this.threadStartGate = null;
      const id = `thread-${++this.threadCounter}`;
      const now = Math.floor(Date.now() / 1_000);
      const thread = {
        id,
        name: null,
        preview: '',
        model: values.model ?? null,
        status: { type: 'idle' },
        createdAt: now,
        updatedAt: now,
        cwd: values.cwd,
        turns: [],
      };
      this.threads.set(id, thread);
      return {
        thread,
        model: values.model ?? 'gpt-test',
        instructionSources: [`${String(values.cwd)}/AGENTS.md`],
      };
    }
    if (method === 'thread/list') {
      if (this.failArchiveReconciliationList) {
        this.failArchiveReconciliationList = false;
        throw new Error('APP_SERVER_REQUEST_FAILED');
      }
      const offset = values.cursor === null ? 0 : Number(values.cursor);
      const archived = values.archived === true;
      const threads = [...this.threads.entries()]
        .filter(([id]) => this.archivedThreadIds.has(id) === archived)
        .map(([, thread]) => ({ ...thread }));
      this.signalThreadList?.();
      this.signalThreadList = null;
      if (this.threadListGate) await this.threadListGate;
      this.threadListGate = null;
      const end = Math.min(threads.length, offset + this.listPageSize);
      return {
        data: threads.slice(offset, end),
        nextCursor: end < threads.length ? String(end) : null,
      };
    }
    if (method === 'thread/read') {
      this.signalThreadRead?.();
      this.signalThreadRead = null;
      if (this.threadReadGate) await this.threadReadGate;
      this.threadReadGate = null;
      const thread = this.threads.get(String(values.threadId));
      if (this.beforeThreadReadReturn) {
        const beforeReturn = this.beforeThreadReadReturn;
        this.beforeThreadReadReturn = null;
        await beforeReturn();
      }
      return {
        thread: thread && values.includeTurns === false ? { ...thread, turns: undefined } : thread,
        model: thread?.model ?? 'gpt-test',
        instructionSources: [],
      };
    }
    if (method === 'thread/resume') {
      const thread = this.threads.get(String(values.threadId));
      this.unloadedThreadIds.delete(String(values.threadId));
      return { thread, model: thread?.model ?? 'gpt-test', instructionSources: [] };
    }
    if (method === 'thread/name/set') {
      const thread = this.threads.get(String(values.threadId));
      if (thread) thread.name = values.name;
      return {};
    }
    if (method === 'thread/archive' || method === 'thread/unarchive') {
      const threadId = String(values.threadId);
      if (method === 'thread/archive') {
        this.archivedThreadIds.add(threadId);
        this.unloadedThreadIds.add(threadId);
      } else this.archivedThreadIds.delete(threadId);
      if (this.failArchiveAfterMutation) {
        this.failArchiveAfterMutation = false;
        throw new Error('APP_SERVER_REQUEST_FAILED');
      }
      return {};
    }
    if (method === 'turn/interrupt') return {};
    if (method === 'turn/start') {
      if (this.unloadedThreadIds.has(String(values.threadId)))
        throw new Error('APP_SERVER_REQUEST_FAILED');
      this.signalTurnStart?.();
      this.signalTurnStart = null;
      if (this.turnStartGate) await this.turnStartGate;
      this.turnStartGate = null;
      if (this.failTurnStartWith) {
        const error = this.failTurnStartWith;
        this.failTurnStartWith = null;
        throw error;
      }
      this.setThreadStatus(String(values.threadId), 'active');
      return { turn: { id: `turn-${++this.turnCounter}` } };
    }
    if (method === 'turn/steer') return { turnId: values.expectedTurnId };
    if (method === 'model/list')
      return {
        data: [
          {
            id: 'model-id',
            model: 'gpt-test',
            displayName: 'Test',
            isDefault: true,
            defaultReasoningEffort: 'high',
            supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
          },
        ],
      };
    if (method === 'skills/list')
      return {
        data: ((values.cwds as string[] | undefined) ?? []).map((cwd) => ({
          cwd,
          skills: [],
          errors: [],
        })),
      };
    if (method === 'account/login/start') {
      this.signalAccountLoginStart?.();
      this.signalAccountLoginStart = null;
      if (this.accountLoginStartGate) await this.accountLoginStartGate;
      this.accountLoginStartGate = null;
      return this.accountLoginResponse;
    }
    if (method === 'account/login/cancel') {
      if (this.failAccountLoginCancels) throw new Error('APP_SERVER_REQUEST_FAILED');
      return { status: this.accountLoginCancelStatus };
    }
    if (method === 'account/read') return { account: this.account, requiresOpenaiAuth: true };
    if (method === 'account/rateLimits/read') {
      if (this.failAccountStatusReads) throw new Error('unsupported status method');
      return {
        accountId: 'private-account-id',
        rateLimits: {
          limitId: 'legacy',
          primary: { usedPercent: 99 },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            limitName: 'Codex',
            planType: 'plus',
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: null,
            credits: { balance: 'secret' },
          },
        },
      };
    }
    if (method === 'account/usage/read') {
      const requestedThreadId =
        params !== null && typeof params === 'object'
          ? (params as Record<string, unknown>).threadId
          : undefined;
      if (typeof requestedThreadId === 'string') {
        if (this.failThreadUsageReads) throw new Error('thread usage unavailable');
        return (
          this.threadUsageResponse ?? {
            summary: {},
            threadUsage: {
              threadId: requestedThreadId,
              groups: [
                {
                  inputTokens: 1_000,
                  cachedInputTokens: 400,
                  netNewInputTokens: 600,
                  outputTokens: 200,
                  totalTokens: 1_200,
                  estimatedUsageCreditsMicros: 123_000,
                  model: 'must-not-leak',
                },
                {
                  inputTokens: 500,
                  cachedInputTokens: null,
                  netNewInputTokens: 500,
                  outputTokens: 100,
                  totalTokens: 600,
                  estimatedUsageCreditsMicros: 61_000,
                },
              ],
              estimatedUsageCreditsMicros: 184_000,
              estimatedUsageUsdMicros: 20_000,
              billingRoute: 'must-not-leak',
            },
          }
        );
      }
      if (this.failAccountStatusReads) throw new Error('unsupported status method');
      return {
        summary: {
          lifetimeTokens: 10_000,
          currentStreakDays: 2,
          longestStreakDays: 5,
          peakDailyTokens: 2_000,
          longestRunningTurnSec: 60,
          email: 'private@example.test',
        },
        dailyUsageBuckets: [{ startDate: '2026-09-27', tokens: 500 }],
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  }
}

type BrokerApplyRequest = Parameters<ResourceBroker['apply']>[0];

class FakeResourceBroker implements ResourceBroker {
  readonly applyRequests: BrokerApplyRequest[] = [];
  failApply = false;
  private applyGate: Promise<void> | null = null;
  private signalApply: (() => void) | null = null;
  current: BrokerResourceSnapshot = {
    capacity: {
      cpuQuotaPercent: 800,
      memoryBytes: 16 * 1_024 * 1_024 * 1_024,
      memoryAvailableBytes: 8 * 1_024 * 1_024 * 1_024,
      tasks: 4_096,
      measuredAt: new Date(0).toISOString(),
    },
    effective: {
      cpuQuotaPercent: 700,
      memoryMaxBytes: 13 * 1_024 * 1_024 * 1_024,
      tasksMax: 3_500,
    },
    policy: { mode: 'auto', cpuQuotaPercent: null, memoryMaxBytes: null, tasksMax: null },
    generation: 1,
  };

  blockApplies(): { entered: Promise<void>; release: () => void } {
    let release!: () => void;
    let entered!: () => void;
    this.applyGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    this.signalApply = entered;
    return { entered: enteredPromise, release };
  }

  async snapshot(): Promise<BrokerResourceSnapshot> {
    return this.current;
  }

  async apply(request: BrokerApplyRequest): Promise<BrokerResourceSnapshot> {
    this.applyRequests.push(request);
    this.signalApply?.();
    this.signalApply = null;
    if (this.applyGate) {
      await this.applyGate;
      this.applyGate = null;
    }
    if (this.failApply) throw new Error('broker failed');
    this.current = {
      ...this.current,
      policy: request,
      effective: {
        cpuQuotaPercent: request.cpuQuotaPercent ?? 700,
        memoryMaxBytes: request.memoryMaxBytes ?? 13 * 1_024 * 1_024 * 1_024,
        tasksMax: request.tasksMax ?? 3_500,
      },
      generation: this.current.generation + 1,
    };
    return this.current;
  }
}

class FakeCodexUpdateBroker implements CodexUpdateBroker {
  statusReads = 0;
  applyCalls = 0;
  failStatus = false;
  failApply = false;
  current: CodexUpdateSnapshot = {
    state: 'ready',
    currentVersion: 'codex-cli 0.153.4',
    availableVersion: 'codex-cli 0.154.0',
    candidateReleaseId: '20261001-update-a1b2c3d4',
    lastResult: null,
  };

  async status(): Promise<CodexUpdateSnapshot> {
    this.statusReads += 1;
    if (this.failStatus) throw new Error('ambiguous update broker status');
    return this.current;
  }

  async apply(): Promise<CodexUpdateSnapshot> {
    this.applyCalls += 1;
    if (this.failApply) throw new Error('ambiguous update broker failure');
    this.current = { ...this.current, state: 'applying' };
    return this.current;
  }
}

class FailingRemoveAttachmentStore extends AttachmentStore {
  failRemove = true;

  override async remove(projectId: string, threadId: string, storageName: string): Promise<void> {
    if (this.failRemove) throw new Error('simulated attachment remove failure');
    await super.remove(projectId, threadId, storageName);
  }
}

class SelectiveFailRemoveAttachmentStore extends AttachmentStore {
  constructor(
    root: string,
    private readonly failingStorageNames: ReadonlySet<string>,
  ) {
    super(root);
  }

  override async remove(projectId: string, threadId: string, storageName: string): Promise<void> {
    if (this.failingStorageNames.has(storageName))
      throw new Error('simulated persistent attachment remove failure');
    await super.remove(projectId, threadId, storageName);
  }
}

class FakeAudioTranscriptionClient implements AudioTranscriptionClient {
  readonly uploads: TranscriptionUpload[] = [];

  async transcribe(upload: TranscriptionUpload): Promise<string> {
    this.uploads.push(upload);
    return 'Распознанный текст';
  }
}

class FakePushSender implements PushSender {
  readonly calls: { subscription: PushSubscriptionInput; payload: PushNotificationPayload }[] = [];
  readonly deliveries: { subscription: PushSubscriptionInput; payload: PushNotificationPayload }[] =
    [];
  failures: Error[] = [];

  async send(subscription: PushSubscriptionInput, payload: PushNotificationPayload): Promise<void> {
    this.calls.push({ subscription, payload });
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    this.deliveries.push({ subscription, payload });
  }
}

let passwordHash: string;
const openApps: Awaited<ReturnType<typeof buildServer>>[] = [];

beforeAll(async () => {
  passwordHash = await hash('correct horse battery staple', { type: 2 });
});
afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

async function fixture(
  maxConcurrentTurns = 2,
  seed?: (context: { repository: SqliteRepository; projectPath: string }) => void,
  attachmentStoreFactory: (root: string) => AttachmentStore = (root) => new AttachmentStore(root),
  resourceBroker?: ResourceBroker,
  transcriptionClient?: AudioTranscriptionClient,
  pushSender?: PushSender,
  accountLoginTimeoutMs?: number,
  codexUpdateBroker?: CodexUpdateBroker,
  codexVersionChecker?: CodexVersionChecker,
  codexUpdateStartupRetryMs?: number,
  configOverrides: Partial<Pick<ServerConfig, 'eventRetentionPerThread'>> = {},
  persistent?: { temp: string; appServer: FakeAppServer },
  threadTitleGenerator?: ThreadTitleGenerator,
) {
  const temp = persistent?.temp ?? (await mkdtemp(path.join(os.tmpdir(), 'codex-web-server-')));
  const root = path.join(temp, 'projects');
  const projectPath = path.join(root, 'demo');
  await mkdir(projectPath, { recursive: true });
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 3000,
    databasePath: path.join(temp, 'codex-web.sqlite3'),
    attachmentStoragePath: path.join(temp, 'attachments'),
    username: 'owner',
    passwordHash,
    sessionSecret: '0123456789abcdef0123456789abcdef',
    sessionTtlMs: 60_000,
    webOrigin: 'https://codex.test',
    projectRoots: [root],
    codexBinary: 'codex',
    codexVersionPin: 'codex-cli 0.153.4',
    cookieSecure: true,
    cookieName: '__Host-codex_web_session',
    eventRetentionPerThread: 1_000,
    maxEventBytes: 4_096,
    maxConcurrentTurns,
    resourceBrokerSocket: path.join(temp, 'resource-broker.sock'),
    codexUpdateBrokerSocket: path.join(temp, 'codex-update-broker.sock'),
    transcriptionModelCachePath: '/opt/codex-web-ui/current/models',
    transcriptionModel: 'onnx-community/whisper-base',
    transcriptionModelRevision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    transcriptionLanguage: 'russian',
    ...(pushSender
      ? {
          vapid: {
            publicKey: 'A'.repeat(64),
            privateKey: 'B'.repeat(64),
            subject: 'mailto:owner@codex.test',
          },
        }
      : {}),
    ...configOverrides,
  };
  const repository = new SqliteRepository(
    persistent ? config.databasePath : ':memory:',
    config.eventRetentionPerThread,
  );
  seed?.({ repository, projectPath });
  const appServer = persistent?.appServer ?? new FakeAppServer();
  const attachmentStore = attachmentStoreFactory(config.attachmentStoragePath);
  const upgradeDrainPath = path.join(temp, 'upgrade-drain');
  const pathPolicy = await ProjectPathPolicy.create([root]);
  const app = await buildServer({
    config,
    repository,
    pathPolicy,
    appServer,
    attachmentStore,
    upgradeDrainPath,
    ...(resourceBroker ? { resourceBroker } : {}),
    ...(codexUpdateBroker ? { codexUpdateBroker } : {}),
    ...(codexVersionChecker ? { codexVersionChecker } : {}),
    ...(transcriptionClient ? { transcriptionClient } : {}),
    ...(pushSender ? { pushSender } : {}),
    ...(accountLoginTimeoutMs === undefined ? {} : { accountLoginTimeoutMs }),
    ...(codexUpdateStartupRetryMs === undefined ? {} : { codexUpdateStartupRetryMs }),
    ...(threadTitleGenerator ? { threadTitleGenerator } : {}),
  });
  openApps.push(app);
  await app.ready();
  return {
    app,
    repository,
    appServer,
    attachmentStore,
    projectPath,
    root,
    pathPolicy,
    upgradeDrainPath,
  };
}

async function login(app: Awaited<ReturnType<typeof buildServer>>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: 'https://codex.test' },
    payload: { username: 'owner', password: 'correct horse battery staple' },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ csrfToken: string }>();
  const cookie = response.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  return {
    cookie,
    csrf: body.csrfToken,
    headers: { origin: 'https://codex.test', cookie, 'x-csrf-token': body.csrfToken },
  };
}

async function createProject(
  app: Awaited<ReturnType<typeof buildServer>>,
  projectPath: string,
  headers: Record<string, string>,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers,
    payload: { name: 'Demo', path: projectPath },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ data: { id: string } }>().data;
}

async function createThread(
  app: Awaited<ReturnType<typeof buildServer>>,
  projectId: string,
  headers: Record<string, string>,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/threads',
    headers,
    payload: { projectId },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ data: { id: string } }>().data.id;
}

function multipartFile(
  name: string,
  mimeType: string | undefined,
  bytes: Buffer,
  boundary = 'codex-web-test',
) {
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n${mimeType === undefined ? '' : `Content-Type: ${mimeType}\r\n`}\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function voiceWav(sample = 2_000): Buffer {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(40, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(4, 40);
  bytes.writeInt16LE(sample, 44);
  bytes.writeInt16LE(-sample, 46);
  return bytes;
}

describe('security and repository boundary', () => {
  it('allowlists only the exact account status and device-code login methods', async () => {
    const supervisor = new CodexAppServerSupervisor({
      executable: 'codex',
      expectedVersion: 'codex-cli 0.153.4',
    });
    await expect(supervisor.request('account/rateLimits/read', null)).rejects.toThrow(
      'APP_SERVER_UNAVAILABLE',
    );
    await expect(supervisor.request('account/usage/read', null)).rejects.toThrow(
      'APP_SERVER_UNAVAILABLE',
    );
    await expect(
      supervisor.request('account/login/start', { type: 'chatgptDeviceCode' }),
    ).rejects.toThrow('APP_SERVER_UNAVAILABLE');
    await expect(
      supervisor.request('account/login/cancel', { loginId: 'login-1' }),
    ).rejects.toThrow('APP_SERVER_UNAVAILABLE');
    await expect(supervisor.request('account/credentials/read', {})).rejects.toThrow(
      'APP_SERVER_METHOD_NOT_ALLOWED',
    );
  });

  it('uses a bounded Unix-stream JSON-RPC connection and reconnects after protocol abuse', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-web-socket-'));
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\codex-web-${process.pid}-${Date.now()}`
        : path.join(root, 'app-server.sock');
    let connections = 0;
    let sentOversizedLine = false;
    const receivedMethods: string[] = [];
    const listener = createNetServer((socket) => {
      connections += 1;
      socket.on('error', () => undefined);
      let buffered = '';
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        while (true) {
          const newline = buffered.indexOf('\n');
          if (newline === -1) break;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          const message = JSON.parse(line) as { id?: RpcId; method?: string };
          if (message.method) receivedMethods.push(message.method);
          if (message.method === 'initialize' && message.id !== undefined) {
            socket.write(`${JSON.stringify({ id: message.id, result: { serverInfo: {} } })}\n`);
          } else if (message.method === 'initialized' && !sentOversizedLine) {
            sentOversizedLine = true;
            socket.write('x'.repeat(1_048_577));
          } else if (message.id !== undefined) {
            socket.write(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`);
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(socketPath, resolve);
    });
    const client = new CodexAppServerSocketClient({
      socketPath,
      requestTimeoutMs: 2_000,
      maxLineBytes: 1_024,
    });
    const disconnected = vi.fn();
    client.subscribeLifecycle(() => {
      throw new Error('listener failure');
    });
    client.subscribeLifecycle(disconnected);
    try {
      await client.start();
      await expect.poll(() => client.generation, { timeout: 3_000 }).toBe(2);
      await expect(client.request('account/read', {})).resolves.toEqual({ ok: true });
      await expect(client.request('account/credentials/read', {})).rejects.toThrow(
        'APP_SERVER_METHOD_NOT_ALLOWED',
      );
      expect(connections).toBe(2);
      expect(receivedMethods.filter((method) => method === 'initialize')).toHaveLength(2);
      expect(disconnected).toHaveBeenCalledExactlyOnceWith({
        type: 'disconnected',
        generation: 1,
      });
    } finally {
      await client.stop();
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it('accepts a bounded multi-megabyte thread response without reconnecting', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-web-large-rpc-'));
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\codex-web-large-${process.pid}-${Date.now()}`
        : path.join(root, 'app-server.sock');
    const largeText = 'x'.repeat(3_200_000);
    let connections = 0;
    const listener = createNetServer((socket) => {
      connections += 1;
      socket.on('error', () => undefined);
      let buffered = '';
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        while (true) {
          const newline = buffered.indexOf('\n');
          if (newline === -1) break;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          const message = JSON.parse(line) as { id?: RpcId; method?: string };
          if (message.method === 'initialize' && message.id !== undefined) {
            socket.write(`${JSON.stringify({ id: message.id, result: { serverInfo: {} } })}\n`);
          } else if (message.method === 'thread/read' && message.id !== undefined) {
            socket.write(`${JSON.stringify({ id: message.id, result: { text: largeText } })}\n`);
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(socketPath, resolve);
    });
    const client = new CodexAppServerSocketClient({ socketPath, requestTimeoutMs: 5_000 });
    try {
      await client.start();
      await expect(client.request('thread/read', {})).resolves.toEqual({ text: largeText });
      expect(client.generation).toBe(1);
      expect(connections).toBe(1);
    } finally {
      await client.stop();
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('clears a connected socket after initialize timeout so a retry can reconnect', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-web-init-timeout-'));
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\codex-web-timeout-${process.pid}-${Date.now()}`
        : path.join(root, 'app-server.sock');
    let connections = 0;
    const listener = createNetServer((socket) => {
      connections += 1;
      socket.on('error', () => undefined);
      let buffered = '';
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        const newline = buffered.indexOf('\n');
        if (newline === -1) return;
        const message = JSON.parse(buffered.slice(0, newline)) as { id?: RpcId; method?: string };
        if (connections > 1 && message.method === 'initialize' && message.id !== undefined) {
          socket.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(socketPath, resolve);
    });
    const client = new CodexAppServerSocketClient({ socketPath, requestTimeoutMs: 100 });
    try {
      await expect(client.start()).rejects.toThrow('APP_SERVER_REQUEST_TIMEOUT');
      await expect(client.start()).resolves.toBeUndefined();
      expect(client.generation).toBe(1);
      expect(connections).toBeGreaterThanOrEqual(2);
    } finally {
      await client.stop();
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('hard-caps retained event count and serialized event bytes', () => {
    const environment = {
      CODEX_WEB_ADMIN_USERNAME: 'owner',
      CODEX_WEB_ADMIN_PASSWORD_HASH: '$argon2id$valid-format',
      CODEX_WEB_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
      CODEX_WEB_PUBLIC_ORIGIN: 'https://codex.test',
      CODEX_WEB_PROJECT_ROOTS: '/srv/projects',
      CODEX_WEB_CODEX_VERSION_PIN: 'codex-cli 0.153.4',
    };
    expect(loadConfig(environment)).toMatchObject({
      eventRetentionPerThread: 1_000,
      maxEventBytes: 32_768,
      transcriptionModel: 'onnx-community/whisper-base',
      transcriptionModelCachePath: '/opt/codex-web-ui/current/models',
      transcriptionModelRevision: '1846881b6b3a3024392c1eea3ad983695bc23925',
      transcriptionLanguage: 'russian',
    });
    expect(loadConfig(environment)).not.toHaveProperty('vapid');
    expect(
      loadConfig({
        ...environment,
        OPENAI_API_KEY: 'legacy-unused-key',
        CODEX_WEB_TRANSCRIPTION_MODEL: 'gpt-transcribe',
      }),
    ).toMatchObject({ transcriptionModel: 'onnx-community/whisper-base' });
    expect(
      loadConfig({
        ...environment,
        CODEX_WEB_PROJECT_PATH_BROKER_SOCKET: '/run/codex-web-ui/project-path-broker.sock',
      }),
    ).toMatchObject({
      projectPathBrokerSocket: '/run/codex-web-ui/project-path-broker.sock',
    });
    expect(
      loadConfig({
        ...environment,
        CODEX_WEB_VAPID_PUBLIC_KEY: 'A'.repeat(64),
        CODEX_WEB_VAPID_PRIVATE_KEY: 'B'.repeat(64),
        CODEX_WEB_VAPID_SUBJECT: 'mailto:owner@codex.test',
      }),
    ).toMatchObject({
      vapid: {
        publicKey: 'A'.repeat(64),
        privateKey: 'B'.repeat(64),
        subject: 'mailto:owner@codex.test',
      },
    });
    expect(() =>
      loadConfig({ ...environment, CODEX_WEB_VAPID_PUBLIC_KEY: 'A'.repeat(64) }),
    ).toThrow('VAPID configuration must provide');
    expect(
      loadConfig({
        ...environment,
        CODEX_WEB_TRANSCRIPTION_MODEL_CACHE_PATH: '/var/lib/codex-web-ui/models',
        CODEX_WEB_TRANSCRIPTION_MODEL: 'local/custom-transcribe',
        CODEX_WEB_TRANSCRIPTION_MODEL_REVISION: 'a'.repeat(40),
        CODEX_WEB_TRANSCRIPTION_LANGUAGE: 'ukrainian',
      }),
    ).toMatchObject({
      transcriptionModelCachePath: '/var/lib/codex-web-ui/models',
      transcriptionModel: 'local/custom-transcribe',
      transcriptionModelRevision: 'a'.repeat(40),
      transcriptionLanguage: 'ukrainian',
    });
    expect(() =>
      loadConfig({ ...environment, CODEX_WEB_TRANSCRIPTION_MODEL: '../unsafe model' }),
    ).toThrow();
    expect(() =>
      loadConfig({ ...environment, CODEX_WEB_EVENT_RETENTION_PER_THREAD: '1001' }),
    ).toThrow();
    expect(() => loadConfig({ ...environment, CODEX_WEB_MAX_EVENT_BYTES: '32769' })).toThrow();
    expect(
      loadConfig({
        ...environment,
        CODEX_WEB_APP_SERVER_SOCKET: '/run/codex-web-ui/app-server.sock',
      }),
    ).toMatchObject({ appServerSocket: '/run/codex-web-ui/app-server.sock' });
    expect(() =>
      loadConfig({
        ...environment,
        CODEX_WEB_APP_SERVER_SOCKET: '/run/codex-web-ui/app-server.sock',
        CODEX_HOME: '/srv/codex-home',
      }),
    ).toThrow('CODEX_HOME must not be provided to the API');
  });

  it('requires exact Origin and persists only hashed session tokens', async () => {
    const { app, repository } = await fixture();
    const denied = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.test' },
      payload: { username: 'owner', password: 'correct horse battery staple' },
    });
    expect(denied.statusCode).toBe(403);
    const session = await login(app);
    const rawToken = session.cookie.match(/__Host-codex_web_session=([^;]+)/)?.[1];
    const stored = repository.database.prepare('SELECT token_hash FROM sessions').get() as {
      token_hash: string;
    };
    expect(stored.token_hash).not.toBe(rawToken);
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('locks repeated invalid logins and never discloses credential validity', async () => {
    const { app } = await fixture();
    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: 'https://codex.test' },
        payload: { username: 'owner', password: 'incorrect password value' },
      });
      expect(response.statusCode).toBe(401);
    }
    const locked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://codex.test' },
      payload: { username: 'owner', password: 'correct horse battery staple' },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ error: { code: 'LOGIN_LOCKED' } });
  });

  it('uses the trusted loopback proxy client address for isolated login lockouts', async () => {
    const { app } = await fixture();
    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: 'https://codex.test', 'x-forwarded-for': '203.0.113.10' },
        payload: { username: 'owner', password: 'incorrect password value' },
      });
      expect(response.statusCode).toBe(401);
    }
    const otherClient = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://codex.test', 'x-forwarded-for': '203.0.113.11' },
      payload: { username: 'owner', password: 'correct horse battery staple' },
    });
    expect(otherClient.statusCode).toBe(200);
  });

  it('passes only allowlisted non-secret environment variables to Codex', () => {
    const environment = buildCodexEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/home/codex',
        LANG: 'C.UTF-8',
        HTTPS_PROXY: 'http://proxy.test',
        CODEX_WEB_ADMIN_PASSWORD_HASH: '$argon2id$secret',
        CODEX_WEB_SESSION_SECRET: 'session-secret',
        CODEX_WEB_DATABASE_PATH: '/private/database.sqlite3',
        DATABASE_URL: 'postgres://private',
      },
      '/srv/codex-home',
    );
    expect(environment).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/codex',
      LANG: 'C.UTF-8',
      CODEX_HOME: '/srv/codex-home',
    });
    expect(JSON.stringify(environment)).not.toContain('secret');
    expect(JSON.stringify(environment)).not.toContain('database.sqlite3');
  });

  it('rejects a real path outside allowlisted project roots', async () => {
    const { root } = await fixture();
    const policy = await ProjectPathPolicy.create([root]);
    await expect(policy.canonicalize(path.dirname(root))).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOTS',
    });
  });

  it('delegates canonicalization for host-admin paths the API identity cannot traverse', async () => {
    const requests: Array<{ candidate: string; kind: 'existing' | 'directory' }> = [];
    const policy = await ProjectPathPolicy.create(['/'], {
      async canonicalize(candidate, kind) {
        requests.push({ candidate, kind });
        return candidate;
      },
    });
    await expect(policy.canonicalize('/root/private-project')).resolves.toBe(
      '/root/private-project',
    );
    expect(requests).toEqual([
      { candidate: '/', kind: 'directory' },
      { candidate: '/root/private-project', kind: 'directory' },
    ]);
  });
});

describe('Codex routes', () => {
  it('exposes transcription capability and protects the paid endpoint with auth, Origin and CSRF', async () => {
    const client = new FakeAudioTranscriptionClient();
    const { app } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      client,
    );
    const audio = multipartFile('voice.wav', 'audio/wav', voiceWav());
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/audio/transcriptions',
      headers: { origin: 'https://codex.test', 'content-type': audio.contentType },
      payload: audio.body,
    });
    expect(anonymous.statusCode).toBe(401);

    const session = await login(app);
    const missingOrigin = await app.inject({
      method: 'POST',
      url: '/api/audio/transcriptions',
      headers: {
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
        'content-type': audio.contentType,
      },
      payload: audio.body,
    });
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.json()).toMatchObject({ error: { code: 'ORIGIN_REQUIRED' } });

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/audio/transcriptions',
      headers: {
        origin: 'https://codex.test',
        cookie: session.cookie,
        'content-type': audio.contentType,
      },
      payload: audio.body,
    });
    expect(missingCsrf.statusCode).toBe(403);

    expect(missingCsrf.json()).toMatchObject({ error: { code: 'CSRF_REQUIRED' } });

    const missingIdempotency = await app.inject({
      method: 'POST',
      url: '/api/audio/transcriptions',
      headers: { ...session.headers, 'content-type': audio.contentType },
      payload: audio.body,
    });
    expect(missingIdempotency.statusCode).toBe(400);
    expect(missingIdempotency.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_INVALID' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/audio/transcriptions',
      headers: {
        ...session.headers,
        'content-type': audio.contentType,
        'idempotency-key': '00000000-0000-4000-8000-000000000201',
      },
      payload: audio.body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: 'Распознанный текст' });
    expect(client.uploads).toHaveLength(1);
    expect(client.uploads[0]).toMatchObject({ name: 'voice.wav', mimeType: 'audio/wav' });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/audio/transcriptions',
      headers: {
        ...session.headers,
        'content-type': audio.contentType,
        'idempotency-key': '00000000-0000-4000-8000-000000000201',
      },
      payload: audio.body,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ text: 'Распознанный текст' });
    expect(client.uploads).toHaveLength(1);

    const changedAudio = multipartFile('voice.wav', 'audio/wav', voiceWav(3_000));
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/audio/transcriptions',
      headers: {
        ...session.headers,
        'content-type': changedAudio.contentType,
        'idempotency-key': '00000000-0000-4000-8000-000000000201',
      },
      payload: changedAudio.body,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });

    const capabilities = await app.inject({
      method: 'GET',
      url: '/api/system/capabilities',
      headers: { cookie: session.cookie },
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      transcription: {
        available: true,
        model: 'onnx-community/whisper-base',
        maxBytes: 10 * 1_024 * 1_024,
        maxDurationSeconds: 120,
      },
    });
  });

  it('fails closed without a configured transcription client', async () => {
    const { app } = await fixture();
    const session = await login(app);
    const capabilities = await app.inject({
      method: 'GET',
      url: '/api/system/capabilities',
      headers: { cookie: session.cookie },
    });
    expect(capabilities.json()).toMatchObject({ transcription: { available: false } });
    const audio = multipartFile('voice.wav', 'audio/wav', voiceWav());
    const response = await app.inject({
      method: 'POST',
      url: '/api/audio/transcriptions',
      headers: { ...session.headers, 'content-type': audio.contentType },
      payload: audio.body,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'TRANSCRIPTION_UNAVAILABLE' } });
  });

  it('rate-limits transcription calls per session and globally bounds concurrency', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blockingClient: AudioTranscriptionClient = {
      async transcribe() {
        entered();
        await gate;
        return 'done';
      },
    };
    const { app } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      blockingClient,
    );
    const session = await login(app);
    const audio = multipartFile('voice.wav', 'audio/wav', voiceWav());
    let requestIndex = 0;
    const request = () => {
      requestIndex += 1;
      const key = `00000000-0000-4000-8000-${String(requestIndex).padStart(12, '0')}`;
      return app.inject({
        method: 'POST',
        url: '/api/audio/transcriptions',
        headers: {
          ...session.headers,
          'content-type': audio.contentType,
          'idempotency-key': key,
        },
        payload: audio.body,
      });
    };
    const first = request();
    await started;
    const concurrent = await request();
    expect(concurrent.statusCode).toBe(429);
    expect(concurrent.json()).toMatchObject({ error: { code: 'TRANSCRIPTION_BUSY' } });
    release();
    expect((await first).statusCode).toBe(200);

    const client = new FakeAudioTranscriptionClient();
    const { app: rateLimitedApp } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      client,
    );
    const rateSession = await login(rateLimitedApp);
    for (let index = 0; index < 10; index += 1) {
      const allowed = await rateLimitedApp.inject({
        method: 'POST',
        url: '/api/audio/transcriptions',
        headers: {
          ...rateSession.headers,
          'content-type': audio.contentType,
          'idempotency-key': `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        },
        payload: audio.body,
      });
      expect(allowed.statusCode).toBe(200);
    }
    const limited = await rateLimitedApp.inject({
      method: 'POST',
      url: '/api/audio/transcriptions',
      headers: {
        ...rateSession.headers,
        'content-type': audio.contentType,
        'idempotency-key': '10000000-0000-4000-8000-000000000010',
      },
      payload: audio.body,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'TRANSCRIPTION_RATE_LIMITED' } });
    expect(client.uploads).toHaveLength(10);
  });

  it('uploads, downloads, lists and deletes a signature-checked attachment without exposing local paths', async () => {
    const { app, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const png = multipartFile(
      'diagram.png',
      'image/png',
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
    );
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/attachments`,
      headers: { ...session.headers, 'content-type': png.contentType },
      payload: png.body,
    });
    expect(uploaded.statusCode).toBe(201);
    const attachment = uploaded.json<{ data: Attachment }>().data;
    expect(attachment).toMatchObject({
      name: 'diagram.png',
      mediaType: 'image/png',
      kind: 'image',
      sizeBytes: 12,
      threadId,
    });
    expect(Object.keys(attachment).sort()).toEqual([
      'createdAt',
      'id',
      'kind',
      'mediaType',
      'name',
      'sizeBytes',
      'threadId',
      'url',
    ]);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/attachments`,
      headers: { cookie: session.cookie },
    });
    expect(listed.json()).toEqual({ data: [attachment] });
    const downloaded = await app.inject({
      method: 'GET',
      url: attachment.url,
      headers: { cookie: session.cookie },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(
      png.body.subarray(
        png.body.indexOf(Buffer.from('\r\n\r\n')) + 4,
        png.body.lastIndexOf(Buffer.from('\r\n--')),
      ),
    );
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${threadId}/attachments/${attachment.id}`,
      headers: session.headers,
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('downloads generated project files without allowing traversal outside the selected project', async () => {
    const { app, projectPath, root } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const reports = path.join(projectPath, 'reports');
    await mkdir(reports);
    await writeFile(path.join(reports, 'итоговый аудит.md'), '# Готово\n', 'utf8');
    await writeFile(path.join(root, 'outside.md'), 'outside', 'utf8');
    await symlink(path.join(root, 'outside.md'), path.join(projectPath, 'outside-link.md'), 'file');

    const url = `/api/threads/${threadId}/project-files/download?path=${encodeURIComponent('reports/итоговый аудит.md')}`;
    const unauthenticated = await app.inject({ method: 'GET', url });
    expect(unauthenticated.statusCode).toBe(401);

    const downloaded = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: session.cookie },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe('# Готово\n');
    expect(downloaded.headers['content-type']).toBe('application/octet-stream');
    expect(downloaded.headers['content-disposition']).toContain(
      "filename*=UTF-8''%D0%B8%D1%82%D0%BE%D0%B3%D0%BE%D0%B2%D1%8B%D0%B9%20%D0%B0%D1%83%D0%B4%D0%B8%D1%82.md",
    );
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');

    const traversal = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/project-files/download?path=${encodeURIComponent('../outside.md')}`,
      headers: { cookie: session.cookie },
    });
    expect(traversal.statusCode).toBe(404);
    expect(traversal.json()).toMatchObject({ error: { code: 'PROJECT_FILE_NOT_FOUND' } });

    const symlinkEscape = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/project-files/download?path=outside-link.md`,
      headers: { cookie: session.cookie },
    });
    expect(symlinkEscape.statusCode).toBe(404);
    expect(symlinkEscape.json()).toMatchObject({
      error: { code: 'PROJECT_FILE_NOT_FOUND' },
    });

    const absolute = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/project-files/download?path=${encodeURIComponent(path.join(root, 'outside.md'))}`,
      headers: { cookie: session.cookie },
    });
    expect(absolute.statusCode).toBe(400);
    expect(absolute.json()).toMatchObject({ error: { code: 'PROJECT_FILE_PATH_INVALID' } });
  });

  it('keeps attachment metadata retryable when filesystem deletion fails', async () => {
    const { app, repository, attachmentStore, projectPath } = await fixture(
      2,
      undefined,
      (root) => new FailingRemoveAttachmentStore(root),
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const upload = multipartFile('retry.txt', 'text/plain', Buffer.from('keep me'));
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/attachments`,
      headers: { ...session.headers, 'content-type': upload.contentType },
      payload: upload.body,
    });
    const attachment = uploaded.json<{ data: Attachment }>().data;
    const failed = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${threadId}/attachments/${attachment.id}`,
      headers: session.headers,
    });
    expect(failed.statusCode).toBe(500);
    expect(repository.getAttachment(attachment.id)?.turnId).toBeNull();
    (attachmentStore as FailingRemoveAttachmentStore).failRemove = false;
    const retried = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${threadId}/attachments/${attachment.id}`,
      headers: session.headers,
    });
    expect(retried.statusCode).toBe(204);
    expect(repository.getAttachment(attachment.id)).toBeUndefined();
  });

  it('passes images as localImage and files as private server text while journaling safe metadata only', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const uploads = [
      multipartFile('picture.png', 'image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])),
      multipartFile('notes.txt', 'text/plain', Buffer.from('hello attachment')),
    ];
    const attachments: Attachment[] = [];
    for (const upload of uploads) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/attachments`,
        headers: { ...session.headers, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(response.statusCode).toBe(201);
      attachments.push(response.json<{ data: Attachment }>().data);
    }
    const turn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: '',
        attachmentIds: attachments.map((attachment) => attachment.id),
        idempotencyKey: '00000000-0000-4000-8000-000000000099',
      },
    });
    expect(turn.statusCode).toBe(202);
    const request = [...appServer.requests]
      .reverse()
      .find((entry) => entry.method === 'turn/start')!;
    const input = (request.params as { input: Record<string, unknown>[] }).input;
    const localImage = input.find((item) => item.type === 'localImage')!;
    expect(String(localImage.path)).toContain(attachments[0]!.id);
    const privateText = String(input.find((item) => item.type === 'text')?.text);
    expect(privateText).toContain('notes.txt:');
    expect(privateText).toContain(attachments[1]!.id);
    const userEvent = repository
      .listEvents(threadId, 0)
      .reverse()
      .find((event) => event.kind === 'user-message')!;
    expect(userEvent.payload).toEqual({ text: '', attachments });
    expect(JSON.stringify(userEvent)).not.toContain(String(localImage.path));

    appServer.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId: 'turn-1',
        item: { type: 'userMessage', content: [{ type: 'localImage', path: localImage.path }] },
      },
    });
    expect(repository.listEvents(threadId, 0).filter((event) => event.kind === 'tool')).toEqual([]);
    const privatePath = String(localImage.path);
    const split = Math.floor(privatePath.length / 2);
    for (const delta of [`read ${privatePath.slice(0, split)}`, privatePath.slice(split)]) {
      appServer.emit({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId: 'turn-1', delta },
      });
    }
    for (const delta of [privatePath.slice(0, split), privatePath.slice(split)]) {
      appServer.emit({
        method: 'item/commandExecution/outputDelta',
        params: { threadId, turnId: 'turn-1', delta },
      });
    }
    expect(repository.listEvents(threadId, 0).filter((event) => event.phase === 'delta')).toEqual(
      [],
    );
    expect(
      repository.listEvents(threadId, 0).filter((event) => event.kind === 'agent-message'),
    ).toEqual([]);
    appServer.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId: 'turn-1',
        item: { type: 'agentMessage', phase: 'final_answer', text: `read ${privatePath}` },
      },
    });
    const agentEvent = repository
      .listEvents(threadId, 0)
      .find((event) => event.kind === 'agent-message')!;
    expect(agentEvent.phase).toBe('completed');
    expect(agentEvent.payload.messagePhase).toBe('final_answer');
    expect(JSON.stringify(agentEvent)).not.toContain(privatePath);
    expect(JSON.stringify(agentEvent)).toContain('[attachment-storage]');
    const hydrated = normalizeThreadHistory(
      threadId,
      [
        {
          id: 'turn-history',
          status: 'completed',
          items: [
            {
              type: 'userMessage',
              content: [
                {
                  type: 'text',
                  text: `visible\n\n[Codex Web attachment references (server-local; do not repeat paths):\nsecret.txt: C:\\private\\secret.txt\n]`,
                },
              ],
            },
          ],
        },
      ],
      4_096,
    );
    expect(hydrated.map((event) => event.kind)).toEqual(['user-message', 'turn']);
    expect(hydrated[0]?.payload).toEqual({ text: 'visible' });
    expect(JSON.stringify(hydrated)).not.toContain('C:\\private');
  });

  it('rejects traversal names, spoofed images, cross-thread IDs, duplicates and sent attachment reuse', async () => {
    const { app, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const firstThread = await createThread(app, project.id, session.headers);
    const secondThread = await createThread(app, project.id, session.headers);
    for (const upload of [
      multipartFile('../escape.txt', 'text/plain', Buffer.from('no')),
      multipartFile('fake.png', 'image/png', Buffer.from('not an image')),
      multipartFile('archive.zip', 'application/zip', Buffer.from('PK')),
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${firstThread}/attachments`,
        headers: { ...session.headers, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
    }
    const text = multipartFile('safe.txt', 'text/plain', Buffer.from('safe'));
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/threads/${firstThread}/attachments`,
      headers: { ...session.headers, 'content-type': text.contentType },
      payload: text.body,
    });
    const attachment = uploaded.json<{ data: Attachment }>().data;
    const basePayload = { text: 'inspect', idempotencyKey: '00000000-0000-4000-8000-000000000101' };
    const crossThread = await app.inject({
      method: 'POST',
      url: `/api/threads/${secondThread}/turns`,
      headers: session.headers,
      payload: { ...basePayload, attachmentIds: [attachment.id] },
    });
    expect(crossThread.statusCode).toBe(400);
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/threads/${firstThread}/turns`,
      headers: session.headers,
      payload: { ...basePayload, attachmentIds: [attachment.id, attachment.id] },
    });
    expect(duplicate.statusCode).toBe(400);
    const sent = await app.inject({
      method: 'POST',
      url: `/api/threads/${firstThread}/turns`,
      headers: session.headers,
      payload: { ...basePayload, attachmentIds: [attachment.id] },
    });
    expect(sent.statusCode).toBe(202);
    const replayed = await app.inject({
      method: 'POST',
      url: `/api/threads/${firstThread}/turns`,
      headers: session.headers,
      payload: { ...basePayload, attachmentIds: [attachment.id] },
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toEqual(sent.json());
    const reused = await app.inject({
      method: 'POST',
      url: `/api/threads/${firstThread}/turns`,
      headers: session.headers,
      payload: {
        ...basePayload,
        idempotencyKey: '00000000-0000-4000-8000-000000000102',
        attachmentIds: [attachment.id],
      },
    });
    expect(reused.statusCode).toBe(409);
  });

  it('steers an active turn with attachment-only input and journals public metadata', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const attachments: Attachment[] = [];
    for (const upload of [
      multipartFile('active.png', 'image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])),
      multipartFile('context.txt', 'text/plain', Buffer.from('additional context')),
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/attachments`,
        headers: { ...session.headers, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(response.statusCode).toBe(201);
      attachments.push(response.json<{ data: Attachment }>().data);
    }
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-active', status: 'inProgress', items: [] } },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/steer`,
      headers: session.headers,
      payload: {
        text: '',
        attachmentIds: attachments.map((attachment) => attachment.id),
        expectedTurnId: 'turn-active',
      },
    });

    expect(response.statusCode).toBe(202);
    const request = [...appServer.requests]
      .reverse()
      .find((entry) => entry.method === 'turn/steer')!;
    const input = (request.params as { input: Record<string, unknown>[] }).input;
    expect(String(input.find((item) => item.type === 'text')?.text)).toContain('context.txt:');
    const localImage = input.find((item) => item.type === 'localImage')!;
    expect(String(localImage.path)).toContain(attachments[0]!.id);
    expect(repository.getAttachment(attachments[0]!.id)?.turnId).toBe('turn-active');
    expect(repository.getAttachment(attachments[1]!.id)?.turnId).toBe('turn-active');
    const event = repository.listEvents(threadId, 0).at(-1)!;
    expect(event).toMatchObject({
      turnId: 'turn-active',
      kind: 'user-message',
      phase: 'completed',
      payload: { text: '', attachments },
    });
    expect(JSON.stringify(event)).not.toContain(String(localImage.path));
  });

  it('rejects duplicate, cross-thread and already-bound steer attachments', async () => {
    const { app, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const firstThread = await createThread(app, project.id, session.headers);
    const secondThread = await createThread(app, project.id, session.headers);
    const upload = multipartFile('steer.txt', 'text/plain', Buffer.from('active context'));
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/threads/${firstThread}/attachments`,
      headers: { ...session.headers, 'content-type': upload.contentType },
      payload: upload.body,
    });
    const attachment = uploaded.json<{ data: Attachment }>().data;
    const payload = {
      text: 'continue',
      expectedTurnId: 'turn-active',
      attachmentIds: [attachment.id],
    };
    const crossThread = await app.inject({
      method: 'POST',
      url: `/api/threads/${secondThread}/steer`,
      headers: session.headers,
      payload,
    });
    expect(crossThread.statusCode).toBe(400);
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/threads/${firstThread}/steer`,
      headers: session.headers,
      payload: { ...payload, attachmentIds: [attachment.id, attachment.id] },
    });
    expect(duplicate.statusCode).toBe(400);
    const sent = await app.inject({
      method: 'POST',
      url: `/api/threads/${firstThread}/steer`,
      headers: session.headers,
      payload,
    });
    expect(sent.statusCode).toBe(202);
    const reused = await app.inject({
      method: 'POST',
      url: `/api/threads/${firstThread}/steer`,
      headers: session.headers,
      payload,
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: { code: 'ATTACHMENT_ALREADY_SENT' } });
  });

  it('releases rejected steer attachments but preserves ambiguous claims', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const uploadAttachment = async (name: string): Promise<Attachment> => {
      const upload = multipartFile(name, 'text/plain', Buffer.from(name));
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/attachments`,
        headers: { ...session.headers, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ data: Attachment }>().data;
    };
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-active', status: 'inProgress', items: [] } },
    });

    const unavailableAttachment = await uploadAttachment('unavailable.txt');
    appServer.failNextRequestWith = new Error('APP_SERVER_UNAVAILABLE');
    const unavailable = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/steer`,
      headers: session.headers,
      payload: {
        text: 'retry later',
        attachmentIds: [unavailableAttachment.id],
        expectedTurnId: 'turn-active',
      },
    });
    expect(unavailable.statusCode).toBeGreaterThanOrEqual(500);
    expect(repository.getAttachment(unavailableAttachment.id)?.turnId).toBeNull();

    const rejectedAttachment = await uploadAttachment('rejected.txt');
    appServer.setThreadStatus(threadId, 'idle');
    appServer.failNextRequestWith = new Error('APP_SERVER_REQUEST_FAILED');
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/steer`,
      headers: session.headers,
      payload: {
        text: 'rejected context',
        attachmentIds: [rejectedAttachment.id],
        expectedTurnId: 'turn-active',
      },
    });
    expect(rejected.statusCode).toBe(409);
    expect(repository.getAttachment(rejectedAttachment.id)?.turnId).toBeNull();

    const ambiguousAttachment = await uploadAttachment('ambiguous.txt');
    appServer.setThreadStatus(threadId, 'active');
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-active', status: 'inProgress', items: [] } },
    });
    appServer.failNextRequestWith = new Error('APP_SERVER_REQUEST_TIMEOUT');
    const ambiguous = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/steer`,
      headers: session.headers,
      payload: {
        text: '',
        attachmentIds: [ambiguousAttachment.id],
        expectedTurnId: 'turn-active',
      },
    });
    expect(ambiguous.statusCode).toBe(502);
    expect(repository.getAttachment(ambiguousAttachment.id)?.turnId).toMatch(/^pending:steer:/);
    expect(repository.listEvents(threadId, 0).at(-1)).toMatchObject({
      turnId: 'turn-active',
      kind: 'user-message',
      phase: 'state',
      payload: {
        text: '',
        attachments: [ambiguousAttachment],
        outcomeUnknown: true,
      },
    });
  });

  it('allows inert Office documents but rejects generic zip uploads', async () => {
    const { app, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    for (const [name, mimeType] of [
      ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ] as const) {
      const upload = multipartFile(name, mimeType, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]));
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/attachments`,
        headers: { ...session.headers, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ data: { name, mediaType: mimeType, kind: 'file' } });
    }
    for (const [name, mediaType] of [
      ['source.ts', 'video/mp2t'],
      ['script.py', 'application/octet-stream'],
      ['notes.md', undefined],
    ] as const) {
      const upload = multipartFile(name, mediaType, Buffer.from('safe source text'));
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/attachments`,
        headers: { ...session.headers, 'content-type': upload.contentType },
        payload: upload.body,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        data: { name, mediaType: name.endsWith('.md') ? 'text/markdown' : 'text/plain' },
      });
    }
    const executable = multipartFile('payload.exe', 'application/octet-stream', Buffer.from('MZ'));
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/attachments`,
      headers: { ...session.headers, 'content-type': executable.contentType },
      payload: executable.body,
    });
    expect(rejected.statusCode).toBe(415);
  });

  it('uses the exact initialized notification and never exposes upstream error details', async () => {
    expect(INITIALIZED_NOTIFICATION).toEqual({ method: 'initialized', params: {} });
    expect(INITIALIZE_PARAMS).toMatchObject({ capabilities: { experimentalApi: true } });
    const { app, appServer } = await fixture();
    const session = await login(app);
    appServer.failNextRequestWith = new Error(
      'failed at /srv/private/customer-project with token sk-secret',
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/models',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(
      JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Request failed' } }),
    );
    expect(response.body).not.toContain('/srv/private');
    expect(response.body).not.toContain('sk-secret');
  });

  it('persists project-scoped threads and maps archive/unarchive to app-server', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const started = await app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: session.headers,
      payload: { projectId: project.id },
    });
    expect(started.statusCode).toBe(201);
    const threadId = started.json<{ data: { id: string } }>().data.id;
    const turn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'Keep this chat',
        idempotencyKey: '00000000-0000-4000-8000-000000000060',
      },
    });
    expect(turn.statusCode).toBe(202);

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/threads/${threadId}/archive`,
          headers: session.headers,
        })
      ).statusCode,
    ).toBe(200);
    const archived = await app.inject({
      method: 'GET',
      url: `/api/threads?projectId=${project.id}&archived=true`,
      headers: { cookie: session.cookie },
    });
    expect(archived.json<{ data: { id: string; archived: boolean }[] }>().data).toEqual([
      expect.objectContaining({ id: threadId, archived: true }),
    ]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/threads/${threadId}/unarchive`,
          headers: session.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(appServer.requests.map((item) => item.method)).toContain('thread/archive');
    expect(appServer.requests.map((item) => item.method)).toContain('thread/unarchive');
  });

  it('does not let a stale active-thread list overwrite a concurrent archive', async () => {
    const { app, appServer, projectPath, repository } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const listGate = appServer.blockThreadLists();

    const staleList = app.inject({
      method: 'GET',
      url: `/api/threads?projectId=${project.id}&archived=false`,
      headers: { cookie: session.cookie },
    });
    await listGate.entered;

    const archived = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/archive`,
      headers: session.headers,
    });
    expect(archived.statusCode).toBe(200);
    listGate.release();

    const staleResponse = await staleList;
    expect(staleResponse.statusCode).toBe(200);
    expect(staleResponse.json<{ data: { id: string }[] }>().data).not.toContainEqual(
      expect.objectContaining({ id: threadId }),
    );
    expect(repository.getThread(threadId)?.archived).toBe(true);
  });

  it('reconciles an archive whose upstream mutation succeeded but response failed', async () => {
    const { app, appServer, projectPath, repository } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const turn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'Persisted before archive',
        idempotencyKey: '00000000-0000-4000-8000-000000000062',
      },
    });
    expect(turn.statusCode).toBe(202);
    appServer.failNextArchiveResponseAfterMutation();

    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/archive`,
      headers: session.headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { archived: boolean } }>().data.archived).toBe(true);
    expect(repository.getThread(threadId)?.archived).toBe(true);
    const [archiveRequest, reconciliationRequest] = appServer.requests.slice(-2);
    expect(archiveRequest?.method).toBe('thread/archive');
    expect(reconciliationRequest?.method).toBe('thread/list');
    expect(reconciliationRequest?.params).toMatchObject({ archived: true });
  });

  it('fails closed and invalidates loaded state when archive reconciliation is incomplete', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.failNextArchiveResponseAndReconciliation();

    const archive = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/archive`,
      headers: session.headers,
    });
    expect(archive.statusCode).toBe(500);

    const sent = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'Continue after ambiguous archive',
        idempotencyKey: '00000000-0000-4000-8000-000000000064',
      },
    });

    expect(sent.statusCode).toBe(202);
    const resumeIndex = appServer.requests.findIndex(
      (request) => request.method === 'thread/resume',
    );
    const turnStartIndex = appServer.requests.findIndex(
      (request) => request.method === 'turn/start',
    );
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(turnStartIndex).toBeGreaterThan(resumeIndex);
  });

  it('fails closed when archive reconciliation finds the thread under another cwd', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.setThreadCwd(threadId, `${projectPath}-other`);
    appServer.failNextArchiveResponseAfterMutation();

    const archive = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/archive`,
      headers: session.headers,
    });

    expect(archive.statusCode).toBe(500);
    expect(archive.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Request failed' },
    });
  });

  it('resumes a restored thread before starting its next turn', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);

    const archived = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/archive`,
      headers: session.headers,
    });
    expect(archived.statusCode).toBe(200);
    const restored = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/unarchive`,
      headers: session.headers,
    });
    expect(restored.statusCode).toBe(200);

    const sent = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'Continue after restore',
        idempotencyKey: '00000000-0000-4000-8000-000000000063',
      },
    });

    expect(sent.statusCode).toBe(202);
    const resumeIndex = appServer.requests.findIndex(
      (request) => request.method === 'thread/resume',
    );
    const turnStartIndex = appServer.requests.findIndex(
      (request) => request.method === 'turn/start',
    );
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(turnStartIndex).toBeGreaterThan(resumeIndex);
  });

  it('archives an empty local chat when Codex has not persisted its thread yet', async () => {
    const { app, appServer, projectPath, repository } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    repository.appendEvent({
      threadId,
      turnId: null,
      kind: 'thread',
      phase: 'state',
      payload: { status: 'idle' },
    });

    const archived = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/archive`,
      headers: session.headers,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ data: { archived: boolean } }>().data.archived).toBe(true);

    appServer.failNextRequestWith = new Error('APP_SERVER_REQUEST_FAILED');
    const restored = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/unarchive`,
      headers: session.headers,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<{ data: { archived: boolean } }>().data.archived).toBe(false);
  });

  it('does not hide an upstream archive failure for a chat with history', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const turn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'Persisted content',
        idempotencyKey: '00000000-0000-4000-8000-000000000061',
      },
    });
    expect(turn.statusCode).toBe(202);

    appServer.failNextRequestWith = new Error('APP_SERVER_REQUEST_FAILED');
    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/archive`,
      headers: session.headers,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Request failed' },
    });
  });

  it('imports existing app-server threads for a registered cwd and reports live account auth safely', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const externalId = appServer.addExternalThread(projectPath);
    const secondExternalId = appServer.addExternalThread(projectPath);
    appServer.setThreadListPageSize(1);
    const listed = await app.inject({
      method: 'GET',
      url: `/api/threads?projectId=${project.id}&archived=false`,
      headers: { cookie: session.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ data: { id: string }[] }>().data).toContainEqual(
      expect.objectContaining({ id: externalId }),
    );
    expect(listed.json<{ data: { id: string }[] }>().data).toContainEqual(
      expect.objectContaining({ id: secondExternalId }),
    );
    const capabilities = await app.inject({
      method: 'GET',
      url: '/api/system/capabilities',
      headers: { cookie: session.cookie },
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      authenticated: true,
      account: { type: 'chatgpt', email: 'owner@example.test', planType: 'plus' },
      codexVersion: 'codex-cli 0.153.4',
      rateLimits: [
        {
          limitId: 'codex',
          limitName: 'Codex',
          planType: 'plus',
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: null,
        },
      ],
      usage: {
        summary: { lifetimeTokens: 10_000, currentStreakDays: 2 },
        dailyUsageBuckets: [{ startDate: '2026-09-27', tokens: 500 }],
      },
    });
    expect(capabilities.body).not.toContain('private-account-id');
    expect(capabilities.body).not.toContain('private@example.test');
    expect(capabilities.body).not.toContain('balance');
    expect(capabilities.body).not.toContain('must-not-leak');
    appServer.failAccountStatusReads = true;
    const degraded = await app.inject({
      method: 'GET',
      url: '/api/system/capabilities',
      headers: { cookie: session.cookie },
    });
    expect(degraded.statusCode).toBe(200);
    const degradedBody = degraded.json<{
      authenticated: boolean;
      rateLimits: unknown;
      usage: unknown;
      warnings: string[];
    }>();
    expect(degradedBody).toMatchObject({
      authenticated: true,
      rateLimits: null,
      usage: null,
    });
    expect(degradedBody.warnings).toContain('Codex rate limits are unavailable.');
    expect(degradedBody.warnings).toContain('Codex account usage is unavailable.');
    expect(appServer.requests.find((item) => item.method === 'thread/list')?.params).toMatchObject({
      sourceKinds: ['cli', 'vscode', 'appServer', 'exec'],
    });
    expect(appServer.requests.filter((item) => item.method === 'thread/list')).toHaveLength(2);
  });

  it('reports only safe aggregated usage for a selected repository thread', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);

    const response = await app.inject({
      method: 'GET',
      url: `/api/system/capabilities?threadId=${encodeURIComponent(threadId)}`,
      headers: { cookie: session.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      usage: {
        summary: { lifetimeTokens: 10_000 },
      },
      threadUsage: {
        threadId,
        estimated: true,
        inputTokens: 1_500,
        cachedInputTokens: null,
        netNewInputTokens: 1_100,
        outputTokens: 300,
        totalTokens: 1_800,
      },
    });
    expect(response.body).not.toContain('estimatedUsageCreditsMicros');
    expect(response.body).not.toContain('estimatedUsageUsdMicros');
    expect(response.body).not.toContain('billingRoute');
    expect(response.body).not.toContain('must-not-leak');
    expect(
      appServer.requests
        .filter((item) => item.method === 'account/usage/read')
        .map((item) => item.params),
    ).toEqual([null, { threadId }]);
  });

  it('degrades malformed or failed thread usage independently from account usage', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.threadUsageResponse = {
      summary: { lifetimeTokens: 999_999 },
      threadUsage: {
        threadId: 'wrong-thread',
        groups: [{ inputTokens: 9_999 }],
        estimatedUsageCreditsMicros: 123_000,
      },
    };

    const malformed = await app.inject({
      method: 'GET',
      url: `/api/system/capabilities?threadId=${encodeURIComponent(threadId)}`,
      headers: { cookie: session.cookie },
    });
    expect(malformed.statusCode).toBe(200);
    const malformedBody = capabilitySchema.parse(malformed.json());
    expect(malformedBody.usage?.summary.lifetimeTokens).toBe(10_000);
    expect(malformedBody.threadUsage).toBeNull();
    expect(malformedBody.warnings).toContain('Codex thread usage is unavailable.');

    appServer.failThreadUsageReads = true;
    const failed = await app.inject({
      method: 'GET',
      url: `/api/system/capabilities?threadId=${encodeURIComponent(threadId)}`,
      headers: { cookie: session.cookie },
    });
    expect(failed.statusCode).toBe(200);
    const failedBody = capabilitySchema.parse(failed.json());
    expect(failedBody.usage?.summary.lifetimeTokens).toBe(10_000);
    expect(failedBody.threadUsage).toBeNull();
    expect(failedBody.warnings).toContain('Codex thread usage is unavailable.');
  });

  it('rejects an unknown capability thread before making upstream requests', async () => {
    const { app, appServer } = await fixture();
    const session = await login(app);
    const requestCount = appServer.requests.length;

    const response = await app.inject({
      method: 'GET',
      url: '/api/system/capabilities?threadId=unknown-thread',
      headers: { cookie: session.cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'THREAD_NOT_FOUND', message: 'THREAD_NOT_FOUND' },
    });
    expect(appServer.requests).toHaveLength(requestCount);
  });

  it('applies a Codex update while all execution work is idle', async () => {
    const updateBroker = new FakeCodexUpdateBroker();
    const { app, appServer, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      updateBroker,
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-busy', status: 'inProgress' } },
    });

    const busy = await app.inject({
      method: 'POST',
      url: '/api/system/codex-update/apply',
      headers: session.headers,
      payload: {},
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: 'CODEX_UPDATE_BUSY' } });
    expect(updateBroker.applyCalls).toBe(0);

    appServer.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-busy', status: 'completed' } },
    });
    const applied = await app.inject({
      method: 'POST',
      url: '/api/system/codex-update/apply',
      headers: session.headers,
      payload: {},
    });
    expect(applied.statusCode).toBe(202);
    expect(applied.json()).toMatchObject({
      data: {
        state: 'applying',
        currentVersion: 'codex-cli 0.153.4',
        availableVersion: 'codex-cli 0.154.0',
      },
    });
    expect(updateBroker.applyCalls).toBe(1);

    const blockedThread = await app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: session.headers,
      payload: { projectId: project.id },
    });
    expect(blockedThread.statusCode).toBe(503);
    expect(blockedThread.json()).toMatchObject({ error: { code: 'SERVICE_DRAINING' } });
    const blockedLogin = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    expect(blockedLogin.statusCode).toBe(409);
    expect(blockedLogin.json()).toMatchObject({ error: { code: 'CODEX_UPDATE_PENDING' } });
  });

  it('retries startup update-broker reconciliation before reopening task admission', async () => {
    const updateBroker = new FakeCodexUpdateBroker();
    updateBroker.failStatus = true;
    const { app, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      updateBroker,
      undefined,
      10,
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: session.headers,
      payload: { projectId: project.id },
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({ error: { code: 'SERVICE_DRAINING' } });

    const readsBeforeRecovery = updateBroker.statusReads;
    updateBroker.failStatus = false;
    await vi.waitFor(() => expect(updateBroker.statusReads).toBeGreaterThan(readsBeforeRecovery));

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: session.headers,
      payload: { projectId: project.id },
    });
    expect(accepted.statusCode).toBe(201);
  });

  it('retires startup reconciliation after an authenticated status request succeeds', async () => {
    const updateBroker = new FakeCodexUpdateBroker();
    updateBroker.failStatus = true;
    const { app, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      updateBroker,
      undefined,
      50,
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);

    updateBroker.failStatus = false;
    const reconciled = await app.inject({
      method: 'GET',
      url: '/api/system/codex-update',
      headers: session.headers,
    });
    expect(reconciled.statusCode).toBe(200);

    const readsAfterRecovery = updateBroker.statusReads;
    updateBroker.failStatus = true;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(updateBroker.statusReads).toBe(readsAfterRecovery);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: session.headers,
      payload: { projectId: project.id },
    });
    expect(accepted.statusCode).toBe(201);
  });

  it('lets the root broker download an available Codex update without accepting a target', async () => {
    const updateBroker = new FakeCodexUpdateBroker();
    updateBroker.current = {
      state: 'unavailable',
      currentVersion: 'codex-cli 0.153.4',
      availableVersion: null,
      candidateReleaseId: null,
      lastResult: null,
    };
    const { app } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      updateBroker,
    );
    const session = await login(app);
    const statusReadsBeforeApply = updateBroker.statusReads;

    const targeted = await app.inject({
      method: 'POST',
      url: '/api/system/codex-update/apply',
      headers: session.headers,
      payload: {
        version: 'codex-cli 0.159.3',
        url: 'https://example.test/codex.tgz',
        path: '/tmp/codex.tgz',
      },
    });
    expect(targeted.statusCode).toBe(400);
    expect(updateBroker.statusReads).toBe(statusReadsBeforeApply);
    expect(updateBroker.applyCalls).toBe(0);

    const applied = await app.inject({
      method: 'POST',
      url: '/api/system/codex-update/apply',
      headers: session.headers,
      payload: {},
    });
    expect(applied.statusCode).toBe(202);
    expect(applied.json()).toMatchObject({
      data: {
        state: 'applying',
        currentVersion: 'codex-cli 0.153.4',
        availableVersion: null,
        candidateReleaseId: null,
      },
    });
    expect(updateBroker.statusReads).toBe(statusReadsBeforeApply + 1);
    expect(updateBroker.applyCalls).toBe(1);
  });

  it('checks the fixed upstream Codex version without accepting a caller target', async () => {
    const calls: Array<{ currentVersion: string; force: boolean | undefined }> = [];
    const versionChecker: CodexVersionChecker = {
      async check(currentVersion, force) {
        calls.push({ currentVersion, force });
        return {
          state: 'available',
          currentVersion,
          latestVersion: 'codex-cli 0.159.3',
          checkedAt: '2026-10-01T16:00:00.000Z',
        };
      },
    };
    const { app } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      versionChecker,
    );
    const session = await login(app);

    const cached = await app.inject({
      method: 'GET',
      url: '/api/system/codex-update/discovery',
      headers: { cookie: session.cookie },
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.json()).toEqual({
      data: {
        state: 'available',
        currentVersion: 'codex-cli 0.153.4',
        latestVersion: 'codex-cli 0.159.3',
        checkedAt: '2026-10-01T16:00:00.000Z',
      },
    });

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/system/codex-update/check',
      headers: session.headers,
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    expect(calls).toEqual([
      { currentVersion: 'codex-cli 0.153.4', force: undefined },
      { currentVersion: 'codex-cli 0.153.4', force: true },
    ]);

    const targeted = await app.inject({
      method: 'POST',
      url: '/api/system/codex-update/check',
      headers: session.headers,
      payload: { version: '0.159.3', url: 'https://example.test/package' },
    });
    expect(targeted.statusCode).toBe(400);
    expect(calls).toHaveLength(2);
  });

  it('keeps update admission fail-closed after an ambiguous broker apply failure', async () => {
    const updateBroker = new FakeCodexUpdateBroker();
    updateBroker.failApply = true;
    const { app, repository, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      updateBroker,
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const failed = await app.inject({
      method: 'POST',
      url: '/api/system/codex-update/apply',
      headers: session.headers,
      payload: {},
    });
    expect(failed.statusCode).toBe(500);

    const key = '00000000-0000-4000-8000-000000000110';
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: { text: 'must remain blocked', idempotencyKey: key },
    });
    expect(blocked.statusCode).toBe(503);
    expect(repository.getIdempotent(`turn:${threadId}`, key)).toBeUndefined();

    updateBroker.failApply = false;
    updateBroker.current = { ...updateBroker.current, state: 'ready' };
    const reconciled = await app.inject({
      method: 'GET',
      url: '/api/system/codex-update',
      headers: { cookie: session.cookie },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({ data: { state: 'ready' } });
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: { text: 'continue after reconciliation', idempotencyKey: key },
    });
    expect(accepted.statusCode).toBe(202);
  });

  it('does not let a concurrent ready status clear a pending update apply fence', async () => {
    const ready: CodexUpdateSnapshot = {
      state: 'ready',
      currentVersion: 'codex-cli 0.153.4',
      availableVersion: 'codex-cli 0.154.0',
      candidateReleaseId: '20261001-update-a1b2c3d4',
      lastResult: null,
    };
    let releaseApply!: () => void;
    let signalApplyStarted!: () => void;
    let releaseLateStatus!: () => void;
    let signalLateStatusStarted!: () => void;
    let statusCalls = 0;
    const applyStarted = new Promise<void>((resolve) => {
      signalApplyStarted = resolve;
    });
    const applyReleased = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const lateStatusStarted = new Promise<void>((resolve) => {
      signalLateStatusStarted = resolve;
    });
    const lateStatusReleased = new Promise<void>((resolve) => {
      releaseLateStatus = resolve;
    });
    const updateBroker: CodexUpdateBroker = {
      status: async () => {
        statusCalls += 1;
        if (statusCalls === 3) {
          signalLateStatusStarted();
          await lateStatusReleased;
        }
        return ready;
      },
      apply: async () => {
        signalApplyStarted();
        await applyReleased;
        return { ...ready, state: 'applying' };
      },
    };
    const { app, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      updateBroker,
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const applying = app.inject({
      method: 'POST',
      url: '/api/system/codex-update/apply',
      headers: session.headers,
      payload: {},
    });
    await applyStarted;

    const statusRequest = app.inject({
      method: 'GET',
      url: '/api/system/codex-update',
      headers: { cookie: session.cookie },
    });
    await lateStatusStarted;
    releaseApply();
    expect((await applying).statusCode).toBe(202);
    releaseLateStatus();
    const status = await statusRequest;
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ data: { state: 'ready' } });
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: session.headers,
      payload: { projectId: project.id },
    });
    expect(blocked.statusCode).toBe(503);
  });

  it('starts fail-closed until update state is reconciled and preserves the fence after rollback failure', async () => {
    const updateBroker = new FakeCodexUpdateBroker();
    updateBroker.failStatus = true;
    const { app, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      updateBroker,
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: session.headers,
      payload: { projectId: project.id },
    });
    expect(blocked.statusCode).toBe(503);

    updateBroker.failStatus = false;
    updateBroker.current = {
      ...updateBroker.current,
      state: 'rollback_failed',
      lastResult: {
        status: 'rollback_failed',
        message: 'Rollback requires operator recovery.',
        completedAt: '2026-10-01T10:00:00.000Z',
      },
    };
    const failedRollback = await app.inject({
      method: 'GET',
      url: '/api/system/codex-update',
      headers: { cookie: session.cookie },
    });
    expect(failedRollback.statusCode).toBe(200);
    expect(failedRollback.json()).toMatchObject({ data: { state: 'rollback_failed' } });
    const stillBlocked = await app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: session.headers,
      payload: { projectId: project.id },
    });
    expect(stillBlocked.statusCode).toBe(503);

    updateBroker.current = { ...updateBroker.current, state: 'ready', lastResult: null };
    await app.inject({
      method: 'GET',
      url: '/api/system/codex-update',
      headers: { cookie: session.cookie },
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: session.headers,
      payload: { projectId: project.id },
    });
    expect(accepted.statusCode).toBe(201);
  });

  it('runs a bounded device-code login and accepts only its matching completion', async () => {
    const { app, appServer } = await fixture();
    const session = await login(app);
    const started = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    expect(started.statusCode).toBe(202);
    const startedBody = started.json<{
      data: {
        state: string;
        loginId: string | null;
        userCode: string | null;
        verificationUrl: string | null;
        expiresAt: string | null;
        message: string | null;
      };
    }>();
    expect(startedBody).toMatchObject({
      data: {
        state: 'pending',
        loginId: 'login-1',
        userCode: 'ABCD-EFGH',
        verificationUrl: 'https://auth.openai.com/codex/device',
        message: null,
      },
    });
    expect(startedBody.data.expiresAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(startedBody.data.expiresAt!))).toBe(false);
    appServer.emit({
      method: 'account/login/completed',
      params: { loginId: 'different-login', success: true },
    });
    const stillPending = await app.inject({
      method: 'GET',
      url: '/api/system/codex-account/login',
      headers: { cookie: session.cookie },
    });
    expect(stillPending.json()).toMatchObject({ data: { state: 'pending', loginId: 'login-1' } });

    appServer.emit({
      method: 'account/login/completed',
      params: { loginId: 'login-1', success: false, error: 'secret upstream detail' },
    });
    const failed = await app.inject({
      method: 'GET',
      url: '/api/system/codex-account/login',
      headers: { cookie: session.cookie },
    });
    expect(failed.json()).toEqual({
      data: {
        state: 'failed',
        loginId: 'login-1',
        userCode: null,
        verificationUrl: null,
        expiresAt: null,
        message: 'Account login failed.',
      },
    });
    expect(failed.body).not.toContain('secret upstream detail');
    const capabilities = await app.inject({
      method: 'GET',
      url: '/api/system/capabilities',
      headers: { cookie: session.cookie },
    });
    expect(capabilities.json()).toMatchObject({
      account: { type: 'chatgpt', email: 'owner@example.test', planType: 'plus' },
    });
  });

  it('rejects unsafe device-code responses without exposing their URL', async () => {
    const { app, appServer } = await fixture();
    const session = await login(app);
    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgpt', accessToken: 'must-not-leak' },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(
      appServer.requests.filter((request) => request.method === 'account/login/start'),
    ).toHaveLength(0);
    expect(unsupported.body).not.toContain('must-not-leak');
    appServer.accountLoginResponse = {
      type: 'chatgptDeviceCode',
      loginId: 'login-unsafe',
      userCode: 'SAFE-CODE',
      verificationUrl: 'https://evil.example/device?token=must-not-leak',
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: 'CODEX_ACCOUNT_LOGIN_INVALID_RESPONSE' },
    });
    expect(response.body).not.toContain('evil.example');
    expect(response.body).not.toContain('must-not-leak');
    expect(
      appServer.requests.filter((request) => request.method === 'account/login/cancel'),
    ).toContainEqual({ method: 'account/login/cancel', params: { loginId: 'login-unsafe' } });
  });

  it('keeps unsafe device-code responses fail-closed until cancellation is confirmed', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.accountLoginCancelStatus = 'notFound';
    appServer.accountLoginResponse = {
      type: 'chatgptDeviceCode',
      loginId: 'login-unsafe',
      userCode: 'SAFE-CODE',
      verificationUrl: 'https://evil.example/device',
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    expect(response.statusCode).toBe(502);
    const status = await app.inject({
      method: 'GET',
      url: '/api/system/codex-account/login',
      headers: { cookie: session.cookie },
    });
    expect(status.json()).toMatchObject({
      data: { state: 'pending', loginId: 'login-unsafe', userCode: null, verificationUrl: null },
    });
    const idempotencyKey = '00000000-0000-4000-8000-000000000108';
    const turn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: { text: 'blocked after unsafe response', idempotencyKey },
    });
    expect(turn.statusCode).toBe(409);
    expect(repository.getIdempotent(`turn:${threadId}`, idempotencyKey)).toBeUndefined();
  });

  it('interlocks login with turn admission before an idempotency reservation is created', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const gate = appServer.blockAccountLoginStarts();
    const startingLogin = app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    await gate.entered;
    const idempotencyKey = '00000000-0000-4000-8000-000000000099';
    const rejectedTurn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: { text: 'must wait', idempotencyKey },
    });
    expect(rejectedTurn.statusCode).toBe(409);
    expect(rejectedTurn.json()).toMatchObject({
      error: { code: 'CODEX_ACCOUNT_LOGIN_PENDING' },
    });
    expect(repository.getIdempotent(`turn:${threadId}`, idempotencyKey)).toBeUndefined();
    gate.release();
    expect((await startingLogin).statusCode).toBe(202);
    const canceled = await app.inject({
      method: 'DELETE',
      url: '/api/system/codex-account/login',
      headers: session.headers,
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json()).toMatchObject({ data: { state: 'idle' } });
    const acceptedTurn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: { text: 'continue', idempotencyKey },
    });
    expect(acceptedTurn.statusCode).toBe(202);
  });

  it('interlocks account login with in-flight and newly requested chat creation', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadGate = appServer.blockThreadStarts();
    const startingThread = app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: session.headers,
      payload: { projectId: project.id },
    });
    await threadGate.entered;
    const busyLogin = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    expect(busyLogin.statusCode).toBe(409);
    expect(busyLogin.json()).toMatchObject({ error: { code: 'CODEX_ACCOUNT_LOGIN_BUSY' } });
    threadGate.release();
    expect((await startingThread).statusCode).toBe(201);

    const loginGate = appServer.blockAccountLoginStarts();
    const startingLogin = app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    await loginGate.entered;
    const threadStartsBefore = appServer.requests.filter(
      (request) => request.method === 'thread/start',
    ).length;
    const blockedThread = await app.inject({
      method: 'POST',
      url: '/api/threads',
      headers: session.headers,
      payload: { projectId: project.id },
    });
    expect(blockedThread.statusCode).toBe(409);
    expect(blockedThread.json()).toMatchObject({
      error: { code: 'CODEX_ACCOUNT_LOGIN_PENDING' },
    });
    expect(appServer.requests.filter((request) => request.method === 'thread/start')).toHaveLength(
      threadStartsBefore,
    );
    loginGate.release();
    expect((await startingLogin).statusCode).toBe(202);
  });

  it('lets login win an admission race while stale turn capacity is being reconciled', async () => {
    const { app, appServer, repository, projectPath } = await fixture(1);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const staleThreadId = await createThread(app, project.id, session.headers);
    const startingThreadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'thread/status/changed',
      params: { threadId: staleThreadId, status: { type: 'active' } },
    });
    appServer.setThreadStatus(staleThreadId, 'idle');
    let loginStatus: number | null = null;
    appServer.beforeThreadReadReturn = async () => {
      appServer.emit({
        method: 'thread/status/changed',
        params: { threadId: staleThreadId, status: { type: 'idle' } },
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/system/codex-account/login',
        headers: session.headers,
        payload: { type: 'chatgptDeviceCode' },
      });
      loginStatus = response.statusCode;
    };
    const idempotencyKey = '00000000-0000-4000-8000-000000000101';
    const turn = await app.inject({
      method: 'POST',
      url: `/api/threads/${startingThreadId}/turns`,
      headers: session.headers,
      payload: { text: 'race', idempotencyKey },
    });
    expect(loginStatus).toBe(202);
    expect(turn.statusCode).toBe(409);
    expect(turn.json()).toMatchObject({ error: { code: 'CODEX_ACCOUNT_LOGIN_PENDING' } });
    expect(repository.getIdempotent(`turn:${startingThreadId}`, idempotencyKey)).toBeUndefined();
  });

  it('keeps the login interlock fail-closed when upstream cancellation fails', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.failAccountLoginCancels = true;
    const started = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    expect(started.statusCode).toBe(202);
    const cancel = await app.inject({
      method: 'DELETE',
      url: '/api/system/codex-account/login',
      headers: session.headers,
    });
    expect(cancel.statusCode).toBe(500);
    const idempotencyKey = '00000000-0000-4000-8000-000000000102';
    const turn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: { text: 'still blocked', idempotencyKey },
    });
    expect(turn.json()).toMatchObject({ error: { code: 'CODEX_ACCOUNT_LOGIN_PENDING' } });
    expect(repository.getIdempotent(`turn:${threadId}`, idempotencyKey)).toBeUndefined();
  });

  it('keeps the login interlock fail-closed when Codex cannot find the login to cancel', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.accountLoginCancelStatus = 'notFound';
    const started = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    expect(started.statusCode).toBe(202);
    const cancel = await app.inject({
      method: 'DELETE',
      url: '/api/system/codex-account/login',
      headers: session.headers,
    });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json()).toMatchObject({
      error: { code: 'CODEX_ACCOUNT_LOGIN_CANCEL_UNCONFIRMED' },
    });
    const idempotencyKey = '00000000-0000-4000-8000-000000000106';
    const turn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: { text: 'still blocked after not found', idempotencyKey },
    });
    expect(turn.statusCode).toBe(409);
    expect(turn.json()).toMatchObject({ error: { code: 'CODEX_ACCOUNT_LOGIN_PENDING' } });
    expect(repository.getIdempotent(`turn:${threadId}`, idempotencyKey)).toBeUndefined();
  });

  it('keeps admission fail-closed after an ambiguous account login start failure', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.failNextRequestWith = new Error('APP_SERVER_REQUEST_TIMEOUT');
    const start = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    expect(start.statusCode).toBe(500);
    const status = await app.inject({
      method: 'GET',
      url: '/api/system/codex-account/login',
      headers: { cookie: session.cookie },
    });
    expect(status.json()).toMatchObject({ data: { state: 'pending', loginId: null } });
    const idempotencyKey = '00000000-0000-4000-8000-000000000107';
    const turn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: { text: 'blocked after ambiguous start', idempotencyKey },
    });
    expect(turn.statusCode).toBe(409);
    expect(turn.json()).toMatchObject({ error: { code: 'CODEX_ACCOUNT_LOGIN_PENDING' } });
    expect(repository.getIdempotent(`turn:${threadId}`, idempotencyKey)).toBeUndefined();

    appServer.emit({
      method: 'account/login/completed',
      params: { loginId: 'unrelated-login', success: true },
    });
    const afterUnrelatedCompletion = await app.inject({
      method: 'GET',
      url: '/api/system/codex-account/login',
      headers: { cookie: session.cookie },
    });
    expect(afterUnrelatedCompletion.json()).toMatchObject({
      data: { state: 'pending', loginId: null },
    });
    const secondTurn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'still blocked after unrelated completion',
        idempotencyKey: '00000000-0000-4000-8000-000000000109',
      },
    });
    expect(secondTurn.statusCode).toBe(409);
  });

  it('releases timed-out login admission only after Codex confirms cancellation', async () => {
    const { app, appServer, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      5,
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const started = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    expect(started.statusCode).toBe(202);
    await expect
      .poll(
        () =>
          appServer.requests.filter((request) => request.method === 'account/login/cancel').length,
      )
      .toBe(1);
    expect(
      appServer.requests.filter((request) => request.method === 'account/login/cancel'),
    ).toContainEqual({ method: 'account/login/cancel', params: { loginId: 'login-1' } });
    const status = await app.inject({
      method: 'GET',
      url: '/api/system/codex-account/login',
      headers: { cookie: session.cookie },
    });
    expect(status.json()).toMatchObject({
      data: { state: 'failed', message: 'Account login expired.' },
    });
    const turn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'continue after timeout',
        idempotencyKey: '00000000-0000-4000-8000-000000000103',
      },
    });
    expect(turn.statusCode).toBe(202);
  });

  it('keeps timed-out login admission blocked when Codex cancellation fails', async () => {
    const { app, appServer, repository, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      5,
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.failAccountLoginCancels = true;
    const started = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    expect(started.statusCode).toBe(202);
    await expect
      .poll(
        () =>
          appServer.requests.filter((request) => request.method === 'account/login/cancel').length,
      )
      .toBe(1);
    const status = await app.inject({
      method: 'GET',
      url: '/api/system/codex-account/login',
      headers: { cookie: session.cookie },
    });
    expect(status.json()).toMatchObject({ data: { state: 'pending', loginId: 'login-1' } });
    const idempotencyKey = '00000000-0000-4000-8000-000000000104';
    const turn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: { text: 'still blocked after timeout', idempotencyKey },
    });
    expect(turn.statusCode).toBe(409);
    expect(turn.json()).toMatchObject({ error: { code: 'CODEX_ACCOUNT_LOGIN_PENDING' } });
    expect(repository.getIdempotent(`turn:${threadId}`, idempotencyKey)).toBeUndefined();
  });

  it('keeps admission fail-closed while the login start RPC has not returned an id', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const gate = appServer.blockAccountLoginStarts();
    const starting = app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    await gate.entered;
    const canceled = await app.inject({
      method: 'DELETE',
      url: '/api/system/codex-account/login',
      headers: session.headers,
    });
    expect(canceled.statusCode).toBe(409);
    expect(canceled.json()).toMatchObject({
      error: { code: 'CODEX_ACCOUNT_LOGIN_STARTING' },
    });
    const idempotencyKey = '00000000-0000-4000-8000-000000000105';
    const turn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: { text: 'blocked while login starts', idempotencyKey },
    });
    expect(turn.statusCode).toBe(409);
    expect(repository.getIdempotent(`turn:${threadId}`, idempotencyKey)).toBeUndefined();
    gate.release();
    expect((await starting).statusCode).toBe(202);
    const finalCancel = await app.inject({
      method: 'DELETE',
      url: '/api/system/codex-account/login',
      headers: session.headers,
    });
    expect(finalCancel.statusCode).toBe(200);
    expect(finalCancel.json()).toMatchObject({ data: { state: 'idle' } });
  });

  it('rejects account login while a root turn, pending start, or subagent is active', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const turnGate = appServer.blockTurnStarts();
    const pendingTurn = app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'running',
        idempotencyKey: '00000000-0000-4000-8000-000000000100',
      },
    });
    await turnGate.entered;
    const pendingBusy = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    expect(pendingBusy.json()).toMatchObject({ error: { code: 'CODEX_ACCOUNT_LOGIN_BUSY' } });
    turnGate.release();
    expect((await pendingTurn).statusCode).toBe(202);
    const activeBusy = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    expect(activeBusy.json()).toMatchObject({ error: { code: 'CODEX_ACCOUNT_LOGIN_BUSY' } });
    appServer.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-1', status: 'completed' } },
    });
    repository.upsertSubagent({
      id: 'login-blocking-child',
      rootThreadId: threadId,
      parentThreadId: threadId,
      agentPath: '/root/login-blocking-child',
      nickname: null,
      role: null,
      model: 'gpt-test',
      reasoningEffort: 'medium',
      status: 'running',
      message: null,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      completedAt: null,
    });
    const subagentBusy = await app.inject({
      method: 'POST',
      url: '/api/system/codex-account/login',
      headers: session.headers,
      payload: { type: 'chatgptDeviceCode' },
    });
    expect(subagentBusy.json()).toMatchObject({ error: { code: 'CODEX_ACCOUNT_LOGIN_BUSY' } });
    expect(
      appServer.requests.filter((request) => request.method === 'account/login/start'),
    ).toHaveLength(0);
  });

  it('rejects a stored project path after a symlink swap before app-server access', async () => {
    const { app, appServer, projectPath, root } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const original = `${projectPath}-original`;
    const outside = path.join(path.dirname(root), 'outside');
    await rename(projectPath, original);
    await mkdir(outside);
    await symlink(outside, projectPath, process.platform === 'win32' ? 'junction' : 'dir');
    const response = await app.inject({
      method: 'GET',
      url: `/api/threads?projectId=${project.id}&archived=false`,
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'PROJECT_PATH_NO_LONGER_ALLOWED' },
    });
    expect(appServer.requests.some((item) => item.method === 'thread/list')).toBe(false);
  });

  it('rejects thread/list entries whose cwd does not exactly match the project', async () => {
    const { app, appServer, projectPath, root } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    appServer.addExternalThread(root);
    const response = await app.inject({
      method: 'GET',
      url: `/api/threads?projectId=${project.id}&archived=false`,
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'APP_SERVER_CWD_MISMATCH' } });
  });

  it('returns safe journal history instead of raw app-server turns', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = (
      await app.inject({
        method: 'POST',
        url: '/api/threads',
        headers: session.headers,
        payload: { projectId: project.id },
      })
    ).json<{ data: { id: string } }>().data;
    appServer.setThreadTurns(thread.id, [
      { id: 'raw-turn', items: [{ type: 'reasoning', text: 'private chain of thought' }] },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}`,
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { id: thread.id }, events: [] });
    expect(response.body).not.toContain('raw-turn');
    expect(response.body).not.toContain('private chain of thought');
    expect(response.json()).not.toHaveProperty('turns');
  });

  it('hydrates existing thread history once through a strict public item allowlist', async () => {
    const { app, appServer, attachmentStore, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = { id: appServer.addExternalThread(projectPath) };
    await app.inject({
      method: 'GET',
      url: `/api/threads?projectId=${project.id}&archived=false`,
      headers: { cookie: session.cookie },
    });
    appServer.setThreadTurns(thread.id, [
      {
        id: 'historical-turn',
        status: 'completed',
        items: [
          {
            id: 'user',
            type: 'userMessage',
            content: [
              { type: 'text', text: 'hello token=supersecret' },
              { type: 'localImage', path: '/private/image.png' },
            ],
          },
          {
            id: 'agent',
            type: 'agentMessage',
            phase: 'final_answer',
            text: `safe answer from ${attachmentStore.root}/private-file.txt`,
          },
          { id: 'plan', type: 'plan', text: 'public plan' },
          {
            id: 'reasoning',
            type: 'reasoning',
            summary: ['public reasoning summary'],
            content: ['hidden chain of thought'],
          },
          {
            id: 'command',
            type: 'commandExecution',
            command: 'echo apiKey=command-secret',
            status: 'completed',
            aggregatedOutput: 'password=output-secret',
            cwd: projectPath,
            commandActions: [],
          },
          {
            id: 'files',
            type: 'fileChange',
            status: 'completed',
            changes: [
              {
                path: 'src/safe.ts',
                kind: { type: 'update' },
                diff: 'raw diff privateKey=diff-secret',
              },
            ],
          },
          {
            id: 'unknown',
            type: 'mcpToolCall',
            arguments: { secret: 'unknown-secret' },
          },
        ],
      },
    ]);

    const first = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}`,
      headers: { cookie: session.cookie },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{
      events: { id: number; kind: string }[];
      turnNavigation: { turnId: string; label: string }[];
    }>();
    const firstEvents = firstBody.events;
    expect(firstEvents.map((event) => event.kind)).toEqual([
      'user-message',
      'agent-message',
      'plan',
      'plan',
      'command',
      'file-change',
      'turn',
    ]);
    expect(first.body).toContain('public reasoning summary');
    expect(first.body).toContain('final_answer');
    expect(first.body).toContain('src/safe.ts');
    expect(first.body).not.toContain('hidden chain of thought');
    expect(first.body).not.toContain('raw diff');
    expect(first.body).not.toContain('unknown-secret');
    expect(first.body).not.toContain('command-secret');
    expect(first.body).not.toContain('output-secret');
    expect(first.body).not.toContain('/private/image.png');
    expect(first.body).not.toContain('supersecret');
    expect(first.body).not.toContain(attachmentStore.root);
    expect(first.body).toContain('[attachment-storage]/private-file.txt');
    expect(firstBody.turnNavigation).toEqual([
      expect.objectContaining({
        turnId: 'historical-turn',
        label: 'hello token[REDACTED]',
      }),
    ]);

    const second = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}`,
      headers: { cookie: session.cookie },
    });
    expect(second.json<{ events: { id: number }[] }>().events).toEqual(firstEvents);
    expect(
      appServer.requests
        .filter((request) => request.method === 'thread/read')
        .map((request) => request.params),
    ).toEqual([
      { threadId: thread.id, includeTurns: true },
      { threadId: thread.id, includeTurns: false },
    ]);
  });

  it('uses an explicit hydration marker and merges history after a pre-hydration event', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = { id: appServer.addExternalThread(projectPath) };
    await app.inject({
      method: 'GET',
      url: `/api/threads?projectId=${project.id}&archived=false`,
      headers: { cookie: session.cookie },
    });
    repository.appendEvent({
      threadId: thread.id,
      turnId: null,
      kind: 'warning',
      phase: 'state',
      payload: { message: 'arrived before hydration' },
    });
    appServer.setThreadTurns(thread.id, [
      {
        id: 'historical-turn',
        status: 'completed',
        items: [
          {
            id: 'historical-user',
            type: 'userMessage',
            content: [{ type: 'text', text: 'historical text' }],
          },
        ],
      },
    ]);
    expect(repository.isThreadHistoryHydrated(thread.id)).toBe(false);
    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}`,
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ events: { kind: string }[] }>().events.map((event) => event.kind),
    ).toEqual(['warning', 'user-message', 'turn']);
    expect(repository.isThreadHistoryHydrated(thread.id)).toBe(true);
  });

  it('recovers missed completed answers from native history after restart without duplicating them', async () => {
    const { app, appServer, repository, attachmentStore, projectPath } = await fixture(
      2,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { eventRetentionPerThread: 3 },
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const redactedAnswer = `finished from ${attachmentStore.root}/private-result.txt`;
    repository.appendEvent({
      threadId,
      turnId: 'identical-turn',
      kind: 'user-message',
      phase: 'completed',
      payload: { text: 'make the result' },
    });
    repository.appendEvent({
      threadId,
      turnId: 'missed-turn',
      kind: 'agent-message',
      phase: 'completed',
      payload: {
        text: 'finished from [attachment-storage]/private-result.txt',
        messagePhase: 'final_answer',
      },
    });
    appServer.setThreadTurns(threadId, [
      {
        id: 'missed-turn',
        status: 'completed',
        items: [
          {
            id: 'missed-user',
            type: 'userMessage',
            content: [{ type: 'text', text: 'make the result' }],
          },
          {
            id: 'phase-less-answer',
            type: 'agentMessage',
            text: 'phase-less final answer',
          },
          {
            id: 'missed-files',
            type: 'fileChange',
            status: 'completed',
            changes: [{ path: 'result/report.md', kind: { type: 'add' } }],
          },
        ],
      },
      {
        id: 'identical-turn',
        status: 'completed',
        items: [
          {
            id: 'first-identical-answer',
            type: 'agentMessage',
            phase: 'final_answer',
            text: redactedAnswer,
          },
          {
            id: 'second-identical-answer',
            type: 'agentMessage',
            phase: 'final_answer',
            text: redactedAnswer,
          },
        ],
      },
      {
        id: 'failed-turn',
        status: 'failed',
        items: [{ id: 'failed-answer', type: 'agentMessage', text: 'failed draft' }],
      },
      {
        id: 'interrupted-turn',
        status: 'interrupted',
        items: [{ id: 'interrupted-answer', type: 'agentMessage', text: 'interrupted draft' }],
      },
    ]);
    appServer.restart();

    const recovered = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });

    expect(recovered.statusCode).toBe(200);
    const recoveredEvents = recovered.json<{ events: SafeEvent[] }>().events;
    const answers = recoveredEvents.filter((event) => event.kind === 'agent-message');
    expect(answers).toHaveLength(3);
    expect(answers.every((event) => event.payload.messagePhase === 'final_answer')).toBe(true);
    expect(answers.map((event) => event.payload.text)).toContain('phase-less final answer');
    expect(answers.map((event) => event.payload.text)).not.toContain('failed draft');
    expect(answers.map((event) => event.payload.text)).not.toContain('interrupted draft');
    expect(JSON.stringify(answers)).not.toContain(attachmentStore.root);
    expect(JSON.stringify(answers)).toContain('[attachment-storage]/private-result.txt');
    expect(
      recoveredEvents.find(
        (event) => event.kind === 'file-change' && event.turnId === 'missed-turn',
      ),
    ).toMatchObject({
      phase: 'completed',
      payload: { changes: [{ path: 'result/report.md', kind: 'add' }] },
    });
    expect(recoveredEvents.filter((event) => event.kind === 'turn')).toHaveLength(4);

    for (let index = 0; index < 5; index += 1) {
      repository.appendEvent({
        threadId,
        turnId: null,
        kind: 'warning',
        phase: 'state',
        payload: { index },
      });
    }

    appServer.restart();
    const repeated = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });
    expect(repeated.statusCode).toBe(200);
    const repeatedEvents = repeated.json<{ events: SafeEvent[] }>().events;
    expect(repeatedEvents.filter((event) => event.kind === 'agent-message')).toHaveLength(3);
    expect(repeatedEvents.filter((event) => event.kind === 'file-change')).toHaveLength(1);
    expect(
      repeatedEvents.find((event) => event.kind === 'turn' && event.turnId === 'missed-turn'),
    ).toMatchObject({ phase: 'completed', payload: { status: 'completed' } });
    expect(
      repeatedEvents.find((event) => event.kind === 'turn' && event.turnId === 'failed-turn'),
    ).toBeUndefined();
    expect(
      repeatedEvents.find((event) => event.kind === 'turn' && event.turnId === 'interrupted-turn'),
    ).toBeUndefined();

    appServer.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId: 'live-production-turn',
        item: {
          id: 'live-production-files',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'result/live.html', kind: { type: 'add' } }],
        },
      },
    });
    appServer.emit({
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: 'live-production-turn', status: 'completed', items: [] },
      },
    });
    for (let index = 0; index < 5; index += 1) {
      repository.appendEvent({
        threadId,
        turnId: null,
        kind: 'warning',
        phase: 'state',
        payload: { liveNoise: index },
      });
    }
    const retainedLiveEvents = repository.listEvents(threadId, 0);
    expect(
      retainedLiveEvents.find(
        (event) => event.kind === 'tool' && event.turnId === 'live-production-turn',
      ),
    ).toMatchObject({
      phase: 'completed',
      payload: {
        item: {
          id: 'live-production-files',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'result/live.html', kind: { type: 'add' } }],
        },
      },
    });
    expect(
      retainedLiveEvents.find(
        (event) => event.kind === 'turn' && event.turnId === 'live-production-turn',
      ),
    ).toMatchObject({
      phase: 'completed',
      payload: { turn: { id: 'live-production-turn', status: 'completed', items: [] } },
    });

    appServer.setThreadTurns(threadId, [
      {
        id: 'replacement-turn',
        status: 'completed',
        items: [{ id: 'replacement-answer', type: 'agentMessage', text: 'replacement' }],
      },
    ]);
    appServer.restart();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/threads/${threadId}`,
          headers: { cookie: session.cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        repository.database
          .prepare('SELECT COUNT(*) AS count FROM thread_history_event_state WHERE thread_id=?')
          .get(threadId) as { count: number }
      ).count,
    ).toBe(2);
  });

  it('does not let a stale initial hydration erase navigation appended while its read is pending', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = appServer.addExternalThread(projectPath);
    await app.inject({
      method: 'GET',
      url: `/api/threads?projectId=${project.id}&archived=false`,
      headers: { cookie: session.cookie },
    });
    appServer.setThreadTurns(threadId, [
      {
        id: 'stale-turn',
        status: 'completed',
        items: [{ type: 'userMessage', content: [{ type: 'text', text: 'stale task' }] }],
      },
    ]);
    const blockedRead = appServer.blockThreadReads();
    const hydration = app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });
    await blockedRead.entered;

    const steered = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/steer`,
      headers: session.headers,
      payload: { text: 'live instruction', expectedTurnId: 'live-turn' },
    });
    expect(steered.statusCode).toBe(202);
    expect(repository.listTurnNavigation(threadId)).toEqual([
      expect.objectContaining({ turnId: 'live-turn', label: 'live instruction' }),
    ]);

    blockedRead.release();
    const first = await hydration;
    expect(first.statusCode).toBe(200);
    expect(first.json<{ turnNavigation: { label: string }[] }>().turnNavigation).toEqual([
      expect.objectContaining({ label: 'live instruction' }),
    ]);

    appServer.setThreadTurns(threadId, [
      {
        id: 'live-turn',
        status: 'completed',
        items: [{ type: 'userMessage', content: [{ type: 'text', text: 'live instruction' }] }],
      },
    ]);
    const repaired = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });
    expect(repaired.statusCode).toBe(200);
    expect(
      repaired.json<{ turnNavigation: { turnId: string; label: string }[] }>().turnNavigation,
    ).toEqual([expect.objectContaining({ turnId: 'live-turn', label: 'live instruction' })]);
    expect(repository.listTurnNavigation(threadId)).toHaveLength(1);
  });

  it('repairs the bounded turn navigation index once per app-server generation', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    repository.appendTurnNavigation({
      threadId,
      turnId: 'stale-turn',
      label: 'stale label',
    });
    appServer.setThreadTurns(threadId, [
      {
        id: 'turn-one',
        status: 'completed',
        items: [
          {
            type: 'userMessage',
            content: [{ type: 'text', text: 'first token=private' }],
          },
        ],
      },
      {
        id: 'turn-two',
        status: 'completed',
        items: [{ type: 'userMessage', content: [{ type: 'text', text: 'second task' }] }],
      },
    ]);
    appServer.restart();

    const first = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });
    expect(first.statusCode).toBe(200);
    expect(
      first.json<{ turnNavigation: { turnId: string; label: string }[] }>().turnNavigation,
    ).toEqual([
      expect.objectContaining({ turnId: 'turn-one', label: 'first token[REDACTED]' }),
      expect.objectContaining({ turnId: 'turn-two', label: 'second task' }),
    ]);
    expect(repository.listTurnNavigation(threadId)).toHaveLength(2);

    const second = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ turnNavigation: unknown[] }>().turnNavigation).toHaveLength(2);
    expect(
      appServer.requests.filter(
        (request) =>
          request.method === 'thread/read' &&
          (request.params as { includeTurns?: boolean }).includeTurns === true,
      ),
    ).toHaveLength(1);
  });

  it('persists separate live turn and steer navigation entries for the same turn id', async () => {
    const { app, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const started = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'first task',
        idempotencyKey: '12121212-1212-4212-8212-121212121212',
      },
    });
    expect(started.statusCode).toBe(202);
    const turnId = started.json<{ data: { turnId: string } }>().data.turnId;
    const steered = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/steer`,
      headers: session.headers,
      payload: { text: 'second instruction', expectedTurnId: turnId },
    });
    expect(steered.statusCode).toBe(202);
    expect(repository.listTurnNavigation(threadId)).toEqual([
      expect.objectContaining({ turnId, label: 'first task' }),
      expect.objectContaining({ turnId, label: 'second instruction' }),
    ]);
  });

  it('replays the full retained cap with bounded high-water pages and cursor-safe pending state', async () => {
    const { app, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = (
      await app.inject({
        method: 'POST',
        url: '/api/threads',
        headers: session.headers,
        payload: { projectId: project.id },
      })
    ).json<{ data: { id: string } }>().data;
    repository.markThreadHistoryHydrated(thread.id);
    for (let index = 0; index < 999; index += 1) {
      repository.appendEvent({
        threadId: thread.id,
        turnId: null,
        kind: 'warning',
        phase: 'state',
        payload: { index },
      });
    }
    const highWater = repository.eventHighWater(thread.id);
    const pending = repository.appendEvent({
      threadId: thread.id,
      turnId: 'pending-turn',
      kind: 'user-input',
      phase: 'state',
      payload: { request: { id: 'pending-request', status: 'pending' } },
    });
    const snapshot: number[] = [];
    let cursor = 0;
    while (cursor < highWater) {
      const page = repository.listEventPage(thread.id, cursor, highWater, 137);
      if (page.length === 0) break;
      snapshot.push(...page.map((event) => event.id));
      cursor = page.at(-1)!.id;
    }
    expect(snapshot).toHaveLength(999);
    expect(snapshot).not.toContain(pending.id);
    expect(repository.listEventPage(thread.id, highWater, pending.id)).toEqual([pending]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}`,
      headers: { cookie: session.cookie },
    });
    const events = response.json<{ events: { id: number; kind: string; payload: unknown }[] }>()
      .events;
    expect(events).toHaveLength(1_000);
    expect(events.at(-1)).toMatchObject({
      id: pending.id,
      kind: 'user-input',
      payload: { request: { id: 'pending-request', status: 'pending' } },
    });

    const boundedRepository = new SqliteRepository(':memory:', 3);
    try {
      const boundedProject = boundedRepository.createProject({
        name: 'Bounded',
        path: projectPath,
        defaultModel: null,
        defaultReasoningEffort: null,
        defaultPermissionPreset: 'workspace-write',
      });
      const now = new Date().toISOString();
      boundedRepository.upsertThread({
        id: 'bounded-thread',
        projectId: boundedProject.id,
        name: null,
        preview: '',
        model: null,
        status: 'idle',
        activeTurnId: null,
        archived: false,
        instructionSources: [],
        createdAt: now,
        updatedAt: now,
      });
      const anchor = boundedRepository.appendEvent({
        threadId: 'bounded-thread',
        turnId: 'retained-anchor',
        kind: 'user-message',
        phase: 'completed',
        payload: { text: 'retained task' },
      });
      const finalAnswerAnchor = boundedRepository.appendEvent({
        threadId: 'bounded-thread',
        turnId: 'retained-anchor',
        kind: 'agent-message',
        phase: 'completed',
        payload: { text: 'retained answer', messagePhase: 'final_answer' },
      });
      const fileChangeAnchor = boundedRepository.appendEvent({
        threadId: 'bounded-thread',
        turnId: 'retained-anchor',
        kind: 'file-change',
        phase: 'completed',
        payload: {
          status: 'completed',
          changes: [{ path: 'result/report.md', kind: 'add' }],
        },
      });
      for (let index = 0; index < 4; index += 1) {
        boundedRepository.appendEvent({
          threadId: 'bounded-thread',
          turnId: null,
          kind: 'warning',
          phase: 'state',
          payload: { afterAnchor: index },
        });
        boundedRepository.appendTurnNavigation({
          threadId: 'bounded-thread',
          turnId: `navigation-${index}`,
          label: `Navigation ${index}`,
        });
      }
      const retainedEvents = boundedRepository.listEvents('bounded-thread', 0);
      expect(retainedEvents).toHaveLength(6);
      expect(retainedEvents).toContainEqual(anchor);
      expect(retainedEvents).toContainEqual(finalAnswerAnchor);
      expect(retainedEvents).toContainEqual(fileChangeAnchor);
      const retainedNavigation = boundedRepository.listTurnNavigation('bounded-thread');
      expect(retainedNavigation).toHaveLength(3);
      expect(retainedNavigation[0]).toMatchObject({
        turnId: 'navigation-1',
        label: 'Navigation 1',
      });
    } finally {
      boundedRepository.database.close();
    }

    const invalidCursor = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/events?after=not-a-number`,
      headers: { cookie: session.cookie },
    });
    expect(invalidCursor.statusCode).toBe(400);

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const readThroughPending = async (after: number, lastEventId?: number): Promise<string> => {
      const stream = await fetch(`${address}/api/threads/${thread.id}/events?after=${after}`, {
        headers: {
          cookie: session.cookie,
          ...(lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) }),
        },
      });
      expect(stream.status).toBe(200);
      const reader = stream.body?.getReader();
      expect(reader).toBeDefined();
      const decoder = new TextDecoder();
      let replay = '';
      while (!replay.includes(`id: ${pending.id}\n`)) {
        const chunk = await reader!.read();
        expect(chunk.done).toBe(false);
        replay += decoder.decode(chunk.value, { stream: true });
      }
      await reader!.cancel();
      return replay;
    };

    const queryReplay = await readThroughPending(events[899]!.id);
    expect(queryReplay.match(/^id: /gm)).toHaveLength(100);
    expect(queryReplay).toContain(`id: ${pending.id}\nevent: user-input\n`);

    const headerReplay = await readThroughPending(events[99]!.id, events[949]!.id);
    expect(headerReplay.match(/^id: /gm)).toHaveLength(50);
  }, 10_000);

  it('returns unhealthy status when the pinned app-server is unavailable', async () => {
    const { app, appServer } = await fixture();
    appServer.ready = false;
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'degraded', appServerReady: false });
  });

  it('persists turn status and native thread name projections from notifications', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);

    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-projection', status: 'inProgress', items: [] } },
    });
    expect(repository.getThread(threadId)?.status).toBe('active');

    appServer.emit({
      method: 'thread/name/updated',
      params: { threadId, threadName: 'Native first topic' },
    });
    expect(repository.getThread(threadId)?.name).toBe('Native first topic');

    appServer.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-projection', status: 'completed', items: [] } },
    });
    expect(repository.getThread(threadId)?.status).toBe('idle');

    appServer.emit({
      method: 'thread/status/changed',
      params: { threadId, status: { type: 'systemError' } },
    });
    expect(repository.getThread(threadId)?.status).toBe('systemError');

    const history = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json<{ data: { name: string; status: string } }>().data).toMatchObject({
      name: 'Native first topic',
      status: 'systemError',
    });
  });

  it('generates and persists a semantic name after the first completed task', async () => {
    const generate = vi.fn(async () => 'Расхождение статистики передач');
    const titleGenerator: ThreadTitleGenerator = { generate };
    const { app, appServer, repository, projectPath } = await fixture(
      2,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      titleGenerator,
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const started = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'Проверь как статистику по фильтру за 5 число показывает 22 передачи',
        idempotencyKey: '11600000-0000-4000-8000-000000000001',
      },
    });
    const turnId = started.json<{ data: { turnId: string } }>().data.turnId;

    appServer.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed', items: [] } },
    });

    await vi.waitFor(() => {
      expect(repository.getThread(threadId)?.name).toBe('Расхождение статистики передач');
    });
    expect(generate).toHaveBeenCalledWith({
      prompt: 'Проверь как статистику по фильтру за 5 число показывает 22 передачи',
      model: 'gpt-test',
    });
    expect(appServer.requests).toContainEqual({
      method: 'thread/name/set',
      params: { threadId, name: 'Расхождение статистики передач' },
    });
    expect(repository.listEvents(threadId, 0)).toContainEqual(
      expect.objectContaining({
        kind: 'thread',
        payload: { threadId, threadName: 'Расхождение статистики передач' },
      }),
    );

    appServer.emit({
      method: 'thread/name/updated',
      params: { threadId, threadName: 'Проверь как статистику по фильтру' },
    });
    expect(repository.getThread(threadId)?.name).toBe('Расхождение статистики передач');
  });

  it('does not overwrite a manual rename while semantic title generation is running', async () => {
    let finishTitle: (title: string | null) => void = () => undefined;
    const generate = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finishTitle = resolve;
        }),
    );
    const { app, appServer, repository, projectPath } = await fixture(
      2,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { generate },
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const started = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'Проверь статистику передач за пятое число',
        idempotencyKey: '11600000-0000-4000-8000-000000000002',
      },
    });
    const turnId = started.json<{ data: { turnId: string } }>().data.turnId;
    appServer.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed', items: [] } },
    });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${threadId}`,
      headers: session.headers,
      payload: { name: 'Проверка статистики' },
    });
    expect(renamed.statusCode).toBe(200);
    finishTitle('Расхождение статистики передач');

    await vi.waitFor(() => {
      expect(repository.getThread(threadId)?.name).toBe('Проверка статистики');
    });
    expect(
      appServer.requests.filter(
        (request) =>
          request.method === 'thread/name/set' &&
          (request.params as { name?: string }).name === 'Расхождение статистики передач',
      ),
    ).toHaveLength(0);
  });

  it('keeps a confirmed live turn active across stale list and thread-status snapshots', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });

    appServer.setThreadStatus(threadId, 'notLoaded');
    const listed = await app.inject({
      method: 'GET',
      url: `/api/threads?projectId=${project.id}&archived=false`,
      headers: { cookie: session.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ data: Thread[] }>().data).toEqual([
      expect.objectContaining({ id: threadId, status: 'active', activeTurnId: 'turn-live' }),
    ]);

    appServer.emit({
      method: 'thread/status/changed',
      params: { threadId, status: { type: 'idle' } },
    });
    expect(repository.getThread(threadId)).toMatchObject({
      status: 'active',
      activeTurnId: 'turn-live',
    });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      upgradeDrain: { activeTurns: 1 },
    });

    appServer.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-live', status: 'completed', items: [] } },
    });
    expect(repository.getThread(threadId)).toMatchObject({ status: 'idle', activeTurnId: null });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      upgradeDrain: { activeTurns: 0 },
    });
  });

  it('clears stale turn and subagent activity when the app-server disconnects', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const persistedOnlyThreadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-disconnected', status: 'inProgress', items: [] } },
    });
    repository.upsertSubagent({
      id: 'child-disconnected',
      rootThreadId: threadId,
      parentThreadId: threadId,
      agentPath: '/root/child-disconnected',
      nickname: 'Disconnected child',
      role: null,
      model: 'gpt-test',
      reasoningEffort: 'medium',
      status: 'running',
      message: 'working',
      startedAt: '2026-10-02T10:00:00.000Z',
      lastActivityAt: '2026-10-02T10:00:01.000Z',
      completedAt: null,
    });
    repository.updateThreadRuntime(persistedOnlyThreadId, {
      status: 'active',
      activeTurnId: null,
    });

    appServer.disconnect();

    expect(repository.getThread(threadId)).toMatchObject({
      status: 'notLoaded',
      activeTurnId: null,
    });
    expect(repository.getSubagent('child-disconnected')).toMatchObject({ status: 'interrupted' });
    expect(repository.getThread(persistedOnlyThreadId)).toMatchObject({
      status: 'notLoaded',
      activeTurnId: null,
    });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toMatchObject({
      upgradeDrain: { activeTurns: 0, activeSubagents: 0, activeExecutionUnits: 0 },
    });
    const disconnectEvents = repository.listEvents(threadId, 0);
    expect(disconnectEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'thread',
          phase: 'state',
          payload: {
            threadRuntime: { status: 'notLoaded', activeTurnId: null },
            appServerDisconnected: true,
          },
        }),
      ]),
    );
    expect(disconnectEvents.find((event) => event.kind === 'subagent')?.payload.subagent).toEqual(
      expect.objectContaining({ id: 'child-disconnected', status: 'interrupted' }),
    );
    expect(repository.listEvents(persistedOnlyThreadId, 0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'thread',
          phase: 'state',
          payload: {
            threadRuntime: { status: 'notLoaded', activeTurnId: null },
            appServerDisconnected: true,
          },
        }),
      ]),
    );
  });

  it('recovers an active turn id from authoritative history after reconnect', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.setThreadUpdatedAt(threadId, Math.floor(Date.now() / 1_000) + 60);
    appServer.setThreadStatus(threadId, 'active');
    appServer.setThreadTurns(threadId, [{ id: 'turn-recovered', status: 'inProgress', items: [] }]);
    appServer.restart();

    const history = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });

    expect(history.statusCode).toBe(200);
    expect(history.json<{ data: Thread }>().data).toMatchObject({
      status: 'active',
      activeTurnId: 'turn-recovered',
    });
    expect(repository.getThread(threadId)).toMatchObject({
      status: 'active',
      activeTurnId: 'turn-recovered',
    });
    expect(
      appServer.requests
        .filter((request) => request.method === 'thread/read')
        .slice(-1)
        .map((request) => request.params),
    ).toEqual([{ threadId, includeTurns: true }]);
  });

  it('clears a stale native active status when every retained turn is terminal', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    repository.upsertSubagent({
      id: 'terminal-child',
      rootThreadId: threadId,
      parentThreadId: threadId,
      agentPath: '/root/terminal-child',
      nickname: 'Terminal child',
      role: null,
      model: 'gpt-test',
      reasoningEffort: 'medium',
      status: 'completed',
      message: 'done',
      startedAt: '2026-09-29T00:00:00.000Z',
      lastActivityAt: '2026-09-29T00:01:00.000Z',
      completedAt: '2026-09-29T00:01:00.000Z',
    });
    appServer.setThreadUpdatedAt(threadId, Date.parse('2026-09-29T00:00:30.000Z') / 1_000);
    appServer.setThreadStatus(threadId, 'active');
    appServer.setThreadTurns(threadId, [
      { id: 'turn-finished', status: 'completed', items: [] },
      { id: 'turn-interrupted', status: 'interrupted', items: [] },
    ]);
    repository.updateThreadRuntime(threadId, { status: 'active', activeTurnId: null });
    appServer.restart();

    const history = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });

    expect(history.statusCode).toBe(200);
    expect(history.json<{ data: Thread }>().data).toMatchObject({
      status: 'idle',
      activeTurnId: null,
    });
    const reconciledHistory = history.json<{
      eventCursor: number;
      events: Array<{ id: number; payload: Record<string, unknown> }>;
    }>();
    expect(reconciledHistory.eventCursor).toBe(reconciledHistory.events.at(-1)?.id);
    expect(reconciledHistory.events).toContainEqual(
      expect.objectContaining({
        kind: 'thread',
        payload: {
          threadRuntime: { status: 'idle', activeTurnId: null },
          appServerReconciled: true,
        },
      }),
    );
    expect(repository.getThread(threadId)).toMatchObject({ status: 'idle', activeTurnId: null });
  });

  it('supersedes a retained active runtime event with the reconciled post-restart snapshot', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    repository.appendEvent({
      threadId,
      turnId: null,
      kind: 'thread',
      phase: 'state',
      payload: { threadRuntime: { status: 'active', activeTurnId: null } },
    });
    repository.updateThreadRuntime(threadId, { status: 'notLoaded', activeTurnId: null });
    appServer.setThreadStatus(threadId, 'idle');
    appServer.restart();

    const history = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });

    expect(history.statusCode).toBe(200);
    const body = history.json<{
      data: Thread;
      eventCursor: number;
      events: Array<{ id: number; payload: Record<string, unknown> }>;
    }>();
    expect(body.data).toMatchObject({ status: 'idle', activeTurnId: null });
    expect(body.eventCursor).toBe(body.events.at(-1)?.id);
    expect(body.events.at(-1)?.payload).toEqual({
      threadRuntime: { status: 'idle', activeTurnId: null },
      appServerReconciled: true,
    });
  });

  it('keeps an unknown active root fail-closed without a complete child projection', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.setThreadUpdatedAt(threadId, Math.floor(Date.now() / 1_000) + 60);
    appServer.setThreadStatus(threadId, 'active');
    appServer.setThreadTurns(threadId, [{ id: 'turn-previous', status: 'completed', items: [] }]);
    appServer.restart();

    const history = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });

    expect(history.statusCode).toBe(200);
    expect(history.json<{ data: Thread }>().data).toMatchObject({
      status: 'active',
      activeTurnId: null,
    });
    expect(repository.getThread(threadId)).toMatchObject({ status: 'active', activeTurnId: null });
  });

  it('recovers a fresh native active turn even when older terminal children remain', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    repository.upsertSubagent({
      id: 'previous-child',
      rootThreadId: threadId,
      parentThreadId: threadId,
      agentPath: '/root/previous-child',
      nickname: 'Previous child',
      role: null,
      model: 'gpt-test',
      reasoningEffort: 'medium',
      status: 'completed',
      message: 'done',
      startedAt: '2026-09-29T00:00:00.000Z',
      lastActivityAt: '2026-09-29T00:01:00.000Z',
      completedAt: '2026-09-29T00:01:00.000Z',
    });
    appServer.setThreadUpdatedAt(threadId, Math.floor(Date.now() / 1_000) + 60);
    appServer.setThreadStatus(threadId, 'active');
    appServer.setThreadTurns(threadId, [
      { id: 'turn-previous', status: 'completed', items: [] },
      { id: 'turn-fresh', status: 'inProgress', items: [] },
    ]);
    appServer.restart();

    const history = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });

    expect(history.statusCode).toBe(200);
    expect(history.json<{ data: Thread }>().data).toMatchObject({
      status: 'active',
      activeTurnId: 'turn-fresh',
    });
  });

  it('does not retain a recovered turn when a newer terminal event wins the read race', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.setThreadStatus(threadId, 'active');
    appServer.setThreadTurns(threadId, [{ id: 'turn-racing', status: 'inProgress', items: [] }]);
    appServer.restart();
    const gate = appServer.blockThreadReads();

    const history = app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });
    await gate.entered;
    appServer.emit({
      method: 'thread/status/changed',
      params: { threadId, status: { type: 'idle' } },
    });
    gate.release();

    expect((await history).statusCode).toBe(200);
    expect(repository.getThread(threadId)).toMatchObject({ status: 'idle', activeTurnId: null });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      upgradeDrain: { activeTurns: 0, activeExecutionUnits: 0 },
    });
  });

  it('does not demote a native active root when its last observed child finishes', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'thread/status/changed',
      params: { threadId, status: { type: 'active' } },
    });
    appServer.emit({
      method: 'item/started',
      params: {
        threadId,
        turnId: 'turn-native',
        startedAtMs: Date.parse('2026-09-29T00:00:00.000Z'),
        item: {
          type: 'subAgentActivity',
          id: 'activity-native-child',
          agentThreadId: 'native-child',
          agentPath: '/root/native-child',
          kind: 'started',
        },
      },
    });
    appServer.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId: 'turn-native',
        completedAtMs: Date.parse('2026-09-29T00:00:01.000Z'),
        item: {
          type: 'subAgentActivity',
          id: 'activity-native-child',
          agentThreadId: 'native-child',
          agentPath: '/root/native-child',
          kind: 'completed',
        },
      },
    });

    expect(repository.getThread(threadId)).toMatchObject({ status: 'active', activeTurnId: null });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      upgradeDrain: { activeTurns: 1, activeExecutionUnits: 1 },
    });
    expect(
      repository
        .listEvents(threadId, 0)
        .filter((event) => event.kind === 'thread')
        .at(-1),
    ).toMatchObject({
      payload: { threadRuntime: { status: 'active', activeTurnId: null } },
    });
  });

  it('does not let a stale turn completion finish a newer active turn', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-old', status: 'inProgress', items: [] } },
    });
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-current', status: 'inProgress', items: [] } },
    });

    appServer.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-old', status: 'completed', items: [] } },
    });
    expect(repository.getThread(threadId)).toMatchObject({
      status: 'active',
      activeTurnId: 'turn-current',
    });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      upgradeDrain: { activeTurns: 1 },
    });
    expect(repository.listEvents(threadId, 0).at(-1)).toMatchObject({
      turnId: 'turn-old',
      kind: 'turn',
      phase: 'completed',
      payload: { runtime: false },
    });

    appServer.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-current', status: 'completed', items: [] } },
    });
    expect(repository.getThread(threadId)).toMatchObject({ status: 'idle', activeTurnId: null });
  });

  it('does not clear a newer turn while reconciling a failed command for the previous turn', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-old', status: 'inProgress', items: [] } },
    });
    appServer.setThreadStatus(threadId, 'idle');
    appServer.failNextRequestWith = new Error('APP_SERVER_REQUEST_FAILED');
    const gate = appServer.blockThreadReads();

    const steer = app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/steer`,
      headers: session.headers,
      payload: { text: 'continue', expectedTurnId: 'turn-old' },
    });
    await gate.entered;
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-current', status: 'inProgress', items: [] } },
    });
    gate.release();

    const response = await steer;
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: 'TURN_COMMAND_OUTCOME_UNKNOWN' },
    });
    expect(repository.getThread(threadId)).toMatchObject({
      status: 'active',
      activeTurnId: 'turn-current',
    });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      upgradeDrain: { activeTurns: 1 },
    });
  });

  it('persists and broadcasts one sanitized steer message to two sessions', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const firstSession = await login(app);
    const secondSession = await login(app);
    const project = await createProject(app, projectPath, firstSession.headers);
    const threadId = await createThread(app, project.id, firstSession.headers);
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-live', status: 'inProgress', items: [] } },
    });

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const connect = async (cookie: string) => {
      const response = await fetch(`${address}/api/threads/${threadId}/events?after=0`, {
        headers: { cookie },
      });
      expect(response.status).toBe(200);
      expect(response.body).not.toBeNull();
      return response.body!.getReader();
    };
    const readUntil = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      marker: string,
    ): Promise<string> => {
      const decoder = new TextDecoder();
      let output = '';
      while (!output.includes(marker)) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        output += decoder.decode(chunk.value, { stream: true });
      }
      return output;
    };
    const [firstReader, secondReader] = await Promise.all([
      connect(firstSession.cookie),
      connect(secondSession.cookie),
    ]);
    await Promise.all([
      readUntil(firstReader, 'event: turn'),
      readUntil(secondReader, 'event: turn'),
    ]);

    const steered = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/steer`,
      headers: secondSession.headers,
      payload: { text: 'follow-up token=private-value', expectedTurnId: 'turn-live' },
    });
    expect(steered.statusCode).toBe(202);
    const liveCopies = await Promise.all([
      readUntil(firstReader, 'event: user-message'),
      readUntil(secondReader, 'event: user-message'),
    ]);
    await Promise.all([firstReader.cancel(), secondReader.cancel()]);
    expect(liveCopies).toHaveLength(2);
    for (const copy of liveCopies) {
      expect(copy).toContain('follow-up token[REDACTED]');
      expect(copy).not.toContain('private-value');
    }

    const replay = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: firstSession.cookie },
    });
    const userMessages = replay
      .json<{ events: SafeEvent[] }>()
      .events.filter((event) => event.kind === 'user-message');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      threadId,
      turnId: 'turn-live',
      payload: { text: 'follow-up token[REDACTED]' },
    });
    expect(
      repository.listEvents(threadId, 0).filter((event) => event.kind === 'user-message'),
    ).toHaveLength(1);
  });

  it('persists interrupt acknowledgement and keeps the turn active until Codex completes it', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-stop', status: 'inProgress', items: [] } },
    });

    const stopped = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/interrupt`,
      headers: session.headers,
      payload: { turnId: 'turn-stop' },
    });
    expect(stopped.statusCode).toBe(200);
    expect(repository.getThread(threadId)).toMatchObject({
      status: 'active',
      activeTurnId: 'turn-stop',
    });
    expect(repository.listEvents(threadId, 0).at(-1)).toMatchObject({
      turnId: 'turn-stop',
      kind: 'turn',
      phase: 'state',
      payload: { status: 'interruptRequested' },
    });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      upgradeDrain: { activeTurns: 1 },
    });

    appServer.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-stop', status: 'interrupted', items: [] } },
    });
    expect(repository.getThread(threadId)).toMatchObject({ status: 'idle', activeTurnId: null });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      upgradeDrain: { activeTurns: 0 },
    });
  });

  it('reconciles a stale interrupt target and returns an actionable conflict', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-stale', status: 'inProgress', items: [] } },
    });
    appServer.failNextRequestWith = new Error('APP_SERVER_REQUEST_FAILED');

    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/interrupt`,
      headers: session.headers,
      payload: { turnId: 'turn-stale' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'TURN_NOT_ACTIVE',
        message: 'Активная задача уже завершена или недоступна. Обновите чат.',
      },
    });
    expect(repository.getThread(threadId)).toMatchObject({ status: 'idle', activeTurnId: null });
  });

  it('keeps an ambiguous failed steer visible while the authoritative thread stays active', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-ambiguous', status: 'inProgress', items: [] } },
    });
    appServer.setThreadStatus(threadId, 'active');
    appServer.failNextRequestWith = new Error('APP_SERVER_REQUEST_TIMEOUT');

    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/steer`,
      headers: session.headers,
      payload: { expectedTurnId: 'turn-ambiguous', text: 'check the uncertain result' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: 'TURN_COMMAND_OUTCOME_UNKNOWN' },
    });
    expect(repository.getThread(threadId)).toMatchObject({
      status: 'active',
      activeTurnId: 'turn-ambiguous',
    });
    expect(repository.listEvents(threadId, 0).at(-1)).toMatchObject({
      turnId: 'turn-ambiguous',
      kind: 'user-message',
      phase: 'state',
      payload: { text: 'check the uncertain result', outcomeUnknown: true },
    });
  });

  it('reports an ambiguous failed interrupt without declaring the active turn finished', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'turn/started',
      params: { threadId, turn: { id: 'turn-ambiguous-stop', status: 'inProgress', items: [] } },
    });
    appServer.setThreadStatus(threadId, 'active');
    appServer.failNextRequestWith = new Error('APP_SERVER_REQUEST_TIMEOUT');

    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/interrupt`,
      headers: session.headers,
      payload: { turnId: 'turn-ambiguous-stop' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: 'TURN_COMMAND_OUTCOME_UNKNOWN' },
    });
    expect(repository.getThread(threadId)).toMatchObject({
      status: 'active',
      activeTurnId: 'turn-ambiguous-stop',
    });
  });

  it('stores one account runtime preference tuple on the server', async () => {
    const { app } = await fixture();
    const session = await login(app);
    const initial = await app.inject({
      method: 'GET',
      url: '/api/preferences/runtime',
      headers: { cookie: session.cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      data: {
        model: null,
        reasoningEffort: null,
        permissionPreset: 'workspace-write',
        approvalPolicy: 'on-request',
      },
    });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/preferences/runtime',
      headers: session.headers,
      payload: {
        model: 'gpt-test',
        reasoningEffort: 'high',
        permissionPreset: 'full-access',
        approvalPolicy: 'never',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      data: {
        model: 'gpt-test',
        reasoningEffort: 'high',
        permissionPreset: 'full-access',
        approvalPolicy: 'never',
      },
    });
    const replay = await app.inject({
      method: 'GET',
      url: '/api/preferences/runtime',
      headers: { cookie: session.cookie },
    });
    expect(replay.json()).toEqual(saved.json());
  });

  it('drains only new turns and reports pending plus active work in health', async () => {
    const { app, appServer, projectPath, upgradeDrainPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const key = '99999999-9999-4999-8999-999999999999';

    await writeFile(upgradeDrainPath, 'upgrade\n');
    const drainingHealth = await app.inject({ method: 'GET', url: '/api/health' });
    expect(drainingHealth.statusCode).toBe(200);
    expect(drainingHealth.json()).toMatchObject({
      upgradeDrain: {
        supported: true,
        requested: true,
        acceptingNewTurns: false,
        activeTurns: 0,
        pendingTurnStarts: 0,
        idle: true,
      },
    });
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: { text: 'wait for upgrade', idempotencyKey: key },
    });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json()).toMatchObject({ error: { code: 'SERVICE_DRAINING' } });
    expect(appServer.requests.filter((request) => request.method === 'turn/start')).toHaveLength(0);

    const steered = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/steer`,
      headers: session.headers,
      payload: { text: 'still reachable', expectedTurnId: 'existing-turn' },
    });
    expect(steered.statusCode).toBe(202);

    await unlink(upgradeDrainPath);
    const gate = appServer.blockTurnStarts();
    const pendingTurn = app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: { text: 'continue after upgrade', idempotencyKey: key },
    });
    await gate.entered;
    const pendingHealth = await app.inject({ method: 'GET', url: '/api/health' });
    expect(pendingHealth.json()).toMatchObject({
      upgradeDrain: {
        requested: false,
        acceptingNewTurns: true,
        activeTurns: 0,
        pendingTurnStarts: 1,
        idle: false,
      },
    });
    gate.release();
    expect((await pendingTurn).statusCode).toBe(202);
    const activeHealth = await app.inject({ method: 'GET', url: '/api/health' });
    expect(activeHealth.json()).toMatchObject({
      upgradeDrain: {
        requested: false,
        acceptingNewTurns: true,
        activeTurns: 1,
        pendingTurnStarts: 0,
        idle: false,
      },
    });
    appServer.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-1', status: 'completed', items: [] } },
    });
    const idleHealth = await app.inject({ method: 'GET', url: '/api/health' });
    expect(idleHealth.json()).toMatchObject({
      upgradeDrain: {
        requested: false,
        acceptingNewTurns: true,
        activeTurns: 0,
        pendingTurnStarts: 0,
        idle: false,
      },
    });
  });

  it('enforces global turn capacity, releases on completion, and replays idempotent starts', async () => {
    const { app, appServer, projectPath } = await fixture(1);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = (
      await app.inject({
        method: 'POST',
        url: '/api/threads',
        headers: session.headers,
        payload: { projectId: project.id },
      })
    ).json<{ data: { id: string } }>().data;
    const firstKey = '11111111-1111-4111-8111-111111111111';
    const first = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/turns`,
      headers: session.headers,
      payload: { text: 'first', idempotencyKey: firstKey },
    });
    expect(first.statusCode).toBe(202);
    const repeated = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/turns`,
      headers: session.headers,
      payload: { text: 'first', idempotencyKey: firstKey },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual(first.json());
    const saturated = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/turns`,
      headers: session.headers,
      payload: { text: 'second', idempotencyKey: '22222222-2222-4222-8222-222222222222' },
    });
    expect(saturated.statusCode).toBe(202);
    expect(saturated.json()).toMatchObject({
      data: { status: 'queued', queuedTurn: { position: 1, textPreview: 'second' } },
    });
    const queuedReplay = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/turns`,
      headers: session.headers,
      payload: { text: 'second', idempotencyKey: '22222222-2222-4222-8222-222222222222' },
    });
    expect(queuedReplay.statusCode).toBe(200);
    expect(queuedReplay.json()).toMatchObject({ data: { status: 'queued' } });
    appServer.emit({
      method: 'turn/completed',
      params: { threadId: thread.id, turn: { id: 'turn-1' } },
    });
    await vi.waitFor(() => {
      expect(appServer.requests.filter((request) => request.method === 'turn/start')).toHaveLength(
        2,
      );
    });
    const afterCompletion = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/turns`,
      headers: session.headers,
      payload: { text: 'third', idempotencyKey: '33333333-3333-4333-8333-333333333333' },
    });
    expect(afterCompletion.statusCode).toBe(202);
    expect(afterCompletion.json()).toMatchObject({
      data: { status: 'queued', queuedTurn: { position: 1 } },
    });
  });

  it('dispatches queued root turns FIFO and exposes the durable projection on reload', async () => {
    const { app, appServer, projectPath } = await fixture(1);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const firstThreadId = await createThread(app, project.id, session.headers);
    const secondThreadId = await createThread(app, project.id, session.headers);
    const thirdThreadId = await createThread(app, project.id, session.headers);
    const start = (threadId: string, text: string, key: string) =>
      app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/turns`,
        headers: session.headers,
        payload: { text, idempotencyKey: key },
      });
    expect(
      (await start(firstThreadId, 'active', '10000000-0000-4000-8000-000000000001')).json(),
    ).toMatchObject({ data: { status: 'started' } });
    expect(
      (await start(secondThreadId, 'queued second', '10000000-0000-4000-8000-000000000002')).json(),
    ).toMatchObject({ data: { status: 'queued', queuedTurn: { position: 1 } } });
    expect(
      (await start(thirdThreadId, 'queued third', '10000000-0000-4000-8000-000000000002')).json(),
    ).toMatchObject({ data: { status: 'queued', queuedTurn: { position: 2 } } });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/threads/${thirdThreadId}`,
      headers: { cookie: session.cookie },
    });
    expect(detail.json()).toMatchObject({
      queuedTurns: [{ status: 'queued', position: 2, textPreview: 'queued third' }],
    });

    appServer.setThreadStatus(firstThreadId, 'idle');
    appServer.emit({
      method: 'turn/completed',
      params: { threadId: firstThreadId, turn: { id: 'turn-1' } },
    });
    await vi.waitFor(
      () => {
        const starts = appServer.requests.filter((request) => request.method === 'turn/start');
        expect(starts).toHaveLength(2);
        expect(starts[1]?.params).toMatchObject({ threadId: secondThreadId });
      },
      { timeout: 2_000 },
    );
    appServer.setThreadStatus(secondThreadId, 'idle');
    appServer.emit({
      method: 'turn/completed',
      params: { threadId: secondThreadId, turn: { id: 'turn-2' } },
    });
    await vi.waitFor(
      () => {
        const starts = appServer.requests.filter((request) => request.method === 'turn/start');
        expect(starts).toHaveLength(3);
        expect(starts[2]?.params).toMatchObject({ threadId: thirdThreadId });
      },
      { timeout: 2_000 },
    );
  });

  it('migrates legacy attachment cleanup tombstones to due-time scheduling without data loss', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-web-cleanup-migration-'));
    const databasePath = path.join(temp, 'legacy.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE attachment_file_deletions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        storage_name TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX attachment_file_deletions_order_idx
        ON attachment_file_deletions(created_at,id);
      INSERT INTO attachment_file_deletions(
        id,project_id,thread_id,storage_name,attempts,created_at,updated_at
      ) VALUES(
        '00000000-0000-4000-8000-000000000099','legacy-project','legacy-thread',
        '00000000-0000-4000-8000-000000000099.txt',3,
        '2026-10-06T00:00:00.000Z','2026-10-06T00:01:00.000Z'
      );
    `);
    legacy.close();

    const migrated = new SqliteRepository(databasePath, 1_000);
    const columns = migrated.database
      .prepare('PRAGMA table_info(attachment_file_deletions)')
      .all() as unknown as { name: string }[];
    expect(columns.map((column) => column.name)).toContain('next_attempt_at');
    const index = migrated.database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='attachment_file_deletions_order_idx'",
      )
      .get() as { sql: string };
    expect(index.sql.replaceAll(/\s+/gu, '').toLowerCase()).toContain(
      'onattachment_file_deletions(next_attempt_at,created_at,id)',
    );
    expect(migrated.listAttachmentFileDeletions()).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000099',
        projectId: 'legacy-project',
        threadId: 'legacy-thread',
        storageName: '00000000-0000-4000-8000-000000000099.txt',
        attempts: 3,
        nextAttemptAt: 0,
        createdAt: '2026-10-06T00:00:00.000Z',
        updatedAt: '2026-10-06T00:01:00.000Z',
      },
    ]);
    migrated.close();
  });

  it('cancels only the addressed queued turn, releases attachments, audits and publishes the change', async () => {
    const { app, repository, attachmentStore, projectPath } = await fixture(1);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const activeThreadId = await createThread(app, project.id, session.headers);
    const queuedThreadId = await createThread(app, project.id, session.headers);
    await app.inject({
      method: 'POST',
      url: `/api/threads/${activeThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'occupy capacity',
        idempotencyKey: '11000000-0000-4000-8000-000000000001',
      },
    });
    const upload = multipartFile('cancel.txt', 'text/plain', Buffer.from('cancel context'));
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/threads/${queuedThreadId}/attachments`,
      headers: { ...session.headers, 'content-type': upload.contentType },
      payload: upload.body,
    });
    const attachment = uploaded.json<{ data: Attachment }>().data;
    const storedAttachment = repository.getAttachment(attachment.id)!;
    const queuedResponse = await app.inject({
      method: 'POST',
      url: `/api/threads/${queuedThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'cancel me',
        attachmentIds: [attachment.id],
        idempotencyKey: '11000000-0000-4000-8000-000000000002',
      },
    });
    const queuedTurnId = queuedResponse.json<{ data: { queuedTurn: { id: number } } }>().data
      .queuedTurn.id;
    expect(repository.getAttachment(attachment.id)?.turnId).not.toBeNull();

    const wrongThread = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${activeThreadId}/queued-turns/${queuedTurnId}`,
      headers: session.headers,
    });
    expect(wrongThread.statusCode).toBe(404);
    expect(wrongThread.json()).toMatchObject({ error: { code: 'QUEUED_TURN_NOT_FOUND' } });
    expect(repository.getQueuedTurn(queuedTurnId)).toBeDefined();

    const queueEventsBefore = repository
      .listEvents(queuedThreadId, 0)
      .filter((event) => event.payload.queueChanged === true).length;
    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${queuedThreadId}/queued-turns/${queuedTurnId}`,
      headers: session.headers,
    });
    expect(cancelled.statusCode).toBe(204);
    expect(repository.getQueuedTurn(queuedTurnId)).toBeUndefined();
    expect(repository.claimQueuedTurn(queuedTurnId)).toBeUndefined();
    expect(repository.getAttachment(attachment.id)).toBeUndefined();
    expect(repository.hasAttachmentFileDeletion(attachment.id)).toBe(false);
    expect(repository.attachmentBytesForThread(queuedThreadId)).toBe(0);
    await expect(
      attachmentStore.read(project.id, queuedThreadId, storedAttachment.storageName),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      repository
        .listEvents(queuedThreadId, 0)
        .filter((event) => event.payload.queueChanged === true),
    ).toHaveLength(queueEventsBefore + 1);
    const audit = repository.database
      .prepare(
        "SELECT outcome,metadata_json FROM audit_events WHERE action='turn.queue.cancel' ORDER BY id DESC LIMIT 1",
      )
      .get() as { outcome: string; metadata_json: string };
    expect(audit.outcome).toBe('succeeded');
    expect(JSON.parse(audit.metadata_json)).toEqual({
      threadId: queuedThreadId,
      queuedTurnId,
      attachmentCount: 1,
    });
    const alreadyGone = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${queuedThreadId}/queued-turns/${queuedTurnId}`,
      headers: session.headers,
    });
    expect(alreadyGone.statusCode).toBe(404);
    expect(alreadyGone.json()).toMatchObject({ error: { code: 'QUEUED_TURN_NOT_FOUND' } });
  });

  it('persists failed queued attachment cleanup and reconciles it after restart', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-web-attachment-cleanup-'));
    const appServer = new FakeAppServer();
    const first = await fixture(
      1,
      undefined,
      (root) => new FailingRemoveAttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      { temp, appServer },
    );
    const session = await login(first.app);
    const project = await createProject(first.app, first.projectPath, session.headers);
    const activeThreadId = await createThread(first.app, project.id, session.headers);
    const queuedThreadId = await createThread(first.app, project.id, session.headers);
    await first.app.inject({
      method: 'POST',
      url: `/api/threads/${activeThreadId}/turns`,
      headers: session.headers,
      payload: { text: 'active', idempotencyKey: '11500000-0000-4000-8000-000000000001' },
    });
    const upload = multipartFile('cleanup.txt', 'text/plain', Buffer.from('cleanup context'));
    const uploaded = await first.app.inject({
      method: 'POST',
      url: `/api/threads/${queuedThreadId}/attachments`,
      headers: { ...session.headers, 'content-type': upload.contentType },
      payload: upload.body,
    });
    const attachment = uploaded.json<{ data: Attachment }>().data;
    const storedAttachment = first.repository.getAttachment(attachment.id)!;
    const queued = await first.app.inject({
      method: 'POST',
      url: `/api/threads/${queuedThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'cancel despite cleanup failure',
        attachmentIds: [attachment.id],
        idempotencyKey: '11500000-0000-4000-8000-000000000002',
      },
    });
    const queuedTurnId = queued.json<{ data: { queuedTurn: { id: number } } }>().data.queuedTurn.id;

    const cancelled = await first.app.inject({
      method: 'DELETE',
      url: `/api/threads/${queuedThreadId}/queued-turns/${queuedTurnId}`,
      headers: session.headers,
    });
    expect(cancelled.statusCode).toBe(204);
    expect(first.repository.getQueuedTurn(queuedTurnId)).toBeUndefined();
    expect(first.repository.getAttachment(attachment.id)).toBeUndefined();
    expect(first.repository.attachmentBytesForThread(queuedThreadId)).toBe(0);
    expect(first.repository.hasAttachmentFileDeletion(attachment.id)).toBe(true);
    expect(
      await first.attachmentStore.read(project.id, queuedThreadId, storedAttachment.storageName),
    ).toEqual(Buffer.from('cleanup context'));
    const cleanupAudit = first.repository.database
      .prepare(
        "SELECT outcome,metadata_json FROM audit_events WHERE action='attachment.file.delete' ORDER BY id DESC LIMIT 1",
      )
      .get() as { outcome: string; metadata_json: string };
    expect(cleanupAudit.outcome).toBe('failed');
    expect(JSON.parse(cleanupAudit.metadata_json)).toEqual({
      attachmentId: attachment.id,
      threadId: queuedThreadId,
      attempt: 1,
    });
    first.repository.database
      .prepare('UPDATE attachment_file_deletions SET next_attempt_at=? WHERE id=?')
      .run(Date.now() - 1, attachment.id);

    await first.app.close();
    openApps.splice(openApps.indexOf(first.app), 1);
    const second = await fixture(
      1,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      { temp, appServer },
    );
    await vi.waitFor(() => {
      expect(second.repository.hasAttachmentFileDeletion(attachment.id)).toBe(false);
    });
    await expect(
      second.attachmentStore.read(project.id, queuedThreadId, storedAttachment.storageName),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a pre-cleanup cancellation tombstone after repository restart', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-web-cleanup-crash-window-'));
    const databasePath = path.join(temp, 'codex-web.sqlite3');
    const repository = new SqliteRepository(databasePath, 1_000);
    const projectPath = path.join(temp, 'projects', 'demo');
    await mkdir(projectPath, { recursive: true });
    const project = repository.createProject({
      name: 'Demo',
      path: projectPath,
      defaultModel: null,
      defaultReasoningEffort: null,
      defaultPermissionPreset: 'workspace-write',
    });
    const threadId = 'crash-window-cleanup-thread';
    const now = new Date().toISOString();
    repository.upsertThread({
      id: threadId,
      projectId: project.id,
      name: null,
      preview: '',
      model: null,
      status: 'idle',
      activeTurnId: null,
      archived: false,
      instructionSources: [],
      createdAt: now,
      updatedAt: now,
    });
    const attachmentStore = new AttachmentStore(path.join(temp, 'attachments'));
    const stored = await attachmentStore.write(
      project.id,
      threadId,
      'crash.txt',
      Buffer.from('survive until cleanup'),
    );
    repository.createAttachment({
      id: stored.id,
      threadId,
      name: 'crash.txt',
      mimeType: 'text/plain',
      kind: 'file',
      size: 21,
      storageName: stored.storageName,
    });
    const key = '11600000-0000-4000-8000-000000000001';
    const requestHashValue = 'crash-cleanup-hash';
    repository.reserveIdempotent(`turn:${threadId}`, key, requestHashValue);
    const queued = repository.enqueueTurn({
      threadId,
      idempotencyKey: key,
      requestHash: requestHashValue,
      request: { text: 'cancel before cleanup', attachmentIds: [stored.id], idempotencyKey: key },
      claimToken: `queued:${threadId}:${key}`,
    }).record;
    expect(repository.cancelQueuedTurn(threadId, queued.id).status).toBe('cancelled');
    expect(repository.hasAttachmentFileDeletion(stored.id)).toBe(true);
    repository.close();

    const appServer = new FakeAppServer();
    const restarted = await fixture(
      1,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      { temp, appServer },
    );
    await vi.waitFor(() => {
      expect(restarted.repository.hasAttachmentFileDeletion(stored.id)).toBe(false);
    });
    await expect(
      restarted.attachmentStore.read(project.id, threadId, stored.storageName),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('backs off persistent cleanup failures so a newer healthy tombstone is not starved', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-web-cleanup-batch-'));
    const repository = new SqliteRepository(path.join(temp, 'codex-web.sqlite3'), 1_000);
    const now = new Date().toISOString();
    const dueAt = Date.now() - 1;
    const failingStorageNames = new Set<string>();
    const insert = repository.database.prepare(
      `INSERT INTO attachment_file_deletions(
         id,project_id,thread_id,storage_name,attempts,next_attempt_at,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?)`,
    );
    for (let index = 0; index < 17; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const storageName = `${id}.txt`;
      if (index < 16) failingStorageNames.add(storageName);
      insert.run(id, 'project', 'thread', storageName, index === 15 ? 16 : 0, dueAt, now, now);
    }
    repository.close();
    const appServer = new FakeAppServer();
    const healthyId = '00000000-0000-4000-8000-000000000016';
    const started = await fixture(
      1,
      undefined,
      (root) => new SelectiveFailRemoveAttachmentStore(root, failingStorageNames),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      { temp, appServer },
    );
    await vi.waitFor(() => {
      expect(started.repository.hasAttachmentFileDeletion(healthyId)).toBe(false);
      const remaining = started.repository.database
        .prepare('SELECT COUNT(*) AS count FROM attachment_file_deletions')
        .get() as { count: number };
      expect(remaining.count).toBe(16);
    });
    const firstFailure = started.repository.database
      .prepare(
        "SELECT attempts,next_attempt_at FROM attachment_file_deletions WHERE id='00000000-0000-4000-8000-000000000000'",
      )
      .get() as { attempts: number; next_attempt_at: number };
    expect(firstFailure.attempts).toBe(1);
    expect(firstFailure.next_attempt_at).toBeGreaterThan(dueAt + 30_000);
    const cappedFailure = started.repository.database
      .prepare(
        "SELECT attempts,next_attempt_at FROM attachment_file_deletions WHERE id='00000000-0000-4000-8000-000000000015'",
      )
      .get() as { attempts: number; next_attempt_at: number };
    expect(cappedFailure.attempts).toBe(17);
    expect(cappedFailure.next_attempt_at).toBeGreaterThan(Date.now() + 3_500_000);
    expect(cappedFailure.next_attempt_at).toBeLessThanOrEqual(Date.now() + 3_600_000);
    const audited = started.repository.database
      .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='attachment.file.delete'")
      .get() as { count: number };
    expect(audited.count).toBe(15);
  });

  it('protects queued-turn cancellation and validates its numeric identifier', async () => {
    const { app, repository, projectPath } = await fixture(1);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const activeThreadId = await createThread(app, project.id, session.headers);
    const queuedThreadId = await createThread(app, project.id, session.headers);
    await app.inject({
      method: 'POST',
      url: `/api/threads/${activeThreadId}/turns`,
      headers: session.headers,
      payload: { text: 'active', idempotencyKey: '12000000-0000-4000-8000-000000000001' },
    });
    const queued = await app.inject({
      method: 'POST',
      url: `/api/threads/${queuedThreadId}/turns`,
      headers: session.headers,
      payload: { text: 'queued', idempotencyKey: '12000000-0000-4000-8000-000000000002' },
    });
    const queuedTurnId = queued.json<{ data: { queuedTurn: { id: number } } }>().data.queuedTurn.id;

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/threads/${queuedThreadId}/queued-turns/${queuedTurnId}`,
        })
      ).statusCode,
    ).toBe(401);
    const missingCsrf = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${queuedThreadId}/queued-turns/${queuedTurnId}`,
      headers: { origin: 'https://codex.test', cookie: session.cookie },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: { code: 'CSRF_REQUIRED' } });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/threads/${queuedThreadId}/queued-turns/0`,
          headers: session.headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(repository.getQueuedTurn(queuedTurnId)).toBeDefined();
  });

  it('makes queued dispatch claim and cancellation mutually exclusive without interrupting native work', async () => {
    const { app, appServer, repository, projectPath } = await fixture(1);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const activeThreadId = await createThread(app, project.id, session.headers);
    const queuedThreadId = await createThread(app, project.id, session.headers);
    await app.inject({
      method: 'POST',
      url: `/api/threads/${activeThreadId}/turns`,
      headers: session.headers,
      payload: { text: 'active', idempotencyKey: '13000000-0000-4000-8000-000000000001' },
    });
    const queued = await app.inject({
      method: 'POST',
      url: `/api/threads/${queuedThreadId}/turns`,
      headers: session.headers,
      payload: { text: 'claim first', idempotencyKey: '13000000-0000-4000-8000-000000000002' },
    });
    const queuedTurnId = queued.json<{ data: { queuedTurn: { id: number } } }>().data.queuedTurn.id;
    expect(repository.claimQueuedTurn(queuedTurnId)?.status).toBe('dispatching');
    const nativeRequestsBefore = appServer.requests.length;

    const cancellation = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${queuedThreadId}/queued-turns/${queuedTurnId}`,
      headers: session.headers,
    });
    expect(cancellation.statusCode).toBe(409);
    expect(cancellation.json()).toMatchObject({
      error: { code: 'QUEUED_TURN_NOT_CANCELLABLE' },
    });
    expect(repository.getQueuedTurn(queuedTurnId)?.status).toBe('dispatching');
    expect(appServer.requests).toHaveLength(nativeRequestsBefore);
  });

  it('skips a queued follow-up for a busy thread and starts the oldest eligible thread', async () => {
    const { app, appServer, repository, projectPath } = await fixture(2);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const busyThreadId = await createThread(app, project.id, session.headers);
    const idleThreadId = await createThread(app, project.id, session.headers);
    const send = (threadId: string, text: string, idempotencyKey: string) =>
      app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/turns`,
        headers: session.headers,
        payload: { text, idempotencyKey },
      });
    await send(busyThreadId, 'active', '20000000-0000-4000-8000-000000000001');
    await send(busyThreadId, 'follow-up', '20000000-0000-4000-8000-000000000002');
    await send(idleThreadId, 'eligible', '20000000-0000-4000-8000-000000000003');

    await vi.waitFor(
      () => {
        const starts = appServer.requests.filter((request) => request.method === 'turn/start');
        expect(starts).toHaveLength(2);
        expect(starts[1]?.params).toMatchObject({ threadId: idleThreadId });
      },
      { timeout: 2_000 },
    );
    const busyQueue = await app.inject({
      method: 'GET',
      url: `/api/threads/${busyThreadId}/queued-turns`,
      headers: { cookie: session.cookie },
    });
    expect(busyQueue.json()).toMatchObject({ data: [{ textPreview: 'follow-up' }] });
    const queuedRecord = repository.listQueuedTurns(busyThreadId)[0];
    expect(queuedRecord).toBeDefined();
    expect(repository.claimQueuedTurn(queuedRecord!.id)).toBeDefined();
    const archive = await app.inject({
      method: 'POST',
      url: `/api/threads/${busyThreadId}/archive`,
      headers: session.headers,
    });
    expect(archive.statusCode).toBe(409);
    expect(archive.json()).toMatchObject({ error: { code: 'QUEUED_TURNS_PENDING' } });
    repository.requeueTurn(queuedRecord!.id);
  });

  it('reconciles a stale subagent before dispatching queued work for its root thread', async () => {
    const { app, appServer, repository, projectPath } = await fixture(2);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const rootThreadId = await createThread(app, project.id, session.headers);
    const observedAt = '2026-10-05T10:00:00.000Z';
    appServer.addSubagentThread('stale-queued-child', projectPath, 'idle');
    repository.upsertSubagent({
      id: 'stale-queued-child',
      rootThreadId,
      parentThreadId: rootThreadId,
      agentPath: '/root/stale-queued-child',
      nickname: null,
      role: null,
      model: null,
      reasoningEffort: null,
      status: 'running',
      message: null,
      startedAt: observedAt,
      lastActivityAt: observedAt,
      completedAt: null,
    });

    const queued = await app.inject({
      method: 'POST',
      url: `/api/threads/${rootThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'start after stale child recovery',
        idempotencyKey: '21000000-0000-4000-8000-000000000001',
      },
    });

    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ data: { status: 'queued' } });
    await vi.waitFor(
      () => {
        expect(
          appServer.requests.filter((request) => request.method === 'turn/start'),
        ).toHaveLength(1);
      },
      { timeout: 2_000 },
    );
    expect(
      appServer.requests.some(
        (request) =>
          request.method === 'thread/read' &&
          (request.params as { threadId?: string }).threadId === 'stale-queued-child',
      ),
    ).toBe(true);
    expect(repository.getSubagent('stale-queued-child')).toMatchObject({ status: 'interrupted' });
    expect(repository.listQueuedTurns(rootThreadId)).toHaveLength(0);
  });

  it('keeps confirmed-live queued work blocked while another chat uses the free slot', async () => {
    const { app, appServer, repository, projectPath } = await fixture(2);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const blockedThreadId = await createThread(app, project.id, session.headers);
    const eligibleThreadId = await createThread(app, project.id, session.headers);
    const observedAt = '2026-10-05T10:00:00.000Z';
    appServer.addSubagentThread('live-queued-child', projectPath, 'active');
    repository.upsertSubagent({
      id: 'live-queued-child',
      rootThreadId: blockedThreadId,
      parentThreadId: blockedThreadId,
      agentPath: '/root/live-queued-child',
      nickname: null,
      role: null,
      model: null,
      reasoningEffort: null,
      status: 'running',
      message: null,
      startedAt: observedAt,
      lastActivityAt: observedAt,
      completedAt: null,
    });

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/threads/${blockedThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'wait for the live child',
        idempotencyKey: '22000000-0000-4000-8000-000000000001',
      },
    });
    expect(blocked.json()).toMatchObject({ data: { status: 'queued' } });
    await vi.waitFor(
      () => {
        expect(
          appServer.requests.filter(
            (request) =>
              request.method === 'thread/read' &&
              (request.params as { threadId?: string }).threadId === 'live-queued-child',
          ),
        ).toHaveLength(1);
      },
      { timeout: 2_000 },
    );

    const eligible = await app.inject({
      method: 'POST',
      url: `/api/threads/${eligibleThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'use the remaining slot',
        idempotencyKey: '22000000-0000-4000-8000-000000000002',
      },
    });
    expect(eligible.json()).toMatchObject({ data: { status: 'queued' } });
    await vi.waitFor(
      () => {
        const starts = appServer.requests.filter((request) => request.method === 'turn/start');
        expect(starts).toHaveLength(1);
        expect(starts[0]?.params).toMatchObject({ threadId: eligibleThreadId });
      },
      { timeout: 2_000 },
    );
    expect(repository.getSubagent('live-queued-child')).toMatchObject({ status: 'running' });
    expect(repository.listQueuedTurns(blockedThreadId)).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(
      appServer.requests.filter(
        (request) =>
          request.method === 'thread/read' &&
          (request.params as { threadId?: string }).threadId === 'live-queued-child',
      ),
    ).toHaveLength(1);
  });

  it('throttles queued runtime reconciliation from the end of a slow authoritative read', async () => {
    const { app, appServer, repository, projectPath } = await fixture(2);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const rootThreadId = await createThread(app, project.id, session.headers);
    const observedAt = '2026-10-05T10:00:00.000Z';
    appServer.addSubagentThread('slow-live-queued-child', projectPath, 'active');
    repository.upsertSubagent({
      id: 'slow-live-queued-child',
      rootThreadId,
      parentThreadId: rootThreadId,
      agentPath: '/root/slow-live-queued-child',
      nickname: null,
      role: null,
      model: null,
      reasoningEffort: null,
      status: 'running',
      message: null,
      startedAt: observedAt,
      lastActivityAt: observedAt,
      completedAt: null,
    });
    const gate = appServer.blockThreadReads();
    await app.inject({
      method: 'POST',
      url: `/api/threads/${rootThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'remain queued during a slow read',
        idempotencyKey: '22500000-0000-4000-8000-000000000001',
      },
    });
    await gate.entered;

    const futureNow = Date.now() + 20_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(futureNow);
    try {
      gate.release();
      await vi.waitFor(() => {
        expect(
          appServer.requests.filter(
            (request) =>
              request.method === 'thread/read' &&
              (request.params as { threadId?: string }).threadId === 'slow-live-queued-child',
          ),
        ).toHaveLength(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(
        appServer.requests.filter(
          (request) =>
            request.method === 'thread/read' &&
            (request.params as { threadId?: string }).threadId === 'slow-live-queued-child',
        ),
      ).toHaveLength(1);
      expect(repository.getSubagent('slow-live-queued-child')).toMatchObject({ status: 'running' });
      expect(repository.listQueuedTurns(rootThreadId)).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps stale-looking queued work blocked when authoritative reconciliation fails', async () => {
    const { app, appServer, repository, projectPath } = await fixture(2);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const rootThreadId = await createThread(app, project.id, session.headers);
    const observedAt = '2026-10-05T10:00:00.000Z';
    appServer.addSubagentThread('unreadable-queued-child', projectPath, 'idle');
    repository.upsertSubagent({
      id: 'unreadable-queued-child',
      rootThreadId,
      parentThreadId: rootThreadId,
      agentPath: '/root/unreadable-queued-child',
      nickname: null,
      role: null,
      model: null,
      reasoningEffort: null,
      status: 'running',
      message: null,
      startedAt: observedAt,
      lastActivityAt: observedAt,
      completedAt: null,
    });
    appServer.failNextRequestWith = new Error('thread/read unavailable');

    const queued = await app.inject({
      method: 'POST',
      url: `/api/threads/${rootThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'stay queued on inconclusive recovery',
        idempotencyKey: '23000000-0000-4000-8000-000000000001',
      },
    });

    expect(queued.json()).toMatchObject({ data: { status: 'queued' } });
    await vi.waitFor(
      () => {
        expect(
          appServer.requests.filter((request) => request.method === 'thread/read'),
        ).toHaveLength(1);
      },
      { timeout: 2_000 },
    );
    expect(repository.getSubagent('unreadable-queued-child')).toMatchObject({ status: 'running' });
    expect(repository.listQueuedTurns(rootThreadId)).toHaveLength(1);
    expect(appServer.requests.filter((request) => request.method === 'turn/start')).toHaveLength(0);
  });

  it('keeps queued attachment ownership until automatic dispatch binds the real turn', async () => {
    const { app, appServer, repository, projectPath } = await fixture(1);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const firstThreadId = await createThread(app, project.id, session.headers);
    const queuedThreadId = await createThread(app, project.id, session.headers);
    await app.inject({
      method: 'POST',
      url: `/api/threads/${firstThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'active',
        idempotencyKey: '30000000-0000-4000-8000-000000000001',
      },
    });
    const upload = multipartFile('queued.txt', 'text/plain', Buffer.from('queued context'));
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/threads/${queuedThreadId}/attachments`,
      headers: { ...session.headers, 'content-type': upload.contentType },
      payload: upload.body,
    });
    const attachment = uploaded.json<{ data: Attachment }>().data;
    const queued = await app.inject({
      method: 'POST',
      url: `/api/threads/${queuedThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'use attachment',
        attachmentIds: [attachment.id],
        idempotencyKey: '30000000-0000-4000-8000-000000000002',
      },
    });
    expect(queued.json()).toMatchObject({ data: { status: 'queued' } });
    expect(repository.getAttachment(attachment.id)?.turnId).toBe(
      `queued:${queuedThreadId}:30000000-0000-4000-8000-000000000002`,
    );

    appServer.setThreadStatus(firstThreadId, 'idle');
    appServer.emit({
      method: 'turn/completed',
      params: { threadId: firstThreadId, turn: { id: 'turn-1' } },
    });
    await vi.waitFor(() => {
      expect(repository.getAttachment(attachment.id)?.turnId).toBe('turn-2');
    });
    expect(appServer.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
  });

  it('recovers a persisted queued request on API startup without duplicate native starts', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-web-queue-restart-'));
    const appServer = new FakeAppServer();
    const first = await fixture(
      1,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      { temp, appServer },
    );
    const session = await login(first.app);
    const project = await createProject(first.app, first.projectPath, session.headers);
    const firstThreadId = await createThread(first.app, project.id, session.headers);
    const queuedThreadId = await createThread(first.app, project.id, session.headers);
    await first.app.inject({
      method: 'POST',
      url: `/api/threads/${firstThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'active before restart',
        idempotencyKey: '40000000-0000-4000-8000-000000000001',
      },
    });
    await first.app.inject({
      method: 'POST',
      url: `/api/threads/${queuedThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'survive restart',
        idempotencyKey: '40000000-0000-4000-8000-000000000002',
      },
    });
    await first.app.close();
    openApps.splice(openApps.indexOf(first.app), 1);

    const second = await fixture(
      1,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      { temp, appServer },
    );
    await vi.waitFor(() => {
      const queuedStarts = appServer.requests.filter(
        (request) =>
          request.method === 'turn/start' &&
          (request.params as { clientUserMessageId?: string }).clientUserMessageId ===
            '40000000-0000-4000-8000-000000000002',
      );
      expect(queuedStarts).toHaveLength(1);
    });
    const replay = await second.app.inject({
      method: 'POST',
      url: `/api/threads/${queuedThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'survive restart',
        idempotencyKey: '40000000-0000-4000-8000-000000000002',
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ data: { status: 'started' } });
  });

  it('reconciles a crash-window dispatch from native client message evidence without retrying', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-web-queue-ambiguous-'));
    const appServer = new FakeAppServer();
    const first = await fixture(
      1,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      { temp, appServer },
    );
    const session = await login(first.app);
    const project = await createProject(first.app, first.projectPath, session.headers);
    const threadId = await createThread(first.app, project.id, session.headers);
    const key = '41000000-0000-4000-8000-000000000001';
    const requestHashValue = 'crash-window-hash';
    first.repository.reserveIdempotent(`turn:${threadId}`, key, requestHashValue);
    const queued = first.repository.enqueueTurn({
      threadId,
      idempotencyKey: key,
      requestHash: requestHashValue,
      request: { text: 'possibly delivered', attachmentIds: [], idempotencyKey: key },
      claimToken: `queued:${threadId}:${key}`,
    }).record;
    expect(first.repository.claimQueuedTurn(queued.id)).toBeDefined();
    appServer.setThreadTurns(threadId, [
      {
        id: 'native-turn-after-crash',
        status: 'completed',
        items: [{ type: 'userMessage', clientId: key, content: [] }],
      },
    ]);
    await first.app.close();
    openApps.splice(openApps.indexOf(first.app), 1);

    const second = await fixture(
      1,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      { temp, appServer },
    );
    await vi.waitFor(() => {
      expect(second.repository.getQueuedTurn(queued.id)).toBeUndefined();
      expect(second.repository.getIdempotent(`turn:${threadId}`, key)).toMatchObject({
        state: 'completed',
        response: { data: { status: 'started', turnId: 'native-turn-after-crash' } },
      });
    });
    expect(
      appServer.requests.filter(
        (request) =>
          request.method === 'turn/start' &&
          (request.params as { clientUserMessageId?: string }).clientUserMessageId === key,
      ),
    ).toHaveLength(0);
  });

  it('keeps an unresolved crash outcome fail closed while other threads continue', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const otherThreadId = await createThread(app, project.id, session.headers);
    const key = '42000000-0000-4000-8000-000000000001';
    const requestHashValue = 'unknown-hash';
    repository.reserveIdempotent(`turn:${threadId}`, key, requestHashValue);
    const queued = repository.enqueueTurn({
      threadId,
      idempotencyKey: key,
      requestHash: requestHashValue,
      request: { text: 'review me', attachmentIds: [], idempotencyKey: key },
      claimToken: `queued:${threadId}:${key}`,
    }).record;
    repository.claimQueuedTurn(queued.id);
    repository.markQueuedTurnUnknown(queued.id, 'IDEMPOTENCY_OUTCOME_UNKNOWN');
    const visible = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/queued-turns`,
      headers: { cookie: session.cookie },
    });
    expect(visible.json()).toMatchObject({
      data: [
        {
          id: queued.id,
          status: 'needsReview',
          position: null,
          errorCode: 'IDEMPOTENCY_OUTCOME_UNKNOWN',
        },
      ],
    });

    const unavailableCancel = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/queued-turns/${queued.id}/cancel`,
      headers: session.headers,
    });
    expect(unavailableCancel.statusCode).toBe(404);
    expect(repository.getQueuedTurn(queued.id)?.status).toBe('unknown');

    const startsBeforeBlockedPost = appServer.requests.filter(
      (request) => request.method === 'turn/start',
    ).length;
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'must not pass an ambiguous predecessor',
        idempotencyKey: '42000000-0000-4000-8000-000000000002',
      },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: { code: 'QUEUED_TURN_OUTCOME_UNKNOWN' } });
    expect(appServer.requests.filter((request) => request.method === 'turn/start')).toHaveLength(
      startsBeforeBlockedPost,
    );

    const followerKey = '42000000-0000-4000-8000-000000000003';
    expect(repository.reserveIdempotent(`turn:${threadId}`, followerKey, 'follower-hash')).toEqual({
      reserved: true,
    });
    const follower = repository.enqueueTurn({
      threadId,
      idempotencyKey: followerKey,
      requestHash: 'follower-hash',
      request: { text: 'already queued follower', attachmentIds: [], idempotencyKey: followerKey },
      claimToken: `queued:${threadId}:${followerKey}`,
    }).record;

    const otherKey = '42000000-0000-4000-8000-000000000004';
    const other = await app.inject({
      method: 'POST',
      url: `/api/threads/${otherThreadId}/turns`,
      headers: session.headers,
      payload: { text: 'independent thread', idempotencyKey: otherKey },
    });
    expect(other.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(
        appServer.requests.filter(
          (request) =>
            request.method === 'turn/start' &&
            (request.params as { clientUserMessageId?: string }).clientUserMessageId === otherKey,
        ),
      ).toHaveLength(1);
    });
    expect(repository.getQueuedTurn(follower.id)?.status).toBe('queued');
    expect(
      appServer.requests.filter(
        (request) =>
          request.method === 'turn/start' &&
          (request.params as { clientUserMessageId?: string }).clientUserMessageId === followerKey,
      ),
    ).toHaveLength(0);

    const archive = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/archive`,
      headers: session.headers,
    });
    expect(archive.statusCode).toBe(409);
    expect(archive.json()).toMatchObject({ error: { code: 'QUEUED_TURNS_PENDING' } });
    expect(repository.getQueuedTurn(queued.id)?.status).toBe('unknown');
  });

  it('rejects queue overflow without consuming the idempotency key', async () => {
    const { app, repository, projectPath } = await fixture(1);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    for (let index = 0; index < MAX_QUEUED_TURNS; index += 1) {
      const idempotencyKey = `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const requestHashValue = `hash-${index}`;
      expect(
        repository.reserveIdempotent(`turn:${threadId}`, idempotencyKey, requestHashValue),
      ).toEqual({
        reserved: true,
      });
      repository.enqueueTurn({
        threadId,
        idempotencyKey,
        requestHash: requestHashValue,
        request: {
          text: `queued ${index}`,
          attachmentIds: [],
          idempotencyKey,
        },
        claimToken: `queued:${idempotencyKey}`,
      });
    }
    const overflowKey = '50000000-0000-4000-8000-999999999999';
    const overflow = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: { text: 'overflow', idempotencyKey: overflowKey },
    });
    expect(overflow.statusCode).toBe(429);
    expect(overflow.json()).toMatchObject({
      error: { code: 'TURN_QUEUE_CAPACITY_EXHAUSTED' },
    });
    expect(repository.getIdempotent(`turn:${threadId}`, overflowKey)).toBeUndefined();
  });

  it('reconciles a missed root terminal before the no-broker capacity fallback rejects', async () => {
    const { app, appServer, projectPath } = await fixture(1);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const firstThreadId = await createThread(app, project.id, session.headers);
    const secondThreadId = await createThread(app, project.id, session.headers);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/threads/${firstThreadId}/turns`,
          headers: session.headers,
          payload: {
            text: 'first',
            idempotencyKey: '00000000-0000-4000-8000-000000000290',
          },
        })
      ).statusCode,
    ).toBe(202);

    appServer.setThreadStatus(firstThreadId, 'idle');
    const reconciled = await app.inject({
      method: 'POST',
      url: `/api/threads/${secondThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'second',
        idempotencyKey: '00000000-0000-4000-8000-000000000291',
      },
    });

    expect(reconciled.statusCode).toBe(202);
    expect(
      appServer.requests.some(
        (request) =>
          request.method === 'thread/read' &&
          (request.params as { threadId?: string }).threadId === firstThreadId,
      ),
    ).toBe(true);
  });

  it('counts and reconciles an unknown-id native active root before no-broker admission', async () => {
    const { app, appServer, projectPath } = await fixture(1);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const firstThreadId = await createThread(app, project.id, session.headers);
    const secondThreadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'thread/status/changed',
      params: { threadId: firstThreadId, status: { type: 'active' } },
    });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      upgradeDrain: { activeTurns: 1, activeExecutionUnits: 1 },
    });

    appServer.setThreadStatus(firstThreadId, 'idle');
    const admitted = await app.inject({
      method: 'POST',
      url: `/api/threads/${secondThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'start after native root stopped',
        idempotencyKey: '00000000-0000-4000-8000-000000000292',
      },
    });

    expect(admitted.statusCode).toBe(202);
    expect(
      appServer.requests.some(
        (request) =>
          request.method === 'thread/read' &&
          (request.params as { threadId?: string }).threadId === firstThreadId,
      ),
    ).toBe(true);
  });

  it('keeps a reconfirmed native root active while an idle capacity reread is in flight', async () => {
    const { app, appServer, repository, projectPath } = await fixture(1);
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const firstThreadId = await createThread(app, project.id, session.headers);
    const secondThreadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'thread/status/changed',
      params: { threadId: firstThreadId, status: { type: 'active' } },
    });
    appServer.setThreadStatus(firstThreadId, 'idle');
    const gate = appServer.blockThreadReads();
    const attemptedStart = app.inject({
      method: 'POST',
      url: `/api/threads/${secondThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'must remain blocked',
        idempotencyKey: '00000000-0000-4000-8000-000000000293',
      },
    });
    await gate.entered;
    appServer.emit({
      method: 'thread/status/changed',
      params: { threadId: firstThreadId, status: { type: 'active' } },
    });
    gate.release();

    expect((await attemptedStart).statusCode).toBe(202);
    expect(repository.getThread(firstThreadId)).toMatchObject({
      status: 'active',
      activeTurnId: null,
    });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      upgradeDrain: { activeTurns: 1, activeExecutionUnits: 1 },
    });
  });

  it('does not resurrect a native root from an active reread older than a fresh idle event', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'thread/status/changed',
      params: { threadId, status: { type: 'active' } },
    });
    appServer.setThreadStatus(threadId, 'active');
    appServer.restart();
    const gate = appServer.blockThreadReads();
    const read = app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}`,
      headers: { cookie: session.cookie },
    });
    await gate.entered;
    appServer.emit({
      method: 'thread/status/changed',
      params: { threadId, status: { type: 'idle' } },
    });
    gate.release();

    expect((await read).json()).toMatchObject({
      data: { id: threadId, status: 'idle', activeTurnId: null },
    });
    expect(repository.getThread(threadId)).toMatchObject({ status: 'idle', activeTurnId: null });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      upgradeDrain: { activeTurns: 0, activeExecutionUnits: 0 },
    });
  });

  it('uses the broker execution ceiling instead of the static fallback turn limit', async () => {
    const broker = new FakeResourceBroker();
    const { app, appServer, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      broker,
    );
    const session = await login(app);
    await new Promise((resolve) => setImmediate(resolve));
    const project = await createProject(app, projectPath, session.headers);
    const threadIds = await Promise.all(
      Array.from({ length: 7 }, () => createThread(app, project.id, session.headers)),
    );

    for (const [index, threadId] of threadIds.slice(0, 6).entries()) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${threadId}/turns`,
        headers: session.headers,
        payload: {
          text: `accepted ${index}`,
          idempotencyKey: `00000000-0000-4000-8000-00000000010${index}`,
        },
      });
      expect(response.statusCode).toBe(202);
    }

    const saturatedKey = '00000000-0000-4000-8000-000000000200';
    const saturated = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadIds[6]}/turns`,
      headers: session.headers,
      payload: { text: 'wait for capacity', idempotencyKey: saturatedKey },
    });
    expect(saturated.statusCode).toBe(202);
    expect(saturated.json()).toMatchObject({
      data: { status: 'queued', queuedTurn: { position: 1 } },
    });
    expect(appServer.requests.filter((request) => request.method === 'turn/start')).toHaveLength(6);
    await vi.waitFor(async () => {
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
        upgradeDrain: { activeTurns: 6, pendingTurnStarts: 0 },
      });
    });

    appServer.emit({
      method: 'turn/completed',
      params: { threadId: threadIds[0], turn: { id: 'turn-1' } },
    });
    await vi.waitFor(() => {
      expect(appServer.requests.filter((request) => request.method === 'turn/start')).toHaveLength(
        7,
      );
    });
    const retried = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadIds[6]}/turns`,
      headers: session.headers,
      payload: { text: 'wait for capacity', idempotencyKey: saturatedKey },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ data: { status: 'started' } });
    expect(appServer.requests.filter((request) => request.method === 'turn/start')).toHaveLength(7);
  });

  it('keeps descendant work visible and reconciles missed child terminals before rejecting capacity', async () => {
    const broker = new FakeResourceBroker();
    const { app, appServer, repository, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      broker,
    );
    const session = await login(app);
    await new Promise((resolve) => setImmediate(resolve));
    const project = await createProject(app, projectPath, session.headers);
    const rootThreadId = await createThread(app, project.id, session.headers);
    const nextThreadId = await createThread(app, project.id, session.headers);
    const started = await app.inject({
      method: 'POST',
      url: `/api/threads/${rootThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'root task',
        idempotencyKey: '00000000-0000-4000-8000-000000000301',
      },
    });
    expect(started.statusCode).toBe(202);

    const baseTime = Date.parse('2026-09-29T00:00:00.000Z');
    for (let index = 0; index < 6; index += 1) {
      const observedAt = new Date(baseTime + index * 1_000).toISOString();
      appServer.addSubagentThread(`child-${index}`, projectPath, 'idle');
      repository.upsertSubagent({
        id: `child-${index}`,
        rootThreadId,
        parentThreadId: rootThreadId,
        agentPath: `/root/child-${index}`,
        nickname: null,
        role: null,
        model: null,
        reasoningEffort: null,
        status: 'running',
        message: null,
        startedAt: observedAt,
        lastActivityAt: observedAt,
        completedAt: null,
      });
    }
    repository.upsertSubagent({
      id: rootThreadId,
      rootThreadId,
      parentThreadId: rootThreadId,
      agentPath: '/root',
      nickname: null,
      role: null,
      model: null,
      reasoningEffort: null,
      status: 'running',
      message: null,
      startedAt: new Date(baseTime).toISOString(),
      lastActivityAt: new Date(baseTime).toISOString(),
      completedAt: null,
    });
    expect(repository.countActiveSubagents()).toBe(6);
    expect(repository.listSubagents(rootThreadId)).toHaveLength(6);

    appServer.emit({
      method: 'turn/completed',
      params: { threadId: rootThreadId, turn: { id: 'turn-1', status: 'completed', items: [] } },
    });
    expect(repository.getThread(rootThreadId)).toMatchObject({
      status: 'active',
      activeTurnId: null,
    });
    expect(
      repository
        .listEvents(rootThreadId, 0)
        .filter((event) => event.kind === 'turn')
        .at(-1),
    ).toMatchObject({
      phase: 'completed',
      payload: {
        runtime: true,
        threadRuntime: { status: 'active', activeTurnId: null },
      },
    });
    const retried = await app.inject({
      method: 'POST',
      url: `/api/threads/${nextThreadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'new task after missed terminal',
        idempotencyKey: '00000000-0000-4000-8000-000000000302',
      },
    });

    expect(retried.statusCode).toBe(202);
    expect(repository.countActiveSubagents()).toBe(0);
    expect(repository.listSubagents(rootThreadId).map((subagent) => subagent.status)).toEqual([
      'interrupted',
      'interrupted',
      'interrupted',
      'interrupted',
      'interrupted',
      'interrupted',
    ]);
    expect(
      appServer.requests.some(
        (request) =>
          request.method === 'thread/read' &&
          (request.params as { threadId?: string }).threadId === 'child-0',
      ),
    ).toBe(true);
  });

  it('does not regress terminal subagents from older or equal-time activity', async () => {
    const { app, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const rootThreadId = await createThread(app, project.id, session.headers);
    const completedAt = '2026-09-29T00:00:02.000Z';
    repository.upsertSubagent({
      id: 'child-terminal',
      rootThreadId,
      parentThreadId: rootThreadId,
      agentPath: null,
      nickname: null,
      role: null,
      model: null,
      reasoningEffort: null,
      status: 'completed',
      message: 'done',
      startedAt: '2026-09-29T00:00:00.000Z',
      lastActivityAt: completedAt,
      completedAt,
    });
    for (const lastActivityAt of ['2026-09-29T00:00:01.000Z', completedAt]) {
      repository.upsertSubagent({
        id: 'child-terminal',
        rootThreadId,
        parentThreadId: rootThreadId,
        agentPath: null,
        nickname: null,
        role: null,
        model: null,
        reasoningEffort: null,
        status: 'running',
        message: 'stale',
        startedAt: '2026-09-29T00:00:00.000Z',
        lastActivityAt,
        completedAt: null,
      });
    }
    expect(repository.getSubagent('child-terminal')).toMatchObject({
      status: 'completed',
      message: 'done',
      lastActivityAt: completedAt,
      completedAt,
    });
    const futureActivity = '2026-09-29T01:00:00.000Z';
    repository.upsertSubagent({
      id: 'child-clock-skew',
      rootThreadId,
      parentThreadId: rootThreadId,
      agentPath: null,
      nickname: null,
      role: null,
      model: null,
      reasoningEffort: null,
      status: 'running',
      message: null,
      startedAt: futureActivity,
      lastActivityAt: futureActivity,
      completedAt: null,
    });
    expect(
      repository.reconcileActiveSubagent(
        'child-clock-skew',
        'running',
        futureActivity,
        '2026-09-29T00:59:59.000Z',
      ),
    ).toBe(true);
    expect(repository.getSubagent('child-clock-skew')).toMatchObject({
      status: 'interrupted',
      lastActivityAt: futureActivity,
      completedAt: futureActivity,
    });
  });

  it('atomically reserves a turn idempotency key across concurrent duplicates', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = (
      await app.inject({
        method: 'POST',
        url: '/api/threads',
        headers: session.headers,
        payload: { projectId: project.id },
      })
    ).json<{ data: { id: string } }>().data;
    const gate = appServer.blockTurnStarts();
    const payload = {
      text: 'one logical request',
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
    };
    const firstPromise = app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/turns`,
      headers: session.headers,
      payload,
    });
    await gate.entered;
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/turns`,
      headers: session.headers,
      payload,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_PENDING' } });
    expect(appServer.requests.filter((item) => item.method === 'turn/start')).toHaveLength(1);
    gate.release();
    expect((await firstPromise).statusCode).toBe(202);
  });

  it('reuses a resource-bounded thread writer and resumes it only after app-server restart', async () => {
    const broker = new FakeResourceBroker();
    const { app, appServer, projectPath, repository } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      broker,
    );
    for (
      let attempt = 0;
      attempt < 20 && repository.getResourceLimits().state !== 'applied';
      attempt += 1
    )
      await new Promise((resolve) => setImmediate(resolve));
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = (
      await app.inject({
        method: 'POST',
        url: '/api/threads',
        headers: session.headers,
        payload: { projectId: project.id },
      })
    ).json<{ data: { id: string } }>().data;
    expect(appServer.requests.find((item) => item.method === 'thread/start')?.params).toMatchObject(
      { config: { agents: { max_threads: 6 } } },
    );

    const first = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/turns`,
      headers: session.headers,
      payload: {
        text: 'first',
        idempotencyKey: '66666666-6666-4666-8666-666666666666',
      },
    });
    expect(first.statusCode).toBe(202);
    expect(appServer.requests.filter((item) => item.method === 'thread/resume')).toHaveLength(0);
    const history = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}`,
      headers: { cookie: session.headers.cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(appServer.requests.filter((item) => item.method === 'thread/read')).toHaveLength(0);

    appServer.emit({
      method: 'turn/completed',
      params: { threadId: thread.id, turn: { id: 'turn-1' } },
    });
    appServer.restart();
    const second = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/turns`,
      headers: session.headers,
      payload: {
        text: 'second',
        idempotencyKey: '77777777-7777-4777-8777-777777777777',
      },
    });
    expect(second.statusCode).toBe(202);
    expect(appServer.requests.filter((item) => item.method === 'thread/resume')).toHaveLength(1);
    expect(
      appServer.requests.find((item) => item.method === 'thread/resume')?.params,
    ).toMatchObject({ config: { agents: { max_threads: 6 } } });
  });

  it('explains when an empty pre-restart chat was never persisted by Codex', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.restart();
    appServer.failNextRequestWith = new Error('APP_SERVER_REQUEST_FAILED');

    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'first task after restart',
        idempotencyKey: '78787878-7878-4787-8787-787878787878',
      },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('EMPTY_THREAD_NOT_PERSISTED');
    expect(body.error.message).toContain('Создайте новый чат');
    expect(appServer.requests.filter((item) => item.method === 'turn/start')).toHaveLength(0);
  });

  it('serves hydrated journal history when a post-restart metadata refresh fails', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = (
      await app.inject({
        method: 'POST',
        url: '/api/threads',
        headers: session.headers,
        payload: { projectId: project.id },
      })
    ).json<{ data: { id: string } }>().data;
    repository.appendEvent({
      threadId: thread.id,
      turnId: null,
      kind: 'warning',
      phase: 'state',
      payload: { message: 'retained safe history' },
    });

    appServer.restart();
    appServer.failNextRequestWith = new Error('thread/read unavailable');
    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}`,
      headers: { cookie: session.headers.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { id: thread.id },
      events: [{ kind: 'warning', payload: { message: 'retained safe history' } }],
    });
    expect(appServer.requests.filter((item) => item.method === 'thread/read')).toHaveLength(1);
  });

  it('marks an ambiguous turn/start failure unknown and never retries it', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = (
      await app.inject({
        method: 'POST',
        url: '/api/threads',
        headers: session.headers,
        payload: { projectId: project.id },
      })
    ).json<{ data: { id: string } }>().data;
    const payload = {
      text: 'ambiguous request',
      idempotencyKey: '55555555-5555-4555-8555-555555555555',
    };
    appServer.failTurnStartWith = new Error('connection lost after write');
    const first = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/turns`,
      headers: session.headers,
      payload,
    });
    expect(first.statusCode).toBe(500);
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/turns`,
      headers: session.headers,
      payload,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' },
    });
    expect(appServer.requests.filter((item) => item.method === 'turn/start')).toHaveLength(1);
  });

  it('rejects stale approvals after restart and safely reuses rpc request ids', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = (
      await app.inject({
        method: 'POST',
        url: '/api/threads',
        headers: session.headers,
        payload: { projectId: project.id },
      })
    ).json<{ data: { id: string } }>().data;
    appServer.emit({
      method: 'item/commandExecution/requestApproval',
      id: 41,
      params: { threadId: thread.id, turnId: 'turn-a', command: 'pnpm test', reason: 'Run tests' },
    });
    const stale = repository.database.prepare('SELECT id FROM approvals').get() as { id: string };
    appServer.restart();
    const staleResolution = await app.inject({
      method: 'POST',
      url: `/api/approvals/${stale.id}/resolve`,
      headers: session.headers,
      payload: { decision: 'accept' },
    });
    expect(staleResolution.statusCode).toBe(409);
    expect(staleResolution.json()).toMatchObject({
      error: { code: 'APPROVAL_NO_LONGER_ACTIVE' },
    });
    expect(appServer.responses).toEqual([]);

    appServer.emit({
      method: 'item/commandExecution/requestApproval',
      id: 41,
      params: {
        threadId: thread.id,
        turnId: 'turn-b',
        command: 'pnpm lint',
        reason: 'Run lint',
      },
    });
    const row = repository.database
      .prepare('SELECT id FROM approvals ORDER BY rowid DESC LIMIT 1')
      .get() as { id: string };
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/approvals/${row.id}/resolve`,
      headers: session.headers,
      payload: { decision: 'accept' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(appServer.responses).toEqual([{ id: 41, result: { decision: 'accept' } }]);
    const count = repository.database.prepare('SELECT COUNT(*) AS count FROM approvals').get() as {
      count: number;
    };
    expect(count.count).toBe(2);
  });

  it('atomically resolves a legacy approval only once under concurrent requests', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = (
      await app.inject({
        method: 'POST',
        url: '/api/threads',
        headers: session.headers,
        payload: { projectId: project.id },
      })
    ).json<{ data: { id: string } }>().data;
    appServer.emit({
      method: 'item/commandExecution/requestApproval',
      id: 51,
      params: { threadId: thread.id, turnId: 'turn-race', command: 'pnpm test' },
    });
    const row = repository.database.prepare('SELECT id FROM approvals').get() as { id: string };
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/approvals/${row.id}/resolve`,
        headers: session.headers,
        payload: { decision: 'accept' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/approvals/${row.id}/resolve`,
        headers: session.headers,
        payload: { decision: 'decline' },
      }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    expect(appServer.responses).toHaveLength(1);
    const terminals = repository
      .listEvents(thread.id, 0)
      .filter((event) => event.kind === 'approval' && event.phase !== 'state');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.payload).toMatchObject({ approval: { id: row.id } });
  });

  it('fails a claimed approval closed when the JSON-RPC write throws', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = (
      await app.inject({
        method: 'POST',
        url: '/api/threads',
        headers: session.headers,
        payload: { projectId: project.id },
      })
    ).json<{ data: { id: string } }>().data;
    appServer.emit({
      method: 'item/commandExecution/requestApproval',
      id: 52,
      params: { threadId: thread.id, turnId: 'turn-write-fail', command: 'pnpm test' },
    });
    const row = repository.database.prepare('SELECT id FROM approvals').get() as { id: string };
    appServer.failNextResponseWith = new Error('pipe closed');
    const failed = await app.inject({
      method: 'POST',
      url: `/api/approvals/${row.id}/resolve`,
      headers: session.headers,
      payload: { decision: 'accept' },
    });
    expect(failed.statusCode).toBe(500);
    expect(repository.getApproval(row.id)?.status).toBe('cancelled');
    expect(appServer.responses).toEqual([]);
    expect(
      repository
        .listEvents(thread.id, 0)
        .filter((event) => event.kind === 'approval')
        .at(-1)?.payload,
    ).toEqual({ approval: { id: row.id, status: 'cancelled' } });
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/approvals/${row.id}/resolve`,
      headers: session.headers,
      payload: { decision: 'accept' },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('cancels persisted pending approvals at process start and fails them closed', async () => {
    let staleApprovalId = '';
    const interactionIds: string[] = [];
    const pendingOperation = 'turn:seeded-thread';
    const pendingKey = '66666666-6666-4666-8666-666666666666';
    const pendingHash = 'seeded-request-hash';
    const { app, repository } = await fixture(2, ({ repository: seeded, projectPath }) => {
      const project = seeded.createProject({
        name: 'Seeded',
        path: projectPath,
        defaultModel: null,
        defaultReasoningEffort: null,
        defaultPermissionPreset: 'workspace-write',
      });
      const now = new Date().toISOString();
      const thread = seeded.upsertThread({
        id: 'seeded-thread',
        projectId: project.id,
        name: null,
        preview: '',
        model: null,
        status: 'idle',
        activeTurnId: null,
        archived: false,
        instructionSources: [],
        createdAt: now,
        updatedAt: now,
      });
      staleApprovalId = seeded.createApproval({
        threadId: thread.id,
        turnId: 'old-turn',
        rpcRequestId: 7,
        method: 'item/commandExecution/requestApproval',
        summary: 'Old request',
        details: {},
      }).id;
      interactionIds.push(
        seeded.createApproval({
          threadId: thread.id,
          turnId: 'old-user-turn',
          rpcRequestId: 8,
          method: 'item/tool/requestUserInput',
          summary: 'Old input',
          details: {},
        }).id,
      );
      const resolvingPermission = seeded.createApproval({
        threadId: thread.id,
        turnId: 'old-permission-turn',
        rpcRequestId: 9,
        method: 'item/permissions/requestApproval',
        summary: 'Old permission',
        details: {},
      }).id;
      interactionIds.push(resolvingPermission);
      expect(seeded.claimApproval(resolvingPermission)).toBe(true);
      expect(seeded.reserveIdempotent(pendingOperation, pendingKey, pendingHash)).toEqual({
        reserved: true,
      });
    });
    expect(repository.getApproval(staleApprovalId)?.status).toBe('cancelled');
    expect(interactionIds.map((id) => repository.getApproval(id)?.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    expect(
      repository
        .listEvents('seeded-thread', 0)
        .map((event) => ({ kind: event.kind, payload: event.payload })),
    ).toEqual([
      { kind: 'approval', payload: { approval: { id: staleApprovalId, status: 'cancelled' } } },
      {
        kind: 'user-input',
        payload: { request: { id: interactionIds[0], status: 'cancelled' } },
      },
      {
        kind: 'permission-approval',
        payload: { request: { id: interactionIds[1], status: 'cancelled' } },
      },
    ]);
    expect(repository.getIdempotent(pendingOperation, pendingKey)).toMatchObject({
      requestHash: pendingHash,
      state: 'unknown',
    });
    const session = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/approvals/${staleApprovalId}/resolve`,
      headers: session.headers,
      payload: { decision: 'accept' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'APPROVAL_NO_LONGER_ACTIVE' } });
  });

  it('validates user input exactly and never persists or emits secret answers', async () => {
    const { app, appServer, repository, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = (
      await app.inject({
        method: 'POST',
        url: '/api/threads',
        headers: session.headers,
        payload: { projectId: project.id },
      })
    ).json<{ data: { id: string } }>().data;
    appServer.emit({
      method: 'item/tool/requestUserInput',
      id: 71,
      params: {
        threadId: thread.id,
        turnId: 'turn-input',
        itemId: 'item-input',
        isBlocking: true,
        questions: [
          {
            id: 'choice',
            header: 'Choice',
            question: 'Choose exactly',
            options: [{ label: 'One', description: 'First' }],
            isOther: false,
            isSecret: false,
          },
          {
            id: 'secret',
            header: 'Secret',
            question: 'Enter secret',
            options: null,
            isOther: true,
            isSecret: true,
          },
        ],
      },
    });
    const row = repository.database
      .prepare("SELECT id FROM approvals WHERE method='item/tool/requestUserInput'")
      .get() as { id: string };
    const pending = repository
      .listEvents(thread.id, 0)
      .find((event) => event.kind === 'user-input');
    expect(pending?.payload).toMatchObject({
      request: {
        id: row.id,
        method: 'item/tool/requestUserInput',
        itemId: 'item-input',
        isBlocking: true,
        status: 'pending',
      },
    });

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/user-input-requests/${row.id}/resolve`,
      headers: session.headers,
      payload: { answers: { choice: { answers: ['Unknown'] } } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(appServer.responses).toEqual([]);

    const secretAnswer = 'answer-value-must-never-persist';
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/user-input-requests/${row.id}/resolve`,
      headers: session.headers,
      payload: {
        answers: {
          choice: { answers: ['One'] },
          secret: { answers: [secretAnswer] },
        },
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(appServer.responses).toEqual([
      {
        id: 71,
        result: {
          answers: {
            choice: { answers: ['One'] },
            secret: { answers: [secretAnswer] },
          },
        },
      },
    ]);
    const persisted = JSON.stringify({
      approvals: repository.database.prepare('SELECT details_json,status FROM approvals').all(),
      events: repository.database.prepare('SELECT payload_json FROM events').all(),
      audit: repository.database.prepare('SELECT metadata_json FROM audit_events').all(),
    });
    expect(persisted).not.toContain(secretAnswer);
    const terminal = repository
      .listEvents(thread.id, 0)
      .filter((event) => event.kind === 'user-input')
      .at(-1);
    expect(terminal?.payload).toEqual({ request: { id: row.id, status: 'accepted' } });

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/user-input-requests/${row.id}/resolve`,
      headers: session.headers,
      payload: {
        answers: { choice: { answers: ['One'] }, secret: { answers: ['another'] } },
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(appServer.responses).toHaveLength(1);
  });

  it('validates one-turn permissions, rejects unsafe paths, and fails stale requests closed', async () => {
    const { app, appServer, repository, projectPath, root, pathPolicy } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const thread = (
      await app.inject({
        method: 'POST',
        url: '/api/threads',
        headers: session.headers,
        payload: { projectId: project.id },
      })
    ).json<{ data: { id: string } }>().data;
    const emitPermission = (id: number, permissions: unknown) =>
      appServer.emit({
        method: 'item/permissions/requestApproval',
        id,
        params: {
          threadId: thread.id,
          turnId: `turn-${id}`,
          itemId: `item-${id}`,
          cwd: projectPath,
          reason: 'Need permission',
          permissions,
          startedAtMs: Date.now(),
        },
      });
    const permissionCount = () =>
      (
        repository.database
          .prepare(
            "SELECT COUNT(*) AS count FROM approvals WHERE method='item/permissions/requestApproval'",
          )
          .get() as { count: number }
      ).count;

    const newLeaf = path.join(projectPath, 'new-file.txt');
    await writeFile(newLeaf, '');
    emitPermission(81, {
      fileSystem: { write: [newLeaf] },
      network: { enabled: true },
    });
    await expect.poll(permissionCount).toBe(1);
    const grantedRow = repository.database
      .prepare("SELECT id FROM approvals WHERE method='item/permissions/requestApproval'")
      .get() as { id: string };
    const grant = await app.inject({
      method: 'POST',
      url: `/api/permission-requests/${grantedRow.id}/resolve`,
      headers: session.headers,
      payload: { decision: 'grant', scope: 'turn' },
    });
    expect(grant.statusCode).toBe(200);
    expect(appServer.responses.at(-1)).toEqual({
      id: 81,
      result: {
        permissions: {
          fileSystem: { write: [newLeaf] },
          network: { enabled: true },
        },
        scope: 'turn',
      },
    });
    const permissionTerminal = repository
      .listEvents(thread.id, 0)
      .filter((event) => event.kind === 'permission-approval')
      .at(-1);
    expect(permissionTerminal?.payload).toEqual({
      request: { id: grantedRow.id, status: 'accepted' },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/permission-requests/${grantedRow.id}/resolve`,
          headers: session.headers,
          payload: { decision: 'deny' },
        })
      ).statusCode,
    ).toBe(409);

    const outside = path.join(path.dirname(root), 'outside-permission');
    await mkdir(outside);
    emitPermission(82, { fileSystem: { write: [outside] } });
    emitPermission(83, {
      fileSystem: {
        entries: [{ access: 'write', path: { type: 'glob_pattern', pattern: '**/*' } }],
      },
    });
    emitPermission(86, { fileSystem: { write: [path.join(projectPath, 'missing.txt')] } });
    await expect.poll(() => appServer.responseErrors.length).toBe(3);
    expect(permissionCount()).toBe(1);
    expect(appServer.responseErrors.map((error) => error.id).sort()).toEqual([82, 83, 86]);

    emitPermission(84, { network: { enabled: true } });
    await expect.poll(permissionCount).toBe(2);
    const deniedRow = repository.database
      .prepare(
        "SELECT id FROM approvals WHERE method='item/permissions/requestApproval' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { id: string };
    const denied = await app.inject({
      method: 'POST',
      url: `/api/permission-requests/${deniedRow.id}/resolve`,
      headers: session.headers,
      payload: { decision: 'deny' },
    });
    expect(denied.statusCode).toBe(200);
    expect(appServer.responses.at(-1)).toEqual({
      id: 84,
      result: { permissions: {}, scope: 'turn' },
    });

    emitPermission(85, { network: { enabled: true } });
    await expect.poll(permissionCount).toBe(3);
    const staleRow = repository.database
      .prepare(
        "SELECT id FROM approvals WHERE method='item/permissions/requestApproval' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { id: string };
    const sessionScope = await app.inject({
      method: 'POST',
      url: `/api/permission-requests/${staleRow.id}/resolve`,
      headers: session.headers,
      payload: { decision: 'grant', scope: 'session' },
    });
    expect(sessionScope.statusCode).toBe(400);
    expect(appServer.responses.some((response) => response.id === 85)).toBe(false);
    appServer.restart();
    const stale = await app.inject({
      method: 'POST',
      url: `/api/permission-requests/${staleRow.id}/resolve`,
      headers: session.headers,
      payload: { decision: 'grant' },
    });
    expect(stale.statusCode).toBe(409);
    expect(appServer.responses.some((response) => response.id === 85)).toBe(false);

    appServer.restart();
    let releaseValidation!: () => void;
    let signalValidation!: () => void;
    const validationEntered = new Promise<void>((resolve) => {
      signalValidation = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const canonicalizeExisting = pathPolicy.canonicalizeExisting.bind(pathPolicy);
    vi.spyOn(pathPolicy, 'canonicalizeExisting').mockImplementation(async (candidate) => {
      signalValidation();
      await validationGate;
      return canonicalizeExisting(candidate);
    });
    emitPermission(87, { fileSystem: { write: [newLeaf] } });
    await validationEntered;
    appServer.disconnect();
    releaseValidation();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(permissionCount()).toBe(3);
    expect(appServer.responseErrors.some((response) => response.id === 87)).toBe(false);
  });
  it('reconciles the stored default resource policy when the server starts idle', async () => {
    const broker = new FakeResourceBroker();
    const { app, repository } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      broker,
    );
    for (
      let attempt = 0;
      attempt < 20 && repository.getResourceLimits().state !== 'applied';
      attempt += 1
    )
      await new Promise((resolve) => setImmediate(resolve));
    expect(repository.getResourceLimits().state).toBe('applied');
    expect(broker.applyRequests).toEqual([
      { mode: 'auto', cpuQuotaPercent: null, memoryMaxBytes: null, tasksMax: null },
    ]);
    await app.close();
  });

  it('schedules the startup retry only after a slow first broker attempt settles', async () => {
    vi.useFakeTimers();
    try {
      let rejectFirst!: (error: Error) => void;
      const firstSnapshot = new Promise<BrokerResourceSnapshot>((_resolve, reject) => {
        rejectFirst = reject;
      });
      class SlowFirstSnapshotBroker extends FakeResourceBroker {
        snapshots = 0;

        override async snapshot(): Promise<BrokerResourceSnapshot> {
          this.snapshots += 1;
          if (this.snapshots === 1) return firstSnapshot;
          return super.snapshot();
        }
      }
      const broker = new SlowFirstSnapshotBroker();
      const { app, repository } = await fixture(
        2,
        undefined,
        (root) => new AttachmentStore(root),
        broker,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(broker.snapshots).toBe(1);
      rejectFirst(new Error('first snapshot failed'));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(repository.getResourceLimits().state).toBe('applied');
      expect(broker.snapshots).toBe(2);
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies bounded resource policies and rejects host-overcommit requests', async () => {
    const broker = new FakeResourceBroker();
    const { app } = await fixture(2, undefined, (root) => new AttachmentStore(root), broker);
    const session = await login(app);
    await new Promise((resolve) => setImmediate(resolve));

    const initial = await app.inject({
      method: 'GET',
      url: '/api/system/resource-limits',
      headers: { cookie: session.cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(
      initial.json<{ data: { desired: { mode: string }; state: string } }>().data,
    ).toMatchObject({
      desired: { mode: 'auto' },
      state: 'applied',
    });

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/system/resource-limits',
      headers: session.headers,
      payload: {
        expectedVersion: 0,
        desired: {
          mode: 'custom',
          cpuCores: 4,
          memoryBytes: 8 * 1_024 * 1_024 * 1_024,
          tasks: 1_024,
          maxParallelAgents: 3,
        },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(broker.applyRequests.at(-1)).toEqual({
      mode: 'custom',
      cpuQuotaPercent: 400,
      memoryMaxBytes: 8 * 1_024 * 1_024 * 1_024,
      tasksMax: 1_024,
    });

    const excessive = await app.inject({
      method: 'PUT',
      url: '/api/system/resource-limits',
      headers: session.headers,
      payload: {
        expectedVersion: 1,
        desired: {
          mode: 'custom',
          cpuCores: 9,
          memoryBytes: 8 * 1_024 * 1_024 * 1_024,
          tasks: 1_024,
          maxParallelAgents: null,
        },
      },
    });
    expect(excessive.statusCode).toBe(409);
    expect(excessive.json<{ error: { code: string } }>().error.code).toBe(
      'RESOURCE_LIMIT_EXCEEDS_CAPACITY',
    );

    const unsafeConcurrency = await app.inject({
      method: 'PUT',
      url: '/api/system/resource-limits',
      headers: session.headers,
      payload: {
        expectedVersion: 1,
        desired: {
          mode: 'custom',
          cpuCores: 4,
          memoryBytes: 4 * 1_024 * 1_024 * 1_024,
          tasks: 1_024,
          maxParallelAgents: 4,
        },
      },
    });
    expect(unsafeConcurrency.statusCode).toBe(409);
    expect(unsafeConcurrency.json<{ error: { code: string } }>().error.code).toBe(
      'RESOURCE_AGENT_LIMIT_EXCEEDS_CAPACITY',
    );
  });

  it('persists and returns sanitized subagent lifecycle projections', async () => {
    const { app, appServer, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    appServer.emit({
      method: 'item/started',
      params: {
        threadId,
        turnId: 'turn-1',
        startedAtMs: Date.now(),
        item: {
          type: 'collabAgentToolCall',
          id: 'collab-1',
          tool: 'spawnAgent',
          status: 'inProgress',
          senderThreadId: threadId,
          receiverThreadIds: ['agent-1'],
          agentsStates: { 'agent-1': { status: 'running', message: 'Bearer secret-token-value' } },
          model: 'gpt-6-sol',
          reasoningEffort: 'medium',
          prompt: 'must never be persisted',
        },
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/subagents`,
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { id: string; status: string; message: string }[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: 'agent-1', status: 'running' });
    expect(body.data[0]!.message).toContain('[REDACTED]');
    expect(response.body).not.toContain('must never be persisted');
  });

  it('serializes concurrent resource updates and applies the newest stored version', async () => {
    const broker = new FakeResourceBroker();
    const { app, repository } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      broker,
    );
    const session = await login(app);
    await new Promise((resolve) => setImmediate(resolve));
    const gate = broker.blockApplies();
    const first = app.inject({
      method: 'PUT',
      url: '/api/system/resource-limits',
      headers: session.headers,
      payload: {
        expectedVersion: 0,
        desired: {
          mode: 'custom',
          cpuCores: 4,
          memoryBytes: 8 * 1_024 * 1_024 * 1_024,
          tasks: 1_024,
          maxParallelAgents: 3,
        },
      },
    });
    await gate.entered;
    const second = app.inject({
      method: 'PUT',
      url: '/api/system/resource-limits',
      headers: session.headers,
      payload: {
        expectedVersion: 1,
        desired: {
          mode: 'custom',
          cpuCores: 2,
          memoryBytes: 4 * 1_024 * 1_024 * 1_024,
          tasks: 512,
          maxParallelAgents: 2,
        },
      },
    });
    for (let attempt = 0; attempt < 20 && repository.getResourceLimits().version < 2; attempt += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(repository.getResourceLimits().version).toBe(2);
    gate.release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(repository.getResourceLimits()).toMatchObject({
      version: 2,
      state: 'applied',
      desired: { cpuCores: 2, memoryBytes: 4 * 1_024 * 1_024 * 1_024 },
    });
    expect(broker.applyRequests.at(-1)).toMatchObject({
      cpuQuotaPercent: 200,
      memoryMaxBytes: 4 * 1_024 * 1_024 * 1_024,
      tasksMax: 512,
    });
  });

  it('defers policy changes during work and passes the effective agent ceiling to Codex', async () => {
    const broker = new FakeResourceBroker();
    const { app, appServer, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      broker,
    );
    const session = await login(app);
    await new Promise((resolve) => setImmediate(resolve));
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const turn = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/turns`,
      headers: session.headers,
      payload: {
        text: 'run safely',
        idempotencyKey: '00000000-0000-4000-8000-000000000123',
      },
    });
    expect(turn.statusCode).toBe(202);
    const startedThread = appServer.requests.find((request) => request.method === 'thread/start');
    expect(startedThread?.params).toMatchObject({ config: { agents: { max_threads: 6 } } });
    expect(appServer.requests.filter((request) => request.method === 'thread/resume')).toHaveLength(
      0,
    );

    const applyCount = broker.applyRequests.length;
    const deferred = await app.inject({
      method: 'PUT',
      url: '/api/system/resource-limits',
      headers: session.headers,
      payload: {
        expectedVersion: 0,
        desired: {
          mode: 'custom',
          cpuCores: 4,
          memoryBytes: 8 * 1_024 * 1_024 * 1_024,
          tasks: 1_024,
          maxParallelAgents: 2,
        },
      },
    });
    expect(deferred.statusCode).toBe(202);
    expect(deferred.json<{ data: { state: string } }>().data.state).toBe('pending-idle');
    expect(broker.applyRequests).toHaveLength(applyCount);

    const turnId = turn.json<{ data: { turnId: string } }>().data.turnId;
    appServer.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed', items: [] } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(broker.applyRequests).toHaveLength(applyCount + 1);
    const current = await app.inject({
      method: 'GET',
      url: '/api/system/resource-limits',
      headers: { cookie: session.cookie },
    });
    expect(current.json<{ data: { state: string } }>().data.state).toBe('applied');
  });

  it('protects per-thread push subscription status, upsert and removal with auth and CSRF', async () => {
    const sender = new FakePushSender();
    const { app, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      sender,
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const firstThread = await createThread(app, project.id, session.headers);
    const secondThread = await createThread(app, project.id, session.headers);
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/device-one',
      expirationTime: null,
      keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
    };

    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/api/threads/${firstThread}/push-subscriptions/status`,
      headers: { origin: 'https://codex.test' },
      payload: { endpoint: subscription.endpoint },
    });
    expect(unauthenticated.statusCode).toBe(401);
    const missingCsrf = await app.inject({
      method: 'PUT',
      url: `/api/threads/${firstThread}/push-subscriptions`,
      headers: { origin: 'https://codex.test', cookie: session.cookie },
      payload: subscription,
    });
    expect(missingCsrf.statusCode).toBe(403);

    for (const endpoint of [
      'https://127.0.0.1/push',
      'https://[::1]/push',
      'https://localhost/push',
      'https://example.com/push',
    ]) {
      const rejected = await app.inject({
        method: 'PUT',
        url: `/api/threads/${firstThread}/push-subscriptions`,
        headers: session.headers,
        payload: { ...subscription, endpoint },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({ error: { code: 'PUSH_ENDPOINT_NOT_ALLOWED' } });
      expect(rejected.body).not.toContain(endpoint);
    }

    const subscribed = await app.inject({
      method: 'PUT',
      url: `/api/threads/${firstThread}/push-subscriptions`,
      headers: session.headers,
      payload: subscription,
    });
    expect(subscribed.statusCode).toBe(200);
    expect(subscribed.json()).toEqual({ subscribed: true });
    const firstStatus = await app.inject({
      method: 'POST',
      url: `/api/threads/${firstThread}/push-subscriptions/status`,
      headers: session.headers,
      payload: { endpoint: subscription.endpoint },
    });
    expect(firstStatus.json()).toEqual({ subscribed: true });
    const isolatedStatus = await app.inject({
      method: 'POST',
      url: `/api/threads/${secondThread}/push-subscriptions/status`,
      headers: session.headers,
      payload: { endpoint: subscription.endpoint },
    });
    expect(isolatedStatus.json()).toEqual({ subscribed: false });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${firstThread}/push-subscriptions`,
      headers: session.headers,
      payload: { endpoint: subscription.endpoint },
    });
    expect(removed.json()).toEqual({ subscribed: false });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/threads/${firstThread}/push-subscriptions/status`,
          headers: session.headers,
          payload: { endpoint: subscription.endpoint },
        })
      ).json(),
    ).toEqual({ subscribed: false });

    for (let index = 0; index < 16; index += 1) {
      const withinLimit = await app.inject({
        method: 'PUT',
        url: `/api/threads/${firstThread}/push-subscriptions`,
        headers: session.headers,
        payload: { ...subscription, endpoint: `https://fcm.googleapis.com/cap-${index}` },
      });
      expect(withinLimit.statusCode).toBe(200);
    }
    const limitedEndpoint = 'https://fcm.googleapis.com/cap-overflow';
    const limited = await app.inject({
      method: 'PUT',
      url: `/api/threads/${firstThread}/push-subscriptions`,
      headers: session.headers,
      payload: { ...subscription, endpoint: limitedEndpoint },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: { code: 'PUSH_SUBSCRIPTION_LIMIT_REACHED' },
    });
    expect(limited.body).not.toContain(limitedEndpoint);

    const capabilities = await app.inject({
      method: 'GET',
      url: '/api/system/capabilities',
      headers: { cookie: session.cookie },
    });
    expect(capabilities.json()).toMatchObject({
      notifications: { available: true, vapidPublicKey: 'A'.repeat(64) },
    });
  });

  it('fails closed when Web Push is unconfigured without affecting chat endpoints', async () => {
    const { app, projectPath } = await fixture();
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/push-subscriptions/status`,
      headers: session.headers,
      payload: { endpoint: 'https://fcm.googleapis.com/unavailable' },
    });
    expect(response.statusCode).toBe(503);
    const capabilities = await app.inject({
      method: 'GET',
      url: '/api/system/capabilities',
      headers: { cookie: session.cookie },
    });
    expect(capabilities.json()).toMatchObject({
      notifications: { available: false, vapidPublicKey: null },
    });
  });

  it('deduplicates safe terminal push delivery, retries transient errors and removes stale devices', async () => {
    const sender = new FakePushSender();
    sender.failures.push(new Error('temporary push failure'));
    const { app, appServer, repository, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      sender,
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const threadId = await createThread(app, project.id, session.headers);
    repository.updateThreadRuntime(threadId, { name: 'Build chat' });
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/retry-device',
      expirationTime: null,
      keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
    };
    await app.inject({
      method: 'PUT',
      url: `/api/threads/${threadId}/push-subscriptions`,
      headers: session.headers,
      payload: subscription,
    });

    const completed = {
      method: 'turn/completed' as const,
      params: { threadId, turn: { id: 'turn-push-one', status: 'completed', items: [] } },
    };
    appServer.emit(completed);
    appServer.emit(completed);
    await vi.waitFor(() => expect(sender.deliveries).toHaveLength(1), { timeout: 3_000 });
    expect(sender.calls).toHaveLength(2);
    expect(sender.deliveries[0]?.payload).toEqual({
      threadId,
      status: 'completed',
    });
    expect(Object.keys(sender.deliveries[0]!.payload).sort()).toEqual(['status', 'threadId']);

    appServer.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-push-interrupted', status: 'interrupted', items: [] } },
    });
    await vi.waitFor(() => expect(sender.deliveries).toHaveLength(2));
    expect(sender.deliveries[1]?.payload.status).toBe('interrupted');

    sender.failures.push(Object.assign(new Error('stale subscription'), { statusCode: 410 }));
    appServer.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: 'turn-push-stale', status: 'completed', items: [] } },
    });
    await vi.waitFor(
      () => expect(repository.hasPushSubscription(threadId, subscription.endpoint)).toBe(false),
      { timeout: 2_000 },
    );
  });

  it('aborts only the exact active thread delivery when that mapping is removed', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let aborted = false;
    const sender: PushSender = {
      send(_subscription, _payload, signal) {
        entered();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('unsubscribed'));
            },
            { once: true },
          );
        });
      },
    };
    const { app, appServer, repository, projectPath } = await fixture(
      2,
      undefined,
      (root) => new AttachmentStore(root),
      undefined,
      undefined,
      sender,
    );
    const session = await login(app);
    const project = await createProject(app, projectPath, session.headers);
    const firstThread = await createThread(app, project.id, session.headers);
    const secondThread = await createThread(app, project.id, session.headers);
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/active-unsubscribe',
      expirationTime: null,
      keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
    };
    for (const threadId of [firstThread, secondThread]) {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/threads/${threadId}/push-subscriptions`,
        headers: session.headers,
        payload: subscription,
      });
      expect(response.statusCode).toBe(200);
    }
    appServer.emit({
      method: 'turn/completed',
      params: { threadId: firstThread, turn: { id: 'turn-active-send', status: 'completed' } },
    });
    await started;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${firstThread}/push-subscriptions`,
      headers: session.headers,
      payload: { endpoint: subscription.endpoint },
    });
    expect(removed.statusCode).toBe(200);
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(repository.hasPushSubscription(firstThread, subscription.endpoint)).toBe(false);
    expect(repository.hasPushSubscription(secondThread, subscription.endpoint)).toBe(true);
    expect(
      repository.database.prepare('SELECT COUNT(*) AS count FROM push_deliveries').get(),
    ).toEqual({ count: 0 });
  });
});

describe('event normalization', () => {
  it('waits for SSE drain and bounds post-high-water live buffering', async () => {
    class FakeSseWritable extends EventEmitter {
      readonly chunks: string[] = [];
      blocked = true;
      destroyed = false;

      write(chunk: string): boolean {
        this.chunks.push(chunk);
        return !this.blocked;
      }

      destroy(): this {
        this.destroyed = true;
        this.emit('close');
        return this;
      }
    }

    const event = (id: number): SafeEvent => ({
      id,
      threadId: 'thread',
      turnId: null,
      kind: 'warning',
      phase: 'state',
      payload: { id },
      createdAt: '2026-09-27T00:00:00.000Z',
    });

    const raw = new FakeSseWritable();
    const delivery = createSseDelivery(raw, 10, 2);
    let replaySettled = false;
    const replay = delivery.writeReplay(event(10)).then((result) => {
      replaySettled = true;
      return result;
    });
    await Promise.resolve();
    expect(replaySettled).toBe(false);
    raw.blocked = false;
    raw.emit('drain');
    await expect(replay).resolves.toBe(true);

    delivery.deliverLive(event(11));
    delivery.deliverLive(event(12));
    delivery.deliverLive(event(13));
    expect(delivery.closed).toBe(true);
    expect(raw.destroyed).toBe(true);

    const flushingRaw = new FakeSseWritable();
    flushingRaw.blocked = false;
    const flushing = createSseDelivery(flushingRaw, 20, 2);
    flushing.deliverLive(event(20));
    flushing.deliverLive(event(21));
    await flushing.finishReplay();
    expect(flushingRaw.chunks).toHaveLength(1);
    expect(flushingRaw.chunks[0]).toContain('id: 21\n');
  });

  it('drops hidden reasoning and redacts bounded command output', () => {
    expect(
      normalizeNotification(
        {
          method: 'item/reasoning/textDelta',
          params: { threadId: 't', turnId: 'u', delta: 'private' },
        },
        2_048,
      ),
    ).toBeNull();
    const event = normalizeNotification(
      {
        method: 'item/commandExecution/outputDelta',
        params: { threadId: 't', turnId: 'u', delta: `Bearer abc.def.ghi ${'x'.repeat(5_000)}` },
      },
      1_024,
    );
    expect(JSON.stringify(event)).not.toContain('abc.def.ghi');
    expect(Buffer.byteLength(JSON.stringify(event?.payload))).toBeLessThan(1_300);

    const completed = normalizeNotification(
      {
        method: 'item/completed',
        params: {
          threadId: 't',
          turnId: 'u',
          item: {
            id: 'command-1',
            type: 'commandExecution',
            command: 'curl -H "Authorization: Bearer abc.def.ghi" https://example.test',
            aggregatedOutput: 'password=output-secret',
            status: 'completed',
          },
        },
      },
      4_096,
    );
    expect(completed?.payload).toMatchObject({
      item: {
        type: 'commandExecution',
        command: 'curl -H "Authorization[REDACTED] [REDACTED]" https://example.test',
        aggregatedOutput: 'password[REDACTED]',
      },
    });
    expect(JSON.stringify(completed)).not.toContain('abc.def.ghi');
    expect(JSON.stringify(completed)).not.toContain('output-secret');
  });

  it('enforces the serialized byte ceiling and removes hostile secret-bearing fields', () => {
    const payload = sanitizeEventPayload(
      {
        safe: 'visible',
        env: { CODEX_WEB_SESSION_SECRET: 'do-not-store' },
        environment: { API_KEY: 'also-secret' },
        apiKey: 'key-secret',
        privateKey: '-----BEGIN PRIVATE KEY----- hidden -----END PRIVATE KEY-----',
        nested: {
          password: 'password-secret',
          output: `api_key=abcd1234 ${'x'.repeat(5_000)}`,
        },
        oversizedArray: Array.from({ length: 300 }, (_, index) => `value-${index}`),
      },
      256,
    );
    const serialized = JSON.stringify(payload);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(256);
    expect(serialized).not.toContain('do-not-store');
    expect(serialized).not.toContain('also-secret');
    expect(serialized).not.toContain('key-secret');
    expect(serialized).not.toContain('password-secret');
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
  });
});
