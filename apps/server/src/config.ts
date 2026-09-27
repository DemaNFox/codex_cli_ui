import { z } from 'zod';
import path from 'node:path';

const envSchema = z.object({
  CODEX_WEB_HOST: z.string().default('127.0.0.1'),
  CODEX_WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  CODEX_WEB_DATABASE_PATH: z.string().min(1).default('data/codex-web.sqlite3'),
  CODEX_WEB_ATTACHMENT_STORAGE_PATH: z.string().min(1).optional(),
  CODEX_WEB_ADMIN_USERNAME: z.string().min(1).max(80),
  CODEX_WEB_ADMIN_PASSWORD_HASH: z.string().startsWith('$argon2id$'),
  CODEX_WEB_SESSION_SECRET: z.string().min(32),
  CODEX_WEB_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(2_592_000).default(28_800),
  CODEX_WEB_PUBLIC_ORIGIN: z.string().url(),
  CODEX_WEB_PROJECT_ROOTS: z.string().min(1),
  CODEX_BIN: z.string().min(1).default('codex'),
  CODEX_HOME: z.string().min(1).optional(),
  CODEX_WEB_APP_SERVER_SOCKET: z.string().startsWith('/').optional(),
  CODEX_WEB_CODEX_VERSION_PIN: z.string().regex(/^codex-cli \d+\.\d+\.\d+$/),
  CODEX_WEB_COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  CODEX_WEB_EVENT_RETENTION_PER_THREAD: z.coerce.number().int().min(100).max(1_000).default(1_000),
  CODEX_WEB_MAX_EVENT_BYTES: z.coerce.number().int().min(1_024).max(32_768).default(32_768),
  CODEX_WEB_MAX_CONCURRENT_TURNS: z.coerce.number().int().min(1).max(5).default(2),
});

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly attachmentStoragePath: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly sessionSecret: string;
  readonly sessionTtlMs: number;
  readonly webOrigin: string;
  readonly projectRoots: readonly string[];
  readonly codexBinary: string;
  readonly codexHome?: string;
  readonly appServerSocket?: string;
  readonly codexVersionPin: string;
  readonly cookieSecure: boolean;
  readonly cookieName: string;
  readonly eventRetentionPerThread: number;
  readonly maxEventBytes: number;
  readonly maxConcurrentTurns: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.parse(env);
  if (parsed.CODEX_WEB_APP_SERVER_SOCKET !== undefined && parsed.CODEX_HOME !== undefined) {
    throw new Error('CODEX_HOME must not be provided to the API when socket isolation is enabled');
  }
  const roots = parsed.CODEX_WEB_PROJECT_ROOTS.split(',')
    .map((root) => root.trim())
    .filter(Boolean);
  if (roots.length === 0) throw new Error('PROJECT_ROOTS must contain at least one path');

  return {
    host: parsed.CODEX_WEB_HOST,
    port: parsed.CODEX_WEB_PORT,
    databasePath: parsed.CODEX_WEB_DATABASE_PATH,
    attachmentStoragePath:
      parsed.CODEX_WEB_ATTACHMENT_STORAGE_PATH ??
      path.join(path.dirname(parsed.CODEX_WEB_DATABASE_PATH), 'attachments'),
    username: parsed.CODEX_WEB_ADMIN_USERNAME,
    passwordHash: parsed.CODEX_WEB_ADMIN_PASSWORD_HASH,
    sessionSecret: parsed.CODEX_WEB_SESSION_SECRET,
    sessionTtlMs: parsed.CODEX_WEB_SESSION_TTL_SECONDS * 1_000,
    webOrigin: new URL(parsed.CODEX_WEB_PUBLIC_ORIGIN).origin,
    projectRoots: roots,
    codexBinary: parsed.CODEX_BIN,
    ...(parsed.CODEX_HOME === undefined ? {} : { codexHome: parsed.CODEX_HOME }),
    ...(parsed.CODEX_WEB_APP_SERVER_SOCKET === undefined
      ? {}
      : { appServerSocket: parsed.CODEX_WEB_APP_SERVER_SOCKET }),
    codexVersionPin: parsed.CODEX_WEB_CODEX_VERSION_PIN,
    cookieSecure: parsed.CODEX_WEB_COOKIE_SECURE === 'true',
    cookieName: '__Host-codex_web_session',
    eventRetentionPerThread: parsed.CODEX_WEB_EVENT_RETENTION_PER_THREAD,
    maxEventBytes: parsed.CODEX_WEB_MAX_EVENT_BYTES,
    maxConcurrentTurns: parsed.CODEX_WEB_MAX_CONCURRENT_TURNS,
  };
}
