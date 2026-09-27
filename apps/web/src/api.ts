import type {
  ApprovalPolicy,
  Capability,
  ModelOption,
  PendingApproval,
  PermissionPreset,
  Project,
  ResolveUserInputRequest,
  SafeEvent,
  Session,
  Thread,
} from '@codex-web/contracts';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  csrfToken?: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, csrfToken, ...requestOptions } = options;
  const headers = new Headers(options.headers);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (csrfToken) headers.set('X-CSRF-Token', csrfToken);

  const init: RequestInit = {
    ...requestOptions,
    headers,
    credentials: 'same-origin',
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await fetch(path, init);

  if (!response.ok) {
    let message = `Запрос завершился с ошибкой (${response.status})`;
    try {
      const payload = (await response.json()) as {
        message?: unknown;
        error?: unknown;
      };
      if (typeof payload.message === 'string') message = payload.message;
      else if (typeof payload.error === 'string') message = payload.error;
      else if (
        payload.error &&
        typeof payload.error === 'object' &&
        'message' in payload.error &&
        typeof payload.error.message === 'string'
      ) {
        message = payload.error.message;
      }
    } catch {
      // The response can intentionally have no JSON body.
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function asList<T>(value: T[] | { data: T[] }): T[] {
  return Array.isArray(value) ? value : value.data;
}

function unwrapData<T>(value: T | { data: T }): T {
  if (value && typeof value === 'object' && 'data' in value) return value.data;
  return value;
}

export interface ThreadHistory {
  data: Thread;
  events: SafeEvent[];
}

export const api = {
  session: () => request<Session>('/api/auth/session'),
  login: (username: string, password: string) =>
    request<Session>('/api/auth/login', { method: 'POST', body: { username, password } }),
  logout: (csrfToken: string) => request<void>('/api/auth/logout', { method: 'POST', csrfToken }),
  projects: async () => asList(await request<Project[] | { data: Project[] }>('/api/projects')),
  createProject: async (csrfToken: string, input: { name: string; path: string }) =>
    unwrapData(
      await request<Project | { data: Project }>('/api/projects', {
        method: 'POST',
        csrfToken,
        body: input,
      }),
    ),
  models: async () => asList(await request<ModelOption[] | { data: ModelOption[] }>('/api/models')),
  threads: async (projectId: string, archived = false) =>
    asList(
      await request<Thread[] | { data: Thread[] }>(
        `/api/threads?projectId=${encodeURIComponent(projectId)}&archived=${String(archived)}`,
      ),
    ),
  thread: (threadId: string) =>
    request<ThreadHistory>(`/api/threads/${encodeURIComponent(threadId)}`),
  startThread: (
    csrfToken: string,
    input: {
      projectId: string;
      model?: string;
      reasoningEffort?: string;
      permissionPreset: PermissionPreset;
      approvalPolicy: ApprovalPolicy;
    },
  ) =>
    request<Thread | { data: Thread }>('/api/threads', {
      method: 'POST',
      csrfToken,
      body: input,
    }).then(unwrapData),
  startTurn: (
    csrfToken: string,
    threadId: string,
    input: {
      text: string;
      model?: string;
      reasoningEffort?: string;
      permissionPreset: PermissionPreset;
      approvalPolicy: ApprovalPolicy;
      idempotencyKey: string;
    },
  ) =>
    request<{ turnId: string } | { data: { turnId: string } }>(
      `/api/threads/${encodeURIComponent(threadId)}/turns`,
      {
        method: 'POST',
        csrfToken,
        body: input,
      },
    ).then(unwrapData),
  steer: async (csrfToken: string, threadId: string, text: string, expectedTurnId: string) =>
    unwrapData(
      await request<{ turnId: string } | { data: { turnId: string } }>(
        `/api/threads/${encodeURIComponent(threadId)}/steer`,
        {
          method: 'POST',
          csrfToken,
          body: { text, expectedTurnId },
        },
      ),
    ),
  interrupt: async (csrfToken: string, threadId: string, turnId: string) =>
    unwrapData(
      await request<{ interrupted: boolean } | { data: { interrupted: boolean } }>(
        `/api/threads/${encodeURIComponent(threadId)}/interrupt`,
        {
          method: 'POST',
          csrfToken,
          body: { turnId },
        },
      ),
    ),
  archiveThread: async (csrfToken: string, threadId: string) =>
    unwrapData(
      await request<Thread | { data: Thread }>(
        `/api/threads/${encodeURIComponent(threadId)}/archive`,
        {
          method: 'POST',
          csrfToken,
        },
      ),
    ),
  unarchiveThread: async (csrfToken: string, threadId: string) =>
    unwrapData(
      await request<Thread | { data: Thread }>(
        `/api/threads/${encodeURIComponent(threadId)}/unarchive`,
        {
          method: 'POST',
          csrfToken,
        },
      ),
    ),
  resolveApproval: (
    csrfToken: string,
    approvalId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ) =>
    request<void>(`/api/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      method: 'POST',
      csrfToken,
      body: { decision },
    }),
  resolveUserInput: (
    csrfToken: string,
    requestId: string,
    answers: ResolveUserInputRequest['answers'],
  ) =>
    request<void>(`/api/user-input-requests/${encodeURIComponent(requestId)}/resolve`, {
      method: 'POST',
      csrfToken,
      body: { answers },
    }),
  resolvePermission: (csrfToken: string, requestId: string, decision: 'grant' | 'deny') =>
    request<void>(`/api/permission-requests/${encodeURIComponent(requestId)}/resolve`, {
      method: 'POST',
      csrfToken,
      body: { decision, scope: 'turn' },
    }),
  capabilities: () => request<Capability>('/api/system/capabilities'),
};

export type { Capability, ModelOption, PendingApproval, Project, SafeEvent, Session, Thread };
