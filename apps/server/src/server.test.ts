import type { Attachment, SafeEvent } from '@codex-web/contracts';
import { hash } from 'argon2';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  INITIALIZED_NOTIFICATION,
  INITIALIZE_PARAMS,
  CodexAppServerSocketClient,
  CodexAppServerSupervisor,
  buildCodexEnvironment,
  type AppServerClient,
  type AppServerInbound,
  type RpcId,
} from './app-server.js';
import { AttachmentStore } from './attachment-store.js';
import { loadConfig, type ServerConfig } from './config.js';
import { SqliteRepository } from './database.js';
import { normalizeNotification, sanitizeEventPayload } from './event-normalizer.js';
import { normalizeThreadHistory } from './history-normalizer.js';
import { ProjectPathPolicy } from './path-policy.js';
import { buildServer } from './server.js';
import { createSseDelivery } from './sse.js';

/* eslint-disable @typescript-eslint/require-await -- fake protocol methods intentionally implement async production interfaces. */

class FakeAppServer implements AppServerClient {
  ready = false;
  generation = 0;
  readonly requests: { method: string; params: unknown }[] = [];
  readonly responses: { id: RpcId; result: unknown }[] = [];
  readonly responseErrors: { id: RpcId; code: number; message: string }[] = [];
  private readonly listeners = new Set<(message: AppServerInbound) => void>();
  private threadCounter = 0;
  private turnCounter = 0;
  private readonly threads = new Map<string, Record<string, unknown>>();
  private listPageSize = Number.POSITIVE_INFINITY;
  private turnStartGate: Promise<void> | null = null;
  private signalTurnStart: (() => void) | null = null;
  failNextRequestWith: Error | null = null;
  failTurnStartWith: Error | null = null;
  failNextResponseWith: Error | null = null;
  failAccountStatusReads = false;

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

  setThreadTurns(threadId: string, turns: unknown[]): void {
    const thread = this.threads.get(threadId);
    if (thread) thread.turns = turns;
  }

  setThreadListPageSize(size: number): void {
    this.listPageSize = size;
  }

  restart(): void {
    this.ready = true;
    this.generation += 1;
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
      const offset = values.cursor === null ? 0 : Number(values.cursor);
      const threads = [...this.threads.values()];
      const end = Math.min(threads.length, offset + this.listPageSize);
      return {
        data: threads.slice(offset, end),
        nextCursor: end < threads.length ? String(end) : null,
      };
    }
    if (method === 'thread/read' || method === 'thread/resume') {
      const thread = this.threads.get(String(values.threadId));
      return { thread, model: thread?.model ?? 'gpt-test', instructionSources: [] };
    }
    if (method === 'thread/name/set') {
      const thread = this.threads.get(String(values.threadId));
      if (thread) thread.name = values.name;
      return {};
    }
    if (method === 'thread/archive' || method === 'thread/unarchive' || method === 'turn/interrupt')
      return {};
    if (method === 'turn/start') {
      this.signalTurnStart?.();
      this.signalTurnStart = null;
      if (this.turnStartGate) await this.turnStartGate;
      this.turnStartGate = null;
      if (this.failTurnStartWith) {
        const error = this.failTurnStartWith;
        this.failTurnStartWith = null;
        throw error;
      }
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
    if (method === 'account/read') return { account: {}, requiresOpenaiAuth: true };
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

class FailingRemoveAttachmentStore extends AttachmentStore {
  failRemove = true;

  override async remove(projectId: string, threadId: string, storageName: string): Promise<void> {
    if (this.failRemove) throw new Error('simulated attachment remove failure');
    await super.remove(projectId, threadId, storageName);
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
) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-web-server-'));
  const root = path.join(temp, 'projects');
  const projectPath = path.join(root, 'demo');
  await mkdir(projectPath, { recursive: true });
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 3000,
    databasePath: ':memory:',
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
  };
  const repository = new SqliteRepository(':memory:', config.eventRetentionPerThread);
  seed?.({ repository, projectPath });
  const appServer = new FakeAppServer();
  const attachmentStore = attachmentStoreFactory(config.attachmentStoragePath);
  const app = await buildServer({
    config,
    repository,
    pathPolicy: await ProjectPathPolicy.create([root]),
    appServer,
    attachmentStore,
  });
  openApps.push(app);
  await app.ready();
  return { app, repository, appServer, attachmentStore, projectPath, root };
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

describe('security and repository boundary', () => {
  it('allowlists only the exact read-only account status methods', async () => {
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
    const client = new CodexAppServerSocketClient({ socketPath, requestTimeoutMs: 2_000 });
    try {
      await client.start();
      await expect.poll(() => client.generation, { timeout: 3_000 }).toBe(2);
      await expect(client.request('account/read', {})).resolves.toEqual({ ok: true });
      await expect(client.request('account/credentials/read', {})).rejects.toThrow(
        'APP_SERVER_METHOD_NOT_ALLOWED',
      );
      expect(connections).toBe(2);
      expect(receivedMethods.filter((method) => method === 'initialize')).toHaveLength(2);
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
    });
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
});

describe('Codex routes', () => {
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
        item: { type: 'agentMessage', text: `read ${privatePath}` },
      },
    });
    const agentEvent = repository
      .listEvents(threadId, 0)
      .find((event) => event.kind === 'agent-message')!;
    expect(agentEvent.phase).toBe('completed');
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
    const firstEvents = first.json<{ events: { id: number; kind: string }[] }>().events;
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
    expect(saturated.statusCode).toBe(429);
    appServer.emit({
      method: 'turn/completed',
      params: { threadId: thread.id, turn: { id: 'turn-1' } },
    });
    const afterCompletion = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/turns`,
      headers: session.headers,
      payload: { text: 'third', idempotencyKey: '33333333-3333-4333-8333-333333333333' },
    });
    expect(afterCompletion.statusCode).toBe(202);
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

  it('reuses a newly started thread writer and resumes it only after app-server restart', async () => {
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
    const { app, appServer, repository, projectPath, root } = await fixture();
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
