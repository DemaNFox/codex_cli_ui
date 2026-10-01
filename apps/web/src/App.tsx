import {
  ClipboardEvent,
  DragEvent,
  FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  ApprovalPolicy,
  PermissionPreset,
  ResolveUserInputRequest,
  UserInputQuestion,
} from '@codex-web/contracts';

import { ApiError, api } from './api.js';
import { AgentMessageContent } from './AgentMessageContent.js';
import type {
  Attachment,
  Capability,
  CodexAccountLogin,
  CodexUpdateSnapshot,
  ModelOption,
  PendingApproval,
  Project,
  ResourceLimitPolicy,
  ResourceLimitSnapshot,
  RuntimePreferences,
  SafeEvent,
  Session,
  Subagent,
  Thread,
  TurnNavigationEntry,
} from './api.js';
import { useThreadEvents } from './useThreadEvents.js';
import { VoiceInputButton } from './VoiceInputButton.js';

type LoadState = 'loading' | 'ready' | 'signed-out';
type PushNotificationState =
  | 'unavailable'
  | 'insecure'
  | 'unsupported'
  | 'checking'
  | 'subscribed'
  | 'unsubscribed'
  | 'denied'
  | 'error';

const MAX_ATTACHMENTS_PER_TURN = 8;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_THREAD_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const ACCOUNT_LOGIN_POLL_INTERVAL_MS = 500;
const ACCOUNT_LOGIN_MAX_POLLS = 1_800;
const CODEX_UPDATE_POLL_INTERVAL_MS = 1_000;
const EVENT_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short',
  timeStyle: 'medium',
});

function pushSupportIssue(): 'insecure' | 'unsupported' | null {
  if (!window.isSecureContext) return 'insecure';
  if (
    typeof Notification === 'undefined' ||
    !('serviceWorker' in navigator) ||
    typeof PushManager === 'undefined'
  ) {
    return 'unsupported';
  }
  return null;
}

function vapidKeyBuffer(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = window.atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function pushNotificationLabel(state: PushNotificationState): string {
  switch (state) {
    case 'subscribed':
      return 'Отключить уведомления для этого чата';
    case 'checking':
      return 'Проверяем подписку на уведомления…';
    case 'insecure':
      return 'Уведомления доступны только по HTTPS или на localhost';
    case 'denied':
      return 'Уведомления запрещены в настройках браузера';
    case 'unsupported':
      return 'Этот браузер не поддерживает push-уведомления';
    case 'unavailable':
      return 'Уведомления не настроены на сервере';
    case 'error':
      return 'Не удалось проверить подписку на уведомления';
    default:
      return 'Включить уведомления для этого чата';
  }
}

function fitComposerInput(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  if (input.value) input.style.height = `${input.scrollHeight}px`;
}

interface QueuedAttachment {
  localId: string;
  file: File;
  previewUrl: string | null;
  progress: number;
  status: 'queued' | 'uploading' | 'uploaded' | 'error';
  uploaded: Attachment | null;
  error: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function formatResourceBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toLocaleString('ru', { maximumFractionDigits: 1 })} ГБ`;
}

function formatDuration(startedAt: string, completedAt: string | null): string {
  const elapsed = Math.max(
    0,
    Date.parse(completedAt ?? new Date().toISOString()) - Date.parse(startedAt),
  );
  if (!Number.isFinite(elapsed)) return 'время неизвестно';
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1000);
  return minutes ? `${minutes} мин. ${seconds} сек.` : `${seconds} сек.`;
}

function useActiveTurnDuration(
  events: SafeEvent[],
  activeTurnId: string | null,
  active: boolean,
): string | null {
  const startedAt = useMemo(() => {
    if (!active || !activeTurnId) return null;
    const timestamps = events
      .filter((event) => event.turnId === activeTurnId)
      .map((event) => Date.parse(event.createdAt))
      .filter(Number.isFinite);
    return timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null;
  }, [active, activeTurnId, events]);
  const [now, setNow] = useState(() => new Date().toISOString());

  useEffect(() => {
    if (!active || !startedAt) return undefined;
    setNow(new Date().toISOString());
    const timer = window.setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);

  return startedAt ? formatDuration(startedAt, now) : null;
}

function formatResetTime(value: number | null): string {
  return value === null ? 'неизвестно' : new Date(value * 1000).toLocaleString('ru');
}

function formatMetric(value: number | null): string {
  return value === null ? 'нет данных' : value.toLocaleString('ru');
}

function formatEventDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : EVENT_TIME_FORMATTER.format(date);
}

function positionAtLatestImmediately(scroll: HTMLDivElement): void {
  const previousScrollBehavior = scroll.style.scrollBehavior;
  scroll.style.scrollBehavior = 'auto';
  scroll.scrollTop = scroll.scrollHeight;
  scroll.style.scrollBehavior = previousScrollBehavior;
}

const SLASH_COMMANDS = [
  { command: '/status', label: 'Статус, лимиты и использование' },
  { command: '/skills', label: 'Доступные скиллы и instruction sources' },
] as const;

function attachmentsFrom(event: SafeEvent): Attachment[] {
  if (!Array.isArray(event.payload.attachments)) return [];
  return event.payload.attachments.filter((item): item is Attachment => {
    if (!item || typeof item !== 'object') return false;
    const value = item as Record<string, unknown>;
    return (
      typeof value.id === 'string' &&
      typeof value.threadId === 'string' &&
      typeof value.name === 'string' &&
      typeof value.mediaType === 'string' &&
      (value.kind === 'image' || value.kind === 'file') &&
      typeof value.sizeBytes === 'number' &&
      typeof value.createdAt === 'string' &&
      typeof value.url === 'string'
    );
  });
}

const SUBAGENT_STATUSES = new Set<Subagent['status']>([
  'pendingInit',
  'running',
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound',
]);
const TERMINAL_SUBAGENT_STATUSES = new Set<Subagent['status']>([
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound',
]);

function shouldReplaceSubagent(current: Subagent, incoming: Subagent): boolean {
  const currentTime = Date.parse(current.lastActivityAt);
  const incomingTime = Date.parse(incoming.lastActivityAt);
  if (incomingTime > currentTime) return true;
  if (incomingTime < currentTime || Number.isNaN(incomingTime)) return false;
  if (Number.isNaN(currentTime)) return true;
  const currentTerminal = TERMINAL_SUBAGENT_STATUSES.has(current.status);
  const incomingTerminal = TERMINAL_SUBAGENT_STATUSES.has(incoming.status);
  if (currentTerminal !== incomingTerminal) return incomingTerminal;
  return true;
}

function mergeSubagents(current: Subagent[], incoming: readonly Subagent[]): Subagent[] {
  if (!incoming.length) return current;
  const next = new Map(current.map((subagent) => [subagent.id, subagent]));
  for (const update of incoming) {
    const existing = next.get(update.id);
    if (!existing || shouldReplaceSubagent(existing, update)) next.set(update.id, update);
  }
  return [...next.values()];
}

function subagentFrom(event: SafeEvent): Subagent | null {
  if (event.kind !== 'subagent') return null;
  const value = event.payload.subagent;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const nullableString = (item: unknown) => item === null || typeof item === 'string';
  if (
    typeof record.id !== 'string' ||
    typeof record.rootThreadId !== 'string' ||
    typeof record.parentThreadId !== 'string' ||
    !nullableString(record.agentPath) ||
    !nullableString(record.nickname) ||
    !nullableString(record.role) ||
    !nullableString(record.model) ||
    !nullableString(record.reasoningEffort) ||
    typeof record.status !== 'string' ||
    !SUBAGENT_STATUSES.has(record.status as Subagent['status']) ||
    !nullableString(record.message) ||
    typeof record.startedAt !== 'string' ||
    typeof record.lastActivityAt !== 'string' ||
    !nullableString(record.completedAt)
  )
    return null;
  return record as unknown as Subagent;
}

function threadRuntimeFrom(
  event: SafeEvent,
): { status: Thread['status']; activeTurnId: string | null } | null {
  const value = event.payload.threadRuntime;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (event.kind !== 'turn' || event.payload.runtime !== true) return null;
    const status: Thread['status'] =
      event.phase === 'started' ||
      event.payload.status === 'inProgress' ||
      event.payload.status === 'interruptRequested'
        ? 'active'
        : event.phase === 'failed'
          ? 'systemError'
          : 'idle';
    return { status, activeTurnId: status === 'active' ? event.turnId : null };
  }
  const runtime = value as Record<string, unknown>;
  if (
    !['notLoaded', 'idle', 'active', 'systemError', 'unknown'].includes(
      typeof runtime.status === 'string' ? runtime.status : '',
    )
  )
    return null;
  if (runtime.activeTurnId !== null && typeof runtime.activeTurnId !== 'string') return null;
  return {
    status: runtime.status as Thread['status'],
    activeTurnId: runtime.activeTurnId,
  };
}

function safeAttachmentUrl(value: string): string | null {
  return value.startsWith('/api/threads/') ? value : null;
}

function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null;
  return (
    <ul className="message-attachments" aria-label="Вложения сообщения">
      {attachments.map((attachment) => {
        const url = safeAttachmentUrl(attachment.url);
        return (
          <li key={attachment.id}>
            {attachment.kind === 'image' && url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Открыть ${attachment.name}`}
              >
                <img src={url} alt={attachment.name} loading="lazy" />
                <span>{attachment.name}</span>
              </a>
            ) : url ? (
              <a href={url} download={attachment.name}>
                <span className="attachment-file-icon" aria-hidden="true">
                  ↧
                </span>
                <span>
                  <strong>{attachment.name}</strong>
                  <small>{formatBytes(attachment.sizeBytes)}</small>
                </span>
              </a>
            ) : (
              <span className="attachment-unavailable">
                {attachment.name} · вложение недоступно
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function errorMessage(error: unknown): string {
  if (
    error instanceof ApiError &&
    (error.code === 'TURN_CAPACITY_EXHAUSTED' || error.code === 'RESOURCE_CAPACITY_EXHAUSTED')
  ) {
    return 'Сейчас заняты все безопасные слоты задач. Дождитесь завершения или остановите один из чатов с пометкой «В работе» и отправьте снова. Текст сохранён.';
  }
  return error instanceof Error ? error.message : 'Неизвестная ошибка';
}

function valueText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map(valueText).filter((part): part is string => part !== null);
    return parts.length ? parts.join('\n') : null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'message', 'summary', 'output', 'delta', 'diff', 'command']) {
    const nested = valueText(record[key]);
    if (nested) return nested;
  }
  return null;
}

function eventText(event: SafeEvent): string {
  const item = eventItem(event);
  if (item?.type === 'commandExecution' && typeof item.aggregatedOutput === 'string')
    return item.aggregatedOutput;
  if (item?.type === 'reasoning' && Array.isArray(item.summary)) {
    const summary = item.summary
      .filter((part): part is string => typeof part === 'string')
      .join('\n');
    if (summary) return summary;
  }
  if (item?.type === 'fileChange' && Array.isArray(item.changes)) {
    const paths = item.changes.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const path = (value as Record<string, unknown>).path;
      return typeof path === 'string' ? [path] : [];
    });
    if (paths.length) return paths.join('\n');
  }
  const text = valueText(event.payload);
  if (text) return text;
  if (
    (event.kind === 'user-message' || event.kind === 'agent-message') &&
    Array.isArray(event.payload.attachments)
  ) {
    return '';
  }
  return `${event.kind}: ${event.phase}`;
}

const MAX_TURN_NAVIGATION_LABEL_LENGTH = 2_000;

function turnNavigationLabel(text: string): string {
  const bounded =
    text.length <= MAX_TURN_NAVIGATION_LABEL_LENGTH
      ? text
      : `${text.slice(0, MAX_TURN_NAVIGATION_LABEL_LENGTH - 13)}…[truncated]`;
  return (
    bounded.replace(/\s+/gu, ' ').trim().slice(0, MAX_TURN_NAVIGATION_LABEL_LENGTH) ||
    'Задача без текста'
  );
}

function agentMessagePhase(event: SafeEvent): 'commentary' | 'final_answer' | null {
  if (event.kind !== 'agent-message') return null;
  const phase = event.payload.messagePhase;
  return phase === 'commentary' || phase === 'final_answer' ? phase : null;
}

function successfullyCompletedTurnIds(events: readonly SafeEvent[]): Set<string> {
  const completed = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'turn' || event.phase !== 'completed' || !event.turnId) continue;
    const nestedTurn =
      event.payload.turn && typeof event.payload.turn === 'object'
        ? (event.payload.turn as Record<string, unknown>)
        : null;
    const status =
      typeof event.payload.status === 'string'
        ? event.payload.status
        : typeof nestedTurn?.status === 'string'
          ? nestedTurn.status
          : null;
    if (status !== 'failed' && status !== 'interrupted') completed.add(event.turnId);
  }
  return completed;
}

function eventTitle(event: SafeEvent): string {
  if (event.kind === 'turn' && event.payload.status === 'interruptRequested')
    return 'Остановка запрошена';
  if (event.kind === 'tool') {
    const itemType = eventItem(event)?.type;
    if (itemType === 'commandExecution')
      return event.phase === 'completed' ? 'Выполнил команду' : 'Выполняет команду';
    if (itemType === 'fileChange')
      return event.phase === 'completed' ? 'Изменил файлы' : 'Изменяет файлы';
    if (itemType === 'reasoning')
      return event.phase === 'completed' ? 'Завершил анализ' : 'Анализирует';
  }
  const titles: Partial<Record<SafeEvent['kind'], Partial<Record<SafeEvent['phase'], string>>>> = {
    plan: { started: 'Составляет план', completed: 'План обновлён', failed: 'План не выполнен' },
    command: {
      started: 'Выполняет команду',
      completed: 'Выполнил команду',
      failed: 'Команда завершилась с ошибкой',
    },
    'file-change': {
      started: 'Изменяет файлы',
      completed: 'Изменил файлы',
      failed: 'Не удалось изменить файлы',
    },
    tool: {
      started: 'Использует инструмент',
      completed: 'Выполнил действие',
      failed: 'Действие завершилось с ошибкой',
    },
    turn: { failed: 'Задача завершилась с ошибкой' },
    warning: { state: 'Предупреждение' },
    error: { failed: 'Ошибка' },
  };
  const fallbacks: Partial<Record<SafeEvent['kind'], string>> = {
    plan: 'Обновил план',
    command: 'Работает в терминале',
    'file-change': 'Редактирует файлы',
    tool: 'Выполняет действие',
    usage: 'Использование',
    warning: 'Предупреждение',
    error: 'Ошибка',
    turn: 'Задача',
  };
  return titles[event.kind]?.[event.phase] ?? fallbacks[event.kind] ?? 'Событие';
}

function eventItem(event: SafeEvent): Record<string, unknown> | null {
  const item = event.payload.item;
  return item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
}

function fileChangePreview(item: Record<string, unknown>): string | null {
  if (!Array.isArray(item.changes)) return null;
  const paths = item.changes.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const path = (value as Record<string, unknown>).path;
    return typeof path === 'string' ? [path] : [];
  });
  if (!paths.length) return null;
  const visible = paths.slice(0, 2).join(', ');
  return paths.length > 2 ? `${visible} и ещё ${paths.length - 2}` : visible;
}

function eventPreview(event: SafeEvent): string | null {
  const source = event.payload;
  const item = eventItem(event);
  const itemType = typeof item?.type === 'string' ? item.type : null;
  const toolName =
    typeof item?.tool === 'string'
      ? [typeof item.server === 'string' ? item.server : item.namespace, item.tool]
          .filter((part): part is string => typeof part === 'string' && part.length > 0)
          .join(' · ')
      : null;
  const reasoningSummary =
    itemType === 'reasoning' && Array.isArray(item?.summary)
      ? item.summary.find((part): part is string => typeof part === 'string' && part.length > 0)
      : null;
  const candidates = [
    source.command,
    source.summary,
    source.message,
    source.name,
    source.tool,
    source.method,
    item?.title,
    item?.name,
    item?.command,
    itemType === 'fileChange' && item ? fileChangePreview(item) : null,
    reasoningSummary,
    toolName,
    itemType,
  ];
  let value = candidates.find((candidate): candidate is string => typeof candidate === 'string');
  if (!value) return null;
  if (value === item?.type) {
    value =
      {
        commandExecution: 'команда',
        fileChange: 'изменение файлов',
        mcpToolCall: 'внешний инструмент',
        reasoning: 'анализ',
      }[value] ?? '';
  }
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length <= 92 ? compact : `${compact.slice(0, 89)}…`;
}

function eventIdentity(event: SafeEvent): string | null {
  const source = event.payload;
  const item =
    source.item && typeof source.item === 'object'
      ? (source.item as Record<string, unknown>)
      : null;
  for (const candidate of [source.itemId, item?.id]) {
    if (typeof candidate === 'string' && candidate)
      return `${event.turnId ?? 'thread'}:${event.kind}:${candidate}`;
  }
  return null;
}

function mergeActivityPayload(
  started: Record<string, unknown>,
  finished: Record<string, unknown>,
): Record<string, unknown> {
  const startedItem =
    started.item && typeof started.item === 'object'
      ? (started.item as Record<string, unknown>)
      : null;
  const finishedItem =
    finished.item && typeof finished.item === 'object'
      ? (finished.item as Record<string, unknown>)
      : null;
  return {
    ...started,
    ...finished,
    ...(startedItem || finishedItem ? { item: { ...startedItem, ...finishedItem } } : {}),
  };
}

function pendingApprovalFrom(event: SafeEvent): PendingApproval | null {
  if (event.kind !== 'approval' || event.phase === 'completed') return null;
  const payload = event.payload;
  const nested = payload.approval;
  const value =
    nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : payload;
  if (typeof value.id !== 'string') return null;
  return {
    id: value.id,
    threadId: event.threadId,
    turnId: typeof event.turnId === 'string' ? event.turnId : null,
    rpcRequestId:
      typeof value.rpcRequestId === 'number' || typeof value.rpcRequestId === 'string'
        ? value.rpcRequestId
        : value.id,
    method: typeof value.method === 'string' ? value.method : 'approval',
    summary: typeof value.summary === 'string' ? value.summary : 'Codex запрашивает разрешение',
    details:
      value.details && typeof value.details === 'object'
        ? (value.details as Record<string, unknown>)
        : {},
    status: 'pending',
    createdAt: event.createdAt,
  };
}

function approvalEventId(event: SafeEvent): string | null {
  const nested = event.payload.approval;
  const value =
    nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : event.payload;
  return typeof value.id === 'string' ? value.id : null;
}

interface UserInputRequest {
  id: string;
  questions: UserInputQuestion[];
}

interface PermissionRequest {
  id: string;
  cwd: string;
  reason: string | null;
  permissions: Record<string, unknown>;
}

function requestPayload(event: SafeEvent): Record<string, unknown> | null {
  const request = event.payload.request;
  return request && typeof request === 'object' ? (request as Record<string, unknown>) : null;
}

function requestEventId(event: SafeEvent): string | null {
  const request = requestPayload(event);
  return request && typeof request.id === 'string' ? request.id : null;
}

function userInputRequestFrom(event: SafeEvent): UserInputRequest | null {
  if (event.kind !== 'user-input') return null;
  const request = requestPayload(event);
  if (!request || request.status !== 'pending' || typeof request.id !== 'string') return null;
  if (!Array.isArray(request.questions)) return null;
  const questions = request.questions.filter((question): question is UserInputQuestion => {
    if (!question || typeof question !== 'object') return false;
    const value = question as Record<string, unknown>;
    return (
      typeof value.id === 'string' &&
      typeof value.header === 'string' &&
      typeof value.question === 'string' &&
      (value.options === null || Array.isArray(value.options)) &&
      typeof value.isOther === 'boolean' &&
      typeof value.isSecret === 'boolean'
    );
  });
  return questions.length === request.questions.length ? { id: request.id, questions } : null;
}

function permissionRequestFrom(event: SafeEvent): PermissionRequest | null {
  if (event.kind !== 'permission-approval') return null;
  const request = requestPayload(event);
  if (!request || request.status !== 'pending' || typeof request.id !== 'string') return null;
  return {
    id: request.id,
    cwd: typeof request.cwd === 'string' ? request.cwd : 'Не указан',
    reason: typeof request.reason === 'string' ? request.reason : null,
    permissions:
      request.permissions && typeof request.permissions === 'object'
        ? (request.permissions as Record<string, unknown>)
        : {},
  };
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login(username, password));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="brand-mark" aria-hidden="true">
          C
        </div>
        <p className="eyebrow">PRIVATE WORKSPACE</p>
        <h1>Codex Server</h1>
        <p className="muted">Рабочее пространство на вашем Ubuntu-сервере</p>
        <label>
          Логин
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          Пароль
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={12}
          />
        </label>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        <button className="primary wide" disabled={busy}>
          {busy ? 'Входим…' : 'Войти'}
        </button>
      </form>
    </main>
  );
}

function CreateProjectForm({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string, path: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await onCreate(name, path);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="project-form" onSubmit={(event) => void submit(event)}>
      <label>
        Название
        <input value={name} onChange={(event) => setName(event.target.value)} required />
      </label>
      <label>
        Путь на сервере
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/srv/projects/app"
          required
        />
      </label>
      <div className="button-row">
        <button className="primary" disabled={busy}>
          Добавить
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}

function ContextMenu({
  label,
  children,
  disabled = false,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 8 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open]);

  return (
    <div
      className="row-menu"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false);
          rootRef.current?.querySelector<HTMLButtonElement>('.menu-trigger')?.focus();
        }
      }}
    >
      <button
        type="button"
        className="icon-button menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          if (!open) {
            const rect = event.currentTarget.getBoundingClientRect();
            setPosition({
              top: rect.bottom + 4,
              left: Math.max(8, Math.min(window.innerWidth - 188, rect.right - 180)),
            });
          }
          setOpen((value) => !value);
        }}
      >
        ⋯
      </button>
      {open &&
        createPortal(
          <div className="menu-popover" role="menu" style={position} ref={menuRef}>
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </div>
  );
}

function NavigationSidebar({
  projects,
  threads,
  recentThreads,
  selectedProjectId,
  selectedThreadId,
  archived,
  onSelectProject,
  onSelectThread,
  onNew,
  onNewInProject,
  onShowArchived,
  onArchive,
  onRestore,
  onRename,
  onBack,
  onCreate,
  onLogout,
  username,
  disabled,
  mobileOpen,
  onMobileClose,
}: {
  projects: Project[];
  threads: Thread[];
  recentThreads: Thread[];
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  archived: boolean;
  onSelectProject: (id: string) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onNew: () => void;
  onNewInProject: (projectId: string) => void;
  onShowArchived: (id: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onRename: (id: string, name: string) => Promise<void>;
  onBack: () => void;
  onCreate: (name: string, path: string) => Promise<void>;
  onLogout: () => void;
  username: string;
  disabled: boolean;
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Thread | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(selectedProjectId);
  useEffect(() => {
    if (selectedProjectId) setExpandedProjectId(selectedProjectId);
  }, [selectedProjectId]);

  const threadRows = (items: Thread[], showProject: boolean, archivedRows = false) =>
    items.map((thread) => {
      const project = projects.find((candidate) => candidate.id === thread.projectId);
      const running = thread.status === 'active';
      const displayName = thread.name || thread.preview || 'Новый чат';
      return (
        <div
          className={`thread-row ${thread.id === selectedThreadId ? 'selected' : ''}`}
          key={thread.id}
        >
          <button
            aria-label={`${showProject ? 'Открыть недавний чат' : 'Открыть чат проекта'} ${displayName}${running ? ' — в работе' : ''}`}
            onClick={() => onSelectThread(thread.projectId, thread.id)}
            disabled={disabled}
          >
            <span className="thread-row-title">
              <strong>{displayName}</strong>
              {running && <span className="thread-running-dot" aria-hidden="true" />}
            </span>
            <small>
              {showProject && project ? `${project.name} · ` : ''}
              {new Date(thread.updatedAt).toLocaleString('ru')}
            </small>
          </button>
          <ContextMenu
            label={`${showProject ? 'Меню недавнего чата' : 'Меню чата проекта'} ${thread.name || thread.preview || 'Новый чат'}`}
            disabled={disabled}
          >
            {(close) => (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    close();
                    setRenameTarget(thread);
                  }}
                >
                  Переименовать
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    close();
                    if (archivedRows) onRestore(thread.id);
                    else onArchive(thread.id);
                  }}
                >
                  {archivedRows ? 'Восстановить чат' : 'Архивировать чат'}
                </button>
              </>
            )}
          </ContextMenu>
        </div>
      );
    });

  return (
    <aside
      id="workspace-navigation"
      className={`navigation-sidebar ${mobileOpen ? 'mobile-open' : ''}`}
      aria-label="Навигация"
    >
      <div className="app-brand">
        <span className="mini-mark">C</span>
        <strong>Codex Server</strong>
        <button
          className="mobile-nav-close"
          type="button"
          onClick={onMobileClose}
          aria-label="Закрыть навигацию"
        >
          ×
        </button>
      </div>
      <div className="navigation-scroll">
        <button className="new-chat-button" onClick={onNew} disabled={!projects.length || disabled}>
          <span aria-hidden="true">＋</span>
          Новый чат
        </button>
        <div className="section-heading">
          <span>Проекты</span>
          <button
            className="icon-button"
            onClick={() => setCreating(true)}
            aria-label="Добавить проект"
            disabled={disabled}
          >
            ＋
          </button>
        </div>
        {creating && (
          <CreateProjectForm
            onCreate={async (name, path) => {
              await onCreate(name, path);
              setCreating(false);
            }}
            onCancel={() => setCreating(false)}
          />
        )}
        <nav className="project-list" aria-label="Проекты">
          {projects.map((project) => (
            <div className="project-group" key={project.id}>
              <div className={`project-row ${project.id === selectedProjectId ? 'selected' : ''}`}>
                <button
                  className="project-button"
                  aria-expanded={expandedProjectId === project.id}
                  onClick={() => {
                    const next = expandedProjectId === project.id ? null : project.id;
                    setExpandedProjectId(next);
                    if (next) onSelectProject(project.id);
                  }}
                  disabled={disabled}
                >
                  <span className="project-chevron" aria-hidden="true">
                    {expandedProjectId === project.id ? '⌄' : '›'}
                  </span>
                  <span>
                    <strong>{project.name}</strong>
                    <small>{project.path}</small>
                  </span>
                </button>
                <button
                  className="icon-button subtle"
                  aria-label={`Новый чат в проекте ${project.name}`}
                  title="Новый чат в проекте"
                  disabled={disabled}
                  onClick={() => onNewInProject(project.id)}
                >
                  ＋
                </button>
                <ContextMenu label={`Меню проекта ${project.name}`} disabled={disabled}>
                  {(close) => (
                    <button
                      role="menuitem"
                      onClick={() => {
                        close();
                        setExpandedProjectId(project.id);
                        onShowArchived(project.id);
                      }}
                    >
                      Архивированные чаты
                    </button>
                  )}
                </ContextMenu>
              </div>
              {expandedProjectId === project.id && project.id === selectedProjectId && (
                <div className="project-threads">
                  {archived && (
                    <div className="archive-heading">
                      <span>Архив</span>
                      <button className="ghost" onClick={onBack} disabled={disabled}>
                        Назад
                      </button>
                    </div>
                  )}
                  {threadRows(threads, false, archived)}
                  {!threads.length && (
                    <p className="empty-hint">
                      {archived ? 'Архив пуст.' : 'Здесь пока нет чатов.'}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </nav>
        {!projects.length && !creating && (
          <p className="empty-hint">Добавьте первый проект на сервере.</p>
        )}
        <div className="section-heading recent-heading">
          <span>Недавние</span>
        </div>
        <nav className="recent-list" aria-label="Недавние чаты">
          {threadRows(recentThreads, true)}
          {!recentThreads.length && <p className="empty-hint">Недавних чатов пока нет.</p>}
        </nav>
      </div>
      <div className="account-row">
        <span className="avatar">{username.slice(0, 1).toUpperCase()}</span>
        <span>{username}</span>
        <button className="ghost" onClick={onLogout}>
          Выйти
        </button>
      </div>
      {renameTarget && (
        <RenameThreadDialog
          thread={renameTarget}
          onCancel={() => setRenameTarget(null)}
          onRename={async (name) => {
            await onRename(renameTarget.id, name);
            setRenameTarget(null);
          }}
        />
      )}
    </aside>
  );
}

function RenameThreadDialog({
  thread,
  onRename,
  onCancel,
}: {
  thread: Thread;
  onRename: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(thread.name || thread.preview || '');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.select(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await onRename(name.trim());
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <form
        className="rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-thread-title"
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
      >
        <h2 id="rename-thread-title">Переименовать чат</h2>
        <label>
          Название
          <input
            ref={inputRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
            required
          />
        </label>
        <div className="button-row">
          <button className="primary" disabled={busy || !name.trim()}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            Отмена
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: PendingApproval;
  onResolve: (decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel') => void;
}) {
  return (
    <section className="approval-card" aria-label="Запрос разрешения">
      <div className="approval-icon">!</div>
      <div>
        <p className="eyebrow">ТРЕБУЕТСЯ РЕШЕНИЕ</p>
        <h3>{approval.summary}</h3>
        {Object.keys(approval.details).length > 0 && (
          <pre>{JSON.stringify(approval.details, null, 2)}</pre>
        )}
        <div className="button-row">
          <button className="primary" onClick={() => onResolve('accept')}>
            Разрешить
          </button>
          <button className="secondary" onClick={() => onResolve('acceptForSession')}>
            На сессию
          </button>
          <button className="danger" onClick={() => onResolve('decline')}>
            Отклонить
          </button>
        </div>
      </div>
    </section>
  );
}

const OTHER_VALUE = '__other__';

function UserInputCard({
  request,
  onResolve,
}: {
  request: UserInputRequest;
  onResolve: (answers: ResolveUserInputRequest['answers']) => Promise<void>;
}) {
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [typedAnswers, setTypedAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  function answerFor(question: UserInputQuestion): string {
    if (question.options?.length) {
      const selected = selections[question.id] ?? '';
      return selected === OTHER_VALUE ? (typedAnswers[question.id] ?? '') : selected;
    }
    return typedAnswers[question.id] ?? '';
  }

  const incomplete = request.questions.some((question) => !answerFor(question).trim());

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (incomplete || busy) return;
    const answers = Object.fromEntries(
      request.questions.map((question) => [question.id, { answers: [answerFor(question).trim()] }]),
    );
    setTypedAnswers((current) => {
      const next = { ...current };
      for (const question of request.questions) {
        if (question.isSecret) delete next[question.id];
      }
      return next;
    });
    setBusy(true);
    try {
      await onResolve(answers);
    } catch {
      // The workspace surfaces the request error and leaves the card available for retry.
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="approval-card interaction-card"
      aria-label="Вопросы Codex"
      onSubmit={(event) => void submit(event)}
    >
      <div className="approval-icon">?</div>
      <div className="interaction-content">
        <p className="eyebrow">НУЖЕН ВАШ ОТВЕТ</p>
        {request.questions.map((question) => {
          const useTypedAnswer =
            !question.options?.length || selections[question.id] === OTHER_VALUE;
          return (
            <fieldset className="question-field" key={question.id}>
              <legend>{question.header}</legend>
              <p>{question.question}</p>
              {question.options?.map((option) => (
                <label className="choice-row" key={option.label}>
                  <input
                    type="radio"
                    name={`${request.id}-${question.id}`}
                    value={option.label}
                    checked={selections[question.id] === option.label}
                    onChange={() =>
                      setSelections((current) => ({ ...current, [question.id]: option.label }))
                    }
                  />
                  <span>
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
              {question.isOther && question.options?.length ? (
                <label className="choice-row">
                  <input
                    type="radio"
                    name={`${request.id}-${question.id}`}
                    value={OTHER_VALUE}
                    checked={selections[question.id] === OTHER_VALUE}
                    onChange={() =>
                      setSelections((current) => ({ ...current, [question.id]: OTHER_VALUE }))
                    }
                  />
                  <span>Другое</span>
                </label>
              ) : null}
              {useTypedAnswer && (
                <input
                  aria-label={`${question.header}: ответ`}
                  type={question.isSecret ? 'password' : 'text'}
                  autoComplete={question.isSecret ? 'off' : undefined}
                  maxLength={8_000}
                  value={typedAnswers[question.id] ?? ''}
                  onChange={(event) =>
                    setTypedAnswers((current) => ({
                      ...current,
                      [question.id]: event.target.value,
                    }))
                  }
                />
              )}
            </fieldset>
          );
        })}
        <button className="primary" disabled={incomplete || busy}>
          {busy ? 'Отправляем…' : 'Ответить'}
        </button>
      </div>
    </form>
  );
}

const permissionLabels: Record<string, string> = {
  filesystem: 'Файловая система',
  fileSystem: 'Файловая система',
  network: 'Сеть',
  read: 'Чтение',
  write: 'Запись',
  paths: 'Пути',
  roots: 'Каталоги',
  enabled: 'Доступ',
};

function permissionValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'разрешено' : 'не запрошено';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(permissionValue).join(', ');
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => `${permissionLabels[key] ?? key}: ${permissionValue(nested)}`)
      .join('; ');
  }
  return 'не указано';
}

function PermissionCard({
  request,
  onResolve,
}: {
  request: PermissionRequest;
  onResolve: (decision: 'grant' | 'deny') => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  async function resolve(decision: 'grant' | 'deny') {
    setBusy(true);
    try {
      await onResolve(decision);
    } catch {
      // The workspace surfaces the request error and leaves the card available for retry.
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="approval-card interaction-card" aria-label="Запрос дополнительных прав">
      <div className="approval-icon">!</div>
      <div className="interaction-content">
        <p className="eyebrow">ДОПОЛНИТЕЛЬНЫЕ ПРАВА</p>
        <h3>{request.reason ?? 'Codex запрашивает дополнительные права'}</h3>
        <p className="permission-cwd">
          Рабочий каталог: <code>{request.cwd}</code>
        </p>
        <dl className="permission-list">
          {Object.entries(request.permissions).map(([name, value]) => (
            <div key={name}>
              <dt>{permissionLabels[name] ?? name}</dt>
              <dd>{permissionValue(value)}</dd>
            </div>
          ))}
        </dl>
        <div className="button-row">
          <button className="primary" disabled={busy} onClick={() => void resolve('grant')}>
            Разрешить один раз
          </button>
          <button className="danger" disabled={busy} onClick={() => void resolve('deny')}>
            Отклонить
          </button>
        </div>
      </div>
    </section>
  );
}

function ActivityEvent({ event }: { event: SafeEvent }) {
  const preview = eventPreview(event);
  const details = eventText(event);
  const hasDetails = details !== `${event.kind}: ${event.phase}` && details !== preview;
  const content = (
    <>
      <span className="activity-dot" aria-hidden="true" />
      <span className="activity-title">{eventTitle(event)}</span>
      {preview && <small>{preview}</small>}
      <time className="event-time" dateTime={event.createdAt}>
        {formatEventDateTime(event.createdAt)}
      </time>
    </>
  );
  return hasDetails ? (
    <details className={`activity-row ${event.kind}`} open={event.kind === 'error'}>
      <summary>{content}</summary>
      <pre>{details}</pre>
    </details>
  ) : (
    <div className={`activity-row ${event.kind}`}>
      <div className="activity-line">{content}</div>
    </div>
  );
}

function ActivityGroup({
  events,
  anchorId,
}: {
  events: SafeEvent[];
  anchorId: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const firstEvent = events[0];
  if (!firstEvent) return null;
  const visibleEvents = expanded ? events : events.slice(-3);
  const duration = formatDuration(firstEvent.createdAt, events.at(-1)?.createdAt ?? null);

  return (
    <section
      className="activity-group"
      aria-label={`Ход работы: ${events.length} действий`}
      id={anchorId}
      tabIndex={anchorId ? -1 : undefined}
    >
      <button
        className="activity-group-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span>Ход работы</span>
        <small>
          {events.length} действий · {duration}
        </small>
        <i aria-hidden="true">{expanded ? '⌃' : '⌄'}</i>
      </button>
      <div className="activity-group-items">
        {visibleEvents.map((event) => (
          <ActivityEvent event={event} key={event.id} />
        ))}
      </div>
      {!expanded && events.length > 3 && (
        <p className="activity-group-hint">Показаны 3 последних действия</p>
      )}
    </section>
  );
}

function Transcript({
  events,
  serverTurnNavigation,
  onNavigateTurn,
}: {
  events: SafeEvent[];
  serverTurnNavigation: TurnNavigationEntry[] | null;
  onNavigateTurn: (anchorId: string) => void;
}) {
  const displayEvents = useMemo(() => {
    const output: SafeEvent[] = [];
    const startedActivities = new Map<string, SafeEvent>();
    const finishedActivities = new Set(
      events
        .filter((event) => event.phase === 'completed' || event.phase === 'failed')
        .map(eventIdentity)
        .filter((identity): identity is string => identity !== null),
    );
    for (const sourceEvent of events) {
      const sourceIdentity = eventIdentity(sourceEvent);
      if (sourceEvent.phase === 'started' && sourceIdentity)
        startedActivities.set(sourceIdentity, sourceEvent);
      const started = sourceIdentity ? startedActivities.get(sourceIdentity) : null;
      const event =
        started && (sourceEvent.phase === 'completed' || sourceEvent.phase === 'failed')
          ? {
              ...sourceEvent,
              payload: mergeActivityPayload(started.payload, sourceEvent.payload),
            }
          : sourceEvent;
      if (
        event.kind === 'approval' ||
        event.kind === 'user-input' ||
        event.kind === 'permission-approval' ||
        event.kind === 'thread' ||
        event.kind === 'usage' ||
        (event.kind === 'turn' &&
          event.phase !== 'failed' &&
          event.payload.status !== 'interruptRequested')
      )
        continue;
      const identity = eventIdentity(event);
      if (event.phase === 'started' && identity && finishedActivities.has(identity)) continue;
      if (event.kind === 'tool' && event.phase !== 'failed' && !eventPreview(event)) continue;
      if (event.kind === 'agent-message' && event.phase === 'delta') {
        const previous = output.at(-1);
        if (previous?.kind === 'agent-message' && previous.turnId === event.turnId) {
          output[output.length - 1] = {
            ...event,
            payload: { text: `${eventText(previous)}${eventText(event)}` },
          };
          continue;
        }
      }
      output.push(event);
    }
    return output;
  }, [events]);
  const completedTurnIds = useMemo(() => successfullyCompletedTurnIds(events), [events]);
  const finalAgentMessageIds = useMemo(() => {
    const result = new Set<number>();
    const legacyCandidates = new Map<string, number>();
    for (const event of displayEvents) {
      if (event.kind !== 'agent-message' || event.phase !== 'completed') continue;
      const messagePhase = agentMessagePhase(event);
      if (messagePhase === 'final_answer') result.add(event.id);
      if (messagePhase === null && event.turnId && completedTurnIds.has(event.turnId)) {
        legacyCandidates.set(event.turnId, event.id);
      }
    }
    for (const id of legacyCandidates.values()) result.add(id);
    return result;
  }, [completedTurnIds, displayEvents]);
  const summarizedTurnIds = useMemo(() => {
    const result = new Set<string>();
    for (const event of displayEvents) {
      if (
        event.turnId &&
        completedTurnIds.has(event.turnId) &&
        finalAgentMessageIds.has(event.id)
      ) {
        result.add(event.turnId);
      }
    }
    return result;
  }, [completedTurnIds, displayEvents, finalAgentMessageIds]);
  const visibleEvents = useMemo(
    () =>
      displayEvents.filter((event) => {
        if (!event.turnId || !summarizedTurnIds.has(event.turnId)) return true;
        return event.kind === 'user-message' || finalAgentMessageIds.has(event.id);
      }),
    [displayEvents, finalAgentMessageIds, summarizedTurnIds],
  );
  const turnNavigation = useMemo(() => {
    const retainedUserMessages: SafeEvent[] = [];
    const firstVisibleByTurn = new Map<string, SafeEvent>();
    for (const event of visibleEvents) {
      if (event.turnId && !firstVisibleByTurn.has(event.turnId)) {
        firstVisibleByTurn.set(event.turnId, event);
      }
      if (event.kind === 'user-message') retainedUserMessages.push(event);
    }
    const messageLabel = (event: SafeEvent) => turnNavigationLabel(eventText(event));
    if (!serverTurnNavigation) {
      return retainedUserMessages.map((event) => ({
        key: `event-turn-${event.id}`,
        anchorId: `turn-message-${event.id}`,
        label: messageLabel(event),
      }));
    }
    const claimedMessageIds = new Set<number>();
    const navigation = serverTurnNavigation.map((entry) => {
      const exactMessage = retainedUserMessages.find(
        (event) =>
          !claimedMessageIds.has(event.id) &&
          event.turnId === entry.turnId &&
          messageLabel(event) === entry.label,
      );
      if (exactMessage) {
        claimedMessageIds.add(exactMessage.id);
        return {
          key: `server-turn-${entry.id}`,
          anchorId: `turn-message-${exactMessage.id}`,
          label: entry.label,
        };
      }
      const firstVisible = firstVisibleByTurn.get(entry.turnId);
      const anchorId = firstVisible
        ? firstVisible.kind === 'user-message'
          ? `turn-message-${firstVisible.id}`
          : `turn-retained-${firstVisible.id}`
        : 'transcript-start';
      return { key: `server-turn-${entry.id}`, anchorId, label: entry.label };
    });
    for (const event of retainedUserMessages) {
      if (claimedMessageIds.has(event.id)) continue;
      navigation.push({
        key: `event-turn-${event.id}`,
        anchorId: `turn-message-${event.id}`,
        label: messageLabel(event),
      });
    }
    return navigation;
  }, [serverTurnNavigation, visibleEvents]);
  const retainedTurnAnchorIds = useMemo(
    () => new Set(turnNavigation.map((turn) => turn.anchorId)),
    [turnNavigation],
  );
  const blocks = useMemo(() => {
    const output: Array<
      { type: 'message'; event: SafeEvent } | { type: 'activities'; events: SafeEvent[] }
    > = [];
    for (const event of visibleEvents) {
      if (event.kind === 'user-message' || event.kind === 'agent-message') {
        output.push({ type: 'message', event });
        continue;
      }
      const previous = output.at(-1);
      if (previous?.type === 'activities' && previous.events.at(-1)?.turnId === event.turnId) {
        previous.events.push(event);
      } else {
        output.push({ type: 'activities', events: [event] });
      }
    }
    return output;
  }, [visibleEvents]);

  if (!visibleEvents.length && !turnNavigation.length) {
    return (
      <div className="welcome-state">
        <div className="welcome-orb">C</div>
        <h2>Что будем делать?</h2>
        <p>Опишите задачу — Codex выполнит её непосредственно на сервере.</p>
      </div>
    );
  }

  return (
    <div className={`transcript-shell${turnNavigation.length > 1 ? ' has-turn-navigation' : ''}`}>
      {turnNavigation.length > 1 && (
        <nav className="turn-navigation" aria-label="Переходы по задачам">
          {turnNavigation.map((turn, index) => (
            <button
              className="turn-jump"
              type="button"
              key={turn.key}
              aria-label={`Перейти к задаче ${index + 1}: ${turn.label}`}
              title={turn.label}
              data-preview={turn.label}
              onClick={() => onNavigateTurn(turn.anchorId)}
            >
              <span aria-hidden="true" />
            </button>
          ))}
        </nav>
      )}
      <div id="transcript-start" className="transcript" aria-live="polite" tabIndex={-1}>
        {blocks.map((block) => {
          if (block.type === 'message') {
            const attachments = attachmentsFrom(block.event);
            const text = eventText(block.event);
            const finalAnswer = finalAgentMessageIds.has(block.event.id);
            const turnAnchorId =
              block.event.kind === 'user-message' && block.event.turnId
                ? `turn-message-${block.event.id}`
                : retainedTurnAnchorIds.has(`turn-retained-${block.event.id}`)
                  ? `turn-retained-${block.event.id}`
                  : undefined;
            return (
              <article
                className={`message ${block.event.kind === 'user-message' ? 'user' : 'agent'}${finalAnswer ? ' final-answer' : ''}`}
                key={block.event.id}
                id={turnAnchorId}
                tabIndex={turnAnchorId ? -1 : undefined}
                aria-label={finalAnswer ? 'Итоговый ответ Codex' : undefined}
              >
                <div className="message-meta">
                  <span className="message-role">
                    {block.event.kind === 'user-message' ? 'Вы' : 'Codex'}
                  </span>
                  {finalAnswer && (
                    <span className="final-answer-badge">
                      <span aria-hidden="true">✓</span> Итоговый ответ
                    </span>
                  )}
                  <time className="event-time" dateTime={block.event.createdAt}>
                    {formatEventDateTime(block.event.createdAt)}
                  </time>
                </div>
                {text &&
                  (block.event.kind === 'agent-message' ? (
                    <AgentMessageContent text={text} threadId={block.event.threadId} />
                  ) : (
                    <div className="message-text">{text}</div>
                  ))}
                <AttachmentList attachments={attachments} />
              </article>
            );
          }
          const firstEvent = block.events[0]!;
          const anchorId = retainedTurnAnchorIds.has(`turn-retained-${firstEvent.id}`)
            ? `turn-retained-${firstEvent.id}`
            : undefined;
          return (
            <ActivityGroup
              events={block.events}
              anchorId={anchorId}
              key={`activities-${firstEvent.id}`}
            />
          );
        })}
      </div>
    </div>
  );
}

const RESOURCE_STATE_LABELS: Record<ResourceLimitSnapshot['state'], string> = {
  applied: 'Применено',
  'pending-idle': 'Ожидает завершения текущих задач',
  applying: 'Применяется…',
  degraded: 'Не удалось применить',
};

function ResourceSettings({
  snapshot,
  busy,
  error,
  onRefresh,
  onSave,
  onApply,
}: {
  snapshot: ResourceLimitSnapshot | null;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onSave: (desired: ResourceLimitPolicy) => Promise<void>;
  onApply: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<ResourceLimitPolicy | null>(snapshot?.desired ?? null);

  useEffect(() => setDraft(snapshot?.desired ?? null), [snapshot?.version]);

  if (!snapshot || !draft) return <p className="empty-hint compact">Загрузка ресурсов…</p>;

  const custom = draft.mode === 'custom';
  const normalizedDraft: ResourceLimitPolicy = custom
    ? draft
    : {
        mode: 'auto',
        cpuCores: null,
        memoryBytes: null,
        tasks: null,
        maxParallelAgents: null,
      };
  const dirty = JSON.stringify(normalizedDraft) !== JSON.stringify(snapshot.desired);
  const maxMemoryGiB = snapshot.capacity.memoryBytes / 1024 ** 3;
  const memoryGiB = draft.memoryBytes === null ? '' : draft.memoryBytes / 1024 ** 3;
  const safeAgentMaximum = Math.max(
    1,
    Math.min(
      8,
      Math.floor(draft.cpuCores ?? snapshot.effective.cpuCores),
      Math.floor((draft.memoryBytes ?? snapshot.effective.memoryBytes) / (2 * 1024 ** 3)),
    ),
  );
  const fieldsValid =
    !custom ||
    (draft.cpuCores !== null &&
      draft.cpuCores > 0 &&
      draft.cpuCores <= snapshot.capacity.cpuCores &&
      draft.memoryBytes !== null &&
      draft.memoryBytes > 0 &&
      draft.memoryBytes <= snapshot.capacity.memoryBytes &&
      draft.tasks !== null &&
      draft.tasks >= 64 &&
      draft.tasks <= snapshot.capacity.tasks &&
      (draft.maxParallelAgents === null ||
        (draft.maxParallelAgents > 0 && draft.maxParallelAgents <= safeAgentMaximum)));

  const setNumber = (key: keyof ResourceLimitPolicy, value: string, multiplier = 1) => {
    const parsed = value === '' ? null : Number(value) * multiplier;
    setDraft((current) => (current ? { ...current, [key]: parsed } : current));
  };

  return (
    <section className="resource-settings" aria-labelledby="resource-settings-title">
      <div className="resource-heading">
        <div>
          <h3 id="resource-settings-title">Ресурсы задач Codex</h3>
          <small>Настройки хранятся на сервере и действуют на всех устройствах.</small>
        </div>
        <button className="text-button" type="button" onClick={onRefresh} disabled={busy}>
          Обновить
        </button>
      </div>
      <div className={`resource-state ${snapshot.state}`} role="status">
        <strong>{RESOURCE_STATE_LABELS[snapshot.state]}</strong>
        <span>
          Сейчас: {snapshot.effective.cpuCores.toLocaleString('ru')} CPU ·{' '}
          {formatResourceBytes(snapshot.effective.memoryBytes)} · {snapshot.effective.tasks}{' '}
          процессов · {snapshot.effective.maxParallelAgents} агентов
        </span>
      </div>
      <p className="resource-capacity">
        Доступно на машине: {snapshot.capacity.cpuCores.toLocaleString('ru')} CPU ·{' '}
        {formatResourceBytes(snapshot.capacity.memoryBytes)} ·{' '}
        {snapshot.capacity.tasks.toLocaleString('ru')} процессов. Автоматический режим не превышает
        этот потолок.
      </p>
      {snapshot.warning && <div className="notice warning">{snapshot.warning}</div>}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <fieldset className="resource-mode" disabled={busy}>
        <legend>Режим</legend>
        <label>
          <input
            type="radio"
            name="resource-mode"
            checked={draft.mode === 'auto'}
            onChange={() =>
              setDraft({
                mode: 'auto',
                cpuCores: null,
                memoryBytes: null,
                tasks: null,
                maxParallelAgents: null,
              })
            }
          />
          Автоматически — без дополнительного ограничения
        </label>
        <label>
          <input
            type="radio"
            name="resource-mode"
            checked={custom}
            onChange={() =>
              setDraft({
                mode: 'custom',
                cpuCores: snapshot.desired.cpuCores ?? snapshot.effective.cpuCores,
                memoryBytes: snapshot.desired.memoryBytes ?? snapshot.effective.memoryBytes,
                tasks: snapshot.desired.tasks ?? snapshot.effective.tasks,
                maxParallelAgents:
                  snapshot.desired.maxParallelAgents ?? snapshot.effective.maxParallelAgents,
              })
            }
          />
          Настроить вручную
        </label>
      </fieldset>
      {custom && (
        <div className="resource-fields">
          <label>
            CPU, ядер
            <input
              aria-label="Лимит CPU, ядер"
              type="number"
              min="0.25"
              max={snapshot.capacity.cpuCores}
              step="0.1"
              value={draft.cpuCores ?? ''}
              onChange={(event) => setNumber('cpuCores', event.target.value)}
              disabled={busy}
            />
            <small>Максимум: {snapshot.capacity.cpuCores.toLocaleString('ru')}</small>
          </label>
          <label>
            Память, ГБ
            <input
              aria-label="Лимит памяти, ГБ"
              type="number"
              min="0.1"
              max={maxMemoryGiB}
              step="0.1"
              value={memoryGiB}
              onChange={(event) => setNumber('memoryBytes', event.target.value, 1024 ** 3)}
              disabled={busy}
            />
            <small>
              Максимум: {formatResourceBytes(snapshot.capacity.memoryBytes)} · свободно{' '}
              {formatResourceBytes(snapshot.capacity.memoryAvailableBytes)}
            </small>
          </label>
          <label>
            Процессы
            <input
              aria-label="Лимит процессов"
              type="number"
              min="64"
              max={snapshot.capacity.tasks}
              step="1"
              value={draft.tasks ?? ''}
              onChange={(event) => setNumber('tasks', event.target.value)}
              disabled={busy}
            />
            <small>Максимум: {snapshot.capacity.tasks.toLocaleString('ru')}</small>
          </label>
          <label>
            Параллельные агенты (включая основной)
            <input
              aria-label="Максимум параллельных агентов"
              type="number"
              min="1"
              max={safeAgentMaximum}
              step="1"
              value={draft.maxParallelAgents ?? ''}
              onChange={(event) => setNumber('maxParallelAgents', event.target.value)}
              disabled={busy}
            />
            <small>Безопасный максимум для выбранных CPU/RAM: {safeAgentMaximum}</small>
          </label>
        </div>
      )}
      {dirty && <p className="resource-unsaved">Изменения ещё не сохранены.</p>}
      <div className="resource-actions">
        <button
          className="ghost"
          type="button"
          disabled={!dirty || !fieldsValid || busy}
          onClick={() => void onSave(normalizedDraft)}
        >
          {busy ? 'Сохранение…' : 'Сохранить'}
        </button>
        <button
          type="button"
          disabled={dirty || snapshot.state === 'applied' || snapshot.state === 'applying' || busy}
          onClick={() => void onApply()}
        >
          Применить
        </button>
      </div>
    </section>
  );
}

function SubagentMenu({ subagents }: { subagents: Subagent[] }) {
  if (!subagents.length) return null;
  const statusLabel = (status: Subagent['status']) => {
    if (status === 'pendingInit') return 'Запускается';
    if (status === 'running') return 'Работает';
    if (status === 'completed') return 'Завершён';
    if (status === 'errored') return 'Ошибка';
    if (status === 'interrupted') return 'Остановлен';
    if (status === 'shutdown') return 'Выключен';
    if (status === 'notFound') return 'Недоступен';
    return status;
  };
  const activeSubagents = subagents.filter(
    (subagent) => subagent.status === 'pendingInit' || subagent.status === 'running',
  );
  const completedSubagents = subagents.filter(
    (subagent) => subagent.status !== 'pendingInit' && subagent.status !== 'running',
  );
  const renderSubagent = (subagent: Subagent) => (
    <li key={subagent.id}>
      <div>
        <strong>{subagent.nickname || subagent.agentPath || 'Агент'}</strong>
        <span className={`subagent-status ${subagent.status}`}>{statusLabel(subagent.status)}</span>
      </div>
      {subagent.role && <p>{subagent.role}</p>}
      {subagent.message && <small>{subagent.message}</small>}
      <footer>
        {subagent.model && <span>{subagent.model}</span>}
        {subagent.reasoningEffort && <span>{subagent.reasoningEffort}</span>}
        <time dateTime={subagent.startedAt}>
          {formatDuration(subagent.startedAt, subagent.completedAt)}
        </time>
      </footer>
    </li>
  );
  return (
    <details className="subagent-menu">
      <summary
        aria-label={`Агенты задачи: активных ${activeSubagents.length}, всего ${subagents.length}`}
      >
        <span className={activeSubagents.length ? 'subagent-live-dot' : ''} aria-hidden="true" />
        <span>Агенты</span>
        <strong>{activeSubagents.length}</strong>
        <small>/ {subagents.length}</small>
      </summary>
      <section className="subagent-popover" aria-label="Агенты задачи">
        <header>
          <div>
            <h2>Агенты задачи</h2>
            <small>
              Активны {activeSubagents.length} из {subagents.length}
            </small>
          </div>
        </header>
        {activeSubagents.length > 0 && (
          <div className="subagent-group">
            <h2>Активные</h2>
            <ul>{activeSubagents.map(renderSubagent)}</ul>
          </div>
        )}
        {completedSubagents.length > 0 && (
          <details className="subagent-history">
            <summary>Завершённые и остановленные · {completedSubagents.length}</summary>
            <ul>{completedSubagents.map(renderSubagent)}</ul>
          </details>
        )}
      </section>
    </details>
  );
}

function Diagnostics({
  capability,
  codexUpdate,
  codexUpdateBusy,
  codexUpdateError,
  resourceLimits,
  resourceBusy,
  resourceError,
  thread,
  onRefreshResources,
  onSaveResources,
  onApplyResources,
  onStartAccountLogin,
  onApplyCodexUpdate,
  accountSwitchButtonRef,
  onClose,
}: {
  capability: Capability | null;
  codexUpdate: CodexUpdateSnapshot | null;
  codexUpdateBusy: boolean;
  codexUpdateError: string | null;
  resourceLimits: ResourceLimitSnapshot | null;
  resourceBusy: boolean;
  resourceError: string | null;
  thread: Thread | null;
  onRefreshResources: () => void;
  onSaveResources: (desired: ResourceLimitPolicy) => Promise<void>;
  onApplyResources: () => Promise<void>;
  onStartAccountLogin: () => void;
  onApplyCodexUpdate: () => void;
  accountSwitchButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  return (
    <aside id="codex-diagnostics" className="diagnostics" aria-label="Статус Codex">
      <header>
        <div>
          <p className="eyebrow">CODEX STATUS</p>
          <h2>Статус</h2>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Закрыть диагностику"
          autoFocus
        >
          ×
        </button>
      </header>
      {!capability ? (
        <p>Загрузка…</p>
      ) : (
        <>
          <dl className="status-grid">
            <dt>Codex</dt>
            <dd>{capability.codexVersion}</dd>
            <dt>Авторизация</dt>
            <dd>{capability.authenticated ? 'активна' : 'нет'}</dd>
            <dt>App Server</dt>
            <dd>{capability.appServerReady ? 'готов' : 'недоступен'}</dd>
            <dt>Аккаунт</dt>
            <dd>{capability.account?.email ?? 'не указан'}</dd>
            <dt>План</dt>
            <dd>{capability.account?.planType ?? 'нет данных'}</dd>
          </dl>
          <button
            ref={accountSwitchButtonRef}
            className="secondary account-switch-button"
            type="button"
            onClick={onStartAccountLogin}
          >
            Сменить аккаунт
          </button>
          <section className="codex-update" aria-labelledby="codex-update-title">
            <h3 id="codex-update-title">Обновление Codex</h3>
            {codexUpdate ? (
              <>
                <dl className="status-grid codex-update-versions">
                  <dt>Текущая версия</dt>
                  <dd>{codexUpdate.currentVersion}</dd>
                  {codexUpdate.availableVersion && (
                    <>
                      <dt>Подготовлена</dt>
                      <dd>{codexUpdate.availableVersion}</dd>
                    </>
                  )}
                </dl>
                <p className="codex-update-state" role="status">
                  {codexUpdate.state === 'ready' && 'Обновление готово к установке.'}
                  {codexUpdate.state === 'applying' && 'Обновляем Codex…'}
                  {codexUpdate.state === 'current' &&
                    'Установлена актуальная подготовленная версия.'}
                  {codexUpdate.state === 'unavailable' && 'Подготовленное обновление отсутствует.'}
                  {codexUpdate.state === 'failed' && 'Обновление не установлено.'}
                  {codexUpdate.state === 'rollback_failed' &&
                    'Обновление не установлено, автоматический откат не завершён.'}
                </p>
                {codexUpdate.lastResult && codexUpdate.lastResult.status !== 'succeeded' && (
                  <p className="notice error" role="alert">
                    {codexUpdate.lastResult.message}
                  </p>
                )}
                {codexUpdate.state === 'ready' && (
                  <button
                    className="primary codex-update-button"
                    type="button"
                    disabled={codexUpdateBusy}
                    onClick={onApplyCodexUpdate}
                  >
                    {codexUpdateBusy ? 'Запускаем…' : 'Обновить Codex'}
                  </button>
                )}
              </>
            ) : (
              <p className="empty-hint compact">Проверяем подготовленные обновления…</p>
            )}
            <p className="codex-update-note">
              Обновление запускается только когда Codex свободен и ненадолго перезапускает его. Чаты
              и файлы сохраняются.
            </p>
            {codexUpdateError && (
              <p className="notice error" role="alert">
                {codexUpdateError}
              </p>
            )}
          </section>
          <ResourceSettings
            snapshot={resourceLimits}
            busy={resourceBusy}
            error={resourceError}
            onRefresh={onRefreshResources}
            onSave={onSaveResources}
            onApply={onApplyResources}
          />
          <h3>Лимиты аккаунта</h3>
          {capability.rateLimits?.length ? (
            <div className="rate-limit-list">
              {capability.rateLimits.map((limit, limitIndex) => (
                <section className="rate-limit" key={limit.limitId ?? `limit-${limitIndex}`}>
                  <strong>{limit.limitName ?? limit.limitId ?? 'Лимит Codex'}</strong>
                  <small>{limit.planType ?? 'текущий план'}</small>
                  {[limit.primary, limit.secondary].filter(Boolean).map((window, index) => (
                    <div className="rate-window" key={`${limit.limitId}:${index}`}>
                      <span>
                        {window!.usedPercent}% использовано ·{' '}
                        {window!.windowDurationMins === null
                          ? 'окно неизвестно'
                          : `${window!.windowDurationMins} мин.`}
                      </span>
                      <progress
                        max="100"
                        value={window!.usedPercent}
                        aria-label={`${limit.limitName ?? limit.limitId ?? 'Лимит Codex'}: использовано ${window!.usedPercent}%`}
                      />
                      <small>Сброс: {formatResetTime(window!.resetsAt)}</small>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          ) : (
            <p className="empty-hint compact">Данные о лимитах недоступны.</p>
          )}
          {capability.usage && (
            <>
              <h3>Использование</h3>
              <dl className="status-grid">
                <dt>Всего токенов</dt>
                <dd>{formatMetric(capability.usage.summary.lifetimeTokens)}</dd>
                <dt>Пиковый день</dt>
                <dd>{formatMetric(capability.usage.summary.peakDailyTokens)}</dd>
                <dt>Текущая серия</dt>
                <dd>
                  {capability.usage.summary.currentStreakDays === null
                    ? 'нет данных'
                    : `${capability.usage.summary.currentStreakDays} дн.`}
                </dd>
              </dl>
            </>
          )}
          <h3>Instruction sources</h3>
          <ul className="path-list">
            {thread?.instructionSources.map((path) => (
              <li key={path}>{path}</li>
            ))}
            {!thread?.instructionSources.length && <li>Нет данных для текущего чата</li>}
          </ul>
          <h3>Skills</h3>
          <ul className="skill-list">
            {capability.skills.map((skill) => (
              <li key={`${skill.name}:${skill.path}`}>
                <span>{skill.name}</span>
                <small>
                  {skill.enabled ? 'включён' : 'выключен'} · {skill.path}
                </small>
              </li>
            ))}
          </ul>
          {capability.warnings.map((warning) => (
            <div className="notice warning" key={warning}>
              {warning}
            </div>
          ))}
        </>
      )}
    </aside>
  );
}

function AccountLoginDialog({
  login,
  busy,
  error,
  copyNotice,
  onCopy,
  onCancel,
  onClose,
}: {
  login: CodexAccountLogin | null;
  busy: boolean;
  error: string | null;
  copyNotice: string | null;
  onCopy: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const pending = login?.state === 'pending';
  const succeeded = login?.state === 'succeeded';
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (busy) return;
    dialogRef.current
      ?.querySelector<HTMLElement>(
        'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      )
      ?.focus();
  }, [busy, pending]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        if (pending) onCancel();
        else onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((element) => element.offsetParent !== null);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel, onClose, pending]);
  return createPortal(
    <div className="dialog-backdrop account-login-backdrop">
      <section
        ref={dialogRef}
        className="account-login-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-login-title"
      >
        <h2 id="account-login-title">Смена аккаунта Codex</h2>
        {busy && !login ? <p role="status">Запрашиваем код входа…</p> : null}
        {pending ? (
          <>
            <p>Откройте страницу входа и введите одноразовый код.</p>
            <div className="account-login-code" aria-label="Одноразовый код">
              {login.userCode}
            </div>
            <div className="account-login-actions">
              <button
                className="secondary"
                type="button"
                onClick={onCopy}
                disabled={!login.userCode}
                autoFocus
              >
                Копировать код
              </button>
              {login.verificationUrl ? (
                <a
                  className="button-link primary"
                  href={login.verificationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Открыть страницу входа
                </a>
              ) : null}
            </div>
            <p className="notice warning">
              Никому не сообщайте этот код — он даёт доступ к вашему аккаунту.
            </p>
            <p className="account-login-progress" role="status">
              Ожидаем подтверждение входа…
            </p>
          </>
        ) : null}
        {succeeded ? (
          <div className="notice success" role="status">
            Аккаунт Codex успешно сменён. Новые задачи будут использовать его.
          </div>
        ) : null}
        {login?.state === 'failed' && !error ? (
          <div className="notice error" role="alert">
            {login.message ?? 'Не удалось завершить вход. Попробуйте ещё раз.'}
          </div>
        ) : null}
        {copyNotice ? (
          <p className="account-login-copy-note" role="status">
            {copyNotice}
          </p>
        ) : null}
        {error ? (
          <div className="notice error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="button-row account-login-footer">
          {pending ? (
            <button className="danger" type="button" onClick={onCancel} disabled={busy}>
              {busy ? 'Отменяем…' : 'Отменить вход'}
            </button>
          ) : (
            <button className="secondary" type="button" onClick={onClose} disabled={busy} autoFocus>
              Закрыть
            </button>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function Workspace({
  session,
  onSessionRefresh,
  onSignedOut,
}: {
  session: Session;
  onSessionRefresh: (session: Session) => void;
  onSignedOut: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [recentThreads, setRecentThreads] = useState<Thread[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [capability, setCapability] = useState<Capability | null>(null);
  const [codexUpdate, setCodexUpdate] = useState<CodexUpdateSnapshot | null>(null);
  const [codexUpdateBusy, setCodexUpdateBusy] = useState(false);
  const [codexUpdateError, setCodexUpdateError] = useState<string | null>(null);
  const [resourceLimits, setResourceLimits] = useState<ResourceLimitSnapshot | null>(null);
  const [resourceBusy, setResourceBusy] = useState(false);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [serverTurnNavigation, setServerTurnNavigation] = useState<TurnNavigationEntry[] | null>(
    null,
  );
  const [projectId, setProjectId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [archiveView, setArchiveView] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [accountLoginOpen, setAccountLoginOpen] = useState(false);
  const [accountLogin, setAccountLogin] = useState<CodexAccountLogin | null>(null);
  const [accountLoginBusy, setAccountLoginBusy] = useState(false);
  const [accountLoginError, setAccountLoginError] = useState<string | null>(null);
  const [accountLoginCopyNotice, setAccountLoginCopyNotice] = useState<string | null>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [mobileRuntimeOpen, setMobileRuntimeOpen] = useState(false);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [pushNotificationState, setPushNotificationState] =
    useState<PushNotificationState>('unavailable');
  const [pushNotificationBusy, setPushNotificationBusy] = useState(false);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permission, setPermission] = useState<PermissionPreset>('workspace-write');
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>('on-request');
  const [composer, setComposer] = useState('');
  const [queuedAttachments, setQueuedAttachments] = useState<QueuedAttachment[]>([]);
  const [threadAttachmentBytes, setThreadAttachmentBytes] = useState(0);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const conversationContentRef = useRef<HTMLDivElement>(null);
  const followingLatestRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const lastEventIdRef = useRef<number | null>(null);
  const positionedThreadRef = useRef<string | null>(null);
  const mobileNavigationToggleRef = useRef<HTMLButtonElement>(null);
  const statusToggleRef = useRef<HTMLButtonElement>(null);
  const accountSwitchButtonRef = useRef<HTMLButtonElement>(null);
  const refreshedCodexUpdateRef = useRef<string | null>(null);
  const queuedAttachmentsRef = useRef<QueuedAttachment[]>([]);
  const attachmentThreadRef = useRef<string | null>(null);
  const activeUploadsRef = useRef(new Map<string, { threadId: string; abort: () => void }>());
  const preferencesWriteRef = useRef<Promise<void>>(Promise.resolve());
  const sendInFlightRef = useRef(false);
  const subagentsRef = useRef<Subagent[]>(subagents);
  subagentsRef.current = subagents;
  const [locallyResolvedRequests, setLocallyResolvedRequests] = useState<Set<string>>(
    () => new Set(),
  );
  const { events, streamState, mergeEvents } = useThreadEvents(threadId);
  const latestEvent = events.at(-1) ?? null;
  const latestEventId = latestEvent?.id ?? null;
  const runtimeSnapshotCursorRef = useRef(0);

  const selectedThread = threads.find((item) => item.id === threadId) ?? null;
  const selectedThreadRef = useRef<Thread | null>(selectedThread);
  selectedThreadRef.current = selectedThread;
  const modelOption = models.find((item) => item.id === model) ?? null;
  const lastRuntimeEvent = [...events].reverse().find((event) => threadRuntimeFrom(event) !== null);
  const lastRuntimeEventRef = useRef<SafeEvent | undefined>(lastRuntimeEvent);
  lastRuntimeEventRef.current = lastRuntimeEvent;
  const active = selectedThread?.status === 'active';
  const activeTurnId = active ? selectedThread.activeTurnId : null;
  const activeSubagentCount = subagents.filter(
    (subagent) => subagent.status === 'pendingInit' || subagent.status === 'running',
  ).length;
  const activeRootTurn = active && activeTurnId !== null;
  const subagentsOnlyActive = active && !activeTurnId && activeSubagentCount > 0;
  const activeTurnDuration = useActiveTurnDuration(events, activeTurnId, active);

  useLayoutEffect(() => {
    if (composerInputRef.current) fitComposerInput(composerInputRef.current);
  }, [composer]);
  const approvals = useMemo(() => {
    const pending = new Map<string, PendingApproval>();
    for (const event of events) {
      if (event.kind !== 'approval') continue;
      const id = approvalEventId(event);
      if (!id) continue;
      if (event.phase === 'completed' || event.phase === 'failed') {
        pending.delete(id);
        continue;
      }
      const approval = pendingApprovalFrom(event);
      if (approval) pending.set(id, approval);
    }
    return [...pending.values()];
  }, [events]);
  const userInputRequests = useMemo(() => {
    const pending = new Map<string, UserInputRequest>();
    for (const event of events) {
      if (event.kind !== 'user-input') continue;
      const id = requestEventId(event);
      if (!id) continue;
      const request = userInputRequestFrom(event);
      if (request) pending.set(id, request);
      else pending.delete(id);
    }
    return [...pending.values()].filter((request) => !locallyResolvedRequests.has(request.id));
  }, [events, locallyResolvedRequests]);
  const permissionRequests = useMemo(() => {
    const pending = new Map<string, PermissionRequest>();
    for (const event of events) {
      if (event.kind !== 'permission-approval') continue;
      const id = requestEventId(event);
      if (!id) continue;
      const request = permissionRequestFrom(event);
      if (request) pending.set(id, request);
      else pending.delete(id);
    }
    return [...pending.values()].filter((request) => !locallyResolvedRequests.has(request.id));
  }, [events, locallyResolvedRequests]);

  useEffect(() => {
    setLocallyResolvedRequests(new Set());
    setActionNotice(null);
    setShowScrollToLatest(false);
    followingLatestRef.current = true;
    userScrollIntentRef.current = false;
    lastEventIdRef.current = null;
  }, [threadId]);

  useEffect(() => {
    let cancelled = false;
    const notificationCapability = capability?.notifications;

    if (!notificationCapability?.available || !notificationCapability.vapidPublicKey) {
      setPushNotificationState('unavailable');
      return;
    }
    const supportIssue = pushSupportIssue();
    if (supportIssue) {
      setPushNotificationState(supportIssue);
      return;
    }
    if (Notification.permission === 'denied') {
      setPushNotificationState('denied');
      return;
    }
    if (!threadId) {
      setPushNotificationState('unsubscribed');
      return;
    }

    setPushNotificationState('checking');
    void navigator.serviceWorker
      .getRegistration('/')
      .then((registration) => registration?.pushManager.getSubscription() ?? null)
      .then(async (subscription) => {
        if (cancelled) return;
        if (!subscription) {
          setPushNotificationState('unsubscribed');
          return;
        }
        const status = await api.pushSubscriptionStatus(
          session.csrfToken,
          threadId,
          subscription.endpoint,
        );
        if (!cancelled) {
          setPushNotificationState(status.subscribed ? 'subscribed' : 'unsubscribed');
        }
      })
      .catch(() => {
        if (!cancelled) setPushNotificationState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [capability?.notifications, session.csrfToken, threadId]);

  useLayoutEffect(() => {
    if (
      threadId === null ||
      latestEvent === null ||
      latestEvent.threadId !== threadId ||
      latestEventId === lastEventIdRef.current
    )
      return;
    const previousEventId = lastEventIdRef.current;
    lastEventIdRef.current = latestEventId;
    const scroll = conversationScrollRef.current;
    if (!scroll) return;
    if (positionedThreadRef.current !== threadId || previousEventId === null) {
      positionedThreadRef.current = threadId;
      followingLatestRef.current = true;
      positionAtLatestImmediately(scroll);
      setShowScrollToLatest(false);
      return;
    }
    if (followingLatestRef.current) {
      positionAtLatestImmediately(scroll);
      setShowScrollToLatest(false);
      return;
    }
    setShowScrollToLatest(true);
  }, [latestEvent, latestEventId, threadId]);

  useLayoutEffect(() => {
    const scroll = conversationScrollRef.current;
    if (
      !scroll ||
      threadId === null ||
      positionedThreadRef.current !== threadId ||
      !followingLatestRef.current
    )
      return;
    positionAtLatestImmediately(scroll);
  }, [approvals, events, permissionRequests, subagents, threadId, userInputRequests]);

  useEffect(() => {
    const scroll = conversationScrollRef.current;
    const content = conversationContentRef.current;
    if (!scroll || !content || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!followingLatestRef.current) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (followingLatestRef.current) {
          positionAtLatestImmediately(scroll);
        }
      });
    });
    observer.observe(content);
    observer.observe(scroll);
    frame = window.requestAnimationFrame(() => {
      if (followingLatestRef.current) positionAtLatestImmediately(scroll);
    });
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [threadId]);

  function trackConversationScroll(): void {
    const scroll = conversationScrollRef.current;
    if (!scroll) return;
    const nearLatest = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 80;
    if (nearLatest) {
      const wasFollowingLatest = followingLatestRef.current;
      followingLatestRef.current = true;
      if (!wasFollowingLatest) userScrollIntentRef.current = false;
    } else if (userScrollIntentRef.current) {
      followingLatestRef.current = false;
    }
    setShowScrollToLatest(!followingLatestRef.current);
  }

  function markConversationScrollIntent(): void {
    userScrollIntentRef.current = true;
  }

  function markConversationKeyboardScrollIntent(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      markConversationScrollIntent();
    }
  }

  function scrollToLatest(): void {
    const scroll = conversationScrollRef.current;
    if (!scroll) return;
    followingLatestRef.current = true;
    userScrollIntentRef.current = false;
    setShowScrollToLatest(false);
    positionAtLatestImmediately(scroll);
  }

  function navigateToTurn(anchorId: string): void {
    const target = document.getElementById(anchorId);
    if (!target) return;
    followingLatestRef.current = false;
    userScrollIntentRef.current = true;
    setShowScrollToLatest(true);
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.focus({ preventScroll: true });
  }

  useEffect(() => {
    const nameEvent = [...events]
      .reverse()
      .find((event) => event.kind === 'thread' && Object.hasOwn(event.payload, 'threadName'));
    if (!nameEvent) return;
    const nextName =
      typeof nameEvent.payload.threadName === 'string' ? nameEvent.payload.threadName : null;
    const update = (item: Thread) =>
      item.id === nameEvent.threadId &&
      Date.parse(nameEvent.createdAt) >= Date.parse(item.updatedAt)
        ? { ...item, name: nextName, updatedAt: nameEvent.createdAt }
        : item;
    setThreads((current) => current.map(update));
    setRecentThreads((current) => current.map(update));
  }, [events]);

  useEffect(() => {
    if (!lastRuntimeEvent) return;
    if (lastRuntimeEvent.id <= runtimeSnapshotCursorRef.current) return;
    const runtime = threadRuntimeFrom(lastRuntimeEvent);
    if (!runtime) return;
    const update = (item: Thread) =>
      item.id === lastRuntimeEvent.threadId
        ? {
            ...item,
            status: runtime.status,
            activeTurnId: runtime.activeTurnId,
            updatedAt: lastRuntimeEvent.createdAt,
          }
        : item;
    setThreads((current) => current.map(update));
    setRecentThreads((current) => current.map(update));
  }, [lastRuntimeEvent]);

  useEffect(() => {
    const updates = events.map(subagentFrom).filter((item): item is Subagent => item !== null);
    if (!updates.length) return;
    setSubagents((current) => mergeSubagents(current, updates));
  }, [events]);

  useEffect(() => {
    queuedAttachmentsRef.current = queuedAttachments;
  }, [queuedAttachments]);

  useEffect(() => {
    if (!mobileNavigationOpen) return;
    const navigation = document.getElementById('workspace-navigation');
    if (!navigation) return;
    const focusableSelector =
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
    const focusable = () =>
      [...navigation.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (element) => element.offsetParent !== null,
      );
    navigation.querySelector<HTMLElement>('.mobile-nav-close')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileNavigationOpen(false);
        window.setTimeout(() => mobileNavigationToggleRef.current?.focus());
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      if (!controls.length) return;
      const first = controls[0]!;
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileNavigationOpen]);

  function closeMobileNavigation() {
    setMobileNavigationOpen(false);
    window.setTimeout(() => mobileNavigationToggleRef.current?.focus());
  }

  useEffect(() => {
    if (!showDiagnostics || accountLoginOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setShowDiagnostics(false);
      window.setTimeout(() => statusToggleRef.current?.focus());
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [accountLoginOpen, showDiagnostics]);

  function closeDiagnostics() {
    setShowDiagnostics(false);
    window.setTimeout(() => statusToggleRef.current?.focus());
  }

  function closeAccountLoginDialog() {
    setAccountLoginOpen(false);
    setAccountLogin(null);
    setAccountLoginError(null);
    setAccountLoginCopyNotice(null);
    window.setTimeout(() => accountSwitchButtonRef.current?.focus());
  }

  async function refreshCapabilitiesAfterLogin() {
    try {
      setCapability(await api.capabilities());
    } catch (cause) {
      setAccountLoginError(
        `Вход завершён, но статус аккаунта не обновился: ${errorMessage(cause)}`,
      );
    }
  }

  async function startAccountLogin() {
    setAccountLoginOpen(true);
    setAccountLogin(null);
    setAccountLoginError(null);
    setAccountLoginCopyNotice(null);
    setAccountLoginBusy(true);
    try {
      const next = await api.startCodexAccountLogin(session.csrfToken);
      setAccountLogin(next);
      if (next.state === 'succeeded') await refreshCapabilitiesAfterLogin();
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.status === 409 &&
        cause.code === 'CODEX_ACCOUNT_LOGIN_PENDING'
      ) {
        try {
          setAccountLogin(await api.codexAccountLogin());
          setAccountLoginError(
            'Смена аккаунта уже запущена. Продолжаем ожидать подтверждение входа.',
          );
        } catch (statusCause) {
          setAccountLoginError(
            `Смена аккаунта уже запущена, но её статус недоступен: ${errorMessage(statusCause)}`,
          );
        }
      } else {
        const message =
          cause instanceof ApiError &&
          cause.status === 409 &&
          cause.code === 'CODEX_ACCOUNT_LOGIN_BUSY'
            ? 'Сейчас Codex занят задачей или субагентом. Дождитесь их завершения и повторите попытку.'
            : `Не удалось начать смену аккаунта: ${errorMessage(cause)}`;
        setAccountLoginError(message);
      }
    } finally {
      setAccountLoginBusy(false);
    }
  }

  async function cancelAccountLogin() {
    if (accountLoginBusy) return;
    setAccountLoginBusy(true);
    setAccountLoginError(null);
    try {
      const next = await api.cancelCodexAccountLogin(session.csrfToken);
      setAccountLogin(next);
      if (next.state === 'succeeded') {
        await refreshCapabilitiesAfterLogin();
      } else if (next.state === 'failed') {
        setAccountLoginError(next.message ?? 'Не удалось завершить вход. Попробуйте ещё раз.');
      } else if (next.state === 'idle') {
        setAccountLogin(null);
        setAccountLoginOpen(false);
        setActionNotice('Смена аккаунта отменена. Текущий аккаунт сохранён.');
        window.setTimeout(() => accountSwitchButtonRef.current?.focus());
      } else {
        setAccountLoginError('Отмена ещё выполняется. Ожидаем подтверждение сервера.');
      }
    } catch (cause) {
      setAccountLoginError(`Не удалось отменить вход: ${errorMessage(cause)}`);
    } finally {
      setAccountLoginBusy(false);
    }
  }

  async function copyAccountLoginCode() {
    if (!accountLogin?.userCode) return;
    try {
      await navigator.clipboard.writeText(accountLogin.userCode);
      setAccountLoginCopyNotice('Код скопирован.');
    } catch {
      setAccountLoginCopyNotice('Не удалось скопировать код. Выделите и скопируйте его вручную.');
    }
  }

  useEffect(() => {
    if (!accountLoginOpen || accountLogin?.state !== 'pending') return;
    let disposed = false;
    let checking = false;
    let attempts = 0;
    let timer = 0;
    const poll = async () => {
      if (disposed || checking) return;
      if (attempts >= ACCOUNT_LOGIN_MAX_POLLS) {
        setAccountLoginError('Время ожидания входа истекло. Отмените вход и попробуйте снова.');
        window.clearInterval(timer);
        return;
      }
      if (accountLogin.expiresAt && Date.parse(accountLogin.expiresAt) <= Date.now()) {
        setAccountLoginError('Одноразовый код истёк. Отмените вход и запросите новый код.');
        window.clearInterval(timer);
        return;
      }
      attempts += 1;
      checking = true;
      try {
        const next = await api.codexAccountLogin();
        if (disposed) return;
        setAccountLogin(next);
        if (next.state === 'succeeded') {
          window.clearInterval(timer);
          setAccountLoginError(null);
          try {
            setCapability(await api.capabilities());
          } catch (cause) {
            if (!disposed)
              setAccountLoginError(
                `Вход завершён, но статус аккаунта не обновился: ${errorMessage(cause)}`,
              );
          }
        } else if (next.state === 'failed') {
          window.clearInterval(timer);
          setAccountLoginError(next.message ?? 'Не удалось завершить вход. Попробуйте ещё раз.');
        } else {
          setAccountLoginError(null);
        }
      } catch (cause) {
        if (!disposed)
          setAccountLoginError(`Не удалось проверить состояние входа: ${errorMessage(cause)}`);
      } finally {
        checking = false;
      }
    };
    timer = window.setInterval(() => void poll(), ACCOUNT_LOGIN_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [accountLogin?.expiresAt, accountLogin?.state, accountLoginOpen]);

  useEffect(() => {
    if (codexUpdate?.state !== 'applying') return;
    let disposed = false;
    let checking = false;
    const poll = async () => {
      if (disposed || checking) return;
      checking = true;
      try {
        const next = await api.codexUpdate();
        if (!disposed) {
          setCodexUpdate(next);
          setCodexUpdateError(null);
        }
      } catch (cause) {
        if (!disposed)
          setCodexUpdateError(`Не удалось проверить обновление: ${errorMessage(cause)}`);
      } finally {
        checking = false;
      }
    };
    const timer = window.setInterval(() => void poll(), CODEX_UPDATE_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [codexUpdate?.state]);

  useEffect(() => {
    if (
      codexUpdate?.state !== 'current' ||
      codexUpdate.lastResult?.status !== 'succeeded' ||
      !codexUpdate.lastResult.completedAt ||
      refreshedCodexUpdateRef.current === codexUpdate.lastResult.completedAt
    )
      return;
    refreshedCodexUpdateRef.current = codexUpdate.lastResult.completedAt;
    void api
      .capabilities()
      .then((next) => {
        setCapability(next);
        setActionNotice('Codex обновлён. Чаты и файлы сохранены.');
      })
      .catch((cause: unknown) => {
        setCodexUpdateError(
          `Codex обновлён, но его статус пока недоступен: ${errorMessage(cause)}`,
        );
      });
  }, [codexUpdate]);

  async function togglePushNotifications(): Promise<void> {
    if (!threadId || pushNotificationBusy) return;
    const notificationCapability = capability?.notifications;
    if (!notificationCapability?.available || !notificationCapability.vapidPublicKey) {
      setPushNotificationState('unavailable');
      return;
    }
    const supportIssue = pushSupportIssue();
    if (supportIssue) {
      setPushNotificationState(supportIssue);
      return;
    }

    setPushNotificationBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const currentSubscription = await registration?.pushManager.getSubscription();
      if (pushNotificationState === 'subscribed') {
        if (currentSubscription) {
          await api.deletePushSubscription(
            session.csrfToken,
            threadId,
            currentSubscription.endpoint,
          );
        }
        setPushNotificationState('unsubscribed');
        setActionNotice('Уведомления для этого чата отключены на этом устройстве.');
        return;
      }

      const permission =
        Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;
      if (permission !== 'granted') {
        setPushNotificationState('denied');
        setActionNotice(null);
        return;
      }

      let activeRegistration = registration;
      if (!activeRegistration) {
        await navigator.serviceWorker.register('/push-service-worker.js', { scope: '/' });
        activeRegistration = await navigator.serviceWorker.ready;
      }
      const subscription =
        currentSubscription ??
        (await activeRegistration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKeyBuffer(notificationCapability.vapidPublicKey),
        }));
      await api.savePushSubscription(session.csrfToken, threadId, subscription.toJSON());
      setPushNotificationState('subscribed');
      setActionNotice('Уведомления для этого чата включены на этом устройстве.');
    } catch (cause) {
      setPushNotificationState('error');
      setActionNotice(null);
      setError(`Не удалось изменить уведомления: ${errorMessage(cause)}`);
    } finally {
      setPushNotificationBusy(false);
    }
  }

  function persistRuntimePreferences(input: Omit<RuntimePreferences, 'updatedAt'>) {
    preferencesWriteRef.current = preferencesWriteRef.current
      .catch(() => undefined)
      .then(async () => {
        await api.updateRuntimePreferences(session.csrfToken, input);
      })
      .catch((cause: unknown) =>
        setError(`Не удалось сохранить параметры: ${errorMessage(cause)}`),
      );
  }

  function rememberRuntimePreferences(patch: Partial<Omit<RuntimePreferences, 'updatedAt'>>): void {
    const next = {
      model: patch.model === undefined ? model || null : patch.model,
      reasoningEffort: patch.reasoningEffort === undefined ? effort || null : patch.reasoningEffort,
      permissionPreset: patch.permissionPreset ?? permission,
      approvalPolicy: patch.approvalPolicy ?? approvalPolicy,
    };
    setModel(next.model ?? '');
    setEffort(next.reasoningEffort ?? '');
    setPermission(next.permissionPreset);
    setApprovalPolicy(next.approvalPolicy);
    persistRuntimePreferences(next);
  }

  useEffect(() => {
    void Promise.all([api.projects(), api.models(), api.capabilities(), api.runtimePreferences()])
      .then(([projectList, modelList, systemCapability, preferences]) => {
        setProjects(projectList);
        setModels(modelList);
        setCapability(systemCapability);
        setProjectId((current) => current ?? projectList[0]?.id ?? null);
        const defaultModel = modelList.find((item) => item.isDefault) ?? modelList[0] ?? null;
        const preferredModel =
          modelList.find((item) => item.id === preferences.model) ?? defaultModel;
        const preferredEffort = preferredModel?.supportedReasoningEfforts.some(
          (item) => item.reasoningEffort === preferences.reasoningEffort,
        )
          ? (preferences.reasoningEffort ?? '')
          : (preferredModel?.defaultReasoningEffort ?? '');
        setModel(preferredModel?.id ?? '');
        setEffort(preferredEffort);
        setPermission(preferences.permissionPreset);
        setApprovalPolicy(preferences.approvalPolicy);
        void refreshRecentThreads(projectList).catch((cause: unknown) =>
          setError(errorMessage(cause)),
        );
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
    void api
      .resourceLimits()
      .then(setResourceLimits)
      .catch((cause: unknown) => setResourceError(errorMessage(cause)));
  }, []);

  useEffect(() => {
    if (!projectId) {
      setThreads([]);
      setThreadId(null);
      return;
    }
    setError(null);
    void api
      .threads(projectId, archiveView)
      .then((items) => {
        setThreads(items);
        setThreadId((current) =>
          items.some((item) => item.id === current) ? current : (items[0]?.id ?? null),
        );
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [projectId, archiveView]);

  useEffect(() => {
    let cancelled = false;
    let refreshing = false;

    const refreshServerNavigation = async () => {
      if (refreshing || document.visibilityState === 'hidden') return;
      refreshing = true;
      try {
        const [projectList, resourceSnapshot, threadSubagents] = await Promise.all([
          api.projects(),
          api.resourceLimits().catch(() => null),
          threadId ? api.subagents(threadId).catch(() => null) : Promise.resolve([]),
        ]);
        const activeThreads = await Promise.all(
          projectList.map((project) => api.threads(project.id, false)),
        );
        const archivedThreads =
          archiveView && projectId ? await api.threads(projectId, true) : null;
        if (cancelled) return;
        setProjects(projectList);
        if (resourceSnapshot) setResourceLimits(resourceSnapshot);
        if (threadSubagents) setSubagents((current) => mergeSubagents(current, threadSubagents));
        const selectedIndex = projectList.findIndex((project) => project.id === projectId);
        if (selectedIndex >= 0)
          setThreads(archiveView ? (archivedThreads ?? []) : (activeThreads[selectedIndex] ?? []));
        setRecentThreads(
          activeThreads
            .flat()
            .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
            .slice(0, 20),
        );
      } catch {
        // The selected-thread SSE remains authoritative while a background refresh is unavailable.
      } finally {
        refreshing = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshServerNavigation();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const timer = window.setInterval(() => void refreshServerNavigation(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [archiveView, projectId, threadId]);

  useEffect(() => {
    const previousThreadId = attachmentThreadRef.current;
    attachmentThreadRef.current = threadId;
    if (previousThreadId && previousThreadId !== threadId) {
      for (const upload of activeUploadsRef.current.values()) {
        if (upload.threadId === previousThreadId) upload.abort();
      }
      const previousQueue = queuedAttachmentsRef.current;
      for (const item of previousQueue) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        if (item.uploaded)
          void api.deleteAttachment(session.csrfToken, previousThreadId, item.uploaded.id);
      }
      queuedAttachmentsRef.current = [];
    }
    setQueuedAttachments((current) => {
      current.forEach((item) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
      return [];
    });
    setAttachmentNotice(null);
    setThreadAttachmentBytes(0);
    setSubagents([]);
    setServerTurnNavigation(null);
    runtimeSnapshotCursorRef.current = 0;
    if (!threadId) return;
    const requestedThreadId = threadId;
    let cancelled = false;
    void Promise.all([api.thread(requestedThreadId), api.attachments(requestedThreadId)])
      .then(([history, attachments]) => {
        if (cancelled) return;
        runtimeSnapshotCursorRef.current = history.eventCursor ?? history.events.at(-1)?.id ?? 0;
        setThreads((current) =>
          current.map((item) => (item.id === requestedThreadId ? history.data : item)),
        );
        setRecentThreads((current) =>
          current.map((item) => (item.id === requestedThreadId ? history.data : item)),
        );
        mergeEvents(history.events, requestedThreadId);
        setServerTurnNavigation(history.turnNavigation ?? null);
        const historySubagents = history.subagents;
        if (historySubagents) setSubagents((current) => mergeSubagents(current, historySubagents));
        setThreadAttachmentBytes(
          attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0),
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    void api
      .subagents(requestedThreadId)
      .then((threadSubagents) => {
        if (!cancelled) setSubagents((current) => mergeSubagents(current, threadSubagents));
      })
      .catch(() => {
        // Subagent observability is optional and must not hide the chat history.
      });
    return () => {
      cancelled = true;
    };
  }, [mergeEvents, session.csrfToken, threadId]);

  async function refreshThreads(selectId?: string) {
    if (!projectId) return;
    const items = await api.threads(projectId, archiveView);
    setThreads(items);
    if (selectId) setThreadId(selectId);
  }

  async function refreshRecentThreads(sourceProjects = projects) {
    const projectThreads = await Promise.all(
      sourceProjects.map((project) => api.threads(project.id, false)),
    );
    setRecentThreads(
      projectThreads
        .flat()
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, 20),
    );
  }

  async function createProject(name: string, path: string) {
    try {
      const project = await api.createProject(session.csrfToken, { name, path });
      setProjects((current) => [...current, project]);
      setProjectId(project.id);
      setArchiveView(false);
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    }
  }

  async function newThread(targetProjectId = projectId) {
    if (!targetProjectId) return;
    setBusy(true);
    try {
      const thread = await api.startThread(session.csrfToken, {
        projectId: targetProjectId,
        ...(model ? { model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        permissionPreset: permission,
        approvalPolicy,
      });
      setProjectId(targetProjectId);
      setArchiveView(false);
      setThreads((current) => (targetProjectId === projectId ? [thread, ...current] : [thread]));
      setRecentThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
      setThreadId(thread.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function archiveThread(id: string) {
    try {
      await api.archiveThread(session.csrfToken, id);
      await Promise.all([refreshThreads(), refreshRecentThreads()]);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function restoreThread(id: string) {
    try {
      await api.unarchiveThread(session.csrfToken, id);
      await Promise.all([refreshThreads(), refreshRecentThreads()]);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function renameThread(id: string, name: string) {
    try {
      const updated = await api.renameThread(session.csrfToken, id, name);
      setThreads((current) => current.map((item) => (item.id === id ? updated : item)));
      setRecentThreads((current) => current.map((item) => (item.id === id ? updated : item)));
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    }
  }

  function queueFiles(files: File[]) {
    if (!threadId || archiveView) return;
    if (active) {
      setAttachmentNotice(
        'Вложения нельзя добавить во время активной задачи. Дождитесь её завершения или остановите задачу.',
      );
      return;
    }
    setAttachmentNotice(null);
    setQueuedAttachments((current) => {
      const next = [...current];
      let totalBytes =
        threadAttachmentBytes + current.reduce((total, item) => total + item.file.size, 0);
      for (const file of files) {
        if (next.length >= MAX_ATTACHMENTS_PER_TURN) {
          setAttachmentNotice(`Можно прикрепить не более ${MAX_ATTACHMENTS_PER_TURN} файлов.`);
          break;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setAttachmentNotice(`Файл «${file.name}» больше 20 МБ.`);
          continue;
        }
        if (totalBytes + file.size > MAX_THREAD_ATTACHMENT_BYTES) {
          setAttachmentNotice('Для вложений этого чата превышен лимит 50 МБ.');
          continue;
        }
        const previewUrl =
          file.type.startsWith('image/') && typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(file)
            : null;
        next.push({
          localId: crypto.randomUUID(),
          file,
          previewUrl,
          progress: 0,
          status: 'queued',
          uploaded: null,
          error: null,
        });
        totalBytes += file.size;
      }
      return next;
    });
  }

  async function removeQueuedAttachment(localId: string) {
    const item = queuedAttachments.find((candidate) => candidate.localId === localId);
    if (!item || item.status === 'uploading') return;
    if (item.uploaded && threadId) {
      try {
        await api.deleteAttachment(session.csrfToken, threadId, item.uploaded.id);
      } catch (cause) {
        setError(errorMessage(cause));
        return;
      }
    }
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setQueuedAttachments((current) => current.filter((candidate) => candidate.localId !== localId));
  }

  async function uploadQueued(thread: string): Promise<Attachment[]> {
    const snapshot = queuedAttachments;
    return Promise.all(
      snapshot.map(async (item) => {
        if (item.uploaded) return item.uploaded;
        setQueuedAttachments((current) =>
          current.map((candidate) =>
            candidate.localId === item.localId
              ? { ...candidate, status: 'uploading', progress: 0, error: null }
              : candidate,
          ),
        );
        const upload = api.uploadAttachment(session.csrfToken, thread, item.file, (progress) =>
          setQueuedAttachments((current) =>
            current.map((candidate) =>
              candidate.localId === item.localId ? { ...candidate, progress } : candidate,
            ),
          ),
        );
        activeUploadsRef.current.set(item.localId, {
          threadId: thread,
          abort: upload.abort,
        });
        try {
          const attachment = await upload.promise;
          setQueuedAttachments((current) =>
            current.map((candidate) =>
              candidate.localId === item.localId
                ? { ...candidate, status: 'uploaded', progress: 100, uploaded: attachment }
                : candidate,
            ),
          );
          return attachment;
        } catch (cause) {
          setQueuedAttachments((current) =>
            current.map((candidate) =>
              candidate.localId === item.localId
                ? { ...candidate, status: 'error', error: errorMessage(cause) }
                : candidate,
            ),
          );
          throw cause;
        } finally {
          activeUploadsRef.current.delete(item.localId);
        }
      }),
    );
  }

  async function send() {
    const text = composer.trim();
    if (text === '/status' || text === '/skills') {
      await openStatus();
      setComposer('');
      return;
    }
    if (!threadId || archiveView || (!text && !queuedAttachments.length)) return;
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setBusy(true);
    setError(null);
    const releaseSend = () => {
      sendInFlightRef.current = false;
      setBusy(false);
    };
    let targetActiveTurnId = activeTurnId;
    let targetActiveRootTurn = activeRootTurn;
    if (active && !activeTurnId && !subagentsOnlyActive) {
      try {
        const refreshed = await api.thread(threadId);
        const refreshedEventCursor = refreshed.eventCursor ?? refreshed.events.at(-1)?.id ?? 0;
        const currentSnapshot = selectedThreadRef.current;
        const currentRuntimeEvent = lastRuntimeEventRef.current;
        const reconciledThread =
          currentSnapshot?.id === threadId &&
          currentRuntimeEvent !== undefined &&
          currentRuntimeEvent.id > refreshedEventCursor
            ? currentSnapshot
            : refreshed.data;
        runtimeSnapshotCursorRef.current = refreshedEventCursor;
        const refreshedSubagents = refreshed.subagents ?? [];
        const reconciledSubagents = mergeSubagents(
          attachmentThreadRef.current === threadId ? subagentsRef.current : [],
          refreshedSubagents,
        );
        const refreshedActiveSubagents = reconciledSubagents.filter(
          (subagent) => subagent.status === 'pendingInit' || subagent.status === 'running',
        ).length;
        setThreads((current) =>
          current.map((item) => (item.id === threadId ? reconciledThread : item)),
        );
        setRecentThreads((current) =>
          current.map((item) => (item.id === threadId ? reconciledThread : item)),
        );
        mergeEvents(refreshed.events, threadId);
        setServerTurnNavigation(refreshed.turnNavigation ?? null);
        setSubagents(reconciledSubagents);
        targetActiveTurnId = reconciledThread.activeTurnId;
        targetActiveRootTurn =
          reconciledThread.status === 'active' && reconciledThread.activeTurnId !== null;
        const refreshedSubagentsOnlyActive =
          reconciledThread.status === 'active' &&
          reconciledThread.activeTurnId === null &&
          refreshedActiveSubagents > 0;
        if (
          reconciledThread.status === 'active' &&
          !targetActiveTurnId &&
          !refreshedSubagentsOnlyActive
        ) {
          setError('Не удалось определить активную задачу после сверки с Codex. Повторите позже.');
          releaseSend();
          return;
        }
      } catch (cause) {
        setError(`Не удалось сверить состояние активной задачи: ${errorMessage(cause)}`);
        releaseSend();
        return;
      }
    }
    if (targetActiveRootTurn && queuedAttachments.length) {
      setAttachmentNotice(
        'Вложения нельзя отправить во время активной задачи. Дождитесь её завершения или удалите вложения.',
      );
      releaseSend();
      return;
    }
    setActionNotice(
      targetActiveRootTurn ? 'Передаём уточнение активной задаче…' : 'Передаём задачу Codex…',
    );
    try {
      if (targetActiveRootTurn && targetActiveTurnId) {
        await api.steer(session.csrfToken, threadId, text, targetActiveTurnId);
        setActionNotice('Уточнение принято активной задачей.');
      } else {
        const attachments = await uploadQueued(threadId);
        await api.startTurn(session.csrfToken, threadId, {
          text,
          ...(model ? { model } : {}),
          ...(effort ? { reasoningEffort: effort } : {}),
          permissionPreset: permission,
          approvalPolicy,
          idempotencyKey: crypto.randomUUID(),
          attachmentIds: attachments.map((attachment) => attachment.id),
        });
        setThreadAttachmentBytes(
          (current) =>
            current + attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0),
        );
        queuedAttachments.forEach((item) => {
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        });
        setQueuedAttachments([]);
        setAttachmentNotice(null);
        setActionNotice('Задача принята Codex.');
      }
      setComposer('');
    } catch (cause) {
      setActionNotice(null);
      if (
        active &&
        cause instanceof ApiError &&
        cause.status === 403 &&
        cause.code === 'CSRF_INVALID'
      ) {
        try {
          const refreshedSession = await api.session();
          onSessionRefresh(refreshedSession);
          if (attachmentThreadRef.current === threadId) {
            setError('Сессия обновлена. Текст сохранён — отправьте уточнение ещё раз.');
          }
        } catch {
          if (attachmentThreadRef.current === threadId) {
            setError('Сессия изменилась. Текст сохранён; обновите страницу и отправьте его снова.');
          }
        }
      } else if (attachmentThreadRef.current === threadId) {
        setError(errorMessage(cause));
      }
    } finally {
      releaseSend();
    }
  }

  async function interruptActiveTurn() {
    if (!threadId || !activeTurnId || interrupting) return;
    const interruptedThreadId = threadId;
    const interruptedTurnId = activeTurnId;
    setInterrupting(true);
    setError(null);
    setActionNotice('Отправляем запрос на остановку…');
    try {
      await api.interrupt(session.csrfToken, interruptedThreadId, interruptedTurnId);
      if (attachmentThreadRef.current === interruptedThreadId)
        setActionNotice('Запрос на остановку принят. Ждём завершения задачи.');
    } catch (cause) {
      if (attachmentThreadRef.current === interruptedThreadId) {
        setActionNotice(null);
        setError(errorMessage(cause));
      }
    } finally {
      setInterrupting(false);
    }
  }

  async function openStatus() {
    setShowDiagnostics(true);
    setStatusRefreshing(true);
    setError(null);
    try {
      const [capabilityResult, resourceResult, codexUpdateResult] = await Promise.allSettled([
        api.capabilities(),
        api.resourceLimits(),
        api.codexUpdate(),
      ]);
      if (capabilityResult.status === 'rejected') throw capabilityResult.reason;
      setCapability(capabilityResult.value);
      if (resourceResult.status === 'fulfilled') {
        setResourceLimits(resourceResult.value);
        setResourceError(null);
      } else {
        setResourceError(errorMessage(resourceResult.reason));
      }
      if (codexUpdateResult.status === 'fulfilled') {
        setCodexUpdate(codexUpdateResult.value);
        setCodexUpdateError(null);
      } else {
        setCodexUpdateError(errorMessage(codexUpdateResult.reason));
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStatusRefreshing(false);
    }
  }

  async function applyCodexUpdate() {
    if (codexUpdate?.state !== 'ready' || codexUpdateBusy) return;
    setCodexUpdateBusy(true);
    setCodexUpdateError(null);
    try {
      const next = await api.applyCodexUpdate(session.csrfToken);
      setCodexUpdate(next);
      setActionNotice(
        next.state === 'applying'
          ? 'Обновление Codex началось. Оно завершится автоматически.'
          : 'Состояние обновления Codex изменилось.',
      );
    } catch (cause) {
      setCodexUpdateError(`Не удалось начать обновление: ${errorMessage(cause)}`);
    } finally {
      setCodexUpdateBusy(false);
    }
  }

  async function refreshResourceLimits() {
    setResourceBusy(true);
    setResourceError(null);
    try {
      setResourceLimits(await api.resourceLimits());
    } catch (cause) {
      setResourceError(errorMessage(cause));
    } finally {
      setResourceBusy(false);
    }
  }

  async function saveResourceLimits(desired: ResourceLimitPolicy) {
    if (!resourceLimits) return;
    setResourceBusy(true);
    setResourceError(null);
    try {
      setResourceLimits(
        await api.updateResourceLimits(session.csrfToken, desired, resourceLimits.version),
      );
    } catch (cause) {
      setResourceError(`${errorMessage(cause)} Обновите данные и повторите попытку.`);
    } finally {
      setResourceBusy(false);
    }
  }

  async function applyResourceLimits() {
    if (!resourceLimits) return;
    setResourceBusy(true);
    setResourceError(null);
    try {
      setResourceLimits(
        await api.applyResourceLimits(
          session.csrfToken,
          resourceLimits.version,
          crypto.randomUUID(),
        ),
      );
    } catch (cause) {
      setResourceError(errorMessage(cause));
    } finally {
      setResourceBusy(false);
    }
  }

  async function resolveApproval(
    approvalId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ) {
    try {
      await api.resolveApproval(session.csrfToken, approvalId, decision);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function resolveUserInput(requestId: string, answers: ResolveUserInputRequest['answers']) {
    try {
      await api.resolveUserInput(session.csrfToken, requestId, answers);
      setLocallyResolvedRequests((current) => new Set(current).add(requestId));
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    }
  }

  async function resolvePermission(requestId: string, decision: 'grant' | 'deny') {
    try {
      await api.resolvePermission(session.csrfToken, requestId, decision);
      setLocallyResolvedRequests((current) => new Set(current).add(requestId));
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    }
  }

  return (
    <main className={`workspace ${showDiagnostics ? 'with-diagnostics' : ''}`}>
      <NavigationSidebar
        projects={projects}
        threads={threads}
        recentThreads={recentThreads}
        selectedProjectId={projectId}
        selectedThreadId={threadId}
        archived={archiveView}
        onSelectProject={(id) => {
          setProjectId(id);
          setArchiveView(false);
          setMobileNavigationOpen(false);
        }}
        onSelectThread={(nextProjectId, nextThreadId) => {
          setProjectId(nextProjectId);
          setArchiveView(false);
          setThreadId(nextThreadId);
          setMobileNavigationOpen(false);
        }}
        onNew={() => {
          setMobileNavigationOpen(false);
          void newThread(projectId ?? projects[0]?.id ?? null);
        }}
        onNewInProject={(id) => {
          setMobileNavigationOpen(false);
          void newThread(id);
        }}
        onShowArchived={(id) => {
          setProjectId(id);
          setArchiveView(true);
        }}
        onArchive={(id) => void archiveThread(id)}
        onRestore={(id) => void restoreThread(id)}
        onRename={renameThread}
        onBack={() => setArchiveView(false)}
        onCreate={createProject}
        username={session.username}
        disabled={busy}
        mobileOpen={mobileNavigationOpen}
        onMobileClose={closeMobileNavigation}
        onLogout={() => void api.logout(session.csrfToken).finally(onSignedOut)}
      />
      {mobileNavigationOpen && (
        <button
          className="mobile-nav-backdrop"
          type="button"
          onClick={closeMobileNavigation}
          aria-label="Закрыть навигацию"
        />
      )}
      <section className="chat-panel">
        <header className="chat-toolbar">
          <button
            ref={mobileNavigationToggleRef}
            className="mobile-nav-toggle"
            type="button"
            onClick={() => setMobileNavigationOpen(true)}
            aria-controls="workspace-navigation"
            aria-expanded={mobileNavigationOpen}
            aria-label="Открыть навигацию"
          >
            ☰
          </button>
          <div className="chat-heading">
            <h1>{selectedThread?.name || selectedThread?.preview || 'Новый чат'}</h1>
            <span className={`live-status ${active ? 'running' : ''}`}>
              <i />
              {active
                ? subagentsOnlyActive
                  ? `Субагенты работают: ${activeSubagentCount}`
                  : `Codex работает${activeTurnDuration ? ` уже ${activeTurnDuration}` : ''}`
                : streamState === 'offline'
                  ? 'Нет подключения'
                  : 'Готов'}
            </span>
          </div>
          <div className="toolbar-actions">
            <SubagentMenu subagents={subagents} />
            <button
              className={`icon-button push-notification-toggle ${pushNotificationState === 'subscribed' ? 'enabled' : ''}`}
              type="button"
              onClick={() => void togglePushNotifications()}
              disabled={
                !threadId ||
                pushNotificationBusy ||
                pushNotificationState === 'checking' ||
                pushNotificationState === 'unavailable' ||
                pushNotificationState === 'insecure' ||
                pushNotificationState === 'unsupported' ||
                pushNotificationState === 'denied'
              }
              aria-pressed={pushNotificationState === 'subscribed'}
              aria-label={pushNotificationLabel(pushNotificationState)}
              title={pushNotificationLabel(pushNotificationState)}
            >
              <span aria-hidden="true">
                {pushNotificationBusy || pushNotificationState === 'checking'
                  ? '…'
                  : pushNotificationState === 'subscribed'
                    ? '🔔'
                    : '🔕'}
              </span>
            </button>
            {activeRootTurn && threadId && (
              <button
                className="danger"
                disabled={interrupting || !activeTurnId}
                onClick={() => void interruptActiveTurn()}
              >
                {interrupting ? 'Останавливаем…' : 'Остановить'}
              </button>
            )}
            <button
              ref={statusToggleRef}
              className="ghost"
              onClick={() => (showDiagnostics ? closeDiagnostics() : void openStatus())}
              aria-expanded={showDiagnostics}
              aria-controls="codex-diagnostics"
              disabled={statusRefreshing}
            >
              {statusRefreshing ? 'Обновление…' : 'Статус'}
            </button>
          </div>
        </header>
        {error && (
          <div className="notice error global-error" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Закрыть ошибку">
              ×
            </button>
          </div>
        )}
        {!error && actionNotice && (
          <div className="notice success global-error" role="status">
            <span>{actionNotice}</span>
          </div>
        )}
        <div
          className="conversation-scroll"
          ref={conversationScrollRef}
          tabIndex={0}
          aria-label="История чата"
          onScroll={trackConversationScroll}
          onWheel={markConversationScrollIntent}
          onTouchMove={markConversationScrollIntent}
          onPointerDown={markConversationScrollIntent}
          onKeyDown={markConversationKeyboardScrollIntent}
        >
          <div className="conversation-content" ref={conversationContentRef}>
            <Transcript
              events={events}
              serverTurnNavigation={serverTurnNavigation}
              onNavigateTurn={navigateToTurn}
            />
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onResolve={(decision) => void resolveApproval(approval.id, decision)}
              />
            ))}
            {userInputRequests.map((request) => (
              <UserInputCard
                key={request.id}
                request={request}
                onResolve={(answers) => resolveUserInput(request.id, answers)}
              />
            ))}
            {permissionRequests.map((request) => (
              <PermissionCard
                key={request.id}
                request={request}
                onResolve={(decision) => resolvePermission(request.id, decision)}
              />
            ))}
          </div>
        </div>
        <div className="composer-wrap">
          {showScrollToLatest && (
            <button
              className="scroll-to-latest"
              type="button"
              onClick={scrollToLatest}
              aria-label="Перейти к новым сообщениям"
              title="Новые сообщения ниже"
            >
              ↓
            </button>
          )}
          {composer.startsWith('/') && !composer.includes(' ') && (
            <div className="slash-palette" role="listbox" aria-label="Команды Codex">
              {SLASH_COMMANDS.filter(({ command }) => command.startsWith(composer)).map(
                ({ command, label }) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={composer === command}
                    key={command}
                    onClick={() => setComposer(command)}
                  >
                    <strong>{command}</strong>
                    <span>{label}</span>
                  </button>
                ),
              )}
            </div>
          )}
          <button
            className="mobile-runtime-toggle"
            type="button"
            aria-expanded={mobileRuntimeOpen}
            aria-controls="runtime-selectors"
            onClick={() => setMobileRuntimeOpen((current) => !current)}
          >
            <span>Параметры</span>
            <small>
              {modelOption?.displayName || model || 'Модель'} ·{' '}
              {permission === 'full-access'
                ? 'Полный доступ'
                : permission === 'read-only'
                  ? 'Чтение'
                  : 'Рабочая папка'}
            </small>
            <i aria-hidden="true">{mobileRuntimeOpen ? '⌃' : '⌄'}</i>
          </button>
          <div
            id="runtime-selectors"
            className={`runtime-selectors ${mobileRuntimeOpen ? 'mobile-expanded' : ''}`}
          >
            <label>
              Модель
              <select
                aria-label="Модель"
                value={model}
                onChange={(event) => {
                  const next = models.find((item) => item.id === event.target.value);
                  rememberRuntimePreferences({
                    model: event.target.value,
                    reasoningEffort: next?.defaultReasoningEffort ?? null,
                  });
                }}
              >
                {models.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reasoning
              <select
                aria-label="Уровень reasoning"
                value={effort}
                onChange={(event) =>
                  rememberRuntimePreferences({ reasoningEffort: event.target.value || null })
                }
              >
                <option value="">По умолчанию</option>
                {modelOption?.supportedReasoningEfforts.map((item) => (
                  <option value={item.reasoningEffort} key={item.reasoningEffort}>
                    {item.reasoningEffort}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Доступ
              <select
                aria-label="Уровень доступа"
                value={permission}
                onChange={(event) =>
                  rememberRuntimePreferences({
                    permissionPreset: event.target.value as PermissionPreset,
                  })
                }
              >
                <option value="read-only">Только чтение</option>
                <option value="workspace-write">Рабочая папка</option>
                <option value="full-access">Полный</option>
              </select>
            </label>
            <label>
              Подтверждения
              <select
                aria-label="Политика подтверждений"
                value={approvalPolicy}
                onChange={(event) =>
                  rememberRuntimePreferences({
                    approvalPolicy: event.target.value as ApprovalPolicy,
                  })
                }
              >
                <option value="untrusted">Для недоверенных</option>
                <option value="on-request">По запросу</option>
                <option value="never">Никогда</option>
              </select>
            </label>
          </div>
          <div
            className={`composer ${dragActive ? 'drag-active' : ''}`}
            onDragEnter={(event: DragEvent<HTMLDivElement>) => {
              if (
                !active &&
                !archiveView &&
                threadId &&
                event.dataTransfer.types.includes('Files')
              ) {
                event.preventDefault();
                setDragActive(true);
              }
            }}
            onDragOver={(event: DragEvent<HTMLDivElement>) => {
              if (
                !active &&
                !archiveView &&
                threadId &&
                event.dataTransfer.types.includes('Files')
              ) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDragLeave={(event: DragEvent<HTMLDivElement>) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setDragActive(false);
            }}
            onDrop={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault();
              setDragActive(false);
              queueFiles(Array.from(event.dataTransfer.files));
            }}
          >
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              multiple
              aria-label="Выбрать вложения"
              onChange={(event) => {
                queueFiles(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
              disabled={!threadId || archiveView || active || busy}
            />
            {queuedAttachments.length > 0 && (
              <ul className="attachment-queue" aria-label="Вложения к отправке">
                {queuedAttachments.map((item) => (
                  <li className={item.status === 'error' ? 'failed' : ''} key={item.localId}>
                    {item.previewUrl ? (
                      <img src={item.previewUrl} alt="" />
                    ) : (
                      <span className="attachment-file-icon" aria-hidden="true">
                        ＋
                      </span>
                    )}
                    <span className="queued-file-copy">
                      <strong>{item.file.name}</strong>
                      <small>
                        {item.status === 'uploading'
                          ? `Загрузка ${item.progress}%`
                          : item.status === 'error'
                            ? item.error
                            : `${formatBytes(item.file.size)}${item.status === 'uploaded' ? ' · загружено' : ''}`}
                      </small>
                      {item.status === 'uploading' && (
                        <progress
                          value={item.progress}
                          max="100"
                          aria-label={`Загрузка ${item.file.name}`}
                        />
                      )}
                    </span>
                    <button
                      type="button"
                      className="remove-attachment"
                      aria-label={`Удалить ${item.file.name}`}
                      disabled={item.status === 'uploading' || busy}
                      onClick={() => void removeQueuedAttachment(item.localId)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <textarea
              ref={composerInputRef}
              aria-label={activeRootTurn ? 'Уточнение для активной задачи' : 'Сообщение Codex'}
              placeholder={
                threadId
                  ? archiveView
                    ? 'Восстановите чат, чтобы продолжить'
                    : activeRootTurn
                      ? 'Направить активную задачу…'
                      : subagentsOnlyActive
                        ? 'Поставить новую задачу, пока субагенты завершают работу…'
                        : 'Опишите задачу…'
                  : 'Создайте чат, чтобы начать'
              }
              value={composer}
              onChange={(event) => {
                setComposer(event.target.value);
                fitComposerInput(event.currentTarget);
              }}
              onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
                const files = Array.from(event.clipboardData.files);
                if (files.length) {
                  event.preventDefault();
                  queueFiles(files);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              disabled={!threadId || archiveView}
              rows={1}
            />
            <div className="composer-controls">
              <button
                type="button"
                className="attach-button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!threadId || archiveView || activeRootTurn || busy}
                aria-label="Прикрепить файлы"
                title={
                  activeRootTurn
                    ? 'Вложения недоступны во время активной задачи'
                    : 'Прикрепить файлы'
                }
              >
                ＋
              </button>
              <VoiceInputButton
                available={capability?.transcription?.available ?? false}
                csrfToken={session.csrfToken}
                disabled={!threadId || archiveView || busy}
                maxBytes={capability?.transcription?.maxBytes ?? 10 * 1024 * 1024}
                maxDurationSeconds={capability?.transcription?.maxDurationSeconds ?? 120}
                onError={setError}
                onTranscript={(text) => {
                  setComposer((current) => `${current}${current.trim() ? '\n' : ''}${text}`);
                  window.requestAnimationFrame(() => composerInputRef.current?.focus());
                }}
              />
              <button
                className="send-button"
                onClick={() => void send()}
                disabled={
                  !threadId ||
                  archiveView ||
                  (!composer.trim() && !queuedAttachments.length) ||
                  (activeRootTurn && queuedAttachments.length > 0) ||
                  busy
                }
                aria-label={activeRootTurn ? 'Направить задачу' : 'Отправить сообщение'}
              >
                {activeRootTurn ? '↗' : '↑'}
              </button>
            </div>
          </div>
          {(attachmentNotice || (activeRootTurn && queuedAttachments.length > 0)) && (
            <p className="attachment-notice" role="status">
              {attachmentNotice ??
                'Вложения нельзя отправить во время активной задачи. Дождитесь её завершения или удалите вложения.'}
            </p>
          )}
          <p className="composer-hint">
            Enter — отправить · Shift+Enter — новая строка · / — команды
          </p>
        </div>
      </section>
      {showDiagnostics && (
        <Diagnostics
          capability={capability}
          codexUpdate={codexUpdate}
          codexUpdateBusy={codexUpdateBusy}
          codexUpdateError={codexUpdateError}
          resourceLimits={resourceLimits}
          resourceBusy={resourceBusy}
          resourceError={resourceError}
          thread={selectedThread}
          onRefreshResources={() => void refreshResourceLimits()}
          onSaveResources={saveResourceLimits}
          onApplyResources={applyResourceLimits}
          onStartAccountLogin={() => void startAccountLogin()}
          onApplyCodexUpdate={() => void applyCodexUpdate()}
          accountSwitchButtonRef={accountSwitchButtonRef}
          onClose={closeDiagnostics}
        />
      )}
      {accountLoginOpen && (
        <AccountLoginDialog
          login={accountLogin}
          busy={accountLoginBusy}
          error={accountLoginError}
          copyNotice={accountLoginCopyNotice}
          onCopy={() => void copyAccountLoginCode()}
          onCancel={() => void cancelAccountLogin()}
          onClose={closeAccountLoginDialog}
        />
      )}
    </main>
  );
}

export function App() {
  const [state, setState] = useState<LoadState>('loading');
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    void api
      .session()
      .then((value) => {
        setSession(value);
        setState('ready');
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) setState('signed-out');
        else setState('signed-out');
      });
  }, []);

  if (state === 'loading')
    return (
      <main className="loading-screen">
        <div className="spinner" />
        <span>Подключаемся к серверу…</span>
      </main>
    );
  if (!session || state === 'signed-out')
    return (
      <Login
        onLogin={(value) => {
          setSession(value);
          setState('ready');
        }}
      />
    );
  return (
    <Workspace
      session={session}
      onSessionRefresh={setSession}
      onSignedOut={() => {
        setSession(null);
        setState('signed-out');
      }}
    />
  );
}
