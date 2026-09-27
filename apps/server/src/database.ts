import type { Attachment, PendingApproval, Project, SafeEvent, Thread } from '@codex-web/contracts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
        instruction_sources_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS threads_project_idx ON threads(project_id, archived, updated_at DESC);

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

      CREATE TABLE IF NOT EXISTS thread_history_state (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        hydrated_at TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.migrateApprovalResolvingState();
    this.migrateIdempotencyState();
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

  listProjects(): Project[] {
    return (
      this.database
        .prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE,id')
        .all() as unknown as ProjectRow[]
    ).map(projectFromRow);
  }

  getProject(id: string): Project | undefined {
    const row = this.database.prepare('SELECT * FROM projects WHERE id=?').get(id) as
      ProjectRow | undefined;
    return row && projectFromRow(row);
  }

  createProject(input: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): Project {
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

  upsertThread(thread: Thread): Thread {
    this.database
      .prepare(
        `INSERT INTO threads(id,project_id,name,preview,model,status,archived,instruction_sources_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,preview=excluded.preview,model=excluded.model,status=excluded.status,archived=excluded.archived,
      instruction_sources_json=excluded.instruction_sources_json,updated_at=excluded.updated_at`,
      )
      .run(
        thread.id,
        thread.projectId,
        thread.name,
        thread.preview,
        thread.model,
        thread.status,
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
        `DELETE FROM events WHERE thread_id=? AND id NOT IN (
      SELECT id FROM events WHERE thread_id=? ORDER BY id DESC LIMIT ?
    )`,
      )
      .run(event.threadId, event.threadId, this.eventRetentionPerThread);
    return { ...event, id, createdAt };
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
