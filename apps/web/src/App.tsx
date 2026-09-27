import {
  ClipboardEvent,
  DragEvent,
  FormEvent,
  type ReactNode,
  useEffect,
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
import type {
  Attachment,
  Capability,
  ModelOption,
  PendingApproval,
  Project,
  SafeEvent,
  Session,
  Thread,
} from './api.js';
import { useThreadEvents } from './useThreadEvents.js';

type LoadState = 'loading' | 'ready' | 'signed-out';

const MAX_ATTACHMENTS_PER_TURN = 8;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_THREAD_ATTACHMENT_BYTES = 50 * 1024 * 1024;

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

function formatResetTime(value: number | null): string {
  return value === null ? 'неизвестно' : new Date(value * 1000).toLocaleString('ru');
}

function formatMetric(value: number | null): string {
  return value === null ? 'нет данных' : value.toLocaleString('ru');
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

function eventTitle(event: SafeEvent): string {
  if (event.kind === 'tool') {
    const preview = eventPreview(event);
    if (preview === 'команда')
      return event.phase === 'completed' ? 'Выполнил команду' : 'Выполняет команду';
    if (preview === 'изменение файлов')
      return event.phase === 'completed' ? 'Изменил файлы' : 'Изменяет файлы';
    if (preview === 'анализ')
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

function eventPreview(event: SafeEvent): string | null {
  const source = event.payload;
  const item =
    source.item && typeof source.item === 'object'
      ? (source.item as Record<string, unknown>)
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
    item?.tool,
    item?.type,
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
  onBack,
  onCreate,
  onLogout,
  username,
  disabled,
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
  onBack: () => void;
  onCreate: (name: string, path: string) => Promise<void>;
  onLogout: () => void;
  username: string;
  disabled: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(selectedProjectId);
  useEffect(() => {
    if (selectedProjectId) setExpandedProjectId(selectedProjectId);
  }, [selectedProjectId]);

  const threadRows = (items: Thread[], showProject: boolean, archivedRows = false) =>
    items.map((thread) => {
      const project = projects.find((candidate) => candidate.id === thread.projectId);
      return (
        <div
          className={`thread-row ${thread.id === selectedThreadId ? 'selected' : ''}`}
          key={thread.id}
        >
          <button
            aria-label={`${showProject ? 'Открыть недавний чат' : 'Открыть чат проекта'} ${thread.name || thread.preview || 'Новый чат'}`}
            onClick={() => onSelectThread(thread.projectId, thread.id)}
            disabled={disabled}
          >
            <strong>{thread.name || thread.preview || 'Новый чат'}</strong>
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
            )}
          </ContextMenu>
        </div>
      );
    });

  return (
    <aside className="navigation-sidebar" aria-label="Навигация">
      <div className="app-brand">
        <span className="mini-mark">C</span>
        <strong>Codex Server</strong>
      </div>
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
                  <p className="empty-hint">{archived ? 'Архив пуст.' : 'Здесь пока нет чатов.'}</p>
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
      <div className="account-row">
        <span className="avatar">{username.slice(0, 1).toUpperCase()}</span>
        <span>{username}</span>
        <button className="ghost" onClick={onLogout}>
          Выйти
        </button>
      </div>
    </aside>
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

function Transcript({ events }: { events: SafeEvent[] }) {
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
        (event.kind === 'turn' && event.phase !== 'failed')
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

  if (!displayEvents.length) {
    return (
      <div className="welcome-state">
        <div className="welcome-orb">C</div>
        <h2>Что будем делать?</h2>
        <p>Опишите задачу — Codex выполнит её непосредственно на сервере.</p>
      </div>
    );
  }

  return (
    <div className="transcript" aria-live="polite">
      {displayEvents.map((event) => {
        if (event.kind === 'user-message' || event.kind === 'agent-message') {
          const attachments = attachmentsFrom(event);
          const text = eventText(event);
          return (
            <article
              className={`message ${event.kind === 'user-message' ? 'user' : 'agent'}`}
              key={event.id}
            >
              <span className="message-role">{event.kind === 'user-message' ? 'Вы' : 'Codex'}</span>
              {text && <div className="message-text">{text}</div>}
              <AttachmentList attachments={attachments} />
            </article>
          );
        }
        const preview = eventPreview(event);
        const details = eventText(event);
        const hasDetails = details !== `${event.kind}: ${event.phase}` && details !== preview;
        const content = (
          <>
            <span className="activity-dot" aria-hidden="true" />
            <span className="activity-title">{eventTitle(event)}</span>
            {preview && <small>{preview}</small>}
          </>
        );
        return hasDetails ? (
          <details
            className={`activity-row ${event.kind}`}
            key={event.id}
            open={event.kind === 'error'}
          >
            <summary>{content}</summary>
            <pre>{details}</pre>
          </details>
        ) : (
          <div className={`activity-row ${event.kind}`} key={event.id}>
            <div className="activity-line">{content}</div>
          </div>
        );
      })}
    </div>
  );
}

function Diagnostics({
  capability,
  thread,
  onClose,
}: {
  capability: Capability | null;
  thread: Thread | null;
  onClose: () => void;
}) {
  return (
    <aside className="diagnostics" aria-label="Статус Codex">
      <header>
        <div>
          <p className="eyebrow">CODEX STATUS</p>
          <h2>Статус</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть диагностику">
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
          </dl>
          <h3>Лимиты</h3>
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

function Workspace({ session, onSignedOut }: { session: Session; onSignedOut: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [recentThreads, setRecentThreads] = useState<Thread[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [capability, setCapability] = useState<Capability | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [archiveView, setArchiveView] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permission, setPermission] = useState<PermissionPreset>('workspace-write');
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>('on-request');
  const [composer, setComposer] = useState('');
  const [queuedAttachments, setQueuedAttachments] = useState<QueuedAttachment[]>([]);
  const [threadAttachmentBytes, setThreadAttachmentBytes] = useState(0);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queuedAttachmentsRef = useRef<QueuedAttachment[]>([]);
  const attachmentThreadRef = useRef<string | null>(null);
  const activeUploadsRef = useRef(new Map<string, { threadId: string; abort: () => void }>());
  const [locallyResolvedRequests, setLocallyResolvedRequests] = useState<Set<string>>(
    () => new Set(),
  );
  const { events, streamState, mergeEvents } = useThreadEvents(threadId);

  const selectedProject = projects.find((item) => item.id === projectId) ?? null;
  const selectedThread = threads.find((item) => item.id === threadId) ?? null;
  const modelOption = models.find((item) => item.id === model) ?? null;
  const turnEvents = events.filter((event) => event.kind === 'turn');
  const lastTurnEvent = turnEvents.at(-1);
  const active =
    lastTurnEvent?.phase === 'started' || lastTurnEvent?.payload.status === 'inProgress';
  const activeTurnId = active ? lastTurnEvent?.turnId : null;
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
  }, [threadId]);

  useEffect(() => {
    queuedAttachmentsRef.current = queuedAttachments;
  }, [queuedAttachments]);

  useEffect(() => {
    void Promise.all([api.projects(), api.models(), api.capabilities()])
      .then(([projectList, modelList, systemCapability]) => {
        setProjects(projectList);
        setModels(modelList);
        setCapability(systemCapability);
        setProjectId((current) => current ?? projectList[0]?.id ?? null);
        const defaultModel = modelList.find((item) => item.isDefault) ?? modelList[0];
        setModel((current) => current || defaultModel?.id || '');
        setEffort((current) => current || defaultModel?.defaultReasoningEffort || '');
        void refreshRecentThreads(projectList).catch((cause: unknown) =>
          setError(errorMessage(cause)),
        );
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
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
    if (!threadId) return;
    const requestedThreadId = threadId;
    let cancelled = false;
    void Promise.all([api.thread(requestedThreadId), api.attachments(requestedThreadId)])
      .then(([history, attachments]) => {
        if (cancelled) return;
        setThreads((current) =>
          current.map((item) => (item.id === requestedThreadId ? history.data : item)),
        );
        setRecentThreads((current) =>
          current.map((item) => (item.id === requestedThreadId ? history.data : item)),
        );
        mergeEvents(history.events, requestedThreadId);
        setThreadAttachmentBytes(
          attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0),
        );
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [mergeEvents, session.csrfToken, threadId]);

  useEffect(() => {
    if (!selectedProject) return;
    setModel(
      selectedProject.defaultModel ||
        models.find((item) => item.isDefault)?.id ||
        models[0]?.id ||
        '',
    );
    setEffort(selectedProject.defaultReasoningEffort || '');
    setPermission(selectedProject.defaultPermissionPreset);
  }, [selectedProject?.id, models]);

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
    const targetProject = projects.find((project) => project.id === targetProjectId) ?? null;
    setBusy(true);
    try {
      const thread = await api.startThread(session.csrfToken, {
        projectId: targetProjectId,
        ...(targetProject?.defaultModel || model
          ? { model: targetProject?.defaultModel || model }
          : {}),
        ...(targetProject?.defaultReasoningEffort || effort
          ? { reasoningEffort: targetProject?.defaultReasoningEffort || effort }
          : {}),
        permissionPreset: targetProject?.defaultPermissionPreset ?? permission,
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
    if (active && queuedAttachments.length) {
      setAttachmentNotice(
        'Вложения нельзя отправить во время активной задачи. Дождитесь её завершения или удалите вложения.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (active && activeTurnId) {
        await api.steer(session.csrfToken, threadId, text, activeTurnId);
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
      }
      setComposer('');
    } catch (cause) {
      if (attachmentThreadRef.current === threadId) setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openStatus() {
    setShowDiagnostics(true);
    setStatusRefreshing(true);
    setError(null);
    try {
      setCapability(await api.capabilities());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStatusRefreshing(false);
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
        }}
        onSelectThread={(nextProjectId, nextThreadId) => {
          setProjectId(nextProjectId);
          setArchiveView(false);
          setThreadId(nextThreadId);
        }}
        onNew={() => void newThread(projectId ?? projects[0]?.id ?? null)}
        onNewInProject={(id) => void newThread(id)}
        onShowArchived={(id) => {
          setProjectId(id);
          setArchiveView(true);
        }}
        onArchive={(id) => void archiveThread(id)}
        onRestore={(id) => void restoreThread(id)}
        onBack={() => setArchiveView(false)}
        onCreate={createProject}
        username={session.username}
        disabled={busy}
        onLogout={() => void api.logout(session.csrfToken).finally(onSignedOut)}
      />
      <section className="chat-panel">
        <header className="chat-toolbar">
          <div>
            <h1>{selectedThread?.name || selectedThread?.preview || 'Новый чат'}</h1>
            <span className={`live-status ${active ? 'running' : ''}`}>
              <i />
              {active ? 'Codex работает' : streamState === 'offline' ? 'Нет подключения' : 'Готов'}
            </span>
          </div>
          <div className="toolbar-actions">
            {active && threadId && activeTurnId && (
              <button
                className="danger"
                onClick={() => void api.interrupt(session.csrfToken, threadId, activeTurnId)}
              >
                Остановить
              </button>
            )}
            <button
              className="ghost"
              onClick={() => (showDiagnostics ? setShowDiagnostics(false) : void openStatus())}
              aria-expanded={showDiagnostics}
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
        <div className="conversation-scroll">
          <Transcript events={events} />
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
        <div className="composer-wrap">
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
          <div className="runtime-selectors">
            <label>
              Модель
              <select
                aria-label="Модель"
                value={model}
                onChange={(event) => {
                  const next = models.find((item) => item.id === event.target.value);
                  setModel(event.target.value);
                  setEffort(next?.defaultReasoningEffort || '');
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
                onChange={(event) => setEffort(event.target.value)}
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
                onChange={(event) => setPermission(event.target.value as PermissionPreset)}
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
                onChange={(event) => setApprovalPolicy(event.target.value as ApprovalPolicy)}
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
              aria-label={active ? 'Уточнение для активной задачи' : 'Сообщение Codex'}
              placeholder={
                threadId
                  ? archiveView
                    ? 'Восстановите чат, чтобы продолжить'
                    : active
                      ? 'Направить активную задачу…'
                      : 'Опишите задачу…'
                  : 'Создайте чат, чтобы начать'
              }
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
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
              rows={3}
            />
            <button
              type="button"
              className="attach-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!threadId || archiveView || active || busy}
              aria-label="Прикрепить файлы"
              title={active ? 'Вложения недоступны во время активной задачи' : 'Прикрепить файлы'}
            >
              ＋
            </button>
            <button
              className="send-button"
              onClick={() => void send()}
              disabled={
                !threadId ||
                archiveView ||
                (!composer.trim() && !queuedAttachments.length) ||
                (active && queuedAttachments.length > 0) ||
                busy
              }
              aria-label={active ? 'Направить задачу' : 'Отправить сообщение'}
            >
              {active ? '↗' : '↑'}
            </button>
          </div>
          {(attachmentNotice || (active && queuedAttachments.length > 0)) && (
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
          thread={selectedThread}
          onClose={() => setShowDiagnostics(false)}
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
      onSignedOut={() => {
        setSession(null);
        setState('signed-out');
      }}
    />
  );
}
