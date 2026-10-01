import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ProjectPathError } from './path-policy.js';
import { ProjectPathBrokerError, UnixProjectPathBrokerClient } from './project-path-broker.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

async function brokerFixture(response: unknown) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-path-broker-'));
  directories.push(directory);
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\codex-path-broker-${randomUUID()}`
      : path.join(directory, 'broker.sock');
  let request: unknown;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let body = '';
    socket.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (!body.includes('\n')) return;
      request = JSON.parse(body) as unknown;
      socket.end(JSON.stringify(response));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    client: new UnixProjectPathBrokerClient(socketPath, 1_000),
    request: () => request,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe('UnixProjectPathBrokerClient', () => {
  it('sends only the bounded canonicalization contract', async () => {
    const fixture = await brokerFixture({ ok: true, canonicalPath: '/root/private-project' });
    try {
      await expect(fixture.client.canonicalize('/root/private-project', 'directory')).resolves.toBe(
        '/root/private-project',
      );
      expect(fixture.request()).toMatchObject({
        version: 1,
        action: 'canonicalize',
        path: '/root/private-project',
        kind: 'directory',
      });
      expect(Object.keys(fixture.request() as object).sort()).toEqual([
        'action',
        'kind',
        'path',
        'requestId',
        'version',
      ]);
    } finally {
      await fixture.close();
    }
  });

  it('preserves safe path errors and rejects malformed responses', async () => {
    const denied = await brokerFixture({
      ok: false,
      error: { code: 'PATH_OUTSIDE_ROOTS', message: 'Path is not allowed' },
    });
    try {
      await expect(denied.client.canonicalize('/outside', 'existing')).rejects.toBeInstanceOf(
        ProjectPathError,
      );
    } finally {
      await denied.close();
    }

    const malformed = await brokerFixture({ ok: true, canonicalPath: 'relative/path' });
    try {
      await expect(malformed.client.canonicalize('/candidate', 'existing')).rejects.toMatchObject({
        code: 'PROJECT_PATH_BROKER_PROTOCOL',
      } satisfies Partial<ProjectPathBrokerError>);
    } finally {
      await malformed.close();
    }

    const extended = await brokerFixture({
      ok: true,
      canonicalPath: '/candidate',
      unexpected: 'field',
    });
    try {
      await expect(extended.client.canonicalize('/candidate', 'existing')).rejects.toMatchObject({
        code: 'PROJECT_PATH_BROKER_PROTOCOL',
      } satisfies Partial<ProjectPathBrokerError>);
    } finally {
      await extended.close();
    }
  });
});
