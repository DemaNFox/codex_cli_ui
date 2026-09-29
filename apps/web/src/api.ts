import type {
  Attachment,
  ApprovalPolicy,
  Capability,
  ModelOption,
  PendingApproval,
  PermissionPreset,
  Project,
  ResolveUserInputRequest,
  ResourceLimitPolicy,
  ResourceLimitSnapshot,
  RuntimePreferences,
  SafeEvent,
  Session,
  Subagent,
  Thread,
} from '@codex-web/contracts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
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
    let code: string | null = null;
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
      if (
        payload.error &&
        typeof payload.error === 'object' &&
        'code' in payload.error &&
        typeof payload.error.code === 'string'
      ) {
        code = payload.error.code;
      }
    } catch {
      // The response can intentionally have no JSON body.
    }
    throw new ApiError(message, response.status, code);
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
  eventCursor?: number;
  subagents?: Subagent[];
}

export interface AttachmentUpload {
  promise: Promise<Attachment>;
  abort: () => void;
}

export interface PushSubscriptionStatus {
  subscribed: boolean;
}

function uploadAttachment(
  csrfToken: string,
  threadId: string,
  file: File,
  onProgress: (percent: number) => void,
): AttachmentUpload {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Attachment>((resolve, reject) => {
    xhr.open('POST', `/api/threads/${encodeURIComponent(threadId)}/attachments`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    });
    xhr.addEventListener('load', () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let message = `Загрузка завершилась с ошибкой (${xhr.status})`;
        try {
          const payload = JSON.parse(xhr.responseText) as { message?: unknown; error?: unknown };
          if (typeof payload.message === 'string') message = payload.message;
          else if (typeof payload.error === 'string') message = payload.error;
        } catch {
          // The response can intentionally have no JSON body.
        }
        reject(new ApiError(message, xhr.status));
        return;
      }
      try {
        const payload = JSON.parse(xhr.responseText) as Attachment | { data: Attachment };
        resolve(unwrapData(payload));
      } catch {
        reject(new ApiError('Сервер вернул некорректный ответ загрузки', xhr.status));
      }
    });
    xhr.addEventListener('error', () => reject(new ApiError('Не удалось загрузить файл', 0)));
    xhr.addEventListener('abort', () => reject(new ApiError('Загрузка отменена', 0)));

    const body = new FormData();
    body.append('file', file, file.name);
    xhr.send(body);
  });
  return { promise, abort: () => xhr.abort() };
}

async function transcribeAudio(csrfToken: string, file: File): Promise<{ text: string }> {
  const body = new FormData();
  body.append('file', file, file.name);
  const idempotencyKey = crypto.randomUUID();
  const send = () =>
    fetch('/api/audio/transcriptions', {
      method: 'POST',
      body,
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey },
    });
  let response: Response;
  try {
    response = await send();
  } catch {
    response = await send();
  }
  if (!response.ok) {
    let message = `Распознавание завершилось с ошибкой (${response.status})`;
    try {
      const payload = (await response.json()) as { message?: unknown; error?: unknown };
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
  return unwrapData((await response.json()) as { text: string } | { data: { text: string } });
}

export const api = {
  session: () => request<Session>('/api/auth/session'),
  login: (username: string, password: string) =>
    request<Session>('/api/auth/login', { method: 'POST', body: { username, password } }),
  logout: (csrfToken: string) => request<void>('/api/auth/logout', { method: 'POST', csrfToken }),
  runtimePreferences: async () =>
    unwrapData(
      await request<RuntimePreferences | { data: RuntimePreferences }>('/api/preferences/runtime'),
    ),
  updateRuntimePreferences: async (
    csrfToken: string,
    input: Omit<RuntimePreferences, 'updatedAt'>,
  ) =>
    unwrapData(
      await request<RuntimePreferences | { data: RuntimePreferences }>('/api/preferences/runtime', {
        method: 'PUT',
        csrfToken,
        body: input,
      }),
    ),
  resourceLimits: async () =>
    unwrapData(
      await request<ResourceLimitSnapshot | { data: ResourceLimitSnapshot }>(
        '/api/system/resource-limits',
      ),
    ),
  updateResourceLimits: async (
    csrfToken: string,
    desired: ResourceLimitPolicy,
    expectedVersion: number,
  ) =>
    unwrapData(
      await request<ResourceLimitSnapshot | { data: ResourceLimitSnapshot }>(
        '/api/system/resource-limits',
        {
          method: 'PUT',
          csrfToken,
          body: { desired, expectedVersion },
        },
      ),
    ),
  applyResourceLimits: async (csrfToken: string, expectedVersion: number, idempotencyKey: string) =>
    unwrapData(
      await request<ResourceLimitSnapshot | { data: ResourceLimitSnapshot }>(
        '/api/system/resource-limits/apply',
        {
          method: 'POST',
          csrfToken,
          body: { idempotencyKey, expectedVersion },
        },
      ),
    ),
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
  subagents: async (threadId: string) =>
    asList(
      await request<Subagent[] | { data: Subagent[] }>(
        `/api/threads/${encodeURIComponent(threadId)}/subagents`,
      ),
    ),
  renameThread: async (csrfToken: string, threadId: string, name: string) =>
    unwrapData(
      await request<Thread | { data: Thread }>(`/api/threads/${encodeURIComponent(threadId)}`, {
        method: 'PATCH',
        csrfToken,
        body: { name },
      }),
    ),
  attachments: async (threadId: string) =>
    asList(
      await request<Attachment[] | { data: Attachment[] }>(
        `/api/threads/${encodeURIComponent(threadId)}/attachments`,
      ),
    ),
  deleteAttachment: (csrfToken: string, threadId: string, attachmentId: string) =>
    request<void>(
      `/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: 'DELETE', csrfToken },
    ),
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
      attachmentIds?: string[];
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
  uploadAttachment,
  transcribeAudio,
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
  pushSubscriptionStatus: async (csrfToken: string, threadId: string, endpoint: string) =>
    unwrapData(
      await request<PushSubscriptionStatus | { data: PushSubscriptionStatus }>(
        `/api/threads/${encodeURIComponent(threadId)}/push-subscriptions/status`,
        {
          method: 'POST',
          csrfToken,
          body: { endpoint },
        },
      ),
    ),
  savePushSubscription: async (
    csrfToken: string,
    threadId: string,
    subscription: PushSubscriptionJSON,
  ) =>
    unwrapData(
      await request<PushSubscriptionStatus | { data: PushSubscriptionStatus }>(
        `/api/threads/${encodeURIComponent(threadId)}/push-subscriptions`,
        {
          method: 'PUT',
          csrfToken,
          body: subscription,
        },
      ),
    ),
  deletePushSubscription: (csrfToken: string, threadId: string, endpoint: string) =>
    request<void>(`/api/threads/${encodeURIComponent(threadId)}/push-subscriptions`, {
      method: 'DELETE',
      csrfToken,
      body: { endpoint },
    }),
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

export type {
  Attachment,
  Capability,
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
};
