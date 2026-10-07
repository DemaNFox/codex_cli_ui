import { describe, expect, it, vi } from 'vitest';

import { ApiError, api } from './api.js';

const project = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Project',
  path: '/srv/projects/project',
  defaultModel: null,
  defaultReasoningEffort: null,
  defaultPermissionPreset: 'workspace-write' as const,
  archived: false,
  createdAt: '2026-09-27T10:00:00.000Z',
  updatedAt: '2026-09-27T10:00:00.000Z',
};

const thread = {
  id: 'thread-1',
  projectId: project.id,
  name: null,
  preview: 'New thread',
  model: null,
  status: 'idle' as const,
  activeTurnId: null,
  archived: false,
  instructionSources: [],
  createdAt: '2026-09-27T10:00:00.000Z',
  updatedAt: '2026-09-27T10:00:00.000Z',
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

const codexUpdate = {
  state: 'ready' as const,
  currentVersion: 'codex-cli 0.153.4',
  availableVersion: 'codex-cli 0.154.0',
  candidateReleaseId: 'release-154',
  lastResult: null,
};

const codexUpdateDiscovery = {
  state: 'available' as const,
  currentVersion: 'codex-cli 0.153.4',
  latestVersion: 'codex-cli 0.159.3',
  checkedAt: '2026-10-01T16:00:00.000Z',
};

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api response envelopes', () => {
  it('preserves structured API error codes for safe recovery decisions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: 'CSRF_INVALID', message: 'CSRF_INVALID' } }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      ),
    );

    const error = await api.session().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'CSRF_INVALID', message: 'CSRF_INVALID' });
  });

  it('unwraps create, thread, turn, archive and interrupt responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === '/api/projects') return Promise.resolve(response({ data: project }));
        if (url === `/api/projects/${project.id}/archive`)
          return Promise.resolve(response({ data: { ...project, archived: true } }));
        if (url === `/api/projects/${project.id}/unarchive`)
          return Promise.resolve(response({ data: project }));
        if (url === '/api/preferences/runtime')
          return Promise.resolve(
            response({
              data: {
                model: 'gpt-test',
                reasoningEffort: 'medium',
                permissionPreset: 'workspace-write',
                approvalPolicy: 'on-request',
                updatedAt: '2026-09-27T10:00:00.000Z',
              },
            }),
          );
        if (url === '/api/threads') return Promise.resolve(response({ data: thread }));
        if (url === '/api/system/resource-limits')
          return Promise.resolve(response({ data: resourceLimits }));
        if (url === '/api/threads/thread-1/subagents')
          return Promise.resolve(response({ data: [{ id: 'agent-1' }] }));
        if (url.endsWith('/turns'))
          return Promise.resolve(response({ data: { status: 'started', turnId: 'turn-1' } }));
        if (url.endsWith('/archive')) {
          return Promise.resolve(response({ data: { ...thread, archived: true } }));
        }
        if (url.endsWith('/unarchive')) return Promise.resolve(response({ data: thread }));
        if (url.endsWith('/interrupt')) {
          return Promise.resolve(response({ data: { interrupted: true } }));
        }
        return Promise.resolve(response({ data: [] }));
      }),
    );

    await expect(
      api.createProject('csrf', { name: 'Project', path: project.path }),
    ).resolves.toEqual(project);
    await expect(api.archiveProject('csrf', project.id)).resolves.toEqual({
      ...project,
      archived: true,
    });
    await expect(api.unarchiveProject('csrf', project.id)).resolves.toEqual(project);
    await expect(
      api.startThread('csrf', {
        projectId: project.id,
        permissionPreset: 'workspace-write',
        approvalPolicy: 'on-request',
      }),
    ).resolves.toEqual(thread);
    await expect(
      api.startTurn('csrf', thread.id, {
        text: 'Run tests',
        permissionPreset: 'workspace-write',
        approvalPolicy: 'on-request',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      }),
    ).resolves.toEqual({ status: 'started', turnId: 'turn-1' });
    await expect(api.archiveThread('csrf', thread.id)).resolves.toEqual({
      ...thread,
      archived: true,
    });
    await expect(api.unarchiveThread('csrf', thread.id)).resolves.toEqual(thread);
    await expect(api.interrupt('csrf', thread.id, 'turn-1')).resolves.toEqual({
      interrupted: true,
    });
    await expect(api.runtimePreferences()).resolves.toMatchObject({
      model: 'gpt-test',
      permissionPreset: 'workspace-write',
    });
    await expect(api.resourceLimits()).resolves.toEqual(resourceLimits);
    await expect(api.subagents(thread.id)).resolves.toEqual([{ id: 'agent-1' }]);
  });

  it('requests active and archived projects separately', async () => {
    const archivedProject = { ...project, archived: true };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        response({ data: url.endsWith('archived=true') ? [archivedProject] : [project] }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.projects()).resolves.toEqual([project]);
    await expect(api.projects(true)).resolves.toEqual([archivedProject]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/projects?archived=false',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/projects?archived=true',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('sends versioned resource save and apply requests', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response({ data: resourceLimits })));
    vi.stubGlobal('fetch', fetchMock);

    await api.updateResourceLimits('csrf', resourceLimits.desired, 1);
    await api.applyResourceLimits('csrf', 1, '22222222-2222-4222-8222-222222222222');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/system/resource-limits',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ desired: resourceLimits.desired, expectedVersion: 1 }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/system/resource-limits/apply',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: '22222222-2222-4222-8222-222222222222',
          expectedVersion: 1,
        }),
      }),
    );
  });

  it('sends attachment ids when steering an active turn', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(response({ data: { turnId: 'turn-active' } })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      api.steer('csrf', thread.id, {
        text: '',
        expectedTurnId: 'turn-active',
        attachmentIds: ['attachment-1'],
      }),
    ).resolves.toEqual({ turnId: 'turn-active' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/threads/thread-1/steer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: '',
          expectedTurnId: 'turn-active',
          attachmentIds: ['attachment-1'],
        }),
      }),
    );
  });

  it('reads and starts the prepared Codex update with CSRF protection', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(response({ data: { ...codexUpdate, state: 'applying' } })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.codexUpdate()).resolves.toMatchObject({ state: 'applying' });
    await expect(api.applyCodexUpdate('csrf')).resolves.toMatchObject({ state: 'applying' });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/system/codex-update',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/system/codex-update/apply',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
      }),
    );
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf');
  });

  it('reads and manually checks Codex update discovery without sending a target', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(response({ data: codexUpdateDiscovery })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.codexUpdateDiscovery()).resolves.toEqual(codexUpdateDiscovery);
    await expect(api.checkCodexUpdate('csrf')).resolves.toEqual(codexUpdateDiscovery);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/system/codex-update/discovery',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/system/codex-update/check',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf');
  });

  it('checks, saves and removes the current device push mapping for one thread', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(response({ data: { subscribed: true } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const subscription = {
      endpoint: 'https://push.example/subscription-1',
      expirationTime: null,
      keys: { p256dh: 'public-key', auth: 'auth-key' },
    } satisfies PushSubscriptionJSON;

    await expect(
      api.pushSubscriptionStatus('csrf', thread.id, subscription.endpoint),
    ).resolves.toEqual({ subscribed: true });
    await expect(api.savePushSubscription('csrf', thread.id, subscription)).resolves.toEqual({
      subscribed: true,
    });
    await api.deletePushSubscription('csrf', thread.id, subscription.endpoint);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/threads/thread-1/push-subscriptions/status',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/threads/thread-1/push-subscriptions',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(subscription) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/threads/thread-1/push-subscriptions',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }),
    );
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf');
    }
  });

  it('retries a network-ambiguous transcription with the same idempotency key', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000301');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(response({ text: 'Готовый текст' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      api.transcribeAudio('csrf', new File(['voice'], 'voice.wav', { type: 'audio/wav' })),
    ).resolves.toEqual({ text: 'Готовый текст' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(
        '00000000-0000-4000-8000-000000000301',
      );
    }
  });
});
