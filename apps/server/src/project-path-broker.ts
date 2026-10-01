import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { z } from 'zod';

import { ProjectPathError, type ProjectPathResolver } from './path-policy.js';

const responseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      canonicalPath: z.string().startsWith('/').max(4_096),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.string().min(1).max(120),
          message: z.string().min(1).max(512),
        })
        .strict(),
    })
    .strict(),
]);

const pathErrorCodes = new Set([
  'PATH_NOT_FOUND',
  'PATH_NOT_DIRECTORY',
  'PATH_OUTSIDE_ROOTS',
  'PATH_UNAVAILABLE',
]);

export class ProjectPathBrokerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ProjectPathBrokerError';
  }
}

export class UnixProjectPathBrokerClient implements ProjectPathResolver {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 5_000,
  ) {}

  canonicalize(candidate: string, kind: 'existing' | 'directory'): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      let settled = false;
      let response = '';
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value!);
      };
      socket.setTimeout(this.timeoutMs, () =>
        finish(new ProjectPathBrokerError('PROJECT_PATH_BROKER_TIMEOUT')),
      );
      socket.once('error', () =>
        finish(new ProjectPathBrokerError('PROJECT_PATH_BROKER_UNAVAILABLE')),
      );
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
        if (Buffer.byteLength(response) > 8_192)
          finish(new ProjectPathBrokerError('PROJECT_PATH_BROKER_PROTOCOL'));
      });
      socket.once('end', () => {
        try {
          const parsed = responseSchema.parse(JSON.parse(response) as unknown);
          if (parsed.ok) finish(undefined, parsed.canonicalPath);
          else if (pathErrorCodes.has(parsed.error.code))
            finish(new ProjectPathError(parsed.error.code as ProjectPathError['code']));
          else finish(new ProjectPathBrokerError('PROJECT_PATH_BROKER_PROTOCOL'));
        } catch {
          finish(new ProjectPathBrokerError('PROJECT_PATH_BROKER_PROTOCOL'));
        }
      });
      socket.once('connect', () =>
        socket.end(
          `${JSON.stringify({
            version: 1,
            requestId: randomUUID(),
            action: 'canonicalize',
            path: candidate,
            kind,
          })}\n`,
        ),
      );
    });
  }
}
