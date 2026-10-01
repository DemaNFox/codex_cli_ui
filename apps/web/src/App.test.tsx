import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import type { ResourceLimitSnapshot } from './api.js';

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
  activeTurnId: null,
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
  account: { type: 'chatgpt' as const, email: 'old@example.com', planType: 'plus' },
  appServerReady: true,
  transcription: {
    available: true,
    model: 'gpt-transcribe',
    maxBytes: 10 * 1024 * 1024,
    maxDurationSeconds: 300,
  },
  notifications: {
    available: true,
    vapidPublicKey: 'BEl62iUYgUivxIkv69yViEuiBIa40HI4o2TjDqFr6BkDHRMYitVCCfZwzVQHBGEY',
  },
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

const resourceLimits = {
  capacity: {
    cpuCores: 8,
    memoryBytes: 16 * 1024 ** 3,
    memoryAvailableBytes: 10 * 1024 ** 3,
    tasks: 1024,
    measuredAt: '2026-09-28T10:00:00.000Z',
  },
  desired: {
    mode: 'auto' as const,
    cpuCores: null,
    memoryBytes: null,
    tasks: null,
    maxParallelAgents: null,
  },
  effective: { cpuCores: 8, memoryBytes: 16 * 1024 ** 3, tasks: 1024, maxParallelAgents: 4 },
  state: 'applied' as const,
  version: 1,
  updatedAt: '2026-09-28T10:00:00.000Z',
  appliedAt: '2026-09-28T10:00:00.000Z',
  warning: null,
};

const unavailableCodexUpdate = {
  state: 'unavailable' as const,
  currentVersion: 'codex-cli 1.2.3',
  availableVersion: null,
  candidateReleaseId: null,
  lastResult: null,
};

const currentCodexUpdateDiscovery = {
  state: 'current' as const,
  currentVersion: 'codex-cli 1.2.3',
  latestVersion: 'codex-cli 1.2.3',
  checkedAt: '2026-10-01T16:00:00.000Z',
};

const subagents = [
  {
    id: 'agent-1',
    rootThreadId: 'thread-1',
    parentThreadId: 'thread-1',
    agentPath: '/root/ui',
    nickname: 'Верстальщик',
    role: 'Адаптивный интерфейс',
    model: 'gpt-test',
    reasoningEffort: 'medium',
    status: 'running' as const,
    message: 'Проверяет мобильный вид',
    startedAt: '2026-09-28T09:59:00.000Z',
    lastActivityAt: '2026-09-28T10:00:00.000Z',
    completedAt: null,
  },
];

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
  overrides?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const overridden = overrides?.(url, init);
    if (overridden) return Promise.resolve(overridden);
    if (url === '/api/auth/session') return Promise.resolve(jsonResponse(session));
    if (url === '/api/projects') return Promise.resolve(jsonResponse([project]));
    if (url === '/api/preferences/runtime')
      return Promise.resolve(
        jsonResponse({
          data: {
            model: 'gpt-test',
            reasoningEffort: 'medium',
            permissionPreset: 'workspace-write',
            approvalPolicy: 'on-request',
            updatedAt: '2026-09-27T10:00:00.000Z',
          },
        }),
      );
    if (url === '/api/models') return Promise.resolve(jsonResponse(models));
    if (url === '/api/system/capabilities') return Promise.resolve(jsonResponse(capabilities));
    if (url === '/api/system/codex-update')
      return Promise.resolve(jsonResponse({ data: unavailableCodexUpdate }));
    if (url === '/api/system/codex-update/discovery')
      return Promise.resolve(jsonResponse({ data: currentCodexUpdateDiscovery }));
    if (url === '/api/system/resource-limits')
      return Promise.resolve(jsonResponse({ data: resourceLimits }));
    if (url.includes('/api/threads?')) return Promise.resolve(jsonResponse([thread]));
    if (url === '/api/threads/thread-1/subagents')
      return Promise.resolve(jsonResponse({ data: subagents }));
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
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:preview'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(() => undefined),
  });
});

function installPushApi() {
  const unsubscribe = vi.fn(() => Promise.resolve(true));
  const subscription = {
    endpoint: 'https://push.example/device-1',
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: null },
    getKey: vi.fn(() => null),
    unsubscribe,
    toJSON: vi.fn(() => ({
      endpoint: 'https://push.example/device-1',
      expirationTime: null,
      keys: { p256dh: 'public-key', auth: 'auth-key' },
    })),
  } as unknown as PushSubscription;
  const pushManager = {
    getSubscription: vi.fn<() => Promise<PushSubscription | null>>(),
    permissionState: vi.fn(),
    subscribe: vi.fn(() => Promise.resolve(subscription)),
  };
  const registration = { pushManager } as unknown as ServiceWorkerRegistration;
  let installedRegistration: ServiceWorkerRegistration | undefined;
  const serviceWorker: Pick<ServiceWorkerContainer, 'getRegistration' | 'ready' | 'register'> = {
    getRegistration: vi.fn(() => Promise.resolve(installedRegistration)),
    ready: Promise.resolve(registration),
    register: vi.fn((_scriptURL: string | URL, _options?: RegistrationOptions) => {
      void _scriptURL;
      void _options;
      installedRegistration = registration;
      return Promise.resolve(registration);
    }),
  };
  pushManager.getSubscription.mockImplementation(() =>
    Promise.resolve(installedRegistration ? subscription : null),
  );
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: serviceWorker,
  });
  class TestNotification {
    static permission: NotificationPermission = 'default';
    static requestPermission = vi.fn(() => {
      TestNotification.permission = 'granted';
      return Promise.resolve<NotificationPermission>('granted');
    });
  }
  vi.stubGlobal('Notification', TestNotification);
  vi.stubGlobal('PushManager', class PushManager {});
  return {
    registration,
    serviceWorker,
    subscription,
    unsubscribe,
    pushManager,
    TestNotification,
  };
}

describe('App', () => {
  it('marks active chats in project and recent sidebar lists without marking idle chats', async () => {
    const runningThread = {
      ...thread,
      id: 'thread-running',
      name: 'Синхронизация лидов',
      status: 'active' as const,
      activeTurnId: 'turn-running',
      updatedAt: '2026-09-27T10:05:00.000Z',
    };
    installAuthenticatedApi((url) => {
      if (url.includes('/api/threads?')) return jsonResponse([thread, runningThread]);
      return undefined;
    });

    render(<App />);

    const projectRow = await screen.findByRole('button', {
      name: 'Открыть чат проекта Синхронизация лидов — в работе',
    });
    expect(projectRow.textContent).not.toContain('В работе');
    expect(projectRow.querySelector('.thread-running-dot')).not.toBeNull();
    const recentRow = screen.getByRole('button', {
      name: 'Открыть недавний чат Синхронизация лидов — в работе',
    });
    expect(recentRow.textContent).not.toContain('В работе');
    expect(recentRow.querySelector('.thread-running-dot')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Открыть чат проекта Frontend task' }).textContent,
    ).not.toContain('В работе');
  });

  it.each(['TURN_CAPACITY_EXHAUSTED', 'RESOURCE_CAPACITY_EXHAUSTED'] as const)(
    'explains %s and preserves the unsent draft',
    async (capacityCode) => {
      const runningThread = {
        ...thread,
        id: 'thread-running',
        name: 'Занятая задача',
        status: 'active' as const,
        activeTurnId: 'turn-running',
      };
      installAuthenticatedApi((url, init) => {
        if (url.includes('/api/threads?')) return jsonResponse([thread, runningThread]);
        if (url === '/api/threads/thread-1/turns' && init?.method === 'POST') {
          return jsonResponse(
            {
              error: {
                code: capacityCode,
                message: capacityCode,
              },
            },
            429,
          );
        }
        return undefined;
      });
      const user = userEvent.setup();
      render(<App />);

      await user.click(
        await screen.findByRole('button', { name: 'Открыть недавний чат Frontend task' }),
      );
      const input = await screen.findByLabelText('Сообщение Codex');
      await user.type(input, 'Запусти после освобождения слота');
      await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }));

      expect((await screen.findByRole('alert')).textContent).toContain(
        'Сейчас заняты все безопасные слоты задач',
      );
      expect((input as HTMLTextAreaElement).value).toBe('Запусти после освобождения слота');
      expect(document.querySelectorAll('.thread-running-dot')).toHaveLength(2);
    },
  );

  it('shows a clear unavailable state when server push is not configured', async () => {
    installAuthenticatedApi((url) => {
      if (url !== '/api/system/capabilities') return undefined;
      return jsonResponse({ ...capabilities, notifications: undefined });
    });

    render(<App />);

    const button = await screen.findByRole('button', {
      name: 'Уведомления не настроены на сервере',
    });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('explains that push requires a secure browser context', async () => {
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: false,
    });
    installAuthenticatedApi();

    render(<App />);

    const button = await screen.findByRole('button', {
      name: 'Уведомления доступны только по HTTPS или на localhost',
    });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('enables and disables only the selected chat push mapping', async () => {
    const { serviceWorker, subscription, unsubscribe, TestNotification } = installPushApi();
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url.endsWith('/push-subscriptions') && init?.method === 'PUT') {
        return jsonResponse({ data: { subscribed: true } });
      }
      if (url.endsWith('/push-subscriptions') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    const enable = await screen.findByRole('button', {
      name: 'Включить уведомления для этого чата',
    });
    await user.click(enable);

    expect(TestNotification.requestPermission).toHaveBeenCalledOnce();
    expect(serviceWorker.register).toHaveBeenCalledWith('/push-service-worker.js', { scope: '/' });
    await expect(serviceWorker.ready).resolves.toBeDefined();
    await screen.findByRole('button', { name: 'Отключить уведомления для этого чата' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/threads/thread-1/push-subscriptions',
      expect.objectContaining({ method: 'PUT' }),
    );

    await user.click(screen.getByRole('button', { name: 'Отключить уведомления для этого чата' }));
    await screen.findByRole('button', { name: 'Включить уведомления для этого чата' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/threads/thread-1/push-subscriptions',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }),
    );
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('rechecks the current browser endpoint when switching chats', async () => {
    const { serviceWorker, registration } = installPushApi();
    const secondThread = { ...thread, id: 'thread-2', name: 'Second task' };
    await serviceWorker.register('/push-service-worker.js', { scope: '/' });
    expect(registration).toBeDefined();
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url.includes('/api/threads?')) return jsonResponse([thread, secondThread]);
      if (url === '/api/threads/thread-2') {
        return jsonResponse({ data: secondThread, events: [] });
      }
      if (url.endsWith('/push-subscriptions/status') && init?.method === 'POST') {
        return jsonResponse({ data: { subscribed: url.includes('thread-2') } });
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: 'Включить уведомления для этого чата' });
    await user.click(screen.getByRole('button', { name: 'Открыть чат проекта Second task' }));
    await screen.findByRole('button', { name: 'Отключить уведомления для этого чата' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/threads/thread-2/push-subscriptions/status',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ endpoint: 'https://push.example/device-1' }),
      }),
    );
  });

  it('remains compatible with a backend that predates transcription capabilities', async () => {
    installAuthenticatedApi((url) => {
      if (url !== '/api/system/capabilities') return undefined;
      const legacyCapabilities = { ...capabilities, transcription: undefined };
      return jsonResponse(legacyCapabilities);
    });

    render(<App />);
    await screen.findByLabelText('Сообщение Codex');
    expect(screen.getByRole('button', { name: 'Голосовой ввод' }).getAttribute('title')).toBe(
      'Голосовой ввод не настроен на сервере',
    );
  });

  it('authenticates the operator and opens the workspace', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === '/api/auth/session')
        return Promise.resolve(jsonResponse({ message: 'unauthorized' }, 401));
      if (url === '/api/auth/login') return Promise.resolve(jsonResponse(session));
      if (url === '/api/projects') return Promise.resolve(jsonResponse([project]));
      if (url === '/api/models') return Promise.resolve(jsonResponse(models));
      if (url === '/api/system/capabilities') return Promise.resolve(jsonResponse(capabilities));
      if (url === '/api/system/resource-limits')
        return Promise.resolve(jsonResponse({ data: resourceLimits }));
      if (url === '/api/preferences/runtime')
        return Promise.resolve(
          jsonResponse({
            data: {
              model: 'gpt-test',
              reasoningEffort: 'medium',
              permissionPreset: 'workspace-write',
              approvalPolicy: 'on-request',
              updatedAt: '2026-09-27T10:00:00.000Z',
            },
          }),
        );
      if (url.includes('/api/threads?')) return Promise.resolve(jsonResponse([thread]));
      if (url === '/api/threads/thread-1/subagents')
        return Promise.resolve(jsonResponse({ data: subagents }));
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

    act(() => {
      source?.emit({
        id: 2,
        threadId: 'thread-1',
        turnId: 'turn-2',
        kind: 'user-message',
        phase: 'completed',
        payload: { text: '**plain user text**' },
        createdAt: '2026-09-27T10:02:00.000Z',
      });
    });
    const userText = await screen.findByText('**plain user text**');
    expect(userText.querySelector('strong')).toBeNull();
    expect(source?.addEventListener).toHaveBeenCalledWith('agent-message', expect.any(Function));
    expect(source?.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));

    unmount();
    expect(source?.removeEventListener).toHaveBeenCalledWith('agent-message', expect.any(Function));
    expect(source?.close).toHaveBeenCalledOnce();
  });

  it('summarizes completed turns, preserves active progress, and navigates between tasks', async () => {
    const events = [
      {
        id: 1,
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'user-message',
        phase: 'completed',
        payload: { text: 'Первая задача' },
        createdAt: '2026-09-27T10:00:00.000Z',
      },
      {
        id: 2,
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'agent-message',
        phase: 'completed',
        payload: { text: 'Промежуточный статус', messagePhase: 'commentary' },
        createdAt: '2026-09-27T10:01:00.000Z',
      },
      {
        id: 3,
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'command',
        phase: 'completed',
        payload: { command: 'pnpm test' },
        createdAt: '2026-09-27T10:01:30.000Z',
      },
      {
        id: 4,
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'agent-message',
        phase: 'completed',
        payload: { text: 'Подтверждённый итог', messagePhase: 'final_answer' },
        createdAt: '2026-09-27T10:02:00.000Z',
      },
      {
        id: 5,
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'turn',
        phase: 'completed',
        payload: { status: 'completed' },
        createdAt: '2026-09-27T10:02:01.000Z',
      },
      {
        id: 6,
        threadId: 'thread-1',
        turnId: 'active-turn',
        kind: 'user-message',
        phase: 'completed',
        payload: { text: 'Активная задача' },
        createdAt: '2026-09-27T10:02:30.000Z',
      },
      {
        id: 7,
        threadId: 'thread-1',
        turnId: 'active-turn',
        kind: 'agent-message',
        phase: 'completed',
        payload: { text: 'Активный промежуточный статус', messagePhase: 'commentary' },
        createdAt: '2026-09-27T10:02:31.000Z',
      },
      {
        id: 8,
        threadId: 'thread-1',
        turnId: 'active-turn',
        kind: 'command',
        phase: 'completed',
        payload: { command: 'pnpm typecheck' },
        createdAt: '2026-09-27T10:02:32.000Z',
      },
      {
        id: 9,
        threadId: 'thread-1',
        turnId: 'legacy-turn',
        kind: 'user-message',
        phase: 'completed',
        payload: { text: 'Старая задача' },
        createdAt: '2026-09-27T10:02:59.000Z',
      },
      {
        id: 10,
        threadId: 'thread-1',
        turnId: 'legacy-turn',
        kind: 'agent-message',
        phase: 'completed',
        payload: { text: 'Старый итог без фазы' },
        createdAt: '2026-09-27T10:03:00.000Z',
      },
      {
        id: 11,
        threadId: 'thread-1',
        turnId: 'legacy-turn',
        kind: 'turn',
        phase: 'completed',
        payload: { status: 'completed' },
        createdAt: '2026-09-27T10:03:01.000Z',
      },
      {
        id: 12,
        threadId: 'thread-1',
        turnId: 'failed-turn',
        kind: 'user-message',
        phase: 'completed',
        payload: { text: 'Упавшая задача' },
        createdAt: '2026-09-27T10:04:00.000Z',
      },
      {
        id: 13,
        threadId: 'thread-1',
        turnId: 'failed-turn',
        kind: 'agent-message',
        phase: 'completed',
        payload: { text: 'Диагностика упавшей задачи', messagePhase: 'commentary' },
        createdAt: '2026-09-27T10:04:01.000Z',
      },
      {
        id: 14,
        threadId: 'thread-1',
        turnId: 'failed-turn',
        kind: 'turn',
        phase: 'completed',
        payload: { status: 'failed' },
        createdAt: '2026-09-27T10:04:02.000Z',
      },
    ];
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1') return jsonResponse({ data: thread, events });
      return undefined;
    });

    render(<App />);

    const finalAnswers = await screen.findAllByRole('article', { name: 'Итоговый ответ Codex' });
    const final = finalAnswers.find((article) =>
      article.textContent?.includes('Подтверждённый итог'),
    );
    if (!final) throw new Error('explicit final answer was not rendered');
    expect(final.textContent).toContain('Подтверждённый итог');
    expect(final.textContent).toContain('Итоговый ответ');
    expect(screen.queryByText('Промежуточный статус')).toBeNull();
    expect(screen.queryByText('pnpm test')).toBeNull();
    expect(screen.getByText('Активный промежуточный статус')).not.toBeNull();
    expect(screen.getByText('pnpm typecheck')).not.toBeNull();
    expect(screen.getByText('Диагностика упавшей задачи')).not.toBeNull();
    expect(screen.getByText('Старый итог без фазы').closest('article')?.classList).toContain(
      'final-answer',
    );
    expect(finalAnswers).toHaveLength(2);

    const navigation = screen.getByRole('navigation', { name: 'Переходы по задачам' });
    expect(within(navigation).getAllByRole('button')).toHaveLength(4);
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const user = userEvent.setup();
    await user.click(
      within(navigation).getByRole('button', { name: 'Перейти к задаче 1: Первая задача' }),
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(document.activeElement).toBe(document.getElementById('turn-message-1'));
  });

  it('restores server-owned turn navigation after reload when old user messages were pruned', async () => {
    const retainedEvents = [
      {
        id: 101,
        threadId: 'thread-1',
        turnId: 'partially-retained-turn',
        kind: 'agent-message',
        phase: 'completed',
        payload: { text: 'Сохранившийся ответ старой задачи', messagePhase: 'commentary' },
        createdAt: '2026-09-27T11:00:00.000Z',
      },
      {
        id: 102,
        threadId: 'thread-1',
        turnId: 'retained-turn',
        kind: 'user-message',
        phase: 'completed',
        payload: { text: 'Сохранившийся запрос' },
        createdAt: '2026-09-27T11:01:00.000Z',
      },
    ];
    const turnNavigation = [
      {
        id: 1,
        threadId: 'thread-1',
        turnId: 'fully-pruned-turn',
        label: 'Полностью старая задача',
      },
      {
        id: 2,
        threadId: 'thread-1',
        turnId: 'partially-retained-turn',
        label: 'Частично сохранённая задача',
      },
      {
        id: 3,
        threadId: 'thread-1',
        turnId: 'retained-turn',
        label: 'Сохранившийся запрос',
      },
    ];
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1') {
        return jsonResponse({ data: thread, events: retainedEvents, turnNavigation });
      }
      return undefined;
    });
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const firstLoad = render(<App />);
    const firstNavigation = await screen.findByRole('navigation', {
      name: 'Переходы по задачам',
    });
    expect(within(firstNavigation).getAllByRole('button')).toHaveLength(3);
    firstLoad.unmount();

    const user = userEvent.setup();
    render(<App />);
    const navigation = await screen.findByRole('navigation', { name: 'Переходы по задачам' });
    expect(within(navigation).getAllByRole('button')).toHaveLength(3);

    await user.click(
      within(navigation).getByRole('button', {
        name: 'Перейти к задаче 2: Частично сохранённая задача',
      }),
    );
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'start' });
    expect(document.activeElement).toBe(document.getElementById('turn-retained-101'));

    await user.click(
      within(navigation).getByRole('button', {
        name: 'Перейти к задаче 1: Полностью старая задача',
      }),
    );
    expect(document.activeElement).toBe(document.getElementById('transcript-start'));

    await user.click(
      within(navigation).getByRole('button', {
        name: 'Перейти к задаче 3: Сохранившийся запрос',
      }),
    );
    expect(document.activeElement).toBe(document.getElementById('turn-message-102'));
  });

  it('matches multiple truncated server navigation labels to their exact retained prompts', async () => {
    const firstPrompt = 'А'.repeat(2_100);
    const secondPrompt = 'Б'.repeat(2_100);
    const navigationLabel = (value: string) => `${value.slice(0, 1_987)}…[truncated]`;
    const retainedEvents = [
      {
        id: 201,
        threadId: 'thread-1',
        turnId: 'shared-turn',
        kind: 'user-message',
        phase: 'completed',
        payload: { text: firstPrompt },
        createdAt: '2026-09-27T12:00:00.000Z',
      },
      {
        id: 202,
        threadId: 'thread-1',
        turnId: 'shared-turn',
        kind: 'user-message',
        phase: 'completed',
        payload: { text: secondPrompt },
        createdAt: '2026-09-27T12:01:00.000Z',
      },
    ];
    const turnNavigation = [
      {
        id: 10,
        threadId: 'thread-1',
        turnId: 'shared-turn',
        label: navigationLabel(firstPrompt),
      },
      {
        id: 11,
        threadId: 'thread-1',
        turnId: 'shared-turn',
        label: navigationLabel(secondPrompt),
      },
    ];
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1') {
        return jsonResponse({ data: thread, events: retainedEvents, turnNavigation });
      }
      return undefined;
    });
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const user = userEvent.setup();

    render(<App />);
    const navigation = await screen.findByRole('navigation', { name: 'Переходы по задачам' });
    const buttons = within(navigation).getAllByRole('button');
    expect(buttons).toHaveLength(2);

    await user.click(buttons[0]!);
    expect(document.activeElement).toBe(document.getElementById('turn-message-201'));
    await user.click(buttons[1]!);
    expect(document.activeElement).toBe(document.getElementById('turn-message-202'));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('offers a scroll-to-latest control when new events arrive below the viewport', async () => {
    const initialEvent = {
      id: 1,
      threadId: 'thread-1',
      turnId: 'turn-1',
      kind: 'agent-message',
      phase: 'completed',
      payload: { text: 'Начальное сообщение' },
      createdAt: '2026-09-27T10:01:00.000Z',
    };
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1')
        return jsonResponse({ data: thread, events: [initialEvent] });
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText('Начальное сообщение');
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const scroll = document.querySelector<HTMLDivElement>('.conversation-scroll');
    if (!scroll) throw new Error('conversation scroll was not rendered');
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    scroll.scrollTop = 1_000;
    fireEvent.scroll(scroll);
    fireEvent.touchMove(scroll);
    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);

    act(() => {
      FakeEventSource.instances.at(-1)?.emit({
        ...initialEvent,
        id: 2,
        payload: { text: 'Новое сообщение ниже' },
        createdAt: '2026-09-27T10:02:00.000Z',
      });
    });

    const jump = await screen.findByRole('button', { name: 'Перейти к новым сообщениям' });
    expect(scroll.scrollTop).toBe(100);
    await user.click(jump);
    expect(scroll.scrollTop).toBe(1_000);
    expect(screen.queryByRole('button', { name: 'Перейти к новым сообщениям' })).toBeNull();

    fireEvent.keyDown(scroll, { key: 'PageUp' });
    scroll.scrollTop = 100;
    fireEvent.scroll(scroll);
    const keyboardJump = await screen.findByRole('button', {
      name: 'Перейти к новым сообщениям',
    });
    await user.click(keyboardJump);

    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1_200 });
    act(() => {
      FakeEventSource.instances.at(-1)?.emit({
        ...initialEvent,
        id: 3,
        payload: { text: 'Ещё одно новое сообщение' },
        createdAt: '2026-09-27T10:03:00.000Z',
      });
    });
    await screen.findByText('Ещё одно новое сообщение');
    await waitFor(() => expect(scroll.scrollTop).toBe(1_200));
    expect(screen.queryByRole('button', { name: 'Перейти к новым сообщениям' })).toBeNull();
  });

  it('keeps the latest message anchored when the mobile transcript viewport resizes', async () => {
    const callbacks: ResizeObserverCallback[] = [];
    const observed = new Set<Element>();
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe(target: Element) {
        observed.add(target);
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    const initialEvent = {
      id: 1,
      threadId: 'thread-1',
      turnId: 'turn-1',
      kind: 'agent-message',
      phase: 'completed',
      payload: { text: 'Мобильное последнее сообщение' },
      createdAt: '2026-09-27T10:01:00.000Z',
    };
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1')
        return jsonResponse({ data: thread, events: [initialEvent] });
      return undefined;
    });
    render(<App />);

    await screen.findByText('Мобильное последнее сообщение');
    const scroll = document.querySelector<HTMLDivElement>('.conversation-scroll');
    const content = document.querySelector<HTMLDivElement>('.conversation-content');
    if (!scroll || !content) throw new Error('conversation layout was not rendered');
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_200 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    expect(observed.has(scroll)).toBe(true);
    expect(observed.has(content)).toBe(true);

    act(() => callbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    await waitFor(() => expect(scroll.scrollTop).toBe(1_200));
    expect(screen.queryByRole('button', { name: 'Перейти к новым сообщениям' })).toBeNull();
  });

  it('opens an existing chat at the latest message without a scroll animation', async () => {
    const initialEvent = {
      id: 1,
      threadId: 'thread-1',
      turnId: 'turn-1',
      kind: 'agent-message',
      phase: 'completed',
      payload: { text: 'Последнее сообщение' },
      createdAt: '2026-09-27T10:01:00.000Z',
    };
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1')
        return jsonResponse({ data: thread, events: [initialEvent] });
      return undefined;
    });
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 1_000,
    });

    try {
      render(<App />);
      await screen.findByText('Последнее сообщение');
      const scroll = document.querySelector<HTMLDivElement>('.conversation-scroll');
      await waitFor(() => expect(scroll?.scrollTop).toBe(1_000));
      expect(scroll?.style.scrollBehavior).toBe('');
      expect(screen.queryByRole('button', { name: 'Перейти к новым сообщениям' })).toBeNull();
    } finally {
      if (originalScrollHeight)
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
    }
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

    const navigationToggle = screen.getByRole('button', { name: 'Открыть навигацию' });
    const navigation = screen.getByRole('complementary', { name: 'Навигация' });
    const navigationScroll = navigation.querySelector('.navigation-scroll');
    const accountRow = screen.getByRole('button', { name: 'Выйти' }).closest('.account-row');
    expect(navigationScroll?.parentElement).toBe(navigation);
    expect(accountRow?.parentElement).toBe(navigation);
    expect(navigationToggle.getAttribute('aria-expanded')).toBe('false');
    expect(navigation.classList.contains('mobile-open')).toBe(false);
    await user.click(navigationToggle);
    expect(navigationToggle.getAttribute('aria-expanded')).toBe('true');
    expect(navigation.classList.contains('mobile-open')).toBe(true);
    await user.keyboard('{Escape}');
    expect(navigation.classList.contains('mobile-open')).toBe(false);
    expect(document.activeElement).toBe(navigationToggle);

    const runtimeToggle = screen.getByRole('button', { name: /Параметры/ });
    const runtimeSelectors = document.querySelector('#runtime-selectors');
    expect(runtimeToggle.getAttribute('aria-expanded')).toBe('false');
    expect(runtimeSelectors?.classList.contains('mobile-expanded')).toBe(false);
    await user.click(runtimeToggle);
    expect(runtimeToggle.getAttribute('aria-expanded')).toBe('true');
    expect(runtimeSelectors?.classList.contains('mobile-expanded')).toBe(true);

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

  it('loads and saves the last server-owned runtime parameters', async () => {
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url === '/api/preferences/runtime' && init?.method === 'PUT') {
        if (typeof init.body !== 'string') throw new TypeError('expected serialized preferences');
        const parsed: unknown = JSON.parse(init.body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new TypeError('expected preference object');
        }
        const body = parsed as Record<string, unknown>;
        return jsonResponse({
          data: { ...body, updatedAt: '2026-09-27T11:00:00.000Z' },
        });
      }
      if (url === '/api/preferences/runtime') {
        return jsonResponse({
          data: {
            model: 'gpt-test',
            reasoningEffort: 'low',
            permissionPreset: 'full-access',
            approvalPolicy: 'never',
            updatedAt: '2026-09-27T10:00:00.000Z',
          },
        });
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByLabelText('Уровень reasoning');
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>('Уровень reasoning').value).toBe('low'),
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Уровень доступа').value).toBe('full-access');
    expect(screen.getByLabelText<HTMLSelectElement>('Политика подтверждений').value).toBe('never');

    await user.selectOptions(screen.getByLabelText('Уровень доступа'), 'workspace-write');
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/preferences/runtime',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            model: 'gpt-test',
            reasoningEffort: 'low',
            permissionPreset: 'workspace-write',
            approvalPolicy: 'never',
          }),
        }),
      ),
    );
  });

  it('saves resource limits explicitly and reports a pending apply without optimistic success', async () => {
    let stored: ResourceLimitSnapshot = resourceLimits;
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url === '/api/system/resource-limits' && init?.method === 'PUT') {
        if (typeof init.body !== 'string') throw new TypeError('expected serialized limits');
        const body = JSON.parse(init.body) as {
          desired: typeof resourceLimits.desired;
          expectedVersion: number;
        };
        stored = {
          ...resourceLimits,
          desired: body.desired,
          state: 'pending-idle',
          version: 2,
          updatedAt: '2026-09-28T10:01:00.000Z',
        };
        return jsonResponse({ data: stored });
      }
      if (url === '/api/system/resource-limits/apply' && init?.method === 'POST') {
        return jsonResponse({ data: stored }, 202);
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Статус' }));
    expect(await screen.findByText('Ресурсы задач Codex')).not.toBeNull();
    await user.click(screen.getByLabelText('Настроить вручную'));
    const cpu = screen.getByLabelText('Лимит CPU, ядер');
    await user.clear(cpu);
    await user.type(cpu, '4');
    expect(screen.getByText('Изменения ещё не сохранены.')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/system/resource-limits',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    expect(await screen.findByText('Ожидает завершения текущих задач')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/system/resource-limits/apply',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(screen.queryByText('Применено')).toBeNull();
  });

  it('shows server-owned subagents for the selected chat', async () => {
    installAuthenticatedApi();
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText('Агенты задачи: активных 1, всего 1'));
    expect(await screen.findByRole('heading', { name: 'Агенты задачи' })).not.toBeNull();
    expect(screen.getByText('Верстальщик')).not.toBeNull();
    expect(screen.getByText('Адаптивный интерфейс')).not.toBeNull();
    expect(screen.getByText('Работает')).not.toBeNull();
  });

  it('starts a follow-up turn when only child agents remain active', async () => {
    const childOnlyThread = {
      ...thread,
      status: 'active' as const,
      activeTurnId: null,
      updatedAt: '2026-09-29T00:00:01.000Z',
    };
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url.includes('/api/threads?')) return jsonResponse([childOnlyThread]);
      if (url === '/api/threads/thread-1')
        return jsonResponse({ data: childOnlyThread, events: [], subagents });
      if (url === '/api/threads/thread-1/subagents') return jsonResponse({ data: subagents });
      if (url === '/api/threads/thread-1/turns' && init?.method === 'POST')
        return jsonResponse({ data: { turnId: 'turn-follow-up' } }, 202);
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByLabelText('Агенты задачи: активных 1, всего 1');
    const input = await screen.findByLabelText('Сообщение Codex');
    await user.type(input, 'Продолжай с учётом результатов агентов');
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/threads/thread-1/turns',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(screen.queryByText(/потеряла идентификатор/)).toBeNull();
  });

  it('reconciles an ambiguous active chat before sending instead of failing locally', async () => {
    const ambiguousThread = {
      ...thread,
      status: 'active' as const,
      activeTurnId: null,
      updatedAt: '2026-09-29T00:00:01.000Z',
    };
    const reconciledIdleThread = {
      ...thread,
      updatedAt: '2026-09-29T00:00:02.000Z',
    };
    let historyReads = 0;
    let resolveReconciliation!: (response: Response) => void;
    const reconciliation = new Promise<Response>((resolve) => {
      resolveReconciliation = resolve;
    });
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url.includes('/api/threads?')) return jsonResponse([ambiguousThread]);
      if (url === '/api/threads/thread-1') {
        historyReads += 1;
        if (historyReads === 1)
          return jsonResponse({ data: ambiguousThread, events: [], subagents: [] });
        return reconciliation;
      }
      if (url === '/api/threads/thread-1/subagents') return jsonResponse({ data: [] });
      if (url === '/api/threads/thread-1/turns' && init?.method === 'POST')
        return jsonResponse({ data: { turnId: 'turn-after-reconcile' } }, 202);
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText(/Codex работает/)).not.toBeNull();
    const input = await screen.findByLabelText('Сообщение Codex');
    await user.type(input, 'Продолжить после переподключения');
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }));

    await waitFor(() => expect(historyReads).toBe(2));
    resolveReconciliation(jsonResponse({ data: reconciledIdleThread, events: [], subagents: [] }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/threads/thread-1/turns',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          requestUrl(input) === '/api/threads/thread-1/turns' && init?.method === 'POST',
      ),
    ).toHaveLength(1);
    expect(screen.queryByText(/потеряла идентификатор/)).toBeNull();
  });

  it('does not replay a stale active runtime event over an authoritative idle snapshot', async () => {
    const ambiguousThread = {
      ...thread,
      status: 'active' as const,
      activeTurnId: null,
      updatedAt: '2026-09-29T00:00:01.000Z',
    };
    const terminalSubagents = Array.from({ length: 36 }, (_, index) => ({
      ...subagents[0]!,
      id: `terminal-agent-${index}`,
      status: 'completed' as const,
      lastActivityAt: '2026-09-29T00:00:02.000Z',
      completedAt: '2026-09-29T00:00:02.000Z',
    }));
    const staleActiveEvent = {
      id: 41,
      threadId: 'thread-1',
      turnId: null,
      kind: 'thread' as const,
      phase: 'state' as const,
      payload: { threadRuntime: { status: 'active', activeTurnId: null } },
      createdAt: '2026-09-29T00:00:03.000Z',
    };
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url.includes('/api/threads?')) return jsonResponse([ambiguousThread]);
      if (url === '/api/threads/thread-1')
        return jsonResponse({
          data: thread,
          events: [staleActiveEvent],
          eventCursor: staleActiveEvent.id,
          subagents: terminalSubagents,
        });
      if (url === '/api/threads/thread-1/subagents')
        return jsonResponse({ data: terminalSubagents });
      if (url === '/api/threads/thread-1/turns' && init?.method === 'POST')
        return jsonResponse({ data: { turnId: 'turn-after-stale-event' } }, 202);
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText('Готов')).not.toBeNull();
    expect(screen.queryByText(/Codex работает/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Остановить' })).toBeNull();

    const input = await screen.findByLabelText('Сообщение Codex');
    await user.type(input, 'Продолжить завершённый чат');
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/threads/thread-1/turns',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(screen.queryByText(/Не удалось определить активную задачу/)).toBeNull();
  });

  it('does not let an older reconciliation response override a newer active turn event', async () => {
    const ambiguousThread = {
      ...thread,
      status: 'active' as const,
      activeTurnId: null,
      updatedAt: '2026-09-29T00:00:01.000Z',
    };
    let historyReads = 0;
    let resolveReconciliation!: (response: Response) => void;
    const reconciliation = new Promise<Response>((resolve) => {
      resolveReconciliation = resolve;
    });
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url.includes('/api/threads?')) return jsonResponse([ambiguousThread]);
      if (url === '/api/threads/thread-1') {
        historyReads += 1;
        if (historyReads === 1)
          return jsonResponse({ data: ambiguousThread, events: [], subagents: [] });
        return reconciliation;
      }
      if (url === '/api/threads/thread-1/subagents') return jsonResponse({ data: [] });
      if (url === '/api/threads/thread-1/steer' && init?.method === 'POST')
        return jsonResponse({ data: { turnId: 'turn-new' } }, 202);
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText(/Codex работает/)).not.toBeNull();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const input = await screen.findByLabelText('Сообщение Codex');
    await user.type(input, 'Уточнение после нового события');
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    await waitFor(() => expect(historyReads).toBe(2));

    act(() =>
      FakeEventSource.instances.at(-1)?.emit({
        id: 500,
        threadId: 'thread-1',
        turnId: 'turn-new',
        kind: 'turn',
        phase: 'started',
        payload: { threadRuntime: { status: 'active', activeTurnId: 'turn-new' } },
        createdAt: '2026-09-29T00:00:03.000Z',
      }),
    );
    await screen.findByLabelText('Уточнение для активной задачи');
    resolveReconciliation(jsonResponse({ data: thread, events: [], subagents: [] }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/threads/thread-1/steer',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const steerCall = fetchMock.mock.calls.find(
      ([request, init]) =>
        requestUrl(request) === '/api/threads/thread-1/steer' && init?.method === 'POST',
    );
    const steerBody = steerCall?.[1]?.body;
    expect(typeof steerBody).toBe('string');
    if (typeof steerBody !== 'string') throw new Error('Expected a serialized steer body');
    expect(steerBody).toContain('"expectedTurnId":"turn-new"');
    expect(
      fetchMock.mock.calls.some(
        ([request, init]) =>
          requestUrl(request) === '/api/threads/thread-1/turns' && init?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('keeps a newer running subagent while an older reconciliation response is pending', async () => {
    const ambiguousThread = {
      ...thread,
      status: 'active' as const,
      activeTurnId: null,
      updatedAt: '2026-09-29T00:00:01.000Z',
    };
    let historyReads = 0;
    let resolveReconciliation!: (response: Response) => void;
    const reconciliation = new Promise<Response>((resolve) => {
      resolveReconciliation = resolve;
    });
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url.includes('/api/threads?')) return jsonResponse([ambiguousThread]);
      if (url === '/api/threads/thread-1') {
        historyReads += 1;
        if (historyReads === 1)
          return jsonResponse({ data: ambiguousThread, events: [], subagents: [] });
        return reconciliation;
      }
      if (url === '/api/threads/thread-1/subagents') return jsonResponse({ data: [] });
      if (url === '/api/threads/thread-1/turns' && init?.method === 'POST')
        return jsonResponse({ data: { turnId: 'turn-follow-up' } }, 202);
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText(/Codex работает/)).not.toBeNull();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const input = await screen.findByLabelText('Сообщение Codex');
    await user.type(input, 'Новая задача после дочерней');
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    await waitFor(() => expect(historyReads).toBe(2));

    act(() =>
      FakeEventSource.instances.at(-1)?.emit({
        id: 501,
        threadId: 'thread-1',
        turnId: null,
        kind: 'subagent',
        phase: 'state',
        payload: {
          subagent: {
            ...subagents[0],
            id: 'new-running-child',
            lastActivityAt: '2026-09-29T00:00:03.000Z',
          },
          threadRuntime: { status: 'active', activeTurnId: null },
        },
        createdAt: '2026-09-29T00:00:03.000Z',
      }),
    );
    await screen.findByText('Субагенты работают: 1');
    resolveReconciliation(jsonResponse({ data: thread, events: [], subagents: [] }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/threads/thread-1/turns',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(screen.queryByText(/Не удалось определить активную задачу/)).toBeNull();
  });

  it('merges thread, REST and SSE subagents monotonically without terminal regression', async () => {
    const completed = {
      ...subagents[0]!,
      status: 'completed' as const,
      message: 'Готово',
      lastActivityAt: '2026-09-28T10:02:00.000Z',
      completedAt: '2026-09-28T10:02:00.000Z',
    };
    const staleRunning = {
      ...subagents[0]!,
      status: 'running' as const,
      message: 'Старый прогресс',
      lastActivityAt: '2026-09-28T10:01:00.000Z',
    };
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1') {
        return jsonResponse({ data: thread, events: [], subagents: [completed] });
      }
      if (url === '/api/threads/thread-1/subagents') {
        return jsonResponse({ data: [staleRunning] });
      }
      return undefined;
    });
    render(<App />);

    expect(await screen.findByText('Завершён')).not.toBeNull();
    expect(screen.getByText('Готово')).not.toBeNull();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    act(() =>
      FakeEventSource.instances.at(-1)?.emit({
        id: 200,
        threadId: 'thread-1',
        turnId: null,
        kind: 'subagent',
        phase: 'state',
        payload: {
          subagent: {
            ...staleRunning,
            status: 'pendingInit',
            message: 'Равный, но незавершённый снимок',
            lastActivityAt: completed.lastActivityAt,
          },
        },
        createdAt: '2026-09-28T10:02:01.000Z',
      }),
    );
    expect(screen.getByText('Завершён')).not.toBeNull();
    expect(screen.queryByText('Равный, но незавершённый снимок')).toBeNull();

    act(() =>
      FakeEventSource.instances.at(-1)?.emit({
        id: 201,
        threadId: 'thread-1',
        turnId: null,
        kind: 'subagent',
        phase: 'state',
        payload: {
          subagent: {
            ...completed,
            status: 'errored',
            message: 'Новый терминальный снимок',
            lastActivityAt: '2026-09-28T10:03:00.000Z',
          },
        },
        createdAt: '2026-09-28T10:03:01.000Z',
      }),
    );
    expect(await screen.findByText('Ошибка')).not.toBeNull();
    expect(screen.getByText('Новый терминальный снимок')).not.toBeNull();
  });

  it('keeps live tree work active until the last subagent becomes terminal', async () => {
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1')
        return jsonResponse({ data: thread, events: [], subagents: [] });
      if (url === '/api/threads/thread-1/subagents') return jsonResponse({ data: [] });
      return undefined;
    });
    render(<App />);
    expect(await screen.findByText('Готов')).not.toBeNull();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const runningChild = {
      ...subagents[0]!,
      id: 'tree-child',
      status: 'running' as const,
      lastActivityAt: '2026-09-29T00:00:00.000Z',
      completedAt: null,
    };

    act(() =>
      FakeEventSource.instances.at(-1)?.emit({
        id: 300,
        threadId: 'thread-1',
        turnId: null,
        kind: 'subagent',
        phase: 'state',
        payload: {
          subagent: runningChild,
          threadRuntime: { status: 'active', activeTurnId: null },
        },
        createdAt: '2026-09-29T00:00:00.000Z',
      }),
    );
    expect(await screen.findByText('Субагенты работают: 1')).not.toBeNull();

    act(() =>
      FakeEventSource.instances.at(-1)?.emit({
        id: 301,
        threadId: 'thread-1',
        turnId: 'turn-root',
        kind: 'turn',
        phase: 'completed',
        payload: {
          runtime: true,
          status: 'completed',
          threadRuntime: { status: 'active', activeTurnId: null },
        },
        createdAt: '2026-09-29T00:00:01.000Z',
      }),
    );
    expect(screen.getByText('Субагенты работают: 1')).not.toBeNull();

    act(() =>
      FakeEventSource.instances.at(-1)?.emit({
        id: 302,
        threadId: 'thread-1',
        turnId: null,
        kind: 'subagent',
        phase: 'state',
        payload: {
          subagent: {
            ...runningChild,
            status: 'completed',
            lastActivityAt: '2026-09-29T00:00:02.000Z',
            completedAt: '2026-09-29T00:00:02.000Z',
          },
          threadRuntime: { status: 'idle', activeTurnId: null },
        },
        createdAt: '2026-09-29T00:00:02.000Z',
      }),
    );
    expect(await screen.findByText('Готов')).not.toBeNull();
  });

  it('applies native root status changes without requiring a REST refresh', async () => {
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1')
        return jsonResponse({ data: thread, events: [], subagents: [] });
      if (url === '/api/threads/thread-1/subagents') return jsonResponse({ data: [] });
      return undefined;
    });
    render(<App />);
    expect(await screen.findByText('Готов')).not.toBeNull();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    act(() =>
      FakeEventSource.instances.at(-1)?.emit({
        id: 310,
        threadId: 'thread-1',
        turnId: null,
        kind: 'thread',
        phase: 'state',
        payload: { threadRuntime: { status: 'active', activeTurnId: null } },
        createdAt: '2026-09-29T00:01:00.000Z',
      }),
    );
    expect(await screen.findByText(/Codex работает/)).not.toBeNull();

    act(() =>
      FakeEventSource.instances.at(-1)?.emit({
        id: 311,
        threadId: 'thread-1',
        turnId: null,
        kind: 'thread',
        phase: 'state',
        payload: { threadRuntime: { status: 'idle', activeTurnId: null } },
        createdAt: '2026-09-29T00:01:01.000Z',
      }),
    );
    expect(await screen.findByText('Готов')).not.toBeNull();
  });

  it('keeps execution history compact and removes redundant lifecycle noise', async () => {
    const events = [
      {
        id: 0,
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'user-message',
        phase: 'completed',
        payload: { text: 'Вчерашнее задание' },
        createdAt: '2026-09-27T10:00:59.000Z',
      },
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
    expect(
      screen
        .getByText('Вчерашнее задание')
        .closest('article')
        ?.querySelector('time')
        ?.getAttribute('dateTime'),
    ).toBe('2026-09-27T10:00:59.000Z');
    expect(screen.queryByText('Состояние чата')).toBeNull();
    expect(screen.queryByText('Состояние задачи')).toBeNull();
    expect(screen.queryByText('Использует инструмент')).toBeNull();
    const command = screen.getByText('Выполнил команду').closest('details');
    expect(
      screen
        .getByText('GitHub')
        .closest('.activity-row')
        ?.querySelector('time')
        ?.getAttribute('dateTime'),
    ).toBe('2026-09-27T10:01:05.000Z');
    expect(command?.classList.contains('activity-row')).toBe(true);
    expect(document.querySelector('.activity-card')).toBeNull();
    expect(command?.open).toBe(false);
    await user.click(screen.getByText('Выполнил команду'));
    expect(command?.open).toBe(true);
    expect(screen.getByText('All tests passed')).not.toBeNull();
  });

  it('collapses long activity runs to the latest three actions with a total and duration', async () => {
    const events = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      threadId: 'thread-1',
      turnId: 'turn-activity',
      kind: 'command',
      phase: 'completed',
      payload: { command: `step-${index + 1}` },
      createdAt: `2026-09-27T10:01:0${index}.000Z`,
    }));
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1') return jsonResponse({ data: thread, events });
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    const group = await screen.findByRole('region', { name: 'Ход работы: 6 действий' });
    const toggle = group.querySelector<HTMLButtonElement>('.activity-group-toggle');
    expect(toggle?.textContent).toContain('6 действий · 5 сек.');
    if (!toggle) throw new Error('activity group toggle was not rendered');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(group.querySelectorAll('.activity-row')).toHaveLength(3);
    expect(screen.getByText('Показаны 3 последних действия')).not.toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(group.querySelectorAll('.activity-row')).toHaveLength(6);
    expect(screen.queryByText('Показаны 3 последних действия')).toBeNull();
  });

  it('shows safe useful previews for live Codex activity items', async () => {
    const events = [
      {
        id: 1,
        threadId: 'thread-1',
        turnId: 'turn-preview',
        kind: 'tool',
        phase: 'completed',
        payload: {
          item: {
            id: 'command-1',
            type: 'commandExecution',
            command: 'pnpm verify',
            aggregatedOutput: 'All checks passed',
          },
        },
        createdAt: '2026-09-27T10:01:01.000Z',
      },
      {
        id: 2,
        threadId: 'thread-1',
        turnId: 'turn-preview',
        kind: 'tool',
        phase: 'completed',
        payload: {
          item: {
            id: 'files-1',
            type: 'fileChange',
            changes: [{ path: 'src/App.tsx' }, { path: 'src/App.test.tsx' }],
          },
        },
        createdAt: '2026-09-27T10:01:02.000Z',
      },
      {
        id: 3,
        threadId: 'thread-1',
        turnId: 'turn-preview',
        kind: 'tool',
        phase: 'completed',
        payload: {
          item: {
            id: 'tool-1',
            type: 'mcpToolCall',
            server: 'github',
            tool: 'create_pull_request',
            arguments: { token: 'must-not-render' },
          },
        },
        createdAt: '2026-09-27T10:01:03.000Z',
      },
    ];
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1') return jsonResponse({ data: thread, events });
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText('pnpm verify')).not.toBeNull();
    expect(screen.getByText('Выполнил команду')).not.toBeNull();
    expect(screen.getByText('src/App.tsx, src/App.test.tsx')).not.toBeNull();
    expect(screen.getByText('github · create_pull_request')).not.toBeNull();
    expect(screen.queryByText('must-not-render')).toBeNull();

    await user.click(screen.getByText('Выполнил команду'));
    expect(screen.getByText('All checks passed')).not.toBeNull();
  });

  it('shows elapsed time for the active task in the toolbar', async () => {
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const activeThread = {
      ...thread,
      status: 'active',
      activeTurnId: 'turn-elapsed',
    };
    installAuthenticatedApi((url) => {
      if (url.includes('/api/threads?')) return jsonResponse([activeThread]);
      if (url === '/api/threads/thread-1') {
        return jsonResponse({
          data: activeThread,
          events: [
            {
              id: 1,
              threadId: 'thread-1',
              turnId: 'turn-elapsed',
              kind: 'turn',
              phase: 'started',
              payload: { status: 'inProgress' },
              createdAt: startedAt,
            },
          ],
        });
      }
      return undefined;
    });
    render(<App />);

    expect(await screen.findByText(/Codex работает уже [5-9] сек\./)).not.toBeNull();
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
        payload: { status: 'inProgress', runtime: true },
        createdAt: '2026-09-27T10:01:00.000Z',
      });
    });

    const input = await screen.findByLabelText('Уточнение для активной задачи');
    await user.type(input, 'Сначала исправь тесты');
    await user.click(screen.getByRole('button', { name: 'Направить задачу' }));
    expect((await screen.findByRole('status')).textContent).toContain('Уточнение принято');
    await user.click(screen.getByRole('button', { name: 'Остановить' }));
    expect((await screen.findByRole('status')).textContent).toContain('Запрос на остановку принят');

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

  it('refreshes stale CSRF after a rejected steer without retrying or losing the draft', async () => {
    const activeThread = { ...thread, status: 'active' as const, activeTurnId: 'turn-active' };
    let sessionReads = 0;
    let steerCalls = 0;
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url === '/api/auth/session') {
        sessionReads += 1;
        return jsonResponse({
          ...session,
          csrfToken: sessionReads === 1 ? 'stale-csrf' : 'fresh-csrf',
        });
      }
      if (url.includes('/api/threads?')) return jsonResponse([activeThread]);
      if (url === '/api/threads/thread-1') {
        return jsonResponse({ data: activeThread, events: [] });
      }
      if (url === '/api/threads/thread-1/steer' && init?.method === 'POST') {
        steerCalls += 1;
        if (steerCalls === 1) {
          return jsonResponse({ error: { code: 'CSRF_INVALID', message: 'CSRF_INVALID' } }, 403);
        }
        return jsonResponse({ data: { turnId: 'turn-active' } });
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    const input = await screen.findByLabelText('Уточнение для активной задачи');
    await user.type(input, 'Не потеряй этот текст');
    await user.click(screen.getByRole('button', { name: 'Направить задачу' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Сессия обновлена. Текст сохранён — отправьте уточнение ещё раз.',
    );
    expect((input as HTMLTextAreaElement).value).toBe('Не потеряй этот текст');
    expect(steerCalls).toBe(1);
    expect(sessionReads).toBe(2);

    await user.click(screen.getByRole('button', { name: 'Направить задачу' }));
    expect((await screen.findByRole('status')).textContent).toContain('Уточнение принято');
    expect(steerCalls).toBe(2);
    const steerRequests = fetchMock.mock.calls.filter(
      ([request]) => requestUrl(request) === '/api/threads/thread-1/steer',
    );
    expect(new Headers(steerRequests[1]?.[1]?.headers).get('X-CSRF-Token')).toBe('fresh-csrf');
  });

  it('shows an interrupt failure and restores the stop control', async () => {
    installAuthenticatedApi((url) => {
      if (url === '/api/threads/thread-1/interrupt')
        return jsonResponse(
          { error: { message: 'Активная задача уже завершена. Обновите чат.' } },
          409,
        );
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    act(() => {
      FakeEventSource.instances.at(-1)?.emit({
        id: 2,
        threadId: 'thread-1',
        turnId: 'turn-active',
        kind: 'turn',
        phase: 'started',
        payload: { status: 'inProgress', runtime: true },
        createdAt: '2026-09-27T10:01:00.000Z',
      });
    });

    await user.click(await screen.findByRole('button', { name: 'Остановить' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Активная задача уже завершена',
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Остановить' }).disabled).toBe(
      false,
    );
  });

  it('keeps server-reported work active when the retained turn start has rolled over', async () => {
    const activeThread = {
      ...thread,
      status: 'active',
      activeTurnId: 'turn-current',
      updatedAt: '2026-09-27T10:10:00.000Z',
    };
    const retainedEvents = [
      {
        id: 20,
        threadId: 'thread-1',
        turnId: 'turn-old',
        kind: 'turn',
        phase: 'completed',
        payload: { status: 'completed' },
        createdAt: '2026-09-27T10:01:00.000Z',
      },
      {
        id: 21,
        threadId: 'thread-1',
        turnId: 'turn-current',
        kind: 'tool',
        phase: 'completed',
        payload: { item: { id: 'item-current', status: 'completed' } },
        createdAt: '2026-09-27T10:09:00.000Z',
      },
    ];
    const fetchMock = installAuthenticatedApi((url) => {
      if (url.includes('/api/threads?')) return jsonResponse([activeThread]);
      if (url === '/api/threads/thread-1')
        return jsonResponse({ data: activeThread, events: retainedEvents });
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    const input = await screen.findByLabelText('Уточнение для активной задачи');
    await user.type(input, 'Проверь текущий прогресс');
    await user.click(screen.getByRole('button', { name: 'Направить задачу' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/threads/thread-1/steer',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            text: 'Проверь текущий прогресс',
            expectedTurnId: 'turn-current',
          }),
        }),
      ),
    );
  });

  it('keeps the composer compact and grows it with multiline input', async () => {
    installAuthenticatedApi();
    render(<App />);

    const textarea = await screen.findByLabelText<HTMLTextAreaElement>('Сообщение Codex');
    expect(textarea.rows).toBe(1);
    expect(textarea.closest('.composer')?.querySelector('.composer-controls')).not.toBeNull();
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 144 });

    fireEvent.change(textarea, { target: { value: 'Первая строка\nВторая строка' } });
    expect(textarea.style.height).toBe('144px');

    fireEvent.change(textarea, { target: { value: '' } });
    expect(textarea.style.height).toBe('auto');
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

  it('renames a chat and keeps the server result in navigation and the heading', async () => {
    const renamed = { ...thread, name: 'Проверка релиза' };
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url === '/api/threads/thread-1' && init?.method === 'PATCH') {
        return jsonResponse({ data: renamed });
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText('Frontend task');

    await user.click(screen.getByRole('button', { name: 'Открыть недавний чат Frontend task' }));
    await user.click(screen.getByRole('button', { name: 'Меню недавнего чата Frontend task' }));
    await user.click(screen.getByRole('menuitem', { name: 'Переименовать' }));
    const input = screen.getByRole('textbox', { name: 'Название' });
    await user.clear(input);
    await user.type(input, 'Проверка релиза');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/threads/thread-1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    expect((await screen.findAllByText('Проверка релиза')).length).toBeGreaterThan(1);
  });

  it('applies the first native Codex topic name from the server stream', async () => {
    installAuthenticatedApi();
    render(<App />);
    await screen.findAllByText('Frontend task');
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    act(() => {
      FakeEventSource.instances.at(-1)?.emit({
        id: 8,
        threadId: 'thread-1',
        turnId: null,
        kind: 'thread',
        phase: 'state',
        payload: { threadId: 'thread-1', threadName: 'Безопасное обновление сервиса' },
        createdAt: '2026-09-27T10:05:00.000Z',
      });
    });

    expect((await screen.findAllByText('Безопасное обновление сервиса')).length).toBeGreaterThan(1);
  });

  it('refreshes server-owned navigation when another device changes it', async () => {
    let remoteName = 'Frontend task';
    installAuthenticatedApi((url) => {
      if (url.includes('/api/threads?')) return jsonResponse([{ ...thread, name: remoteName }]);
      return undefined;
    });
    render(<App />);
    await screen.findAllByText('Frontend task');

    remoteName = 'Изменено с телефона';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect((await screen.findAllByText('Изменено с телефона')).length).toBeGreaterThan(0);
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
    expect(screen.getAllByText('1.2.3').length).toBeGreaterThan(0);
    expect(screen.getByText('Подготовленное обновление отсутствует.')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Обновить Codex' })).toBeNull();
  });

  it('starts a prepared Codex update and refreshes its version after completion', async () => {
    let updateReads = 0;
    let capabilityReads = 0;
    let modelReads = 0;
    const readyUpdate = {
      state: 'ready' as const,
      currentVersion: 'codex-cli 1.2.3',
      availableVersion: 'codex-cli 1.2.4',
      candidateReleaseId: 'release-124',
      lastResult: null,
    };
    const completedUpdate = {
      state: 'current' as const,
      currentVersion: 'codex-cli 1.2.4',
      availableVersion: null,
      candidateReleaseId: null,
      lastResult: {
        status: 'succeeded' as const,
        message: 'Codex updated',
        completedAt: '2026-10-01T10:00:00.000Z',
      },
    };
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url === '/api/models') {
        modelReads += 1;
        return jsonResponse(
          modelReads > 1
            ? [
                ...models,
                {
                  id: 'gpt-new',
                  displayName: 'GPT New',
                  isDefault: false,
                  defaultReasoningEffort: 'medium',
                  supportedReasoningEfforts: [
                    { reasoningEffort: 'medium', description: 'Balanced' },
                  ],
                },
              ]
            : models,
        );
      }
      if (url === '/api/system/capabilities') {
        capabilityReads += 1;
        return jsonResponse({
          ...capabilities,
          codexVersion: capabilityReads > 1 ? '1.2.4' : '1.2.3',
        });
      }
      if (url === '/api/system/codex-update/apply' && init?.method === 'POST') {
        return jsonResponse(
          {
            data: {
              ...readyUpdate,
              state: 'applying',
            },
          },
          202,
        );
      }
      if (url === '/api/system/codex-update') {
        updateReads += 1;
        return jsonResponse({ data: updateReads > 1 ? completedUpdate : readyUpdate });
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Статус' }));
    expect((await screen.findAllByText('1.2.4')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Обновить Codex' }));

    expect(await screen.findByText('Обновляем Codex…')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Обновить Codex' })).toBeNull();
    expect(screen.getByText(/Обновление запускается только когда Codex свободен/)).not.toBeNull();
    expect(await screen.findByText('Установлена актуальная подготовленная версия.')).not.toBeNull();
    expect(await screen.findByText('Codex обновлён. Чаты и файлы сохранены.')).not.toBeNull();
    expect(modelReads).toBeGreaterThan(1);
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Модель' }).value).toBe(
      'gpt-test',
    );
    expect(screen.getByRole('option', { name: 'GPT New' })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/codex-update/apply',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    const applyCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input) === '/api/system/codex-update/apply' && init?.method === 'POST',
    );
    expect(new Headers(applyCall?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-token');
  });

  it('checks the latest Codex version automatically and supports a manual refresh', async () => {
    const availableDiscovery = {
      state: 'available' as const,
      currentVersion: 'codex-cli 1.2.3',
      latestVersion: 'codex-cli 1.2.4',
      checkedAt: '2026-10-01T16:00:00.000Z',
    };
    const currentDiscovery = {
      ...availableDiscovery,
      state: 'current' as const,
      currentVersion: 'codex-cli 1.2.4',
    };
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url === '/api/system/codex-update/discovery')
        return jsonResponse({ data: availableDiscovery });
      if (url === '/api/system/codex-update/check' && init?.method === 'POST')
        return jsonResponse({ data: currentDiscovery });
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Статус' }));
    expect(await screen.findByText('codex-cli 1.2.4')).not.toBeNull();
    expect(screen.getByText(/Доступна новая версия Codex/)).not.toBeNull();
    expect(screen.getByText(/Проверено/)).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Проверить обновления' }));

    expect(await screen.findByText('Установлена последняя версия Codex.')).not.toBeNull();
    const checkCall = fetchMock.mock.calls.find(
      ([input, request]) =>
        requestUrl(input) === '/api/system/codex-update/check' && request?.method === 'POST',
    );
    expect(checkCall?.[1]?.body).toBe('{}');
    expect(new Headers(checkCall?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-token');
  });

  it('starts Codex account login and presents the device code without accepting credentials', async () => {
    const pendingLogin = {
      state: 'pending',
      loginId: 'login-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.openai.com/device',
      expiresAt: '2027-01-01T00:10:00.000Z',
      message: null,
    };
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url === '/api/system/codex-account/login' && init?.method === 'POST')
        return jsonResponse({ data: pendingLogin });
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Статус' }));
    expect(await screen.findByText('old@example.com')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Сменить аккаунт' }));

    expect(await screen.findByRole('dialog', { name: 'Смена аккаунта Codex' })).not.toBeNull();
    expect(screen.getByLabelText('Одноразовый код').textContent).toContain('ABCD-EFGH');
    expect(screen.getByRole('button', { name: 'Копировать код' })).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Открыть страницу входа' }).getAttribute('href')).toBe(
      'https://auth.openai.com/device',
    );
    expect(screen.getByText(/Никому не сообщайте этот код/)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/codex-account/login',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const startCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input) === '/api/system/codex-account/login' && init?.method === 'POST',
    );
    expect((startCall?.[1]?.headers as Headers).get('X-CSRF-Token')).toBe('csrf-token');
    const startBody = startCall?.[1]?.body;
    expect(typeof startBody).toBe('string');
    if (typeof startBody !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(startBody) as unknown).toEqual({ type: 'chatgptDeviceCode' });
  });

  it('polls a pending Codex account login through the safe status endpoint', async () => {
    let statusReads = 0;
    installAuthenticatedApi((url, init) => {
      if (url !== '/api/system/codex-account/login') return undefined;
      const pending = {
        state: 'pending',
        loginId: 'login-2',
        userCode: 'PEND-ING',
        verificationUrl: 'https://auth.openai.com/device',
        expiresAt: '2027-01-01T00:10:00.000Z',
        message: null,
      };
      if (init?.method === 'POST') return jsonResponse({ data: pending });
      statusReads += 1;
      return jsonResponse({ data: pending });
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Статус' }));
    await user.click(screen.getByRole('button', { name: 'Сменить аккаунт' }));
    expect(await screen.findByText('Ожидаем подтверждение входа…')).not.toBeNull();
    await waitFor(() => expect(statusReads).toBeGreaterThan(0), { timeout: 1_500 });
  });

  it('refreshes capabilities and reports completion after account login succeeds', async () => {
    let statusReads = 0;
    let capabilityReads = 0;
    installAuthenticatedApi((url, init) => {
      if (url === '/api/system/capabilities') {
        capabilityReads += 1;
        return jsonResponse(
          capabilityReads > 1
            ? {
                ...capabilities,
                account: { type: 'chatgpt', email: 'new@example.com', planType: 'pro' },
              }
            : capabilities,
        );
      }
      if (url !== '/api/system/codex-account/login') return undefined;
      if (init?.method === 'POST')
        return jsonResponse({
          data: {
            state: 'pending',
            loginId: 'login-3',
            userCode: 'SUCC-EEDS',
            verificationUrl: 'https://auth.openai.com/device',
            expiresAt: '2027-01-01T00:10:00.000Z',
            message: null,
          },
        });
      statusReads += 1;
      return jsonResponse({
        data: {
          state: 'succeeded',
          loginId: null,
          userCode: null,
          verificationUrl: null,
          expiresAt: null,
          message: null,
        },
      });
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Статус' }));
    await user.click(screen.getByRole('button', { name: 'Сменить аккаунт' }));

    expect(await screen.findByText(/Аккаунт Codex успешно сменён/)).not.toBeNull();
    expect(statusReads).toBeGreaterThan(0);
    expect(await screen.findByText('new@example.com')).not.toBeNull();
  });

  it('cancels a pending Codex account login and keeps the current account', async () => {
    const fetchMock = installAuthenticatedApi((url, init) => {
      if (url !== '/api/system/codex-account/login') return undefined;
      if (init?.method === 'POST')
        return jsonResponse({
          data: {
            state: 'pending',
            loginId: 'login-4',
            userCode: 'CANC-ELME',
            verificationUrl: 'https://auth.openai.com/device',
            expiresAt: '2027-01-01T00:10:00.000Z',
            message: null,
          },
        });
      if (init?.method === 'DELETE')
        return jsonResponse({
          data: {
            state: 'idle',
            loginId: null,
            userCode: null,
            verificationUrl: null,
            expiresAt: null,
            message: null,
          },
        });
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Статус' }));
    await user.click(screen.getByRole('button', { name: 'Сменить аккаунт' }));
    expect(await screen.findByRole('button', { name: 'Отменить вход' })).not.toBeNull();
    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Смена аккаунта Codex' })).toBeNull(),
    );
    expect(await screen.findByText(/Текущий аккаунт сохранён/)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/codex-account/login',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('treats a successful login returned by cancel as completion instead of cancellation', async () => {
    let capabilityReads = 0;
    installAuthenticatedApi((url, init) => {
      if (url === '/api/system/capabilities') {
        capabilityReads += 1;
        return jsonResponse(
          capabilityReads > 1
            ? {
                ...capabilities,
                account: { type: 'chatgpt', email: 'race-winner@example.com', planType: 'pro' },
              }
            : capabilities,
        );
      }
      if (url !== '/api/system/codex-account/login') return undefined;
      if (init?.method === 'POST')
        return jsonResponse({
          data: {
            state: 'pending',
            loginId: 'login-race',
            userCode: 'RACE-WINS',
            verificationUrl: 'https://auth.openai.com/device',
            expiresAt: '2027-01-01T00:10:00.000Z',
            message: null,
          },
        });
      if (init?.method === 'DELETE')
        return jsonResponse({
          data: {
            state: 'succeeded',
            loginId: null,
            userCode: null,
            verificationUrl: null,
            expiresAt: null,
            message: null,
          },
        });
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Статус' }));
    await user.click(screen.getByRole('button', { name: 'Сменить аккаунт' }));
    await user.click(await screen.findByRole('button', { name: 'Отменить вход' }));

    expect(await screen.findByText(/Аккаунт Codex успешно сменён/)).not.toBeNull();
    expect(await screen.findByText('race-winner@example.com')).not.toBeNull();
    expect(screen.queryByText(/Текущий аккаунт сохранён/)).toBeNull();
  });

  it('shows a Russian busy message when another account login is active', async () => {
    installAuthenticatedApi((url, init) => {
      if (url === '/api/system/codex-account/login' && init?.method === 'POST')
        return jsonResponse(
          { error: { code: 'CODEX_ACCOUNT_LOGIN_BUSY', message: 'Login already in progress' } },
          409,
        );
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Статус' }));
    await user.click(screen.getByRole('button', { name: 'Сменить аккаунт' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Сейчас Codex занят задачей или субагентом. Дождитесь их завершения и повторите попытку.',
    );
  });

  it('recovers an already-pending login separately from a busy runner', async () => {
    installAuthenticatedApi((url, init) => {
      if (url !== '/api/system/codex-account/login') return undefined;
      if (init?.method === 'POST')
        return jsonResponse(
          { error: { code: 'CODEX_ACCOUNT_LOGIN_PENDING', message: 'Login already pending' } },
          409,
        );
      return jsonResponse({
        data: {
          state: 'pending',
          loginId: 'login-existing',
          userCode: 'EXIS-TING',
          verificationUrl: 'https://auth.openai.com/device',
          expiresAt: '2027-01-01T00:10:00.000Z',
          message: null,
        },
      });
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Статус' }));
    await user.click(screen.getByRole('button', { name: 'Сменить аккаунт' }));

    expect(await screen.findByLabelText('Одноразовый код')).not.toBeNull();
    expect(screen.getByText(/Смена аккаунта уже запущена/)).not.toBeNull();
    expect(screen.queryByText(/Codex занят задачей/)).toBeNull();
  });
});
