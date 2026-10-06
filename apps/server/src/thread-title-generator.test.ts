import { describe, expect, it } from 'vitest';

import type { AppServerClient, AppServerInbound } from './app-server.js';
import {
  CodexThreadTitleGenerator,
  normalizeGeneratedThreadTitle,
  titleStillNeedsSemanticReplacement,
} from './thread-title-generator.js';

class FakeAppServer implements AppServerClient {
  readonly ready = true;
  readonly generation = 1;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Set<(message: AppServerInbound) => void>();

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === 'thread/start') return Promise.resolve({ thread: { id: 'title-thread' } });
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit({
          method: 'item/completed',
          params: {
            threadId: 'title-thread',
            turnId: 'title-turn',
            item: {
              type: 'agentMessage',
              phase: 'final_answer',
              text: '{"title":"Логический нейминг чатов"}',
            },
          },
        });
        this.emit({
          method: 'turn/completed',
          params: {
            threadId: 'title-thread',
            turn: { id: 'title-turn', status: 'completed' },
          },
        });
      });
      return Promise.resolve({ turn: { id: 'title-turn' } });
    }
    throw new Error(`Unexpected request: ${method}`);
  }

  respond(): void {}

  respondError(): void {}

  subscribe(listener: (message: AppServerInbound) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeLifecycle(): () => void {
    return () => undefined;
  }

  private emit(message: AppServerInbound): void {
    for (const listener of this.listeners) listener(message);
  }
}

describe('CodexThreadTitleGenerator', () => {
  it('creates a bounded ephemeral low-effort title turn', async () => {
    const appServer = new FakeAppServer();
    const generator = new CodexThreadTitleGenerator(appServer, 100);

    await expect(
      generator.generate({
        prompt: 'Можно делать названия чатов из логического контекста первого запроса?',
        model: 'gpt-test',
      }),
    ).resolves.toBe('Логический нейминг чатов');

    expect(appServer.requests).toHaveLength(2);
    expect(appServer.requests[0]).toMatchObject({
      method: 'thread/start',
      params: { ephemeral: true, model: 'gpt-test', approvalPolicy: 'never' },
    });
    expect(appServer.requests[1]).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'title-thread',
        effort: 'low',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      },
    });
  });
});

describe('thread title policy', () => {
  it('replaces a raw prompt prefix but preserves a semantic or manual name', () => {
    const prompt = 'Проверь как статистику по фильтру за 5 число показывает 22 передачи';
    expect(titleStillNeedsSemanticReplacement(null, prompt, prompt)).toBe(true);
    expect(
      titleStillNeedsSemanticReplacement('Проверь как статистику по фильтру', prompt, prompt),
    ).toBe(true);
    expect(
      titleStillNeedsSemanticReplacement('Расхождение статистики передач', prompt, prompt),
    ).toBe(false);
  });

  it('normalizes safe titles and rejects URLs or credentials', () => {
    expect(normalizeGeneratedThreadTitle('«Логический нейминг чатов».')).toBe(
      'Логический нейминг чатов',
    );
    expect(normalizeGeneratedThreadTitle('https://example.com/title')).toBeNull();
    expect(normalizeGeneratedThreadTitle('Bearer abcdefghijklmnop')).toBeNull();
  });
});
