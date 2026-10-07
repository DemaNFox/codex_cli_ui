import type {
  Attachment,
  PendingApproval,
  Project,
  ResourceLimitPolicy,
  RuntimePreferences,
  SafeEvent,
  Subagent,
  Thread,
  TurnNavigationEntry,
  StartTurnRequest,
  PushSubscriptionInput,
} from '@codex-web/contracts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PushNotificationPayload } from './push-notifications.js';
import { isAllowedPushEndpoint } from './push-notifications-policy.js';

interface SessionRow {
  id: string;
  csrf_hash: string;
  expires_at: string;
  revoked_at: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  archived: number;
  default_model: string | null;
  default_reasoning_effort: string | null;
  default_permission_preset: Project['defaultPermissionPreset'];
  created_at: string;
  updated_at: string;
}

interface ThreadRow {
  id: string;
  project_id: string;
  name: string | null;
  preview: string;
  model: string | null;
  status: Thread['status'];
  active_turn_id: string | null;
  archived: number;
  instruction_sources_json: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  thread_id: string;
  turn_id: string | null;
  kind: SafeEvent['kind'];
  phase: SafeEvent['phase'];
  payload_json: string;
  created_at: string;
}

interface ThreadHistoryEventStateRow {
  fingerprint: string;
  observed_count: number;
}

interface TurnNavigationRow {
  id: number;
  thread_id: string;
  turn_id: string;
  label: string;
}

interface AttachmentRow {
  id: string;
  thread_id: string;
  name: string;
  mime_type: string;
  kind: Attachment['kind'];
  size_bytes: number;
  storage_name: string;
  turn_id: string | null;
  created_at: string;
}

interface QueuedTurnRow {
  id: number;
  thread_id: string;
  idempotency_key: string;
  request_hash: string;
  request_json: string;
  claim_token: string;
  status: QueuedTurnRecord['status'];
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface SubagentRow {
  id: string;
  root_thread_id: string;
  parent_thread_id: string;
  agent_path: string | null;
  nickname: string | null;
  role: string | null;
  model: string | null;
  reasoning_effort: string | null;
  status: Subagent['status'];
  message: string | null;
  started_at: string;
  last_activity_at: string;
  completed_at: string | null;
}

interface PushDeliveryRow {
  id: string;
  thread_id: string;
  subscription_id: string;
  endpoint: string;
  expiration_time: number | null;
  p256dh: string;
  auth: string;
  payload_json: string;
  attempts: number;
}

export const PUSH_STORAGE_LIMITS = {
  globalSubscriptions: 64,
  mappingsPerThread: 16,
  pendingGlobal: 1_024,
  pendingPerThread: 64,
  receiptsGlobal: 4_096,
  receiptsPerThread: 128,
} as const;

export class PushStorageLimitError extends Error {
  constructor(readonly scope: 'global-subscriptions' | 'thread-mappings') {
    super('Push subscription limit reached');
  }
}

export class TurnQueueStorageLimitError extends Error {
  constructor() {
    super('Turn queue limit reached');
  }
}

export interface ClaimedPushDelivery {
  readonly id: string;
  readonly threadId: string;
  readonly subscriptionId: string;
  readonly subscription: PushSubscriptionInput;
  readonly payload: PushNotificationPayload;
  readonly attempt: number;
}

export interface StoredResourceLimits {
  desired: ResourceLimitPolicy;
  state: 'applied' | 'pending-idle' | 'applying' | 'degraded';
  version: number;
  updatedAt: string;
  appliedAt: string | null;
  warning: string | null;
}

export interface AttachmentRecord {
  id: string;
  threadId: string;
  name: string;
  mimeType: string;
  kind: Attachment['kind'];
  size: number;
  storageName: string;
  turnId: string | null;
  createdAt: string;
}

export interface AttachmentFileDeletionRecord {
  id: string;
  projectId: string;
  threadId: string;
  storageName: string;
  attempts: number;
  nextAttemptAt: number;
  createdAt: string;
  updatedAt: string;
}

export interface QueuedTurnRecord {
  id: number;
  threadId: string;
  idempotencyKey: string;
  requestHash: string;
  request: StartTurnRequest;
  claimToken: string;
  status: 'queued' | 'dispatching' | 'unknown' | 'failed';
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export const MAX_QUEUED_TURNS = 128;

function queuedTurnFromRow(row: QueuedTurnRow): QueuedTurnRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    request: JSON.parse(row.request_json) as StartTurnRequest,
    claimToken: row.claim_token,
    status: row.status,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ApprovalRow {
  id: string;
  thread_id: string;
  turn_id: string | null;
  rpc_request_id: string;
  rpc_request_id_type: 'number' | 'string';
  method: string;
  summary: string;
  details_json: string;
  status: ApprovalRecord['status'];
  created_at: string;
}

export type ApprovalRecord = Omit<PendingApproval, 'status'> & {
  status: PendingApproval['status'] | 'resolving';
};

function jsonRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    archived: row.archived === 1,
    defaultModel: row.default_model,
    defaultReasoningEffort: row.default_reasoning_effort,
    defaultPermissionPreset: row.default_permission_preset,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function threadFromRow(row: ThreadRow): Thread {
  const sources: unknown = JSON.parse(row.instruction_sources_json);
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    preview: row.preview,
    model: row.model,
    status: row.status,
    activeTurnId: row.active_turn_id,
    archived: row.archived === 1,
    instructionSources: Array.isArray(sources)
      ? sources.filter((item): item is string => typeof item === 'string')
      : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attachmentFromRow(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    name: row.name,
    mimeType: row.mime_type,
    kind: row.kind,
    size: row.size_bytes,
    storageName: row.storage_name,
    turnId: row.turn_id,
    createdAt: row.created_at,
  };
}

function subagentFromRow(row: SubagentRow): Subagent {
  return {
    id: row.id,
    rootThreadId: row.root_thread_id,
    parentThreadId: row.parent_thread_id,
    agentPath: row.agent_path,
    nickname: row.nickname,
    role: row.role,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    status: row.status,
    message: row.message,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    completedAt: row.completed_at,
  };
}

export class SqliteRepository {
  readonly database: DatabaseSync;

  constructor(
    filename: string,
    private readonly eventRetentionPerThread: number,
  ) {
    if (filename !== ':memory:')
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(filename);
    this.database.exec(
      'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;',
    );
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at, revoked_at);

      CREATE TABLE IF NOT EXISTS login_attempts (
        attempt_key TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        window_started_at INTEGER NOT NULL,
        locked_until INTEGER
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
        default_model TEXT,
        default_reasoning_effort TEXT,
        default_permission_preset TEXT NOT NULL CHECK(default_permission_preset IN ('read-only','workspace-write','full-access')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        name TEXT,
        preview TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL CHECK(status IN ('notLoaded','idle','active','systemError','unknown')),
        active_turn_id TEXT,
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
        instruction_sources_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS threads_project_idx ON threads(project_id, archived, updated_at DESC);

      CREATE TABLE IF NOT EXISTS runtime_preferences (
        id INTEGER PRIMARY KEY CHECK(id=1),
        model TEXT,
        reasoning_effort TEXT,
        permission_preset TEXT NOT NULL CHECK(permission_preset IN ('read-only','workspace-write','full-access')),
        approval_policy TEXT NOT NULL CHECK(approval_policy IN ('untrusted','on-request','never')),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS resource_limit_preferences (
        id INTEGER PRIMARY KEY CHECK(id=1),
        mode TEXT NOT NULL CHECK(mode IN ('auto','custom')),
        cpu_cores REAL,
        memory_bytes INTEGER,
        tasks INTEGER,
        max_parallel_agents INTEGER,
        state TEXT NOT NULL CHECK(state IN ('applied','pending-idle','applying','degraded')),
        version INTEGER NOT NULL CHECK(version >= 0),
        updated_at TEXT NOT NULL,
        applied_at TEXT,
        warning TEXT
      );

      CREATE TABLE IF NOT EXISTS subagents (
        id TEXT PRIMARY KEY,
        root_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        parent_thread_id TEXT NOT NULL,
        agent_path TEXT,
        nickname TEXT,
        role TEXT,
        model TEXT,
        reasoning_effort TEXT,
        status TEXT NOT NULL CHECK(status IN ('pendingInit','running','interrupted','completed','errored','shutdown','notFound')),
        message TEXT,
        started_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS subagents_root_idx ON subagents(root_thread_id,status,last_activity_at);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('image','file')),
        size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
        storage_name TEXT NOT NULL UNIQUE,
        turn_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attachments_thread_idx ON attachments(thread_id, created_at, id);

      CREATE TABLE IF NOT EXISTS attachment_file_deletions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        storage_name TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        next_attempt_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_history_state (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        hydrated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_history_event_state (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        observed_count INTEGER NOT NULL CHECK(observed_count >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(thread_id, fingerprint)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT,
        kind TEXT NOT NULL,
        phase TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_thread_idx ON events(thread_id, id);

      CREATE TABLE IF NOT EXISTS turn_navigation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        label TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turn_navigation_thread_idx ON turn_navigation(thread_id, id);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT,
        rpc_request_id TEXT NOT NULL,
        rpc_request_id_type TEXT NOT NULL CHECK(rpc_request_id_type IN ('number','string')),
        method TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','resolving','accepted','declined','cancelled')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      DROP INDEX IF EXISTS approvals_rpc_idx;
      CREATE INDEX IF NOT EXISTS approvals_rpc_lookup_idx ON approvals(rpc_request_id, rpc_request_id_type);

      CREATE TABLE IF NOT EXISTS idempotency (
        operation TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','completed','unknown')),
        response_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(operation, key)
      );

      CREATE TABLE IF NOT EXISTS queued_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        claim_token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('queued','dispatching','unknown','failed')),
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(thread_id,idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS queued_turns_fifo_idx ON queued_turns(status,id);

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        expiration_time INTEGER,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_push_subscriptions (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(thread_id, subscription_id)
      );
      CREATE INDEX IF NOT EXISTS thread_push_subscription_idx
        ON thread_push_subscriptions(subscription_id, thread_id);

      CREATE TABLE IF NOT EXISTS push_deliveries (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
        next_attempt_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(thread_id, turn_id, subscription_id)
      );
      CREATE INDEX IF NOT EXISTS push_deliveries_due_idx
        ON push_deliveries(next_attempt_at, attempts);

      CREATE TABLE IF NOT EXISTS push_delivery_receipts (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
        delivered_at TEXT NOT NULL,
        PRIMARY KEY(thread_id, turn_id, subscription_id)
      );
    `);
    this.migrateProjectArchived();
    this.migrateApprovalResolvingState();
    this.migrateIdempotencyState();
    this.migrateThreadActiveTurn();
    this.migrateAttachmentFileDeletionDueTime();
    this.recoverInterruptedQueuedTurns();
    this.enforcePushStorageBounds();
  }

  private migrateProjectArchived(): void {
    const columns = this.database.prepare('PRAGMA table_info(projects)').all() as unknown as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === 'archived'))
      this.database.exec(
        'ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))',
      );
    this.database.exec(
      'CREATE INDEX IF NOT EXISTS projects_archived_idx ON projects(archived,name COLLATE NOCASE,id)',
    );
  }

  private recoverInterruptedQueuedTurns(): void {
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.database
        .prepare(
          "SELECT thread_id,idempotency_key,request_hash FROM queued_turns WHERE status='dispatching'",
        )
        .all() as unknown as Array<{
        thread_id: string;
        idempotency_key: string;
        request_hash: string;
      }>;
      const markUnknown = this.database.prepare(
        "UPDATE idempotency SET state='unknown',updated_at=? WHERE operation=? AND key=? AND request_hash=?",
      );
      for (const row of rows)
        markUnknown.run(now, `turn:${row.thread_id}`, row.idempotency_key, row.request_hash);
      this.database
        .prepare(
          "UPDATE queued_turns SET status='unknown',error_code='IDEMPOTENCY_OUTCOME_UNKNOWN',updated_at=? WHERE status='dispatching'",
        )
        .run(now);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private enforcePushStorageBounds(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const subscriptions = this.database
        .prepare('SELECT id,endpoint FROM push_subscriptions')
        .all() as unknown as { id: string; endpoint: string }[];
      const deleteSubscription = this.database.prepare('DELETE FROM push_subscriptions WHERE id=?');
      for (const subscription of subscriptions) {
        if (!isAllowedPushEndpoint(subscription.endpoint)) deleteSubscription.run(subscription.id);
      }
      this.database.exec(`
      UPDATE push_deliveries SET payload_json=CASE
        WHEN payload_json LIKE '%"status":"interrupted"%' THEN '{"status":"interrupted"}'
        WHEN payload_json LIKE '%"status":"failed"%' THEN '{"status":"failed"}'
        ELSE '{"status":"completed"}'
      END;
      DELETE FROM thread_push_subscriptions WHERE rowid IN (
        SELECT rowid FROM (
          SELECT rowid,ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC,rowid DESC) AS position
          FROM thread_push_subscriptions
        ) WHERE position > ${PUSH_STORAGE_LIMITS.mappingsPerThread}
      );
      DELETE FROM push_subscriptions WHERE id NOT IN (
        SELECT DISTINCT subscription_id FROM thread_push_subscriptions
      );
      DELETE FROM push_subscriptions WHERE rowid IN (
        SELECT rowid FROM push_subscriptions ORDER BY updated_at DESC,rowid DESC
        LIMIT -1 OFFSET ${PUSH_STORAGE_LIMITS.globalSubscriptions}
      );
      DELETE FROM push_deliveries WHERE rowid IN (
        SELECT rowid FROM (
          SELECT rowid,ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at,rowid) AS position
          FROM push_deliveries
        ) WHERE position > ${PUSH_STORAGE_LIMITS.pendingPerThread}
      );
      DELETE FROM push_deliveries WHERE rowid IN (
        SELECT rowid FROM push_deliveries ORDER BY created_at,rowid
        LIMIT -1 OFFSET ${PUSH_STORAGE_LIMITS.pendingGlobal}
      );
      DELETE FROM push_delivery_receipts WHERE rowid IN (
        SELECT rowid FROM (
          SELECT rowid,ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY delivered_at DESC,rowid DESC) AS position
          FROM push_delivery_receipts
        ) WHERE position > ${PUSH_STORAGE_LIMITS.receiptsPerThread}
      );
      DELETE FROM push_delivery_receipts WHERE rowid IN (
        SELECT rowid FROM push_delivery_receipts ORDER BY delivered_at DESC,rowid DESC
        LIMIT -1 OFFSET ${PUSH_STORAGE_LIMITS.receiptsGlobal}
      );
      `);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateThreadActiveTurn(): void {
    const columns = this.database.prepare('PRAGMA table_info(threads)').all() as unknown as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === 'active_turn_id'))
      this.database.exec('ALTER TABLE threads ADD COLUMN active_turn_id TEXT');
  }

  private migrateAttachmentFileDeletionDueTime(): void {
    const columns = this.database
      .prepare('PRAGMA table_info(attachment_file_deletions)')
      .all() as unknown as { name: string }[];
    const hasDueTime = columns.some((column) => column.name === 'next_attempt_at');
    const index = this.database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='attachment_file_deletions_order_idx'",
      )
      .get() as { sql: string | null } | undefined;
    const normalizedIndex = index?.sql?.replaceAll(/\s+/gu, '').toLowerCase() ?? '';
    if (
      hasDueTime &&
      normalizedIndex.includes('onattachment_file_deletions(next_attempt_at,created_at,id)')
    )
      return;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (!hasDueTime)
        this.database.exec(
          'ALTER TABLE attachment_file_deletions ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0',
        );
      this.database.exec(`
        DROP INDEX IF EXISTS attachment_file_deletions_order_idx;
        CREATE INDEX attachment_file_deletions_order_idx
          ON attachment_file_deletions(next_attempt_at,created_at,id);
        COMMIT;
      `);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateApprovalResolvingState(): void {
    const row = this.database
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='approvals'")
      .get() as { sql: string } | undefined;
    if (row?.sql.includes("'resolving'")) return;
    this.database.exec(`
      BEGIN IMMEDIATE;
      DROP INDEX IF EXISTS approvals_rpc_idx;
      DROP INDEX IF EXISTS approvals_rpc_lookup_idx;
      ALTER TABLE approvals RENAME TO approvals_legacy;
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT,
        rpc_request_id TEXT NOT NULL,
        rpc_request_id_type TEXT NOT NULL CHECK(rpc_request_id_type IN ('number','string')),
        method TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','resolving','accepted','declined','cancelled')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      INSERT INTO approvals SELECT * FROM approvals_legacy;
      DROP TABLE approvals_legacy;
      CREATE INDEX approvals_rpc_lookup_idx ON approvals(rpc_request_id,rpc_request_id_type);
      COMMIT;
    `);
  }

  private migrateIdempotencyState(): void {
    const columns = this.database.prepare('PRAGMA table_info(idempotency)').all() as unknown as {
      name: string;
    }[];
    if (columns.some((column) => column.name === 'state')) return;
    this.database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE idempotency RENAME TO idempotency_legacy;
      CREATE TABLE idempotency (
        operation TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','completed','unknown')),
        response_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(operation, key)
      );
      INSERT INTO idempotency(operation,key,request_hash,state,response_json,created_at,updated_at)
      SELECT operation,key,request_hash,'completed',response_json,created_at,created_at
      FROM idempotency_legacy;
      DROP TABLE idempotency_legacy;
      COMMIT;
    `);
  }

  close(): void {
    this.database.close();
  }

  private pushSubscriptionId(endpoint: string): string {
    return createHash('sha256').update(endpoint).digest('hex');
  }

  hasPushSubscription(threadId: string, endpoint: string): boolean {
    const subscriptionId = this.pushSubscriptionId(endpoint);
    return (
      this.database
        .prepare('SELECT 1 FROM thread_push_subscriptions WHERE thread_id=? AND subscription_id=?')
        .get(threadId, subscriptionId) !== undefined
    );
  }

  upsertPushSubscription(threadId: string, subscription: PushSubscriptionInput): string {
    const id = this.pushSubscriptionId(subscription.endpoint);
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existingSubscription = this.database
        .prepare('SELECT 1 FROM push_subscriptions WHERE id=?')
        .get(id);
      const existingMapping = this.database
        .prepare('SELECT 1 FROM thread_push_subscriptions WHERE thread_id=? AND subscription_id=?')
        .get(threadId, id);
      if (!existingSubscription) {
        const globalCount = this.database
          .prepare('SELECT COUNT(*) AS count FROM push_subscriptions')
          .get() as { count: number };
        if (globalCount.count >= PUSH_STORAGE_LIMITS.globalSubscriptions)
          throw new PushStorageLimitError('global-subscriptions');
      }
      if (!existingMapping) {
        const mappingCount = this.database
          .prepare('SELECT COUNT(*) AS count FROM thread_push_subscriptions WHERE thread_id=?')
          .get(threadId) as { count: number };
        if (mappingCount.count >= PUSH_STORAGE_LIMITS.mappingsPerThread)
          throw new PushStorageLimitError('thread-mappings');
      }
      this.database
        .prepare(
          `INSERT INTO push_subscriptions(id,endpoint,expiration_time,p256dh,auth,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,
             expiration_time=excluded.expiration_time,p256dh=excluded.p256dh,auth=excluded.auth,
             updated_at=excluded.updated_at`,
        )
        .run(
          id,
          subscription.endpoint,
          subscription.expirationTime,
          subscription.keys.p256dh,
          subscription.keys.auth,
          now,
          now,
        );
      this.database
        .prepare(
          `INSERT INTO thread_push_subscriptions(thread_id,subscription_id,created_at)
           VALUES(?,?,?) ON CONFLICT(thread_id,subscription_id) DO NOTHING`,
        )
        .run(threadId, id, now);
      this.database.exec('COMMIT');
      return id;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  removeThreadPushSubscription(threadId: string, endpoint: string): string {
    const id = this.pushSubscriptionId(endpoint);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare('DELETE FROM thread_push_subscriptions WHERE thread_id=? AND subscription_id=?')
        .run(threadId, id);
      this.database
        .prepare('DELETE FROM push_deliveries WHERE thread_id=? AND subscription_id=?')
        .run(threadId, id);
      this.database
        .prepare(
          `DELETE FROM push_subscriptions WHERE id=?
           AND NOT EXISTS (SELECT 1 FROM thread_push_subscriptions WHERE subscription_id=?)`,
        )
        .run(id, id);
      this.database.exec('COMMIT');
      return id;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  enqueuePushDeliveries(
    threadId: string,
    turnId: string,
    payload: PushNotificationPayload,
  ): { enqueued: number; dropped: number } {
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const eligible = this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM thread_push_subscriptions mapping
           WHERE mapping.thread_id=? AND NOT EXISTS (
             SELECT 1 FROM push_delivery_receipts receipt
             WHERE receipt.thread_id=mapping.thread_id AND receipt.turn_id=?
               AND receipt.subscription_id=mapping.subscription_id
           ) AND NOT EXISTS (
             SELECT 1 FROM push_deliveries delivery
             WHERE delivery.thread_id=mapping.thread_id AND delivery.turn_id=?
               AND delivery.subscription_id=mapping.subscription_id
           )`,
        )
        .get(threadId, turnId, turnId) as { count: number };
      const globalPending = this.database
        .prepare('SELECT COUNT(*) AS count FROM push_deliveries')
        .get() as { count: number };
      const threadPending = this.database
        .prepare('SELECT COUNT(*) AS count FROM push_deliveries WHERE thread_id=?')
        .get(threadId) as { count: number };
      const capacity = Math.max(
        0,
        Math.min(
          PUSH_STORAGE_LIMITS.pendingGlobal - globalPending.count,
          PUSH_STORAGE_LIMITS.pendingPerThread - threadPending.count,
        ),
      );
      const enqueued = Number(
        this.database
          .prepare(
            `INSERT OR IGNORE INTO push_deliveries(
           id,thread_id,turn_id,subscription_id,payload_json,attempts,next_attempt_at,created_at,updated_at
         )
         SELECT lower(hex(randomblob(16))),?,?,mapping.subscription_id,?,0,?,?,?
         FROM thread_push_subscriptions mapping
         WHERE mapping.thread_id=? AND NOT EXISTS (
           SELECT 1 FROM push_delivery_receipts receipt
           WHERE receipt.thread_id=mapping.thread_id AND receipt.turn_id=?
             AND receipt.subscription_id=mapping.subscription_id
         ) LIMIT ?`,
          )
          .run(
            threadId,
            turnId,
            JSON.stringify({ status: payload.status }),
            Date.now(),
            now,
            now,
            threadId,
            turnId,
            capacity,
          ).changes,
      );
      this.database.exec('COMMIT');
      return { enqueued, dropped: Math.max(0, eligible.count - enqueued) };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  claimDuePushDeliveries(limit: number): ClaimedPushDelivery[] {
    const now = Date.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.database
        .prepare(
          `SELECT d.id,d.thread_id,d.subscription_id,s.endpoint,s.expiration_time,s.p256dh,s.auth,
                  d.payload_json,d.attempts
           FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id
           WHERE d.attempts < 5 AND d.next_attempt_at <= ?
           ORDER BY d.next_attempt_at,d.created_at LIMIT ?`,
        )
        .all(now, limit) as unknown as PushDeliveryRow[];
      const updatedAt = new Date().toISOString();
      for (const row of rows) {
        const attempt = row.attempts + 1;
        const backoffMs = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
        this.database
          .prepare(
            'UPDATE push_deliveries SET attempts=?,next_attempt_at=?,updated_at=? WHERE id=?',
          )
          .run(attempt, now + backoffMs, updatedAt, row.id);
      }
      this.database.exec('COMMIT');
      return rows.map((row) => {
        const stored = JSON.parse(row.payload_json) as { status?: unknown };
        const status =
          stored.status === 'interrupted' || stored.status === 'failed'
            ? stored.status
            : 'completed';
        return {
          id: row.id,
          threadId: row.thread_id,
          subscriptionId: row.subscription_id,
          subscription: {
            endpoint: row.endpoint,
            expirationTime: row.expiration_time,
            keys: { p256dh: row.p256dh, auth: row.auth },
          },
          payload: { threadId: row.thread_id, status },
          attempt: row.attempts + 1,
        };
      });
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  completePushDelivery(id: string): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO push_delivery_receipts(thread_id,turn_id,subscription_id,delivered_at)
           SELECT thread_id,turn_id,subscription_id,? FROM push_deliveries WHERE id=?`,
        )
        .run(new Date().toISOString(), id);
      this.database
        .prepare(
          `DELETE FROM push_delivery_receipts WHERE rowid IN (
             SELECT rowid FROM push_delivery_receipts
             WHERE thread_id=(SELECT thread_id FROM push_deliveries WHERE id=?)
             ORDER BY delivered_at DESC,rowid DESC LIMIT -1 OFFSET ${PUSH_STORAGE_LIMITS.receiptsPerThread}
           )`,
        )
        .run(id);
      this.database.exec(`
        DELETE FROM push_delivery_receipts WHERE rowid IN (
          SELECT rowid FROM push_delivery_receipts ORDER BY delivered_at DESC,rowid DESC
          LIMIT -1 OFFSET ${PUSH_STORAGE_LIMITS.receiptsGlobal}
        )
      `);
      this.database.prepare('DELETE FROM push_deliveries WHERE id=?').run(id);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  failPushDelivery(id: string): void {
    this.database.prepare('DELETE FROM push_deliveries WHERE id=? AND attempts>=5').run(id);
    this.database
      .prepare('UPDATE push_deliveries SET updated_at=? WHERE id=? AND attempts<5')
      .run(new Date().toISOString(), id);
  }

  isPushDeliveryActive(id: string): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM push_deliveries delivery
           JOIN thread_push_subscriptions mapping
             ON mapping.thread_id=delivery.thread_id
            AND mapping.subscription_id=delivery.subscription_id
           WHERE delivery.id=?`,
        )
        .get(id) !== undefined
    );
  }

  purgeExhaustedPushDeliveries(): number {
    return Number(
      this.database.prepare('DELETE FROM push_deliveries WHERE attempts>=5').run().changes,
    );
  }

  removePushSubscriptionGlobally(subscriptionId: string): void {
    this.database.prepare('DELETE FROM push_subscriptions WHERE id=?').run(subscriptionId);
  }

  removePushSubscriptionsWhere(predicate: (endpoint: string) => boolean): number {
    const rows = this.database
      .prepare('SELECT id,endpoint FROM push_subscriptions')
      .all() as unknown as {
      id: string;
      endpoint: string;
    }[];
    const ids = rows.filter((row) => predicate(row.endpoint)).map((row) => row.id);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const statement = this.database.prepare('DELETE FROM push_subscriptions WHERE id=?');
      let removed = 0;
      for (const id of ids) removed += Number(statement.run(id).changes);
      this.database.exec('COMMIT');
      return removed;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  nextPushDeliveryDelayMs(): number | null {
    const row = this.database
      .prepare('SELECT MIN(next_attempt_at) AS due FROM push_deliveries WHERE attempts < 5')
      .get() as { due: number | null };
    return row.due === null ? null : Math.max(0, Math.min(60_000, row.due - Date.now()));
  }

  createSession(tokenHash: string, csrfHash: string, expiresAt: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(
        'INSERT INTO sessions(id,token_hash,csrf_hash,expires_at,last_seen_at,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(id, tokenHash, csrfHash, expiresAt, now, now);
    return id;
  }

  findSession(tokenHash: string, now = new Date()): SessionRow | undefined {
    const row = this.database
      .prepare(
        'SELECT id,csrf_hash,expires_at,revoked_at FROM sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?',
      )
      .get(tokenHash, now.toISOString()) as SessionRow | undefined;
    if (row)
      this.database
        .prepare('UPDATE sessions SET last_seen_at=? WHERE id=?')
        .run(now.toISOString(), row.id);
    return row;
  }

  revokeSession(id: string): void {
    this.database
      .prepare('UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
      .run(new Date().toISOString(), id);
  }

  loginState(
    key: string,
  ): { failures: number; windowStartedAt: number; lockedUntil: number | null } | undefined {
    const row = this.database
      .prepare(
        'SELECT failures,window_started_at,locked_until FROM login_attempts WHERE attempt_key=?',
      )
      .get(key) as
      { failures: number; window_started_at: number; locked_until: number | null } | undefined;
    return (
      row && {
        failures: row.failures,
        windowStartedAt: row.window_started_at,
        lockedUntil: row.locked_until,
      }
    );
  }

  recordLoginFailure(
    key: string,
    nowMs: number,
    windowMs: number,
    maxFailures: number,
    lockoutMs: number,
  ): number | null {
    const current = this.loginState(key);
    const failures =
      current === undefined || nowMs - current.windowStartedAt > windowMs
        ? 1
        : current.failures + 1;
    const windowStartedAt =
      current === undefined || nowMs - current.windowStartedAt > windowMs
        ? nowMs
        : current.windowStartedAt;
    const lockedUntil = failures >= maxFailures ? nowMs + lockoutMs : null;
    this.database
      .prepare(
        `
      INSERT INTO login_attempts(attempt_key,failures,window_started_at,locked_until) VALUES(?,?,?,?)
      ON CONFLICT(attempt_key) DO UPDATE SET failures=excluded.failures,window_started_at=excluded.window_started_at,locked_until=excluded.locked_until
    `,
      )
      .run(key, failures, windowStartedAt, lockedUntil);
    return lockedUntil;
  }

  clearLoginFailures(key: string): void {
    this.database.prepare('DELETE FROM login_attempts WHERE attempt_key=?').run(key);
  }

  listProjects(archived = false): Project[] {
    return (
      this.database
        .prepare('SELECT * FROM projects WHERE archived=? ORDER BY name COLLATE NOCASE,id')
        .all(archived ? 1 : 0) as unknown as ProjectRow[]
    ).map(projectFromRow);
  }

  getProject(id: string): Project | undefined {
    const row = this.database.prepare('SELECT * FROM projects WHERE id=?').get(id) as
      ProjectRow | undefined;
    return row && projectFromRow(row);
  }

  createProject(input: Omit<Project, 'id' | 'archived' | 'createdAt' | 'updatedAt'>): Project {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO projects(id,name,path,default_model,default_reasoning_effort,default_permission_preset,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.name,
        input.path,
        input.defaultModel,
        input.defaultReasoningEffort,
        input.defaultPermissionPreset,
        now,
        now,
      );
    return this.getProject(id)!;
  }

  setProjectArchived(id: string, archived: boolean): Project | undefined {
    const now = new Date().toISOString();
    this.database
      .prepare('UPDATE projects SET archived=?,updated_at=? WHERE id=?')
      .run(archived ? 1 : 0, now, id);
    return this.getProject(id);
  }

  projectHasActiveWork(projectId: string): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1
           FROM threads t
           WHERE t.project_id=? AND (
             t.status='active' OR t.active_turn_id IS NOT NULL OR
             EXISTS(
               SELECT 1 FROM queued_turns q
               WHERE q.thread_id=t.id AND q.status IN ('queued','dispatching','unknown')
             ) OR
             EXISTS(
               SELECT 1 FROM subagents s
               WHERE s.root_thread_id=t.id AND s.id<>s.root_thread_id
                 AND s.status IN ('pendingInit','running')
             )
           )
           LIMIT 1`,
        )
        .get(projectId) !== undefined
    );
  }

  listProjectThreadIds(projectId: string): string[] {
    return (
      this.database
        .prepare('SELECT id FROM threads WHERE project_id=?')
        .all(projectId) as unknown as {
        id: string;
      }[]
    ).map((row) => row.id);
  }

  updateProject(
    id: string,
    input: Partial<
      Pick<Project, 'name' | 'defaultModel' | 'defaultReasoningEffort' | 'defaultPermissionPreset'>
    >,
  ): Project | undefined {
    const current = this.getProject(id);
    if (!current) return undefined;
    const updated = { ...current, ...input, updatedAt: new Date().toISOString() };
    this.database
      .prepare(
        `UPDATE projects SET name=?,default_model=?,default_reasoning_effort=?,default_permission_preset=?,updated_at=? WHERE id=?`,
      )
      .run(
        updated.name,
        updated.defaultModel,
        updated.defaultReasoningEffort,
        updated.defaultPermissionPreset,
        updated.updatedAt,
        id,
      );
    return this.getProject(id);
  }

  deleteProject(id: string): boolean {
    return (
      this.database
        .prepare(
          'DELETE FROM projects WHERE id=? AND NOT EXISTS(SELECT 1 FROM threads WHERE project_id=?)',
        )
        .run(id, id).changes === 1
    );
  }

  getRuntimePreferences(): RuntimePreferences {
    const row = this.database.prepare('SELECT * FROM runtime_preferences WHERE id=1').get() as
      | {
          model: string | null;
          reasoning_effort: string | null;
          permission_preset: RuntimePreferences['permissionPreset'];
          approval_policy: RuntimePreferences['approvalPolicy'];
          updated_at: string;
        }
      | undefined;
    return row
      ? {
          model: row.model,
          reasoningEffort: row.reasoning_effort,
          permissionPreset: row.permission_preset,
          approvalPolicy: row.approval_policy,
          updatedAt: row.updated_at,
        }
      : {
          model: null,
          reasoningEffort: null,
          permissionPreset: 'workspace-write',
          approvalPolicy: 'on-request',
          updatedAt: new Date(0).toISOString(),
        };
  }

  setRuntimePreferences(input: Omit<RuntimePreferences, 'updatedAt'>): RuntimePreferences {
    const updatedAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO runtime_preferences(id,model,reasoning_effort,permission_preset,approval_policy,updated_at)
         VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
         model=excluded.model,reasoning_effort=excluded.reasoning_effort,
         permission_preset=excluded.permission_preset,approval_policy=excluded.approval_policy,
         updated_at=excluded.updated_at`,
      )
      .run(
        input.model,
        input.reasoningEffort,
        input.permissionPreset,
        input.approvalPolicy,
        updatedAt,
      );
    return this.getRuntimePreferences();
  }

  getResourceLimits(): StoredResourceLimits {
    this.database
      .prepare(
        `INSERT INTO resource_limit_preferences(id,mode,cpu_cores,memory_bytes,tasks,max_parallel_agents,state,version,updated_at,applied_at,warning)
         VALUES(1,'auto',NULL,NULL,NULL,NULL,'pending-idle',0,?,NULL,NULL) ON CONFLICT(id) DO NOTHING`,
      )
      .run(new Date(0).toISOString());
    const row = this.database
      .prepare('SELECT * FROM resource_limit_preferences WHERE id=1')
      .get() as {
      mode: ResourceLimitPolicy['mode'];
      cpu_cores: number | null;
      memory_bytes: number | null;
      tasks: number | null;
      max_parallel_agents: number | null;
      state: StoredResourceLimits['state'];
      version: number;
      updated_at: string;
      applied_at: string | null;
      warning: string | null;
    };
    return {
      desired: {
        mode: row.mode,
        cpuCores: row.cpu_cores,
        memoryBytes: row.memory_bytes,
        tasks: row.tasks,
        maxParallelAgents: row.max_parallel_agents,
      },
      state: row.state,
      version: row.version,
      updatedAt: row.updated_at,
      appliedAt: row.applied_at,
      warning: row.warning,
    };
  }

  setResourceLimitDesired(
    desired: ResourceLimitPolicy,
    expectedVersion: number,
    state: StoredResourceLimits['state'],
  ): StoredResourceLimits | undefined {
    this.getResourceLimits();
    const updatedAt = new Date().toISOString();
    const result = this.database
      .prepare(
        `UPDATE resource_limit_preferences SET mode=?,cpu_cores=?,memory_bytes=?,tasks=?,max_parallel_agents=?,
         state=?,version=version+1,updated_at=?,warning=NULL WHERE id=1 AND version=?`,
      )
      .run(
        desired.mode,
        desired.cpuCores,
        desired.memoryBytes,
        desired.tasks,
        desired.maxParallelAgents,
        state,
        updatedAt,
        expectedVersion,
      );
    return result.changes === 1 ? this.getResourceLimits() : undefined;
  }

  setResourceLimitState(
    version: number,
    state: StoredResourceLimits['state'],
    input: { appliedAt?: string | null; warning?: string | null } = {},
  ): StoredResourceLimits | undefined {
    const current = this.getResourceLimits();
    const result = this.database
      .prepare(
        `UPDATE resource_limit_preferences SET state=?,applied_at=?,warning=?,updated_at=?
         WHERE id=1 AND version=?`,
      )
      .run(
        state,
        input.appliedAt === undefined ? current.appliedAt : input.appliedAt,
        input.warning === undefined ? current.warning : input.warning,
        new Date().toISOString(),
        version,
      );
    return result.changes === 1 ? this.getResourceLimits() : undefined;
  }

  upsertSubagent(subagent: Subagent): Subagent {
    this.database
      .prepare(
        `INSERT INTO subagents(id,root_thread_id,parent_thread_id,agent_path,nickname,role,model,reasoning_effort,status,message,started_at,last_activity_at,completed_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
         root_thread_id=excluded.root_thread_id,parent_thread_id=excluded.parent_thread_id,
         agent_path=COALESCE(excluded.agent_path,subagents.agent_path),nickname=COALESCE(excluded.nickname,subagents.nickname),
         role=COALESCE(excluded.role,subagents.role),model=COALESCE(excluded.model,subagents.model),
         reasoning_effort=COALESCE(excluded.reasoning_effort,subagents.reasoning_effort),status=excluded.status,
         message=excluded.message,last_activity_at=excluded.last_activity_at,completed_at=excluded.completed_at
         WHERE excluded.last_activity_at > subagents.last_activity_at
            OR (excluded.last_activity_at = subagents.last_activity_at
                AND NOT (subagents.status IN ('interrupted','completed','errored','shutdown','notFound')
                         AND excluded.status IN ('pendingInit','running')))`,
      )
      .run(
        subagent.id,
        subagent.rootThreadId,
        subagent.parentThreadId,
        subagent.agentPath,
        subagent.nickname,
        subagent.role,
        subagent.model,
        subagent.reasoningEffort,
        subagent.status,
        subagent.message,
        subagent.startedAt,
        subagent.lastActivityAt,
        subagent.completedAt,
      );
    return this.getSubagent(subagent.id)!;
  }

  getSubagent(id: string): Subagent | undefined {
    const row = this.database.prepare('SELECT * FROM subagents WHERE id=?').get(id) as
      SubagentRow | undefined;
    return row && subagentFromRow(row);
  }

  listSubagents(rootThreadId: string): Subagent[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM subagents WHERE root_thread_id=? AND id<>root_thread_id ORDER BY started_at,id',
        )
        .all(rootThreadId) as unknown as SubagentRow[]
    ).map(subagentFromRow);
  }

  countActiveSubagents(): number {
    const row = this.database
      .prepare(
        "SELECT count(*) AS count FROM subagents WHERE id<>root_thread_id AND status IN ('pendingInit','running')",
      )
      .get() as { count: number };
    return row.count;
  }

  countActiveSubagentsForRoot(rootThreadId: string): number {
    const row = this.database
      .prepare(
        "SELECT count(*) AS count FROM subagents WHERE root_thread_id=? AND id<>root_thread_id AND status IN ('pendingInit','running')",
      )
      .get(rootThreadId) as { count: number };
    return row.count;
  }

  listActiveSubagents(): Subagent[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM subagents WHERE id<>root_thread_id AND status IN ('pendingInit','running') ORDER BY last_activity_at,id",
        )
        .all() as unknown as SubagentRow[]
    ).map(subagentFromRow);
  }

  reconcileActiveSubagent(
    id: string,
    expectedStatus: 'pendingInit' | 'running',
    expectedLastActivityAt: string,
    observedAt: string,
  ): boolean {
    const terminalAt = new Date(
      Math.max(Date.parse(expectedLastActivityAt), Date.parse(observedAt)),
    ).toISOString();
    const result = this.database
      .prepare(
        `UPDATE subagents SET status='interrupted',message=?,last_activity_at=?,completed_at=?
         WHERE id=? AND status=? AND last_activity_at=?`,
      )
      .run(
        'Subagent is no longer active',
        terminalAt,
        terminalAt,
        id,
        expectedStatus,
        expectedLastActivityAt,
      );
    return result.changes === 1;
  }

  resetActiveSubagentRuntime(): number {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `UPDATE subagents SET status='interrupted',message='Runtime restarted',last_activity_at=?,completed_at=?
         WHERE status IN ('pendingInit','running')`,
      )
      .run(now, now);
    return Number(result.changes);
  }

  upsertThread(thread: Thread): Thread {
    this.database
      .prepare(
        `INSERT INTO threads(id,project_id,name,preview,model,status,active_turn_id,archived,instruction_sources_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,preview=excluded.preview,model=excluded.model,status=excluded.status,active_turn_id=excluded.active_turn_id,archived=excluded.archived,
      instruction_sources_json=excluded.instruction_sources_json,updated_at=excluded.updated_at`,
      )
      .run(
        thread.id,
        thread.projectId,
        thread.name,
        thread.preview,
        thread.model,
        thread.status,
        thread.activeTurnId,
        thread.archived ? 1 : 0,
        JSON.stringify(thread.instructionSources),
        thread.createdAt,
        thread.updatedAt,
      );
    return this.getThread(thread.id)!;
  }

  getThread(id: string): Thread | undefined {
    const row = this.database.prepare('SELECT * FROM threads WHERE id=?').get(id) as
      ThreadRow | undefined;
    return row && threadFromRow(row);
  }

  listThreads(projectId: string, archived: boolean): Thread[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM threads WHERE project_id=? AND archived=? ORDER BY updated_at DESC,id',
        )
        .all(projectId, archived ? 1 : 0) as unknown as ThreadRow[]
    ).map(threadFromRow);
  }

  setThreadArchived(id: string, archived: boolean): Thread | undefined {
    this.database
      .prepare('UPDATE threads SET archived=?,updated_at=? WHERE id=?')
      .run(archived ? 1 : 0, new Date().toISOString(), id);
    return this.getThread(id);
  }

  updateThreadRuntime(
    id: string,
    patch: Partial<Pick<Thread, 'name' | 'status' | 'activeTurnId'>>,
  ): Thread | undefined {
    const current = this.getThread(id);
    if (!current) return undefined;
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.database
      .prepare('UPDATE threads SET name=?,status=?,active_turn_id=?,updated_at=? WHERE id=?')
      .run(updated.name, updated.status, updated.activeTurnId, updated.updatedAt, id);
    return this.getThread(id);
  }

  resetActiveThreadRuntime(): string[] {
    const threadIds = (
      this.database
        .prepare("SELECT id FROM threads WHERE active_turn_id IS NOT NULL OR status='active'")
        .all() as unknown as Array<{ id: string }>
    ).map((row) => row.id);
    this.database
      .prepare(
        "UPDATE threads SET status=CASE WHEN status='active' THEN 'notLoaded' ELSE status END,active_turn_id=NULL WHERE active_turn_id IS NOT NULL OR status='active'",
      )
      .run();
    return threadIds;
  }

  createAttachment(input: Omit<AttachmentRecord, 'turnId' | 'createdAt'>): AttachmentRecord {
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO attachments(id,thread_id,name,mime_type,kind,size_bytes,storage_name,turn_id,created_at)
       VALUES(?,?,?,?,?,?,?,NULL,?)`,
      )
      .run(
        input.id,
        input.threadId,
        input.name,
        input.mimeType,
        input.kind,
        input.size,
        input.storageName,
        createdAt,
      );
    return this.getAttachment(input.id)!;
  }

  getAttachment(id: string): AttachmentRecord | undefined {
    const row = this.database.prepare('SELECT * FROM attachments WHERE id=?').get(id) as
      AttachmentRow | undefined;
    return row && attachmentFromRow(row);
  }

  listAttachments(threadId: string): AttachmentRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM attachments WHERE thread_id=? ORDER BY created_at,id')
        .all(threadId) as unknown as AttachmentRow[]
    ).map(attachmentFromRow);
  }

  attachmentBytesForThread(threadId: string): number {
    const row = this.database
      .prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM attachments WHERE thread_id=?')
      .get(threadId) as { bytes: number };
    return row.bytes;
  }

  claimAttachmentDeletion(id: string, threadId: string, claimToken: string): boolean {
    return (
      this.database
        .prepare('UPDATE attachments SET turn_id=? WHERE id=? AND thread_id=? AND turn_id IS NULL')
        .run(claimToken, id, threadId).changes === 1
    );
  }

  completeAttachmentDeletion(id: string, threadId: string, claimToken: string): boolean {
    return (
      this.database
        .prepare('DELETE FROM attachments WHERE id=? AND thread_id=? AND turn_id=?')
        .run(id, threadId, claimToken).changes === 1
    );
  }

  releaseAttachmentDeletion(id: string, threadId: string, claimToken: string): boolean {
    return (
      this.database
        .prepare('UPDATE attachments SET turn_id=NULL WHERE id=? AND thread_id=? AND turn_id=?')
        .run(id, threadId, claimToken).changes === 1
    );
  }

  claimAttachments(threadId: string, ids: readonly string[], claimToken: string): boolean {
    if (ids.length === 0) return true;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) {
        const changed = this.database
          .prepare(
            'UPDATE attachments SET turn_id=? WHERE id=? AND thread_id=? AND turn_id IS NULL',
          )
          .run(claimToken, id, threadId).changes;
        if (changed !== 1) throw new Error('ATTACHMENT_CLAIM_FAILED');
      }
      this.database.exec('COMMIT');
      return true;
    } catch {
      this.database.exec('ROLLBACK');
      return false;
    }
  }

  finalizeAttachmentClaims(threadId: string, claimToken: string, turnId: string): boolean {
    return (
      this.database
        .prepare('UPDATE attachments SET turn_id=? WHERE thread_id=? AND turn_id=?')
        .run(turnId, threadId, claimToken).changes > 0
    );
  }

  releaseAttachmentClaims(threadId: string, claimToken: string): number {
    return Number(
      this.database
        .prepare('UPDATE attachments SET turn_id=NULL WHERE thread_id=? AND turn_id=?')
        .run(threadId, claimToken).changes,
    );
  }

  enqueueTurn(input: {
    threadId: string;
    idempotencyKey: string;
    requestHash: string;
    request: StartTurnRequest;
    claimToken: string;
  }): { record: QueuedTurnRecord; position: number } {
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const count = this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM queued_turns WHERE status IN ('queued','dispatching')",
        )
        .get() as { count: number };
      if (count.count >= MAX_QUEUED_TURNS) throw new TurnQueueStorageLimitError();
      for (const attachmentId of input.request.attachmentIds) {
        const claimed = this.database
          .prepare(
            'UPDATE attachments SET turn_id=? WHERE id=? AND thread_id=? AND turn_id IS NULL',
          )
          .run(input.claimToken, attachmentId, input.threadId).changes;
        if (claimed !== 1) throw new Error('ATTACHMENT_CLAIM_FAILED');
      }
      const inserted = this.database
        .prepare(
          `INSERT INTO queued_turns(thread_id,idempotency_key,request_hash,request_json,claim_token,status,error_code,created_at,updated_at)
           VALUES(?,?,?,?,?,'queued',NULL,?,?)`,
        )
        .run(
          input.threadId,
          input.idempotencyKey,
          input.requestHash,
          JSON.stringify(input.request),
          input.claimToken,
          now,
          now,
        );
      const id = Number(inserted.lastInsertRowid);
      const position = (
        this.database
          .prepare("SELECT COUNT(*) AS count FROM queued_turns WHERE status='queued' AND id<=?")
          .get(id) as { count: number }
      ).count;
      const response = {
        data: {
          status: 'queued',
          queuedTurn: {
            id,
            threadId: input.threadId,
            status: 'queued',
            position,
            textPreview: input.request.text.slice(0, 240),
            attachmentCount: input.request.attachmentIds.length,
            createdAt: now,
          },
        },
      };
      const completed = this.database
        .prepare(
          `UPDATE idempotency SET state='completed',response_json=?,updated_at=?
           WHERE operation=? AND key=? AND request_hash=? AND state='pending'`,
        )
        .run(
          JSON.stringify(response),
          now,
          `turn:${input.threadId}`,
          input.idempotencyKey,
          input.requestHash,
        ).changes;
      if (completed !== 1) throw new Error('IDEMPOTENCY_RESERVATION_LOST');
      this.database.exec('COMMIT');
      return { record: this.getQueuedTurn(id)!, position };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getQueuedTurn(id: number): QueuedTurnRecord | undefined {
    const row = this.database.prepare('SELECT * FROM queued_turns WHERE id=?').get(id) as
      QueuedTurnRow | undefined;
    return row && queuedTurnFromRow(row);
  }

  getQueuedTurnByIdempotency(
    threadId: string,
    idempotencyKey: string,
  ): QueuedTurnRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM queued_turns WHERE thread_id=? AND idempotency_key=?')
      .get(threadId, idempotencyKey) as QueuedTurnRow | undefined;
    return row && queuedTurnFromRow(row);
  }

  listQueuedTurns(threadId?: string): QueuedTurnRecord[] {
    const rows = (threadId === undefined
      ? this.database.prepare("SELECT * FROM queued_turns WHERE status='queued' ORDER BY id").all()
      : this.database
          .prepare("SELECT * FROM queued_turns WHERE status='queued' AND thread_id=? ORDER BY id")
          .all(threadId)) as unknown as QueuedTurnRow[];
    return rows.map(queuedTurnFromRow);
  }

  listVisibleQueuedTurns(threadId: string): QueuedTurnRecord[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM queued_turns WHERE thread_id=? AND status IN ('queued','unknown') ORDER BY id",
        )
        .all(threadId) as unknown as QueuedTurnRow[]
    ).map(queuedTurnFromRow);
  }

  listUnknownQueuedTurns(): QueuedTurnRecord[] {
    return (
      this.database
        .prepare("SELECT * FROM queued_turns WHERE status='unknown' ORDER BY id")
        .all() as unknown as QueuedTurnRow[]
    ).map(queuedTurnFromRow);
  }

  hasUnknownQueuedTurn(threadId: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 FROM queued_turns WHERE thread_id=? AND status='unknown' LIMIT 1")
        .get(threadId) !== undefined
    );
  }

  hasOutstandingQueuedTurns(threadId: string): boolean {
    return (
      this.database
        .prepare(
          "SELECT 1 FROM queued_turns WHERE thread_id=? AND status IN ('queued','dispatching','unknown','failed') LIMIT 1",
        )
        .get(threadId) !== undefined
    );
  }

  queuedTurnPosition(id: number): number | null {
    const current = this.getQueuedTurn(id);
    if (!current || current.status !== 'queued') return null;
    return (
      this.database
        .prepare("SELECT COUNT(*) AS count FROM queued_turns WHERE status='queued' AND id<=?")
        .get(id) as { count: number }
    ).count;
  }

  claimQueuedTurn(id: number): QueuedTurnRecord | undefined {
    const result = this.database
      .prepare(
        "UPDATE queued_turns SET status='dispatching',updated_at=? WHERE id=? AND status='queued'",
      )
      .run(new Date().toISOString(), id);
    return result.changes === 1 ? this.getQueuedTurn(id) : undefined;
  }

  cancelQueuedTurn(
    threadId: string,
    id: number,
  ):
    | { status: 'cancelled'; attachments: AttachmentRecord[] }
    | { status: 'not_found' }
    | { status: 'not_cancellable' } {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database
        .prepare('SELECT thread_id,status,claim_token FROM queued_turns WHERE id=?')
        .get(id) as
        { thread_id: string; status: QueuedTurnRecord['status']; claim_token: string } | undefined;
      if (!row || row.thread_id !== threadId) {
        this.database.exec('COMMIT');
        return { status: 'not_found' };
      }
      if (row.status !== 'queued') {
        this.database.exec('COMMIT');
        return { status: 'not_cancellable' };
      }
      const attachments = (
        this.database
          .prepare(
            'SELECT * FROM attachments WHERE thread_id=? AND turn_id=? ORDER BY created_at,id',
          )
          .all(threadId, row.claim_token) as unknown as AttachmentRow[]
      ).map(attachmentFromRow);
      const project = this.database
        .prepare('SELECT project_id FROM threads WHERE id=?')
        .get(threadId) as { project_id: string } | undefined;
      if (!project) throw new Error('QUEUED_TURN_PROJECT_MISSING');
      const now = new Date().toISOString();
      const insertDeletion = this.database.prepare(
        `INSERT INTO attachment_file_deletions(
           id,project_id,thread_id,storage_name,attempts,next_attempt_at,created_at,updated_at
         ) VALUES(?,?,?,?,0,?,?,?)`,
      );
      for (const attachment of attachments)
        insertDeletion.run(
          attachment.id,
          project.project_id,
          threadId,
          attachment.storageName,
          Date.now(),
          now,
          now,
        );
      const removedAttachments = this.database
        .prepare('DELETE FROM attachments WHERE thread_id=? AND turn_id=?')
        .run(threadId, row.claim_token).changes;
      if (removedAttachments !== attachments.length)
        throw new Error('QUEUED_TURN_ATTACHMENT_CANCELLATION_FAILED');
      const removed = this.database
        .prepare("DELETE FROM queued_turns WHERE id=? AND thread_id=? AND status='queued'")
        .run(id, threadId).changes;
      if (removed !== 1) throw new Error('QUEUED_TURN_CANCELLATION_FAILED');
      this.database.exec('COMMIT');
      return { status: 'cancelled', attachments };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listAttachmentFileDeletions(): AttachmentFileDeletionRecord[] {
    const now = Date.now();
    return (
      this.database
        .prepare(
          `SELECT id,project_id,thread_id,storage_name,attempts,next_attempt_at,created_at,updated_at
           FROM attachment_file_deletions WHERE next_attempt_at<=?
           ORDER BY next_attempt_at,created_at,id LIMIT 16`,
        )
        .all(now) as unknown as {
        id: string;
        project_id: string;
        thread_id: string;
        storage_name: string;
        attempts: number;
        next_attempt_at: number;
        created_at: string;
        updated_at: string;
      }[]
    ).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      threadId: row.thread_id,
      storageName: row.storage_name,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  hasAttachmentFileDeletion(id: string): boolean {
    return (
      this.database.prepare('SELECT 1 FROM attachment_file_deletions WHERE id=?').get(id) !==
      undefined
    );
  }

  completeAttachmentFileDeletion(id: string): boolean {
    return (
      this.database.prepare('DELETE FROM attachment_file_deletions WHERE id=?').run(id).changes ===
      1
    );
  }

  earliestAttachmentFileDeletionAttempt(): number | null {
    const row = this.database
      .prepare('SELECT MIN(next_attempt_at) AS next_attempt_at FROM attachment_file_deletions')
      .get() as { next_attempt_at: number | null };
    return row.next_attempt_at;
  }

  recordAttachmentFileDeletionFailure(
    id: string,
    expectedAttempts: number,
  ): { attempt: number; nextAttemptAt: number } | undefined {
    const attempt = expectedAttempts + 1;
    const delayMs = Math.min(3_600_000, 30_000 * 2 ** Math.min(expectedAttempts, 7));
    const nextAttemptAt = Date.now() + delayMs;
    const changed = this.database
      .prepare(
        `UPDATE attachment_file_deletions
         SET attempts=?,next_attempt_at=?,updated_at=? WHERE id=? AND attempts=?`,
      )
      .run(attempt, nextAttemptAt, new Date().toISOString(), id, expectedAttempts).changes;
    return changed === 1 ? { attempt, nextAttemptAt } : undefined;
  }

  requeueTurn(id: number): boolean {
    return (
      this.database
        .prepare(
          "UPDATE queued_turns SET status='queued',error_code=NULL,updated_at=? WHERE id=? AND status='dispatching'",
        )
        .run(new Date().toISOString(), id).changes === 1
    );
  }

  markQueuedTurnUnknown(id: number, errorCode: string): boolean {
    const record = this.getQueuedTurn(id);
    if (!record || record.status !== 'dispatching') return false;
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.database
        .prepare(
          "UPDATE queued_turns SET status='unknown',error_code=?,updated_at=? WHERE id=? AND status='dispatching'",
        )
        .run(errorCode, now, id).changes;
      this.database
        .prepare(
          "UPDATE idempotency SET state='unknown',updated_at=? WHERE operation=? AND key=? AND request_hash=?",
        )
        .run(now, `turn:${record.threadId}`, record.idempotencyKey, record.requestHash);
      this.database.exec('COMMIT');
      return changed === 1;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  completeQueuedTurn(id: number, turnId: string): boolean {
    const record = this.getQueuedTurn(id);
    if (!record || (record.status !== 'dispatching' && record.status !== 'unknown')) return false;
    const now = new Date().toISOString();
    const response = { data: { status: 'started', turnId } };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (record.request.attachmentIds.length > 0)
        this.database
          .prepare('UPDATE attachments SET turn_id=? WHERE thread_id=? AND turn_id=?')
          .run(turnId, record.threadId, record.claimToken);
      const idempotency = this.database
        .prepare(
          `UPDATE idempotency SET state='completed',response_json=?,updated_at=?
           WHERE operation=? AND key=? AND request_hash=? AND state IN ('completed','unknown')`,
        )
        .run(
          JSON.stringify(response),
          now,
          `turn:${record.threadId}`,
          record.idempotencyKey,
          record.requestHash,
        ).changes;
      const removed = this.database
        .prepare("DELETE FROM queued_turns WHERE id=? AND status IN ('dispatching','unknown')")
        .run(id).changes;
      if (idempotency !== 1 || removed !== 1) throw new Error('QUEUED_TURN_COMPLETION_FAILED');
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  isThreadHistoryHydrated(threadId: string): boolean {
    return (
      this.database
        .prepare('SELECT 1 FROM thread_history_state WHERE thread_id=?')
        .get(threadId) !== undefined
    );
  }

  markThreadHistoryHydrated(threadId: string): void {
    this.database
      .prepare(
        `INSERT INTO thread_history_state(thread_id,hydrated_at) VALUES(?,?)
         ON CONFLICT(thread_id) DO NOTHING`,
      )
      .run(threadId, new Date().toISOString());
  }

  reconcileThreadHistoryEvents(
    threadId: string,
    events: readonly Omit<SafeEvent, 'id' | 'createdAt'>[],
  ): SafeEvent[] {
    const fingerprint = (event: Omit<SafeEvent, 'id' | 'createdAt'>): string => {
      const canonicalJson = (value: unknown): string => {
        if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
        if (value !== null && typeof value === 'object') {
          const source = value as Record<string, unknown>;
          return `{${Object.keys(source)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
            .join(',')}}`;
        }
        return JSON.stringify(value) ?? 'null';
      };
      const identity =
        event.kind === 'turn'
          ? [event.turnId, event.kind, event.phase]
          : [event.turnId, event.kind, event.phase, event.payload];
      return createHash('sha256').update(canonicalJson(identity)).digest('hex');
    };

    const authoritativeCounts = new Map<string, number>();
    const fingerprints = events.map((event) => {
      const value = fingerprint(event);
      authoritativeCounts.set(value, (authoritativeCounts.get(value) ?? 0) + 1);
      return value;
    });
    const observedCounts = new Map(
      (
        this.database
          .prepare(
            'SELECT fingerprint,observed_count FROM thread_history_event_state WHERE thread_id=?',
          )
          .all(threadId) as unknown as ThreadHistoryEventStateRow[]
      ).map((row) => [row.fingerprint, row.observed_count] as const),
    );
    const retainedCounts = new Map<string, number>();
    for (const event of this.listEvents(threadId, 0)) {
      const value = fingerprint(event);
      retainedCounts.set(value, (retainedCounts.get(value) ?? 0) + 1);
    }
    const baselineCounts = new Map<string, number>();
    for (const value of authoritativeCounts.keys()) {
      baselineCounts.set(
        value,
        Math.max(observedCounts.get(value) ?? 0, retainedCounts.get(value) ?? 0),
      );
    }

    const occurrenceCounts = new Map<string, number>();
    const appended: SafeEvent[] = [];
    const createdAt = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const insertEvent = this.database.prepare(
        'INSERT INTO events(thread_id,turn_id,kind,phase,payload_json,created_at) VALUES(?,?,?,?,?,?)',
      );
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index]!;
        const value = fingerprints[index]!;
        const occurrence = (occurrenceCounts.get(value) ?? 0) + 1;
        occurrenceCounts.set(value, occurrence);
        if (occurrence <= (baselineCounts.get(value) ?? 0)) continue;
        const result = insertEvent.run(
          event.threadId,
          event.turnId,
          event.kind,
          event.phase,
          JSON.stringify(event.payload),
          createdAt,
        );
        appended.push({ ...event, id: Number(result.lastInsertRowid), createdAt });
      }
      const upsertState = this.database.prepare(
        `INSERT INTO thread_history_event_state(thread_id,fingerprint,observed_count,updated_at)
         VALUES(?,?,?,?)
         ON CONFLICT(thread_id,fingerprint) DO UPDATE SET
           observed_count=MAX(thread_history_event_state.observed_count,excluded.observed_count),
           updated_at=excluded.updated_at`,
      );
      for (const [value, count] of authoritativeCounts)
        upsertState.run(threadId, value, count, createdAt);
      const deleteState = this.database.prepare(
        'DELETE FROM thread_history_event_state WHERE thread_id=? AND fingerprint=?',
      );
      for (const value of observedCounts.keys()) {
        if (!authoritativeCounts.has(value)) deleteState.run(threadId, value);
      }
      this.database
        .prepare(
          `DELETE FROM events
           WHERE thread_id=?
             AND id NOT IN (
               SELECT id FROM events WHERE thread_id=? ORDER BY id DESC LIMIT ?
             )
             AND id NOT IN (
               SELECT id FROM events
               WHERE thread_id=? AND kind='user-message'
               ORDER BY id DESC LIMIT ?
             )
             AND id NOT IN (
               SELECT id FROM events
               WHERE thread_id=? AND kind='agent-message'
                 AND json_extract(payload_json,'$.messagePhase')='final_answer'
               ORDER BY id DESC LIMIT ?
             )
             AND id NOT IN (
               SELECT id FROM events
               WHERE thread_id=? AND phase='completed'
                 AND (
                   kind='file-change'
                   OR (
                     kind='tool'
                     AND json_extract(payload_json,'$.item.type')='fileChange'
                     AND COALESCE(json_extract(payload_json,'$.item.status'),'completed')='completed'
                   )
                 )
               ORDER BY id DESC LIMIT ?
             )
             AND id NOT IN (
               SELECT id FROM events
               WHERE thread_id=? AND kind='turn' AND phase='completed'
                 AND (
                   json_extract(payload_json,'$.status')='completed'
                   OR json_extract(payload_json,'$.turn.status')='completed'
                 )
               ORDER BY id DESC LIMIT ?
             )`,
        )
        .run(
          threadId,
          threadId,
          this.eventRetentionPerThread,
          threadId,
          this.eventRetentionPerThread,
          threadId,
          this.eventRetentionPerThread,
          threadId,
          this.eventRetentionPerThread,
          threadId,
          this.eventRetentionPerThread,
        );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    if (appended.length === 0) return appended;
    const retainedIds = new Set(
      (
        this.database
          .prepare('SELECT id FROM events WHERE thread_id=? AND id>=? ORDER BY id')
          .all(threadId, appended[0]!.id) as unknown as Array<{ id: number }>
      ).map((row) => row.id),
    );
    return appended.filter((event) => retainedIds.has(event.id));
  }

  appendEvent(event: Omit<SafeEvent, 'id' | 'createdAt'>): SafeEvent {
    const createdAt = new Date().toISOString();
    const result = this.database
      .prepare(
        'INSERT INTO events(thread_id,turn_id,kind,phase,payload_json,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        event.threadId,
        event.turnId,
        event.kind,
        event.phase,
        JSON.stringify(event.payload),
        createdAt,
      );
    const id = Number(result.lastInsertRowid);
    this.database
      .prepare(
        `DELETE FROM events
         WHERE thread_id=?
           AND id NOT IN (
             SELECT id FROM events WHERE thread_id=? ORDER BY id DESC LIMIT ?
           )
           AND id NOT IN (
             SELECT id FROM events
             WHERE thread_id=? AND kind='user-message'
             ORDER BY id DESC LIMIT ?
           )
           AND id NOT IN (
             SELECT id FROM events
             WHERE thread_id=? AND kind='agent-message'
               AND json_extract(payload_json,'$.messagePhase')='final_answer'
             ORDER BY id DESC LIMIT ?
           )
           AND id NOT IN (
             SELECT id FROM events
             WHERE thread_id=? AND phase='completed'
               AND (
                 kind='file-change'
                 OR (
                   kind='tool'
                   AND json_extract(payload_json,'$.item.type')='fileChange'
                   AND COALESCE(json_extract(payload_json,'$.item.status'),'completed')='completed'
                 )
               )
             ORDER BY id DESC LIMIT ?
           )
           AND id NOT IN (
             SELECT id FROM events
             WHERE thread_id=? AND kind='turn' AND phase='completed'
               AND (
                 json_extract(payload_json,'$.status')='completed'
                 OR json_extract(payload_json,'$.turn.status')='completed'
               )
             ORDER BY id DESC LIMIT ?
           )`,
      )
      .run(
        event.threadId,
        event.threadId,
        this.eventRetentionPerThread,
        event.threadId,
        this.eventRetentionPerThread,
        event.threadId,
        this.eventRetentionPerThread,
        event.threadId,
        this.eventRetentionPerThread,
        event.threadId,
        this.eventRetentionPerThread,
      );
    return { ...event, id, createdAt };
  }

  private turnNavigationFromRow(row: TurnNavigationRow): TurnNavigationEntry {
    return {
      id: row.id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      label: row.label,
    };
  }

  appendTurnNavigation(entry: Omit<TurnNavigationEntry, 'id'>): TurnNavigationEntry {
    const result = this.database
      .prepare('INSERT INTO turn_navigation(thread_id,turn_id,label) VALUES(?,?,?)')
      .run(entry.threadId, entry.turnId, entry.label);
    this.database
      .prepare(
        `DELETE FROM turn_navigation WHERE thread_id=? AND id NOT IN (
           SELECT id FROM turn_navigation WHERE thread_id=? ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(entry.threadId, entry.threadId, this.eventRetentionPerThread);
    return { ...entry, id: Number(result.lastInsertRowid) };
  }

  listTurnNavigation(threadId: string): TurnNavigationEntry[] {
    return (
      this.database
        .prepare('SELECT * FROM turn_navigation WHERE thread_id=? ORDER BY id')
        .all(threadId) as unknown as TurnNavigationRow[]
    ).map((row) => this.turnNavigationFromRow(row));
  }

  replaceTurnNavigation(
    threadId: string,
    entries: readonly Omit<TurnNavigationEntry, 'id'>[],
  ): TurnNavigationEntry[] {
    const retained = entries.slice(-this.eventRetentionPerThread);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM turn_navigation WHERE thread_id=?').run(threadId);
      const insert = this.database.prepare(
        'INSERT INTO turn_navigation(thread_id,turn_id,label) VALUES(?,?,?)',
      );
      for (const entry of retained) insert.run(threadId, entry.turnId, entry.label);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.listTurnNavigation(threadId);
  }

  eventHighWater(threadId: string): number {
    const row = this.database
      .prepare('SELECT COALESCE(MAX(id),0) AS id FROM events WHERE thread_id=?')
      .get(threadId) as { id: number };
    return row.id;
  }

  listEventPage(threadId: string, afterId: number, throughId: number, limit = 500): SafeEvent[] {
    return (
      this.database
        .prepare('SELECT * FROM events WHERE thread_id=? AND id>? AND id<=? ORDER BY id LIMIT ?')
        .all(threadId, afterId, throughId, limit) as unknown as EventRow[]
    ).map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      kind: row.kind,
      phase: row.phase,
      payload: jsonRecord(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  listEvents(threadId: string, afterId: number, limit?: number): SafeEvent[] {
    const throughId = this.eventHighWater(threadId);
    if (limit !== undefined) return this.listEventPage(threadId, afterId, throughId, limit);
    const events: SafeEvent[] = [];
    let cursor = afterId;
    while (cursor < throughId) {
      const page = this.listEventPage(threadId, cursor, throughId);
      if (page.length === 0) break;
      events.push(...page);
      cursor = page.at(-1)!.id;
    }
    return events;
  }

  createApproval(input: Omit<PendingApproval, 'id' | 'createdAt' | 'status'>): PendingApproval {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO approvals(id,thread_id,turn_id,rpc_request_id,rpc_request_id_type,method,summary,details_json,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.threadId,
        input.turnId,
        String(input.rpcRequestId),
        typeof input.rpcRequestId,
        input.method,
        input.summary,
        JSON.stringify(input.details),
        'pending',
        createdAt,
      );
    return { ...input, id, status: 'pending', createdAt };
  }

  private approvalFromRow(row: ApprovalRow): ApprovalRecord {
    return {
      id: row.id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      rpcRequestId:
        row.rpc_request_id_type === 'number' ? Number(row.rpc_request_id) : row.rpc_request_id,
      method: row.method,
      summary: row.summary,
      details: jsonRecord(row.details_json),
      status: row.status,
      createdAt: row.created_at,
    };
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.database.prepare('SELECT * FROM approvals WHERE id=?').get(id) as
      ApprovalRow | undefined;
    return row && this.approvalFromRow(row);
  }

  listUnfinishedApprovals(): ApprovalRecord[] {
    return (
      this.database
        .prepare("SELECT * FROM approvals WHERE status IN ('pending','resolving') ORDER BY rowid")
        .all() as unknown as ApprovalRow[]
    ).map((row) => this.approvalFromRow(row));
  }

  claimApproval(id: string): boolean {
    return (
      this.database
        .prepare("UPDATE approvals SET status='resolving' WHERE id=? AND status='pending'")
        .run(id).changes === 1
    );
  }

  finalizeApproval(id: string, status: Exclude<PendingApproval['status'], 'pending'>): boolean {
    return (
      this.database
        .prepare("UPDATE approvals SET status=?,resolved_at=? WHERE id=? AND status='resolving'")
        .run(status, new Date().toISOString(), id).changes === 1
    );
  }

  cancelUnfinishedApproval(id: string): boolean {
    return (
      Number(
        this.database
          .prepare(
            "UPDATE approvals SET status='cancelled',resolved_at=? WHERE id=? AND status IN ('pending','resolving')",
          )
          .run(new Date().toISOString(), id).changes,
      ) === 1
    );
  }

  getIdempotent(
    operation: string,
    key: string,
  ):
    | {
        requestHash: string;
        state: 'pending' | 'completed' | 'unknown';
        response?: unknown;
      }
    | undefined {
    const row = this.database
      .prepare(
        'SELECT request_hash,state,response_json FROM idempotency WHERE operation=? AND key=?',
      )
      .get(operation, key) as
      | {
          request_hash: string;
          state: 'pending' | 'completed' | 'unknown';
          response_json: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      requestHash: row.request_hash,
      state: row.state,
      ...(row.response_json === null ? {} : { response: JSON.parse(row.response_json) as unknown }),
    };
  }

  reserveIdempotent(
    operation: string,
    key: string,
    requestHash: string,
  ):
    | { reserved: true }
    | {
        reserved: false;
        record: NonNullable<ReturnType<SqliteRepository['getIdempotent']>>;
      } {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `INSERT INTO idempotency(operation,key,request_hash,state,response_json,created_at,updated_at)
         VALUES(?,?,?,'pending',NULL,?,?) ON CONFLICT(operation,key) DO NOTHING`,
      )
      .run(operation, key, requestHash, now, now);
    if (result.changes === 1) return { reserved: true };
    return { reserved: false, record: this.getIdempotent(operation, key)! };
  }

  completeIdempotent(
    operation: string,
    key: string,
    requestHash: string,
    response: unknown,
  ): boolean {
    return (
      this.database
        .prepare(
          `UPDATE idempotency SET state='completed',response_json=?,updated_at=?
           WHERE operation=? AND key=? AND request_hash=? AND state='pending'`,
        )
        .run(JSON.stringify(response), new Date().toISOString(), operation, key, requestHash)
        .changes === 1
    );
  }

  markIdempotentUnknown(operation: string, key: string, requestHash: string): boolean {
    return (
      this.database
        .prepare(
          `UPDATE idempotency SET state='unknown',updated_at=?
           WHERE operation=? AND key=? AND request_hash=? AND state='pending'`,
        )
        .run(new Date().toISOString(), operation, key, requestHash).changes === 1
    );
  }

  releasePendingIdempotent(operation: string, key: string, requestHash: string): boolean {
    return (
      this.database
        .prepare(
          `DELETE FROM idempotency
           WHERE operation=? AND key=? AND request_hash=? AND state='pending'`,
        )
        .run(operation, key, requestHash).changes === 1
    );
  }

  markPendingIdempotencyUnknown(): number {
    return Number(
      this.database
        .prepare("UPDATE idempotency SET state='unknown',updated_at=? WHERE state='pending'")
        .run(new Date().toISOString()).changes,
    );
  }

  audit(action: string, outcome: string, metadata: Record<string, unknown> = {}): void {
    this.database
      .prepare('INSERT INTO audit_events(action,outcome,metadata_json,created_at) VALUES(?,?,?,?)')
      .run(action, outcome, JSON.stringify(metadata), new Date().toISOString());
  }
}
