import type { CodexVersionDiscovery } from '@codex-web/contracts';
import { z } from 'zod';

const CODEX_LATEST_URL = 'https://registry.npmjs.org/@openai%2Fcodex/latest';
const MAX_RESPONSE_BYTES = 32_768;
const versionSchema = z.string().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/);
const metadataSchema = z.object({ version: versionSchema });

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

interface CachedVersion {
  readonly version: string | null;
  readonly checkedAt: string;
  readonly expiresAt: number;
}

export interface CodexVersionChecker {
  check(currentVersion: string, force?: boolean): Promise<CodexVersionDiscovery>;
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionSchema.parse(left).split('.').map(BigInt);
  const rightParts = versionSchema.parse(right).split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index]! < rightParts[index]!) return -1;
    if (leftParts[index]! > rightParts[index]!) return 1;
  }
  return 0;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_RESPONSE_BYTES)
      throw new Error('CODEX_VERSION_RESPONSE_TOO_LARGE');
  }
  if (!response.body) throw new Error('CODEX_VERSION_RESPONSE_EMPTY');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('CODEX_VERSION_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

export class NpmCodexVersionChecker implements CodexVersionChecker {
  private cached: CachedVersion | null = null;
  private inFlight: Promise<CachedVersion> | null = null;

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
    private readonly successTtlMs = 15 * 60_000,
    private readonly failureTtlMs = 60_000,
    private readonly timeoutMs = 5_000,
  ) {}

  async check(currentVersion: string, force = false): Promise<CodexVersionDiscovery> {
    const current = versionSchema.parse(currentVersion.replace(/^codex-cli /, ''));
    const cached = await this.resolve(force);
    if (cached.version === null) {
      return {
        state: 'failed',
        currentVersion: `codex-cli ${current}`,
        latestVersion: null,
        checkedAt: cached.checkedAt,
      };
    }
    return {
      state: compareVersions(current, cached.version) < 0 ? 'available' : 'current',
      currentVersion: `codex-cli ${current}`,
      latestVersion: `codex-cli ${cached.version}`,
      checkedAt: cached.checkedAt,
    };
  }

  startPeriodic(currentVersion: string, intervalMs = 6 * 60 * 60_000): () => void {
    void this.check(currentVersion, true);
    const timer = setInterval(() => void this.check(currentVersion, true), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async resolve(force: boolean): Promise<CachedVersion> {
    if (!force && this.cached && this.cached.expiresAt > this.now()) return this.cached;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchLatest().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchLatest(): Promise<CachedVersion> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const checkedAt = new Date(this.now()).toISOString();
    try {
      const response = await this.fetcher(CODEX_LATEST_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'codex-web-ui-update-check/1',
        },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('CODEX_VERSION_REGISTRY_ERROR');
      const metadata = metadataSchema.parse(await readBoundedJson(response));
      this.cached = {
        version: metadata.version,
        checkedAt,
        expiresAt: this.now() + this.successTtlMs,
      };
    } catch {
      this.cached = {
        version: null,
        checkedAt,
        expiresAt: this.now() + this.failureTtlMs,
      };
    } finally {
      clearTimeout(timeout);
    }
    return this.cached;
  }
}
