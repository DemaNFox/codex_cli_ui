import { describe, expect, it, vi } from 'vitest';

import { api } from './api.js';

const project = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Project',
  path: '/srv/projects/project',
  defaultModel: null,
  defaultReasoningEffort: null,
  defaultPermissionPreset: 'workspace-write' as const,
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

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api response envelopes', () => {
  it('unwraps create, thread, turn, archive and interrupt responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === '/api/projects') return Promise.resolve(response({ data: project }));
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
        if (url.endsWith('/turns'))
          return Promise.resolve(response({ data: { turnId: 'turn-1' } }));
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
    ).resolves.toEqual({ turnId: 'turn-1' });
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
  });
});
