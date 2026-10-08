import { EventEmitter } from 'node:events';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_RPC_LINE_BYTES = 32 * 1_024 * 1_024;

const CODEX_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'TEMP',
  'TMP',
]);

export function buildCodexEnvironment(
  source: NodeJS.ProcessEnv,
  codexHome?: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && CODEX_ENV_ALLOWLIST.has(key.toUpperCase())) environment[key] = value;
  }
  if (codexHome !== undefined) environment.CODEX_HOME = codexHome;
  return environment;
}

export const INITIALIZED_NOTIFICATION = Object.freeze({ method: 'initialized', params: {} });
export const INITIALIZE_PARAMS = Object.freeze({
  clientInfo: { name: 'codex-web-ui', title: 'Codex Web UI', version: '0.1.0' },
  capabilities: { experimentalApi: true },
});

export type RpcId = string | number;

export interface AppServerInbound {
  readonly method: string;
  readonly params: unknown;
  readonly id?: RpcId;
}

export interface AppServerClient {
  readonly ready: boolean;
  readonly generation: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
  respond(id: RpcId, result: unknown): void;
  respondError(id: RpcId, code: number, message: string): void;
  subscribe(listener: (message: AppServerInbound) => void): () => void;
  subscribeLifecycle(listener: (event: AppServerLifecycleEvent) => void): () => void;
}

export interface AppServerLifecycleEvent {
  readonly type: 'disconnected';
  readonly generation: number;
}

function emitLifecycle(emitter: EventEmitter, event: AppServerLifecycleEvent): void {
  for (const listener of emitter.listeners('event')) {
    try {
      (listener as (value: AppServerLifecycleEvent) => void)(event);
    } catch {
      // A consumer cannot prevent transport recovery after an unexpected disconnect.
    }
  }
}

const ALLOWED_REQUESTS = new Set([
  'account/login/cancel',
  'account/login/start',
  'account/read',
  'account/rateLimits/read',
  'account/rateLimitResetCredit/consume',
  'account/usage/read',
  'model/list',
  'skills/list',
  'thread/start',
  'thread/resume',
  'thread/read',
  'thread/list',
  'thread/name/set',
  'thread/archive',
  'thread/unarchive',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
]);

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface JsonRpcResponse {
  readonly id: RpcId;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

export type AppServerRequestFailureKind = 'notSent' | 'rejected' | 'ambiguous';

export class AppServerRequestError extends Error {
  constructor(
    readonly failureKind: AppServerRequestFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'AppServerRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseInbound(value: unknown): AppServerInbound | JsonRpcResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.method === 'string' && 'params' in value) {
    const id = value.id;
    if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') return null;
    return { method: value.method, params: value.params, ...(id === undefined ? {} : { id }) };
  }
  if (
    (typeof value.id === 'string' || typeof value.id === 'number') &&
    ('result' in value || 'error' in value)
  ) {
    return value as unknown as JsonRpcResponse;
  }
  return null;
}

function attachBoundedLineReader(
  stream: Readable,
  consume: (line: string) => void,
  reject: () => void,
  maxLineBytes: number,
): () => void {
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let rejected = false;
  const rejectOnce = () => {
    if (rejected) return;
    rejected = true;
    reject();
  };
  const onData = (chunk: Buffer | string) => {
    if (rejected) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffered = buffered.length === 0 ? bytes : Buffer.concat([buffered, bytes]);
    while (true) {
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) break;
      const hasCarriageReturn = newline > 0 && buffered[newline - 1] === 0x0d;
      if (newline - (hasCarriageReturn ? 1 : 0) > maxLineBytes) {
        rejectOnce();
        return;
      }
      let line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      consume(line.toString('utf8'));
      if (rejected) return;
    }
    if (buffered.length > maxLineBytes) rejectOnce();
  };
  stream.on('data', onData);
  return () => stream.off('data', onData);
}

export interface SupervisorOptions {
  readonly executable: string;
  readonly codexHome?: string;
  readonly expectedVersion: string;
  readonly requestTimeoutMs?: number;
  readonly maxLineBytes?: number;
}

export class CodexAppServerSupervisor implements AppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly events = new EventEmitter();
  private readonly lifecycleEvents = new EventEmitter();
  private stopping = false;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private currentGeneration = 0;
  private detachLineReader: (() => void) | null = null;

  constructor(private readonly options: SupervisorOptions) {}

  get ready(): boolean {
    return this.child !== null && this.initialized;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  async start(): Promise<void> {
    this.stopping = false;
    const { stdout } = await execFileAsync(this.options.executable, ['--version'], {
      env: this.environment(),
      timeout: 10_000,
      maxBuffer: 4_096,
    });
    if (stdout.trim() !== this.options.expectedVersion) {
      throw new Error(`CODEX_VERSION_MISMATCH: expected ${this.options.expectedVersion}`);
    }
    await this.spawnAndInitialize();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.rejectAll(new AppServerRequestError('ambiguous', 'APP_SERVER_STOPPED'));
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.detachLineReader?.();
    this.detachLineReader = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  subscribe(listener: (message: AppServerInbound) => void): () => void {
    this.events.on('message', listener);
    return () => this.events.off('message', listener);
  }

  subscribeLifecycle(listener: (event: AppServerLifecycleEvent) => void): () => void {
    this.lifecycleEvents.on('event', listener);
    return () => this.lifecycleEvents.off('event', listener);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!ALLOWED_REQUESTS.has(method)) throw new Error('APP_SERVER_METHOD_NOT_ALLOWED');
    if (!this.ready) throw new AppServerRequestError('notSent', 'APP_SERVER_UNAVAILABLE');
    return this.sendRequest(method, params);
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private environment(): NodeJS.ProcessEnv {
    return buildCodexEnvironment(process.env, this.options.codexHome);
  }

  private async spawnAndInitialize(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.options.executable, ['app-server', '--listen', 'stdio://'], {
      env: this.environment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.initialized = false;
    this.detachLineReader = attachBoundedLineReader(
      child.stdout,
      (line) => this.consumeLine(line),
      () => child.kill('SIGKILL'),
      this.options.maxLineBytes ?? DEFAULT_MAX_RPC_LINE_BYTES,
    );
    // Drain stderr without persisting it: app-server diagnostics may contain private paths.
    child.stderr.on('data', () => undefined);
    let finalized = false;
    const finalizeUnexpectedDisconnect = () => {
      if (finalized) return;
      finalized = true;
      const wasInitialized = this.initialized;
      this.detachLineReader?.();
      this.detachLineReader = null;
      if (this.child === child) this.child = null;
      this.initialized = false;
      this.rejectAll(new AppServerRequestError('ambiguous', 'APP_SERVER_EXITED'));
      if (!this.stopping) {
        this.scheduleRestart();
        if (wasInitialized)
          emitLifecycle(this.lifecycleEvents, {
            type: 'disconnected',
            generation: this.currentGeneration,
          } satisfies AppServerLifecycleEvent);
      }
    };
    child.once('exit', finalizeUnexpectedDisconnect);
    child.once('error', finalizeUnexpectedDisconnect);

    await this.sendRequest('initialize', INITIALIZE_PARAMS);
    this.write(INITIALIZED_NOTIFICATION);
    this.initialized = true;
    this.currentGeneration += 1;
    this.restartAttempt = 0;
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.restartAttempt++, 6));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.spawnAndInitialize().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref();
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerRequestError('ambiguous', 'APP_SERVER_REQUEST_TIMEOUT'));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(
          new AppServerRequestError(
            'notSent',
            error instanceof Error ? error.message : 'APP_SERVER_WRITE_FAILED',
          ),
        );
      }
    });
  }

  private write(value: unknown): void {
    if (!this.child?.stdin.writable) throw new Error('APP_SERVER_UNAVAILABLE');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private consumeLine(line: string): void {
    if (Buffer.byteLength(line) > (this.options.maxLineBytes ?? DEFAULT_MAX_RPC_LINE_BYTES)) {
      this.child?.kill('SIGKILL');
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch {
      this.child?.kill('SIGKILL');
      return;
    }
    const message = parseInbound(decoded);
    if (!message) return;
    if ('method' in message) {
      this.events.emit('message', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new AppServerRequestError('rejected', 'APP_SERVER_REQUEST_FAILED'));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export interface SocketClientOptions {
  readonly socketPath: string;
  readonly requestTimeoutMs?: number;
  readonly maxLineBytes?: number;
}

export class CodexAppServerSocketClient implements AppServerClient {
  private socket: Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly events = new EventEmitter();
  private readonly lifecycleEvents = new EventEmitter();
  private stopping = false;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private currentGeneration = 0;
  private detachLineReader: (() => void) | null = null;

  constructor(private readonly options: SocketClientOptions) {}

  get ready(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.initialized;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  async start(): Promise<void> {
    this.stopping = false;
    try {
      await this.connectAndInitialize();
    } catch (error) {
      this.scheduleRestart();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.rejectAll(new AppServerRequestError('ambiguous', 'APP_SERVER_STOPPED'));
    const socket = this.socket;
    this.socket = null;
    this.initialized = false;
    this.detachLineReader?.();
    this.detachLineReader = null;
    if (!socket || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => socket.destroy(), 3_000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.end();
    });
  }

  subscribe(listener: (message: AppServerInbound) => void): () => void {
    this.events.on('message', listener);
    return () => this.events.off('message', listener);
  }

  subscribeLifecycle(listener: (event: AppServerLifecycleEvent) => void): () => void {
    this.lifecycleEvents.on('event', listener);
    return () => this.lifecycleEvents.off('event', listener);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!ALLOWED_REQUESTS.has(method)) throw new Error('APP_SERVER_METHOD_NOT_ALLOWED');
    if (!this.ready) throw new AppServerRequestError('notSent', 'APP_SERVER_UNAVAILABLE');
    return this.sendRequest(method, params);
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private async connectAndInitialize(): Promise<void> {
    if (this.socket) return;
    const socket = createConnection(this.options.socketPath);
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        socket.off('connect', onConnect);
        reject(error);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
    socket.on('error', () => undefined);
    this.socket = socket;
    this.initialized = false;
    this.detachLineReader = attachBoundedLineReader(
      socket,
      (line) => this.consumeLine(line),
      () => socket.destroy(),
      this.options.maxLineBytes ?? DEFAULT_MAX_RPC_LINE_BYTES,
    );
    socket.once('close', () => {
      if (this.socket !== socket) return;
      const wasInitialized = this.initialized;
      this.detachLineReader?.();
      this.detachLineReader = null;
      this.socket = null;
      this.initialized = false;
      this.rejectAll(new AppServerRequestError('ambiguous', 'APP_SERVER_EXITED'));
      if (!this.stopping) {
        this.scheduleRestart();
        if (wasInitialized)
          emitLifecycle(this.lifecycleEvents, {
            type: 'disconnected',
            generation: this.currentGeneration,
          } satisfies AppServerLifecycleEvent);
      }
    });

    try {
      await this.sendRequest('initialize', INITIALIZE_PARAMS);
      this.write(INITIALIZED_NOTIFICATION);
      this.initialized = true;
      this.currentGeneration += 1;
      this.restartAttempt = 0;
    } catch (error) {
      if (this.socket === socket) this.socket = null;
      this.detachLineReader?.();
      this.detachLineReader = null;
      this.initialized = false;
      socket.destroy();
      this.rejectAll(new Error('APP_SERVER_INITIALIZE_FAILED'));
      throw error;
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.restartAttempt++, 6));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.connectAndInitialize().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref();
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerRequestError('ambiguous', 'APP_SERVER_REQUEST_TIMEOUT'));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(
          new AppServerRequestError(
            'notSent',
            error instanceof Error ? error.message : 'APP_SERVER_WRITE_FAILED',
          ),
        );
      }
    });
  }

  private write(value: unknown): void {
    if (!this.socket?.writable) throw new Error('APP_SERVER_UNAVAILABLE');
    this.socket.write(`${JSON.stringify(value)}\n`);
  }

  private consumeLine(line: string): void {
    if (Buffer.byteLength(line) > (this.options.maxLineBytes ?? DEFAULT_MAX_RPC_LINE_BYTES)) {
      this.socket?.destroy();
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch {
      this.socket?.destroy();
      return;
    }
    const message = parseInbound(decoded);
    if (!message) return;
    if ('method' in message) {
      this.events.emit('message', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new AppServerRequestError('rejected', 'APP_SERVER_REQUEST_FAILED'));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
