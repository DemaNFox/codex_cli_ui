import type { SafeEvent } from '@codex-web/contracts';

import { publicSubagentItem } from './subagents.js';

export interface RpcNotification {
  readonly method: string;
  readonly params: unknown;
}

/* eslint-disable no-control-regex -- terminal control bytes must be stripped before persistence. */
const ANSI_PATTERN = new RegExp(
  '[\\u001b\\u009b][[\\]\\()#;?]*(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*)?\\u0007|(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~])',
  'g',
);
/* eslint-enable no-control-regex */
const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /\b(password|token|secret|authorization|cookie|api[_-]?key|private[_-]?key)\b\s*[:=]\s*([^\s,;]+)/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
];

function privateKeyName(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    normalized === 'env' ||
    normalized.startsWith('environment') ||
    normalized.includes('apikey') ||
    normalized.includes('privatekey') ||
    /^(?:password|token|secret|authorization|cookie|cookies)$/.test(normalized)
  );
}

const METHOD_MAP: Readonly<Record<string, { kind: SafeEvent['kind']; phase: SafeEvent['phase'] }>> =
  {
    'thread/started': { kind: 'thread', phase: 'started' },
    'thread/status/changed': { kind: 'thread', phase: 'state' },
    'thread/archived': { kind: 'thread', phase: 'state' },
    'thread/unarchived': { kind: 'thread', phase: 'state' },
    'thread/name/updated': { kind: 'thread', phase: 'state' },
    'turn/started': { kind: 'turn', phase: 'started' },
    'turn/completed': { kind: 'turn', phase: 'completed' },
    'turn/diff/updated': { kind: 'file-change', phase: 'delta' },
    'turn/plan/updated': { kind: 'plan', phase: 'state' },
    'item/started': { kind: 'tool', phase: 'started' },
    'item/completed': { kind: 'tool', phase: 'completed' },
    'item/agentMessage/delta': { kind: 'agent-message', phase: 'delta' },
    'item/plan/delta': { kind: 'plan', phase: 'delta' },
    'item/reasoning/summaryTextDelta': { kind: 'plan', phase: 'delta' },
    'item/reasoning/summaryPartAdded': { kind: 'plan', phase: 'state' },
    'item/commandExecution/outputDelta': { kind: 'command', phase: 'delta' },
    'item/commandExecution/terminalInteraction': { kind: 'command', phase: 'state' },
    'item/fileChange/outputDelta': { kind: 'file-change', phase: 'delta' },
    'item/fileChange/patchUpdated': { kind: 'file-change', phase: 'state' },
    'item/mcpToolCall/progress': { kind: 'tool', phase: 'delta' },
    warning: { kind: 'warning', phase: 'state' },
    guardianWarning: { kind: 'warning', phase: 'state' },
    configWarning: { kind: 'warning', phase: 'state' },
    error: { kind: 'error', phase: 'failed' },
  };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: string, maxLength: number): string {
  let output = value.replace(ANSI_PATTERN, '');
  for (const pattern of SECRET_PATTERNS)
    output = output.replace(pattern, (_match, prefix?: string) => `${prefix ?? ''}[REDACTED]`);
  return output.length <= maxLength
    ? output
    : `${output.slice(0, Math.max(0, maxLength - 13))}…[truncated]`;
}

export function sanitizePublicText(value: string, maxLength: number): string {
  return boundedString(value, maxLength);
}

function sanitize(value: unknown, budget: { remaining: number }, depth = 0): unknown {
  if (budget.remaining <= 0) return '[truncated]';
  if (depth > 8) return '[max-depth]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const result = boundedString(value, Math.min(16_384, budget.remaining));
    budget.remaining -= Buffer.byteLength(result);
    return result;
  }
  if (Array.isArray(value))
    return value.slice(0, 200).map((item) => sanitize(item, budget, depth + 1));
  const source = record(value);
  if (!source) return typeof value === 'bigint' ? value.toString() : '[unsupported]';
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source).slice(0, 200)) {
    if (
      /^(?:raw|encrypted|chain.?of.?thought|reasoningText|auth|headers)$/i.test(key) ||
      privateKeyName(key)
    )
      continue;
    output[key] = sanitize(child, budget, depth + 1);
  }
  return output;
}

export function sanitizeEventPayload(value: unknown, maxBytes: number): Record<string, unknown> {
  const payload = record(sanitize(value, { remaining: maxBytes })) ?? {};
  if (Buffer.byteLength(JSON.stringify(payload)) <= maxBytes) return payload;
  const fallback = { truncated: true };
  return Buffer.byteLength(JSON.stringify(fallback)) <= maxBytes ? fallback : {};
}

function nestedString(
  source: Record<string, unknown>,
  ...paths: readonly string[][]
): string | null {
  for (const segments of paths) {
    let current: unknown = source;
    for (const segment of segments) current = record(current)?.[segment];
    if (typeof current === 'string' && current.length > 0) return current;
  }
  return null;
}

export function normalizeNotification(
  notification: RpcNotification,
  maxBytes: number,
): Omit<SafeEvent, 'id' | 'createdAt'> | null {
  // Raw hidden reasoning is intentionally never journaled.
  if (notification.method === 'item/reasoning/textDelta') return null;
  const mapping = METHOD_MAP[notification.method];
  if (!mapping) return null;
  const params = record(notification.params);
  if (!params) return null;
  const threadId = nestedString(params, ['threadId'], ['thread', 'id']);
  if (!threadId) return null;
  const turnId = nestedString(params, ['turnId'], ['turn', 'id']);
  const publicItem = publicSubagentItem(params.item);
  const payload = sanitizeEventPayload(
    publicItem ? { ...params, item: publicItem } : params,
    maxBytes,
  );
  return {
    threadId,
    turnId,
    kind: mapping.kind,
    phase: mapping.phase,
    payload,
  };
}

export const SUPPORTED_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);

export function normalizeApproval(method: string, requestId: string | number, params: unknown) {
  if (!SUPPORTED_APPROVAL_METHODS.has(method)) return null;
  const source = record(params);
  if (!source || typeof source.threadId !== 'string') return null;
  const turnId = typeof source.turnId === 'string' ? source.turnId : null;
  const reason = typeof source.reason === 'string' ? boundedString(source.reason, 1_024) : null;
  const command = typeof source.command === 'string' ? boundedString(source.command, 4_096) : null;
  const summary =
    command ??
    reason ??
    (method.includes('fileChange') ? 'Approve file changes' : 'Approve command');
  const details = sanitizeEventPayload(source, 32_768);
  return {
    threadId: source.threadId,
    turnId,
    rpcRequestId: requestId,
    method,
    summary,
    details,
  };
}
