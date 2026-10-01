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
  CODEX_WEB_PROJECT_PATH_BROKER_SOCKET: z.string().startsWith('/').optional(),
  CODEX_WEB_RESOURCE_BROKER_SOCKET: z
    .string()
    .startsWith('/')
    .default('/run/codex-web-ui/resource-broker.sock'),
  CODEX_WEB_CODEX_UPDATE_BROKER_SOCKET: z
    .string()
    .startsWith('/')
    .default('/run/codex-web-ui/codex-update-broker.sock'),
  CODEX_WEB_CODEX_VERSION_PIN: z.string().regex(/^codex-cli \d+\.\d+\.\d+$/),
  CODEX_WEB_COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  CODEX_WEB_EVENT_RETENTION_PER_THREAD: z.coerce.number().int().min(100).max(1_000).default(1_000),
  CODEX_WEB_MAX_EVENT_BYTES: z.coerce.number().int().min(1_024).max(32_768).default(32_768),
  CODEX_WEB_MAX_CONCURRENT_TURNS: z.coerce.number().int().min(1).max(5).default(2),
  CODEX_WEB_TRANSCRIPTION_MODEL_CACHE_PATH: z
    .string()
    .startsWith('/')
    .default('/opt/codex-web-ui/current/models'),
  CODEX_WEB_TRANSCRIPTION_MODEL: z.preprocess(
    (value) => (value === 'gpt-transcribe' ? undefined : value),
    z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/)
      .refine((value) => !value.includes('..') && !value.startsWith('/') && !value.endsWith('/'))
      .default('onnx-community/whisper-base'),
  ),
  CODEX_WEB_TRANSCRIPTION_MODEL_REVISION: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .default('1846881b6b3a3024392c1eea3ad983695bc23925'),
  CODEX_WEB_TRANSCRIPTION_LANGUAGE: z
    .string()
    .regex(/^[a-z][a-z-]{1,31}$/)
    .default('russian'),
  CODEX_WEB_VAPID_PUBLIC_KEY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .min(32)
      .max(512)
      .optional(),
  ),
  CODEX_WEB_VAPID_PRIVATE_KEY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .min(32)
      .max(512)
      .optional(),
  ),
  CODEX_WEB_VAPID_SUBJECT: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .max(512)
      .refine((value) => value.startsWith('mailto:') || value.startsWith('https://'))
      .optional(),
  ),
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
  readonly projectPathBrokerSocket?: string;
  readonly resourceBrokerSocket: string;
  readonly codexUpdateBrokerSocket: string;
  readonly codexVersionPin: string;
  readonly cookieSecure: boolean;
  readonly cookieName: string;
  readonly eventRetentionPerThread: number;
  readonly maxEventBytes: number;
  readonly maxConcurrentTurns: number;
  readonly transcriptionModelCachePath: string;
  readonly transcriptionModel: string;
  readonly transcriptionModelRevision: string;
  readonly transcriptionLanguage: string;
  readonly vapid?: {
    readonly publicKey: string;
    readonly privateKey: string;
    readonly subject: string;
  };
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
  const vapidValues = [
    parsed.CODEX_WEB_VAPID_PUBLIC_KEY,
    parsed.CODEX_WEB_VAPID_PRIVATE_KEY,
    parsed.CODEX_WEB_VAPID_SUBJECT,
  ];
  if (
    vapidValues.some((value) => value !== undefined) &&
    vapidValues.some((value) => value === undefined)
  )
    throw new Error(
      'VAPID configuration must provide public key, private key and subject together',
    );

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
    ...(parsed.CODEX_WEB_PROJECT_PATH_BROKER_SOCKET === undefined
      ? {}
      : { projectPathBrokerSocket: parsed.CODEX_WEB_PROJECT_PATH_BROKER_SOCKET }),
    resourceBrokerSocket: parsed.CODEX_WEB_RESOURCE_BROKER_SOCKET,
    codexUpdateBrokerSocket: parsed.CODEX_WEB_CODEX_UPDATE_BROKER_SOCKET,
    codexVersionPin: parsed.CODEX_WEB_CODEX_VERSION_PIN,
    cookieSecure: parsed.CODEX_WEB_COOKIE_SECURE === 'true',
    cookieName: '__Host-codex_web_session',
    eventRetentionPerThread: parsed.CODEX_WEB_EVENT_RETENTION_PER_THREAD,
    maxEventBytes: parsed.CODEX_WEB_MAX_EVENT_BYTES,
    maxConcurrentTurns: parsed.CODEX_WEB_MAX_CONCURRENT_TURNS,
    transcriptionModelCachePath: parsed.CODEX_WEB_TRANSCRIPTION_MODEL_CACHE_PATH,
    transcriptionModel: parsed.CODEX_WEB_TRANSCRIPTION_MODEL,
    transcriptionModelRevision: parsed.CODEX_WEB_TRANSCRIPTION_MODEL_REVISION,
    transcriptionLanguage: parsed.CODEX_WEB_TRANSCRIPTION_LANGUAGE,
    ...(parsed.CODEX_WEB_VAPID_PUBLIC_KEY === undefined
      ? {}
      : {
          vapid: {
            publicKey: parsed.CODEX_WEB_VAPID_PUBLIC_KEY,
            privateKey: parsed.CODEX_WEB_VAPID_PRIVATE_KEY!,
            subject: parsed.CODEX_WEB_VAPID_SUBJECT!,
          },
        }),
  };
}
