import { codexUpdateSnapshotSchema, type CodexUpdateSnapshot } from '@codex-web/contracts';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { z } from 'zod';

const brokerResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), snapshot: codexUpdateSnapshotSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(2_000) }),
  }),
]);

export interface CodexUpdateBroker {
  status(): Promise<CodexUpdateSnapshot>;
  apply(): Promise<CodexUpdateSnapshot>;
}

export class CodexUpdateBrokerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CodexUpdateBrokerError';
  }
}

export class UnixCodexUpdateBrokerClient implements CodexUpdateBroker {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 5_000,
  ) {}

  status(): Promise<CodexUpdateSnapshot> {
    return this.request('status');
  }

  apply(): Promise<CodexUpdateSnapshot> {
    return this.request('apply');
  }

  private request(action: 'status' | 'apply'): Promise<CodexUpdateSnapshot> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      let settled = false;
      let response = '';
      const finish = (error?: Error, value?: CodexUpdateSnapshot) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value!);
      };
      socket.setTimeout(this.timeoutMs, () =>
        finish(new CodexUpdateBrokerError('CODEX_UPDATE_TIMEOUT', 'Codex update broker timed out')),
      );
      socket.once('error', () =>
        finish(
          new CodexUpdateBrokerError(
            'CODEX_UPDATE_UNAVAILABLE',
            'Codex update broker is unavailable',
          ),
        ),
      );
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
        if (Buffer.byteLength(response) > 32_768)
          finish(
            new CodexUpdateBrokerError(
              'CODEX_UPDATE_PROTOCOL',
              'Codex update broker response is too large',
            ),
          );
      });
      socket.once('end', () => {
        try {
          const parsed = brokerResponseSchema.parse(JSON.parse(response) as unknown);
          if (!parsed.ok)
            finish(new CodexUpdateBrokerError(parsed.error.code, parsed.error.message));
          else finish(undefined, parsed.snapshot);
        } catch {
          finish(
            new CodexUpdateBrokerError(
              'CODEX_UPDATE_PROTOCOL',
              'Invalid Codex update broker response',
            ),
          );
        }
      });
      socket.once('connect', () =>
        socket.end(`${JSON.stringify({ version: 1, requestId: randomUUID(), action })}\n`),
      );
    });
  }
}
