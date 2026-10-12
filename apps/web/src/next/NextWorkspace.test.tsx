import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api.js';
import type { Project, SafeEvent, Session, Thread } from '../api.js';
import { NextWorkspace } from './NextWorkspace.js';

const session: Session = {
  authenticated: true,
  username: 'nick',
  csrfToken: 'csrf',
  expiresAt: '2027-01-01T00:00:00.000Z',
};
const project: Project = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Project A',
  path: '/srv/projects/a',
  archived: false,
  defaultModel: null,
  defaultReasoningEffort: null,
  defaultPermissionPreset: 'workspace-write',
  createdAt: '2026-10-12T12:00:00.000Z',
  updatedAt: '2026-10-12T12:00:00.000Z',
};
const thread: Thread = {
  id: 'thread-1',
  projectId: project.id,
  name: 'History task',
  preview: 'Prompt',
  model: null,
  status: 'idle',
  activeTurnId: null,
  archived: false,
  instructionSources: [],
  createdAt: '2026-10-12T12:00:00.000Z',
  updatedAt: '2026-10-12T12:00:00.000Z',
};
function event(
  id: number,
  turnId: string,
  kind: SafeEvent['kind'],
  payload: SafeEvent['payload'],
): SafeEvent {
  return {
    id,
    threadId: thread.id,
    turnId,
    kind,
    phase: 'completed',
    payload,
    createdAt: '2026-10-12T12:00:00.000Z',
  };
}

class FakeEventSource {
  constructor(_url: string) {
    void _url;
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

describe('v2 read-only workspace', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(api, 'projects').mockResolvedValue([project]);
    vi.spyOn(api, 'threads').mockResolvedValue([thread]);
    vi.spyOn(api, 'thread').mockResolvedValue({
      data: thread,
      events: [
        event(5, 'turn-2', 'user-message', { text: 'Recent prompt' }),
        event(6, 'turn-2', 'agent-message', {
          text: 'Recent answer',
          messagePhase: 'final_answer',
        }),
        event(7, 'turn-2', 'turn', { status: 'completed' }),
      ],
      conversationEvents: [],
      eventCursor: 7,
      oldestEventId: 5,
      historyTruncated: true,
    });
    vi.spyOn(api, 'threadHistory').mockResolvedValue({
      events: [
        event(1, 'turn-1', 'user-message', { text: 'Old prompt' }),
        event(2, 'turn-1', 'agent-message', { text: 'Old answer', messagePhase: 'final_answer' }),
        event(3, 'turn-1', 'turn', { status: 'completed' }),
      ],
      oldestEventId: 1,
      hasMore: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads a bounded snapshot and earlier page without losing the recent answer or issuing Codex mutations', async () => {
    const startTurn = vi.spyOn(api, 'startTurn');
    const steer = vi.spyOn(api, 'steer');
    render(<NextWorkspace session={session} onSignedOut={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'History task' }));
    expect(await screen.findByText('Recent answer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Показать предыдущие сообщения' }));
    expect(await screen.findByText('Old prompt')).toBeTruthy();
    expect(screen.getByText('Old answer')).toBeTruthy();
    expect(screen.getByText('Recent prompt')).toBeTruthy();
    expect(screen.getByText('Recent answer')).toBeTruthy();
    expect(api.threadHistory).toHaveBeenCalledWith(thread.id, 5);
    expect(startTurn).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it('keeps an explicit retry action and existing messages when a refresh fails', async () => {
    render(<NextWorkspace session={session} onSignedOut={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'History task' }));
    expect(await screen.findByText('Recent answer')).toBeTruthy();
    vi.mocked(api.thread).mockRejectedValueOnce(new Error('temporarily unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('temporarily unavailable'),
    );
    expect(screen.getByText('Recent answer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Обновить' }).hasAttribute('disabled')).toBe(false);
  });
});
