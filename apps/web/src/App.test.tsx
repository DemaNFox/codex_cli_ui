import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

const session = {
  authenticated: true,
  username: 'nick',
  csrfToken: 'csrf-token',
  expiresAt: '2027-01-01T00:00:00.000Z',
};

const project = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'AI Chat Bot',
  path: '/srv/projects/ai-chat-bot',
  defaultModel: 'gpt-test',
  defaultReasoningEffort: 'medium',
  defaultPermissionPreset: 'workspace-write',
  createdAt: '2026-09-27T10:00:00.000Z',
  updatedAt: '2026-09-27T10:00:00.000Z',
};

const thread = {
  id: 'thread-1',
  projectId: project.id,
  name: 'Frontend task',
  preview: 'Build UI',
  model: 'gpt-test',
  status: 'idle',
  archived: false,
  instructionSources: ['/srv/projects/ai-chat-bot/AGENTS.md'],
  createdAt: '2026-09-27T10:00:00.000Z',
  updatedAt: '2026-09-27T10:00:00.000Z',
};

const models = [
  {
    id: 'gpt-test',
    displayName: 'GPT Test',
    isDefault: true,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'medium', description: 'Balanced' },
    ],
  },
];

const capabilities = {
  codexVersion: '1.2.3',
  authenticated: true,
  appServerReady: true,
  projectRoots: ['/srv/projects'],
  skills: [
    { name: 'multi-agent-orchestrator', path: '/etc/codex/skills/orchestrator', enabled: true },
  ],
  rateLimits: [
    {
      limitId: 'codex',
      limitName: 'Codex',
      planType: 'plus',
      primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: null,
    },
  ],
  usage: {
    summary: {
      lifetimeTokens: 123456,
      currentStreakDays: 4,
      longestStreakDays: 9,
      peakDailyTokens: 23456,
      longestRunningTurnSec: 321,
    },
    dailyUsageBuckets: null,
  },
  warnings: [],
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  private readonly target = new EventTarget();
  close = vi.fn();
  addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) =>
    this.target.addEventListener(type, listener),
  );
  removeEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) =>
    this.target.removeEventListener(type, listener),
  );
  dispatchEvent = (event: Event) => this.target.dispatchEvent(event);

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  emit(payload: unknown, eventName?: string) {
    const kind =
      payload &&
      typeof payload === 'object' &&
      'kind' in payload &&
      typeof payload.kind === 'string'
        ? payload.kind
        : 'message';
    this.dispatchEvent(
      new MessageEvent(eventName ?? kind, {
        data: JSON.stringify(payload),
      }),
    );
  }
}

class FakeXMLHttpRequest extends EventTarget {
  static instances: FakeXMLHttpRequest[] = [];
  static autoRespond = true;
  readonly upload = new EventTarget();
  status = 0;
  responseText = '';
  withCredentials = false;
  method = '';
  url = '';
  body: Document | XMLHttpRequestBodyInit | null = null;
  headers = new Map<string, string>();

  constructor() {
    super();
    FakeXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.body = body;
    if (FakeXMLHttpRequest.autoRespond) queueMicrotask(() => this.complete());
  }

  abort() {
    this.dispatchEvent(new Event('abort'));
  }

  progress(loaded: number, total: number) {
    this.upload.dispatchEvent(
      new ProgressEvent('progress', { lengthComputable: true, loaded, total }),
    );
  }

  complete(status = 201) {
    const file = this.body instanceof FormData ? this.body.get('file') : null;
    const name = file instanceof File ? file.name : 'attachment.bin';
    const mediaType = file instanceof File ? file.type : 'application/octet-stream';
    const sizeBytes = file instanceof File ? file.size : 0;
    this.status = status;
    this.responseText = JSON.stringify({
      data: {
        id: `attachment-${FakeXMLHttpRequest.instances.indexOf(this) + 1}`,
        threadId: 'thread-1',
        name,
        mediaType,
        kind: mediaType.startsWith('image/') ? 'image' : 'file',
        sizeBytes,
        createdAt: '2026-09-27T10:10:00.000Z',
        url: `/api/threads/thread-1/attachments/attachment-1/content`,
      },
    });
    this.dispatchEvent(new Event('load'));
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function installAuthenticatedApi(
  overrides?: (url: string, init?: RequestInit) => Response | undefined,
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const overridden = overrides?.(url, init);
    if (overridden) return Promise.resolve(overridden);
    if (url === '/api/auth/session') return Promise.resolve(jsonResponse(session));
    if (url === '/api/projects') return Promise.resolve(jsonResponse([project]));
    if (url === '/api/models') return Promise.resolve(jsonResponse(models));
    if (url === '/api/system/capabilities') return Promise.resolve(jsonResponse(capabilities));
    if (url.includes('/api/threads?')) return Promise.resolve(jsonResponse([thread]));
    if (/^\/api\/threads\/[^/]+\/attachments$/.test(url)) {
      return Promise.resolve(jsonResponse([]));
    }
    if (url === '/api/threads/thread-1') {
      return Promise.resolve(jsonResponse({ data: thread, events: [] }));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  FakeXMLHttpRequest.instances = [];
  FakeXMLHttpRequest.autoRespond = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:preview'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(() => undefined),
  });
});

describe('App', () => {
  it('authenticates the operator and opens the workspace', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === '/api/auth/session')
        return Promise.resolve(jsonResponse({ message: 'unauthorized' }, 401));
      if (url === '/api/auth/login') return Promise.resolve(jsonResponse(session));
      if (url === '/api/projects') return Promise.resolve(jsonResponse([project]));
      if (url === '/api/models') return Promise.resolve(jsonResponse(models));
      if (url === '/api/system/capabilities') return Promise.resolve(jsonResponse(capabilities));
      if (url.includes('/api/threads?')) return Promise.resolve(jsonResponse([thread]));
      if (url === '/api/threads/thread-1') {
        return Promise.resolve(jsonResponse({ data: thread, events: [] }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    await user.type(await screen.findByLabelText('Логин'), 'nick');
    await user.type(screen.getByLabelText('Пароль'), 'very-secure-password');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect((await screen.findAllByText('AI Chat Bot')).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
  });

  it('renders streamed repository content as inert text', async () => {
    installAuthenticatedApi();
    const { unmount } = render(<App />);

    await screen.findAllByText('Frontend task');
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1);
    act(() => {
      source?.emit({
        id: 1,
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'agent-message',
        phase: 'completed',
        payload: { text: '<img src=x onerror=alert(1)>' },
        createdAt: '2026-09-27T10:01:00.000Z',
      });
    });

    expect(await screen.findByText('<img src=x onerror=alert(1)>')).not.toBeNull();
    expect(document.querySelector('.message-text img')).toBeNull();
    expect(source?.addEventListener).toHaveBeenCalledWith('agent-message', expect.any(Function));
    expect(source?.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));

    unmount();
    expect(source?.removeEventListener).toHaveBeenCalledWith('agent-message', expect.any(Function));
    expect(source?.close).toHaveBeenCalledOnce();
  });

  it('keeps primary controls available and opens compact project/thread menus', async () => {
    installAuthenticatedApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText('Frontend task');

    expect(screen.getByRole('complementary', { name: 'Навигация' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Новый чат' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Новый чат в проекте AI Chat Bot' })).not.toBeNull();
    expect(screen.getByRole('navigation', { name: 'Недавние чаты' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Статус' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Прикрепить файлы' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Отправить сообщение' })).not.toBeNull();

    const projectMenu = screen.getByRole('button', { name: 'Меню проекта AI Chat Bot' });
    await user.click(projectMenu);
    expect(projectMenu.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menuitem', { name: 'Архивированные чаты' })).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(projectMenu.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menuitem', { name: 'Архивированные чаты' })).toBeNull();

    const threadMenu = screen.getByRole('button', { name: 'Меню чата проекта Frontend task' });
    await user.click(threadMenu);
    expect(screen.getByRole('menuitem', { name: 'Архивировать чат' })).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menuitem', { name: 'Архивировать чат' })).toBeNull();
  });

  it('keeps execution history compact and removes redundant lifecycle noise', async () => {
    const events = [
      {
        id: 1,
        threadId: 'thread-1',
        turnId: null,
        kind: 'thread',
        phase: 'state',
        payload: { status: 'active' },
        createdAt: '2026-09-27T10:01:00.000Z',
      },
      {
        id: 2,
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'turn',
        phase: 'started',
        payload: { status: 'inProgress' },
        createdAt: '2026-09-27T10:01:01.000Z',
      },
      {
        id: 3,
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'tool',
        phase: 'started',
        payload: { item: { id: 'unnamed-item', type: 'dynamicToolCall' } },
        createdAt: '2026-09-27T10:01:02.000Z',
      },
      {
        id: 4,
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'tool',
        phase: 'completed',
        payload: { item: { id: 'unnamed-item' } },
        createdAt: '2026-09-27T10:01:03.000Z',
      },
      {
        id: 5,
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'tool',
        phase: 'started',
        payload: { item: { id: 'item-1', type: 'mcpToolCall', name: 'GitHub' } },
        createdAt: '2026-09-27T10:01:04.000Z',
      },
      {
        id: 6,
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'tool',
        phase: 'completed',
        payload: { item: { id: 'item-1', status: 'completed' } },
        createdAt: '2026-09-27T10:01:05.000Z',
      },
      {
        id: 7,
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'command',
        phase: 'completed',
        payload: { command: 'pnpm test', output: 'All tests passed' },
        createdAt: '2026-09-27T10:01:06.000Z',
      },
    ];
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1') return jsonResponse({ data: thread, events });
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText('GitHub')).not.toBeNull();
    expect(screen.queryByText('Состояние чата')).toBeNull();
    expect(screen.queryByText('Состояние задачи')).toBeNull();
    expect(screen.queryByText('Использует инструмент')).toBeNull();
    const command = screen.getByText('Выполнил команду').closest('details');
    expect(command?.classList.contains('activity-row')).toBe(true);
    expect(document.querySelector('.activity-card')).toBeNull();
    expect(command?.open).toBe(false);
    await user.click(screen.getByText('Выполнил команду'));
    expect(command?.open).toBe(true);
    expect(screen.getByText('All tests passed')).not.toBeNull();
  });

  it('steers an active turn and can interrupt it', async () => {
    const fetchMock = installAuthenticatedApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText('Frontend task');
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    act(() => {
      FakeEventSource.instances.at(-1)?.emit({
        id: 2,
        threadId: 'thread-1',
        turnId: 'turn-active',
        kind: 'turn',
        phase: 'started',
        payload: { status: 'inProgress' },
        createdAt: '2026-09-27T10:01:00.000Z',
      });
    });

    const input = await screen.findByLabelText('Уточнение для активной задачи');
    await user.type(input, 'Сначала исправь тесты');
    await user.click(screen.getByRole('button', { name: 'Направить задачу' }));
    await user.click(screen.getByRole('button', { name: 'Остановить' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/threads/thread-1/steer',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/threads/thread-1/interrupt',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ turnId: 'turn-active' }),
        }),
      );
    });
  });

  it('queues files from picker, clipboard and drop, then removes them before upload', async () => {
    installAuthenticatedApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText('Frontend task');
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    const pickerFile = new File(['picker'], 'picker.txt', { type: 'text/plain' });
    await user.upload(screen.getByLabelText('Выбрать вложения'), pickerFile);
    expect(await screen.findByText('picker.txt')).not.toBeNull();

    const textarea = screen.getByLabelText('Сообщение Codex');
    fireEvent.paste(textarea, {
      clipboardData: { files: [new File(['paste'], 'paste.png', { type: 'image/png' })] },
    });
    expect(await screen.findByText('paste.png')).not.toBeNull();

    const composer = textarea.closest('.composer');
    expect(composer).not.toBeNull();
    fireEvent.drop(composer!, {
      dataTransfer: {
        files: [new File(['drop'], 'drop.md', { type: 'text/markdown' })],
        types: ['Files'],
      },
    });
    expect(await screen.findByText('drop.md')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Удалить picker.txt' }));
    expect(screen.queryByText('picker.txt')).toBeNull();
    expect(FakeXMLHttpRequest.instances).toHaveLength(0);
  });

  it('uploads queued attachments with progress and sends their ids with the message', async () => {
    FakeXMLHttpRequest.autoRespond = false;
    const fetchMock = installAuthenticatedApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText('Frontend task');
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    const file = new File(['1234567890'], 'evidence.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Выбрать вложения'), file);
    await user.type(screen.getByLabelText('Сообщение Codex'), 'Проверь изображение');
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }));

    await waitFor(() => expect(FakeXMLHttpRequest.instances).toHaveLength(1));
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Открыть чат проекта Frontend task',
      }).disabled,
    ).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^AI Chat Bot/ }).disabled).toBe(
      true,
    );
    const upload = FakeXMLHttpRequest.instances[0]!;
    expect(upload.method).toBe('POST');
    expect(upload.url).toBe('/api/threads/thread-1/attachments');
    expect(upload.headers.get('X-CSRF-Token')).toBe('csrf-token');
    expect(upload.body).toBeInstanceOf(FormData);
    act(() => upload.progress(5, 10));
    expect(await screen.findByText('Загрузка 50%')).not.toBeNull();
    act(() => upload.complete());

    await waitFor(() => {
      const turnCall = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/turns'));
      expect(turnCall).toBeDefined();
      const requestBody = turnCall?.[1]?.body;
      expect(typeof requestBody).toBe('string');
      expect(JSON.parse(requestBody as string)).toEqual(
        expect.objectContaining({
          text: 'Проверь изображение',
          attachmentIds: ['attachment-1'],
        }),
      );
    });
    await waitFor(() => expect(screen.queryByText('evidence.png')).toBeNull());
  });

  it('keeps a failed upload queued with an accessible error for retry', async () => {
    FakeXMLHttpRequest.autoRespond = false;
    installAuthenticatedApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText('Frontend task');
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    await user.upload(
      screen.getByLabelText('Выбрать вложения'),
      new File(['broken'], 'broken.txt', { type: 'text/plain' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Отправить сообщение' }).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    await waitFor(() => expect(FakeXMLHttpRequest.instances).toHaveLength(1));
    act(() => FakeXMLHttpRequest.instances[0]!.complete(500));

    expect(
      (await screen.findAllByText('Загрузка завершилась с ошибкой (500)')).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('broken.txt')).not.toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Удалить broken.txt' }).disabled,
    ).toBe(false);
  });

  it('renders persisted image and file attachments from chat history accessibly', async () => {
    const attachmentEvent = {
      id: 40,
      threadId: 'thread-1',
      turnId: 'turn-with-files',
      kind: 'user-message',
      phase: 'completed',
      payload: {
        text: 'Материалы задачи',
        attachments: [
          {
            id: 'image-1',
            threadId: 'thread-1',
            name: 'макет.png',
            mediaType: 'image/png',
            kind: 'image',
            sizeBytes: 512,
            createdAt: '2026-09-27T10:00:00.000Z',
            url: '/api/threads/thread-1/attachments/image-1/content',
          },
          {
            id: 'file-1',
            threadId: 'thread-1',
            name: 'требования.pdf',
            mediaType: 'application/pdf',
            kind: 'file',
            sizeBytes: 2048,
            createdAt: '2026-09-27T10:00:00.000Z',
            url: '/api/threads/thread-1/attachments/file-1/content',
          },
        ],
      },
      createdAt: '2026-09-27T10:01:00.000Z',
    };
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1') {
        return jsonResponse({ data: thread, events: [attachmentEvent] });
      }
      return undefined;
    });
    render(<App />);

    const image = await screen.findByRole('img', { name: 'макет.png' });
    expect(image.getAttribute('src')).toBe('/api/threads/thread-1/attachments/image-1/content');
    const download = screen.getByRole('link', { name: /требования\.pdf/ });
    expect(download.getAttribute('href')).toBe('/api/threads/thread-1/attachments/file-1/content');
    expect(download.hasAttribute('download')).toBe(true);
  });

  it('cleans up only this tab staged upload when switching threads', async () => {
    const secondThread = { ...thread, id: 'thread-2', name: 'Second task' };
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url.includes('/api/threads?')) return jsonResponse([thread, secondThread]);
      if (url === '/api/threads/thread-2') return jsonResponse({ data: secondThread, events: [] });
      if (url === '/api/threads/thread-1/turns' && init?.method === 'POST')
        return jsonResponse({ error: { message: 'turn rejected' } }, 500);
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText('Frontend task');
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    await user.upload(
      screen.getByLabelText('Выбрать вложения'),
      new File(['staged'], 'staged.txt', { type: 'text/plain' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Отправить сообщение' }).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    expect(await screen.findByText('turn rejected')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Открыть чат проекта Second task' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/threads/thread-1/attachments/attachment-1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });

  it('opens a project archive and restores a chat', async () => {
    const archivedThread = { ...thread, id: 'thread-old', name: 'Старый чат', archived: true };
    const archivedEvent = {
      id: 41,
      threadId: archivedThread.id,
      turnId: 'turn-archived',
      kind: 'agent-message',
      phase: 'completed',
      payload: { text: 'Сохранённый ответ из архива' },
      createdAt: '2026-09-26T10:01:00.000Z',
    };
    const fetchMock = installAuthenticatedApi((url) => {
      if (url.includes('archived=true')) return jsonResponse([archivedThread]);
      if (url === '/api/threads/thread-old') {
        return jsonResponse({ data: archivedThread, events: [archivedEvent] });
      }
      if (url === '/api/threads/thread-old/unarchive') {
        return jsonResponse({ data: { ...archivedThread, archived: false } });
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText('Меню проекта AI Chat Bot'));
    await user.click(screen.getByRole('menuitem', { name: 'Архивированные чаты' }));
    expect((await screen.findAllByText('Старый чат')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Сохранённый ответ из архива')).not.toBeNull();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Сообщение Codex').disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Меню чата проекта Старый чат' }));
    await user.click(screen.getByRole('menuitem', { name: 'Восстановить чат' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/threads/thread-old/unarchive',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('hydrates an imported thread and deduplicates its replayed SSE event', async () => {
    const importedThread = {
      ...thread,
      id: 'thread-imported',
      name: 'Импортированный чат',
      preview: 'История с другого клиента',
    };
    const historyEvent = {
      id: 42,
      threadId: importedThread.id,
      turnId: 'turn-imported',
      kind: 'agent-message',
      phase: 'completed',
      payload: { text: 'История с сервера' },
      createdAt: '2026-09-27T09:01:00.000Z',
    };
    installAuthenticatedApi((url) => {
      if (url.includes('/api/threads?')) return jsonResponse([thread, importedThread]);
      if (url === '/api/threads/thread-imported') {
        return jsonResponse({ data: importedThread, events: [historyEvent] });
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole('button', { name: 'Открыть чат проекта Импортированный чат' }),
    );
    expect(await screen.findByText('История с сервера')).not.toBeNull();
    await waitFor(() => expect(FakeEventSource.instances.at(-1)?.url).toContain('thread-imported'));

    act(() => {
      FakeEventSource.instances.at(-1)?.emit(historyEvent);
    });

    expect(screen.getAllByText('История с сервера')).toHaveLength(1);
  });

  it('resolves an approval and removes it after the completion event', async () => {
    const fetchMock = installAuthenticatedApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText('Frontend task');
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1);
    act(() => {
      source?.emit({
        id: 3,
        threadId: 'thread-1',
        turnId: 'turn-approval',
        kind: 'approval',
        phase: 'started',
        payload: {
          id: '22222222-2222-4222-8222-222222222222',
          summary: 'Разрешить запуск тестов?',
          method: 'item/commandExecution/requestApproval',
        },
        createdAt: '2026-09-27T10:02:00.000Z',
      });
    });

    await user.click(await screen.findByRole('button', { name: 'Разрешить' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/approvals/22222222-2222-4222-8222-222222222222/resolve',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    act(() => {
      source?.emit({
        id: 4,
        threadId: 'thread-1',
        turnId: 'turn-approval',
        kind: 'approval',
        phase: 'completed',
        payload: { id: '22222222-2222-4222-8222-222222222222' },
        createdAt: '2026-09-27T10:03:00.000Z',
      });
    });
    await waitFor(() => expect(screen.queryByText('Разрешить запуск тестов?')).toBeNull());
  });

  it('answers user-input questions by keyboard without echoing a secret', async () => {
    const fetchMock = installAuthenticatedApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText('Frontend task');
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    act(() => {
      FakeEventSource.instances.at(-1)?.emit({
        id: 51,
        threadId: 'thread-1',
        turnId: 'turn-input',
        kind: 'user-input',
        phase: 'started',
        payload: {
          request: {
            id: 'input-request-1',
            method: 'item/tool/requestUserInput',
            itemId: 'item-input',
            isBlocking: true,
            status: 'pending',
            questions: [
              {
                id: 'mode',
                header: 'Режим',
                question: 'Какой режим использовать?',
                options: [{ label: 'Быстрый', description: 'Минимальная проверка' }],
                isOther: true,
                isSecret: false,
              },
              {
                id: 'token',
                header: 'Секрет',
                question: 'Введите временный токен',
                options: null,
                isOther: false,
                isSecret: true,
              },
            ],
          },
        },
        createdAt: '2026-09-27T10:04:00.000Z',
      });
    });

    await user.click(await screen.findByRole('radio', { name: 'Другое' }));
    const other = screen.getByLabelText<HTMLInputElement>('Режим: ответ');
    expect(other.maxLength).toBe(8_000);
    await user.type(other, 'Тщательный');
    const secret = screen.getByLabelText<HTMLInputElement>('Секрет: ответ');
    expect(secret.type).toBe('password');
    expect(secret.maxLength).toBe(8_000);
    await user.type(secret, 'private-token');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/user-input-requests/input-request-1/resolve',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            answers: {
              mode: { answers: ['Тщательный'] },
              token: { answers: ['private-token'] },
            },
          }),
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByLabelText('Вопросы Codex')).toBeNull());
    expect(screen.queryByDisplayValue('private-token')).toBeNull();
    expect(screen.queryByText('private-token')).toBeNull();
  });

  it('shows permission details, grants only for one turn, and removes completed cards', async () => {
    const fetchMock = installAuthenticatedApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText('Frontend task');
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1);
    const permissionEvent = {
      id: 52,
      threadId: 'thread-1',
      turnId: 'turn-permission',
      kind: 'permission-approval',
      phase: 'started',
      payload: {
        request: {
          id: 'permission-request-1',
          method: 'item/permissions/requestApproval',
          itemId: 'item-permission',
          cwd: '/srv/projects/ai-chat-bot',
          reason: 'Установить зависимости',
          permissions: {
            fileSystem: { read: ['/srv/projects/ai-chat-bot'], write: ['/tmp/build'] },
            network: { enabled: true },
          },
          status: 'pending',
        },
      },
      createdAt: '2026-09-27T10:05:00.000Z',
    };
    act(() => source?.emit(permissionEvent));

    expect(await screen.findByText('Установить зависимости')).not.toBeNull();
    expect(screen.getByText('Файловая система')).not.toBeNull();
    expect(screen.getByText('Сеть')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /сессию/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Разрешить один раз' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/permission-requests/permission-request-1/resolve',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ decision: 'grant', scope: 'turn' }),
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByLabelText('Запрос дополнительных прав')).toBeNull());

    act(() => {
      source?.emit({
        ...permissionEvent,
        id: 53,
        payload: {
          request: {
            ...permissionEvent.payload.request,
            id: 'permission-request-2',
          },
        },
      });
    });
    expect(await screen.findByLabelText('Запрос дополнительных прав')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Отклонить' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/permission-requests/permission-request-2/resolve',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ decision: 'deny', scope: 'turn' }),
        }),
      ),
    );

    act(() => {
      source?.emit({
        ...permissionEvent,
        id: 54,
        payload: {
          request: {
            ...permissionEvent.payload.request,
            id: 'permission-request-3',
          },
        },
      });
    });
    expect(await screen.findByLabelText('Запрос дополнительных прав')).not.toBeNull();
    act(() => {
      source?.emit({
        id: 55,
        threadId: 'thread-1',
        turnId: 'turn-permission',
        kind: 'permission-approval',
        phase: 'completed',
        payload: { request: { id: 'permission-request-3', status: 'cancelled' } },
        createdAt: '2026-09-27T10:06:00.000Z',
      });
    });
    await waitFor(() => expect(screen.queryByLabelText('Запрос дополнительных прав')).toBeNull());
  });

  it('opens status and skills through slash commands without sending a model turn', async () => {
    installAuthenticatedApi();
    const user = userEvent.setup();
    render(<App />);

    const composer = await screen.findByLabelText('Сообщение Codex');
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    await user.type(composer, '/sta');
    expect(screen.getByRole('listbox', { name: 'Команды Codex' })).not.toBeNull();
    await user.click(screen.getByRole('option', { name: /\/status/ }));
    await user.click(composer);
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('complementary', { name: 'Статус Codex' })).not.toBeNull();
    expect(screen.getByText('27% использовано · 300 мин.')).not.toBeNull();
    expect(screen.getByText((content) => content.replace(/\s/g, '') === '123456')).not.toBeNull();
    expect(await screen.findByText('/srv/projects/ai-chat-bot/AGENTS.md')).not.toBeNull();
    expect(screen.getByText('multi-agent-orchestrator')).not.toBeNull();
    expect(screen.getByText('1.2.3')).not.toBeNull();
  });
});
