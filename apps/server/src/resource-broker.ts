import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { z } from 'zod';

const brokerSnapshotSchema = z.object({
  capacity: z.object({
    cpuQuotaPercent: z.number().int().positive(),
    memoryBytes: z.number().int().positive(),
    memoryAvailableBytes: z.number().int().nonnegative(),
    tasks: z.number().int().positive(),
    measuredAt: z.string().datetime(),
  }),
  effective: z.object({
    cpuQuotaPercent: z.number().int().positive(),
    memoryMaxBytes: z.number().int().positive(),
    tasksMax: z.number().int().positive(),
  }),
  policy: z.object({
    mode: z.enum(['auto', 'custom']),
    cpuQuotaPercent: z.number().int().positive().nullable(),
    memoryMaxBytes: z.number().int().positive().nullable(),
    tasksMax: z.number().int().positive().nullable(),
  }),
  generation: z.number().int().nonnegative(),
});

const brokerResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), snapshot: brokerSnapshotSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(2_000) }),
  }),
]);

export type BrokerResourceSnapshot = z.infer<typeof brokerSnapshotSchema>;

export interface ResourceBroker {
  snapshot(): Promise<BrokerResourceSnapshot>;
  apply(input: {
    mode: 'auto' | 'custom';
    cpuQuotaPercent: number | null;
    memoryMaxBytes: number | null;
    tasksMax: number | null;
  }): Promise<BrokerResourceSnapshot>;
}

export class ResourceBrokerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ResourceBrokerError';
  }
}

export class UnixResourceBrokerClient implements ResourceBroker {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 5_000,
  ) {}

  snapshot(): Promise<BrokerResourceSnapshot> {
    return this.request({ version: 1, requestId: randomUUID(), action: 'snapshot' });
  }

  apply(input: {
    mode: 'auto' | 'custom';
    cpuQuotaPercent: number | null;
    memoryMaxBytes: number | null;
    tasksMax: number | null;
  }): Promise<BrokerResourceSnapshot> {
    return this.request({ version: 1, requestId: randomUUID(), action: 'apply', ...input });
  }

  private request(payload: Record<string, unknown>): Promise<BrokerResourceSnapshot> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      let settled = false;
      let response = '';
      const finish = (error?: Error, value?: BrokerResourceSnapshot) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value!);
      };
      socket.setTimeout(this.timeoutMs, () =>
        finish(new ResourceBrokerError('RESOURCE_BROKER_TIMEOUT', 'Resource broker timed out')),
      );
      socket.once('error', () =>
        finish(
          new ResourceBrokerError('RESOURCE_BROKER_UNAVAILABLE', 'Resource broker is unavailable'),
        ),
      );
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
        if (Buffer.byteLength(response) > 32_768)
          finish(
            new ResourceBrokerError('RESOURCE_BROKER_PROTOCOL', 'Broker response is too large'),
          );
      });
      socket.once('end', () => {
        try {
          const parsed = brokerResponseSchema.parse(JSON.parse(response) as unknown);
          if (!parsed.ok) finish(new ResourceBrokerError(parsed.error.code, parsed.error.message));
          else finish(undefined, parsed.snapshot);
        } catch {
          finish(new ResourceBrokerError('RESOURCE_BROKER_PROTOCOL', 'Invalid broker response'));
        }
      });
      socket.once('connect', () => socket.end(`${JSON.stringify(payload)}\n`));
    });
  }
}
