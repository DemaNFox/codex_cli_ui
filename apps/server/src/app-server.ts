import { EventEmitter } from 'node:events';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
}

const ALLOWED_REQUESTS = new Set([
  'account/read',
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

export interface SupervisorOptions {
  readonly executable: string;
  readonly codexHome?: string;
  readonly expectedVersion: string;
  readonly requestTimeoutMs?: number;
}

export class CodexAppServerSupervisor implements AppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly events = new EventEmitter();
  private stopping = false;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private currentGeneration = 0;

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
    this.rejectAll(new Error('APP_SERVER_STOPPED'));
    const child = this.child;
    this.child = null;
    this.initialized = false;
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

  async request(method: string, params: unknown): Promise<unknown> {
    if (!ALLOWED_REQUESTS.has(method)) throw new Error('APP_SERVER_METHOD_NOT_ALLOWED');
    if (!this.ready) throw new Error('APP_SERVER_UNAVAILABLE');
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
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.consumeLine(line));
    // Drain stderr without persisting it: app-server diagnostics may contain private paths.
    child.stderr.on('data', () => undefined);
    child.once('exit', () => {
      lines.close();
      if (this.child === child) this.child = null;
      this.initialized = false;
      this.rejectAll(new Error('APP_SERVER_EXITED'));
      if (!this.stopping) this.scheduleRestart();
    });
    child.once('error', () => {
      if (this.child === child) this.child = null;
    });

    await this.sendRequest('initialize', INITIALIZE_PARAMS);
    this.write(INITIALIZED_NOTIFICATION);
    this.initialized = true;
    this.currentGeneration += 1;
    this.restartAttempt = 0;
  }

  private scheduleRestart(): void {
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
        reject(new Error('APP_SERVER_REQUEST_TIMEOUT'));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('APP_SERVER_WRITE_FAILED'));
      }
    });
  }

  private write(value: unknown): void {
    if (!this.child?.stdin.writable) throw new Error('APP_SERVER_UNAVAILABLE');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private consumeLine(line: string): void {
    if (Buffer.byteLength(line) > 1_048_576) {
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
      pending.reject(new Error('APP_SERVER_REQUEST_FAILED'));
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
