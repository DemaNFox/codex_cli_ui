import { afterEach, describe, expect, it, vi } from 'vitest';

import { NpmCodexVersionChecker } from './codex-version-checker.js';

afterEach(() => vi.useRealTimers());

function jsonResponse(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('NpmCodexVersionChecker', () => {
  it('checks only the fixed registry endpoint and reports newer semantic versions', async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse({ version: '0.159.3', ignored: true })),
    );
    const checker = new NpmCodexVersionChecker(fetcher, () => Date.parse('2026-10-01T16:00:00Z'));

    await expect(checker.check('codex-cli 0.153.4')).resolves.toEqual({
      state: 'available',
      currentVersion: 'codex-cli 0.153.4',
      latestVersion: 'codex-cli 0.159.3',
      checkedAt: '2026-10-01T16:00:00.000Z',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://registry.npmjs.org/@openai%2Fcodex/latest',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });

  it('caches success and coalesces forced concurrent checks', async () => {
    let resolveResponse!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => (resolveResponse = resolve)));
    const checker = new NpmCodexVersionChecker(fetcher);
    const first = checker.check('codex-cli 0.153.4', true);
    const second = checker.check('codex-cli 0.153.4', true);
    resolveResponse(jsonResponse({ version: '0.159.3' }));
    await Promise.all([first, second]);
    await checker.check('codex-cli 0.153.4');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fails closed for redirects, malformed versions and oversized responses', async () => {
    const responses = [
      new Response(null, { status: 302, headers: { location: 'https://example.test/latest' } }),
      jsonResponse({ version: 'latest' }),
      jsonResponse({ version: '0.159.3' }, { 'content-length': '40000' }),
    ];
    for (const response of responses) {
      const checker = new NpmCodexVersionChecker(() => Promise.resolve(response), Date.now, 0, 0);
      await expect(checker.check('codex-cli 0.153.4', true)).resolves.toMatchObject({
        state: 'failed',
        latestVersion: null,
      });
    }
  });

  it('uses numeric semantic comparison instead of lexical ordering', async () => {
    const checker = new NpmCodexVersionChecker(() =>
      Promise.resolve(jsonResponse({ version: '0.99.0' })),
    );
    await expect(checker.check('codex-cli 0.100.0')).resolves.toMatchObject({ state: 'current' });
  });

  it('checks once at startup and then on the configured background interval', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => Promise.resolve(jsonResponse({ version: '0.159.3' })));
    const checker = new NpmCodexVersionChecker(fetcher);
    const stop = checker.startPeriodic('codex-cli 0.153.4', 1_000);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    stop();
  });
});
