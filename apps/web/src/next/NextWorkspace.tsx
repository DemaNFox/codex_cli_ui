import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AgentMessageContent } from '../AgentMessageContent.js';
import { api } from '../api.js';
import type { Project, SafeEvent, Session, Thread } from '../api.js';
import { useThreadEvents } from '../useThreadEvents.js';
import { clearThreadHistoryCache, disableThreadHistoryCacheWrites } from '../threadHistoryCache.js';
import { conversationMessages } from './conversation.js';
import './next.css';

interface Props {
  session: Session;
  onSignedOut: () => void;
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Неизвестная ошибка';
}

function mergeSnapshotEvents(events: SafeEvent[], spine: SafeEvent[] = []): SafeEvent[] {
  const byId = new Map<number, SafeEvent>();
  for (const event of [...events, ...spine]) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function NextWorkspace({ session, onSignedOut }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [oldestEventId, setOldestEventId] = useState<number | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [eventCursor, setEventCursor] = useState<number | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const selectedThreadRef = useRef(threadId);
  selectedThreadRef.current = threadId;
  const loadRequestRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const olderRequestRef = useRef(0);
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const { events, streamState, replaceSnapshot, prependHistory } = useThreadEvents(
    threadId,
    eventCursor,
  );
  const selectedEvents = useMemo(
    () => events.filter((event) => event.threadId === threadId),
    [events, threadId],
  );
  const messages = useMemo(() => conversationMessages(selectedEvents), [selectedEvents]);
  const activities = useMemo(
    () => selectedEvents.filter((event) => !['user-message', 'agent-message'].includes(event.kind)),
    [selectedEvents],
  );

  useEffect(() => {
    let disposed = false;
    void api
      .projects()
      .then((list) => {
        if (disposed) return;
        setProjects(list);
        setProjectId((current) => current ?? list[0]?.id ?? null);
      })
      .catch((cause) => {
        if (!disposed) setNavigationError(`Проекты не загружены: ${failureMessage(cause)}`);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    setThreads([]);
    setThreadId(null);
    if (!projectId) return;
    let disposed = false;
    void api
      .threads(projectId)
      .then((list) => {
        if (disposed) return;
        setThreads(list);
        setNavigationError(null);
      })
      .catch((cause) => {
        if (!disposed) setNavigationError(`Чаты не загружены: ${failureMessage(cause)}`);
      });
    return () => {
      disposed = true;
    };
  }, [projectId]);

  const loadThread = useCallback(
    async (id: string) => {
      const requestId = ++loadRequestRef.current;
      ++olderRequestRef.current;
      loadingOlderRef.current = false;
      setLoadingOlder(false);
      setLoadingHistory(true);
      setHistoryError(null);
      try {
        const snapshot = await api.thread(id);
        if (selectedThreadRef.current !== id || loadRequestRef.current !== requestId) return;
        setSelectedThread(snapshot.data);
        setOldestEventId(snapshot.oldestEventId ?? snapshot.events[0]?.id ?? null);
        setHasOlder(snapshot.historyTruncated === true);
        replaceSnapshot(mergeSnapshotEvents(snapshot.events, snapshot.conversationEvents), id);
        setEventCursor(
          snapshot.eventCursor ?? Math.max(0, ...snapshot.events.map((event) => event.id)),
        );
        if (snapshot.historyWarning) setHistoryError(snapshot.historyWarning);
      } catch (cause) {
        if (selectedThreadRef.current === id && loadRequestRef.current === requestId)
          setHistoryError(`История не загружена: ${failureMessage(cause)}`);
      } finally {
        if (selectedThreadRef.current === id && loadRequestRef.current === requestId)
          setLoadingHistory(false);
      }
    },
    [replaceSnapshot],
  );

  useEffect(() => {
    ++loadRequestRef.current;
    ++olderRequestRef.current;
    loadingOlderRef.current = false;
    setSelectedThread(null);
    setEventCursor(null);
    setOldestEventId(null);
    setHasOlder(false);
    setHistoryError(null);
    setLoadingHistory(false);
    setLoadingOlder(false);
    if (threadId) void loadThread(threadId);
  }, [threadId, loadThread]);

  async function loadOlder(): Promise<void> {
    if (!threadId || !hasOlder || oldestEventId === null || loadingOlderRef.current) return;
    const id = threadId;
    const snapshotRequestId = loadRequestRef.current;
    const olderRequestId = ++olderRequestRef.current;
    const scroll = historyScrollRef.current;
    const previousHeight = scroll?.scrollHeight ?? 0;
    const previousTop = scroll?.scrollTop ?? 0;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setHistoryError(null);
    try {
      const page = await api.threadHistory(id, oldestEventId);
      if (selectedThreadRef.current !== id || loadRequestRef.current !== snapshotRequestId) return;
      prependHistory(page.events, id);
      setOldestEventId(page.oldestEventId);
      setHasOlder(page.hasMore);
      requestAnimationFrame(() => {
        if (
          selectedThreadRef.current === id &&
          loadRequestRef.current === snapshotRequestId &&
          scroll
        )
          scroll.scrollTop = previousTop + scroll.scrollHeight - previousHeight;
      });
    } catch (cause) {
      if (selectedThreadRef.current === id && loadRequestRef.current === snapshotRequestId)
        setHistoryError(`Предыдущие сообщения не загружены: ${failureMessage(cause)}`);
    } finally {
      if (olderRequestRef.current === olderRequestId) {
        loadingOlderRef.current = false;
        if (selectedThreadRef.current === id) setLoadingOlder(false);
      }
    }
  }

  async function signOut(): Promise<void> {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await api.logout(session.csrfToken);
      disableThreadHistoryCacheWrites();
      await clearThreadHistoryCache().catch(() => undefined);
      onSignedOut();
    } catch (cause) {
      setNavigationError(`Выход не выполнен: ${failureMessage(cause)}`);
      setSigningOut(false);
    }
  }

  return (
    <main className="next-app">
      <aside className="next-sidebar" aria-label="Проекты и чаты">
        <div className="next-brand">
          Codex <span>v2 · просмотр</span>
        </div>
        <a className="next-classic-link" href="/">
          Вернуться в основной интерфейс
        </a>
        <p className="next-section-label">Проекты</p>
        <nav aria-label="Проекты">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={project.id === projectId ? 'next-selected' : ''}
              aria-current={project.id === projectId ? 'page' : undefined}
              onClick={() => setProjectId(project.id)}
            >
              {project.name}
            </button>
          ))}
        </nav>
        <p className="next-section-label">Чаты</p>
        <nav className="next-thread-list" aria-label="Чаты проекта">
          {threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className={thread.id === threadId ? 'next-selected' : ''}
              aria-current={thread.id === threadId ? 'page' : undefined}
              onClick={() => setThreadId(thread.id)}
            >
              <span>{thread.name || 'Новый чат'}</span>
              {thread.status === 'active' && <small>В работе</small>}
            </button>
          ))}
        </nav>
        {navigationError && (
          <p role="alert" className="next-error">
            {navigationError}
          </p>
        )}
        <button
          type="button"
          className="next-logout"
          disabled={signingOut}
          onClick={() => void signOut()}
        >
          Выйти · {session.username}
        </button>
      </aside>
      <section className="next-main" aria-label="Чат">
        <header className="next-header">
          <div>
            <h1>{selectedThread?.name || (threadId ? 'Загружаем чат…' : 'Выберите чат')}</h1>
            {threadId && (
              <p>
                {streamState === 'open'
                  ? 'Подключено'
                  : streamState === 'connecting'
                    ? 'Подключаемся…'
                    : 'Нет соединения'}
              </p>
            )}
          </div>
          {threadId && (
            <button
              type="button"
              onClick={() => void loadThread(threadId)}
              disabled={loadingHistory}
            >
              Обновить
            </button>
          )}
        </header>
        <div className="next-history" ref={historyScrollRef}>
          <div className="next-reading-column">
            {hasOlder && (
              <button
                type="button"
                className="next-older"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
              >
                {' '}
                {loadingOlder ? 'Загружаем…' : 'Показать предыдущие сообщения'}{' '}
              </button>
            )}
            {loadingHistory && <p role="status">Загружаем историю…</p>}
            {historyError && (
              <p role="alert" className="next-error">
                {historyError}
              </p>
            )}
            {!threadId && (
              <div className="next-empty">Выберите проект и чат, чтобы открыть историю.</div>
            )}
            {threadId && !loadingHistory && !messages.length && !historyError && (
              <div className="next-empty">В этом чате пока нет сообщений.</div>
            )}
            {messages.map((message) => (
              <article
                key={message.event.id}
                className={`next-message next-${message.role}${message.finalState === 'complete' ? ' next-final' : ''}`}
              >
                <div className="next-message-meta">
                  <strong>{message.role === 'user' ? 'Вы' : 'Codex'}</strong>
                  {message.finalState === 'complete' && <span>Итоговый ответ</span>}
                  {message.finalState === 'working' && (
                    <span>Ответ получен · работа продолжается</span>
                  )}
                  {message.finalState === 'failed' && (
                    <span>Ответ получен · задача не завершена</span>
                  )}
                  <time dateTime={message.event.createdAt}>
                    {new Date(message.event.createdAt).toLocaleString('ru-RU')}
                  </time>
                </div>
                {message.role === 'codex' ? (
                  <AgentMessageContent text={message.text} threadId={message.event.threadId} />
                ) : (
                  <p className="next-user-text">{message.text || 'Вложение без текста'}</p>
                )}
              </article>
            ))}
            {!!activities.length && (
              <details
                className="next-activities"
                open={showActivity}
                onToggle={(event) => setShowActivity(event.currentTarget.open)}
              >
                <summary>Ход работы · {activities.length} событий</summary>
                <ol>
                  {activities.slice(-30).map((event) => (
                    <li key={event.id}>
                      {event.kind} · {event.phase}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </div>
        </div>
        <footer className="next-footer">
          Режим просмотра: отправка задач и управление агентами пока доступны в{' '}
          <a href="/">основном интерфейсе</a>.
        </footer>
      </section>
    </main>
  );
}
