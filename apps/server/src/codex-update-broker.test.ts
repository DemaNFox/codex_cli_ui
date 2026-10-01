import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexUpdateBrokerError, UnixCodexUpdateBrokerClient } from './codex-update-broker.js';

const openServers: Server[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function brokerSocket(
  handler: (request: Record<string, unknown>) => string,
): Promise<{ path: string; requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-update-client-'));
  tempDirectories.push(directory);
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\codex-update-${randomUUID()}`
      : path.join(directory, 'broker.sock');
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = '';
    let responded = false;
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      input += chunk.toString('utf8');
      if (responded || !input.includes('\n')) return;
      responded = true;
      const request = JSON.parse(input.trim()) as Record<string, unknown>;
      requests.push(request);
      socket.end(handler(request));
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return { path: socketPath, requests };
}

describe('UnixCodexUpdateBrokerClient', () => {
  it('sends only the fixed status operation and parses a bounded snapshot', async () => {
    const broker = await brokerSocket(() =>
      JSON.stringify({
        ok: true,
        snapshot: {
          state: 'ready',
          currentVersion: 'codex-cli 0.153.4',
          availableVersion: 'codex-cli 0.154.0',
          candidateReleaseId: '20261001-update-a1b2c3d4',
          lastResult: null,
        },
      }),
    );
    const snapshot = await new UnixCodexUpdateBrokerClient(broker.path).status();
    expect(snapshot.state).toBe('ready');
    expect(broker.requests).toHaveLength(1);
    expect(Object.keys(broker.requests[0]!).sort()).toEqual(['action', 'requestId', 'version']);
    expect(broker.requests[0]).toMatchObject({ version: 1, action: 'status' });
  });

  it('rejects oversized or malformed broker responses', async () => {
    const oversized = await brokerSocket(() => 'x'.repeat(32_769));
    await expect(new UnixCodexUpdateBrokerClient(oversized.path).status()).rejects.toMatchObject({
      code: 'CODEX_UPDATE_PROTOCOL',
    } satisfies Partial<CodexUpdateBrokerError>);

    const malformed = await brokerSocket(() => JSON.stringify({ ok: true, snapshot: {} }));
    await expect(new UnixCodexUpdateBrokerClient(malformed.path).apply()).rejects.toMatchObject({
      code: 'CODEX_UPDATE_PROTOCOL',
    } satisfies Partial<CodexUpdateBrokerError>);
  });
});
