import type { SafeEvent } from '@codex-web/contracts';

export const SSE_LIVE_QUEUE_LIMIT = 100;

interface SseWritable {
  write(chunk: string): boolean;
  once(event: 'close' | 'drain' | 'error', listener: () => void): unknown;
  removeListener(event: 'close' | 'drain' | 'error', listener: () => void): unknown;
  destroy(): unknown;
}

function encodeEvent(event: SafeEvent): string {
  return `id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function waitForDrain(raw: SseWritable): Promise<boolean> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      raw.removeListener('drain', onDrain);
      raw.removeListener('close', onClosed);
      raw.removeListener('error', onClosed);
    };
    const onDrain = (): void => {
      cleanup();
      resolve(true);
    };
    const onClosed = (): void => {
      cleanup();
      resolve(false);
    };
    raw.once('drain', onDrain);
    raw.once('close', onClosed);
    raw.once('error', onClosed);
  });
}

export interface SseDelivery {
  readonly closed: boolean;
  deliverComment(comment: string): void;
  deliverLive(event: SafeEvent): void;
  finishReplay(): Promise<void>;
  markClosed(): void;
  writeReplay(event: SafeEvent): Promise<boolean>;
}

export function createSseDelivery(
  raw: SseWritable,
  highWater: number,
  queueLimit = SSE_LIVE_QUEUE_LIMIT,
): SseDelivery {
  let closed = false;
  let replaying = true;
  let flushPromise: Promise<void> | undefined;
  const liveQueue: (SafeEvent | string)[] = [];

  const disconnect = (): void => {
    if (closed) return;
    closed = true;
    liveQueue.length = 0;
    raw.destroy();
  };

  const writeChunk = async (chunk: string): Promise<boolean> => {
    if (closed) return false;
    if (raw.write(chunk)) return true;
    const drained = await waitForDrain(raw);
    if (!drained) closed = true;
    return drained;
  };

  const flush = (): Promise<void> => {
    if (closed || replaying) return Promise.resolve();
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      while (!closed && liveQueue.length > 0) {
        const item = liveQueue.shift()!;
        if (!(await writeChunk(typeof item === 'string' ? item : encodeEvent(item)))) return;
      }
    })().finally(() => {
      flushPromise = undefined;
      if (!closed && !replaying && liveQueue.length > 0) void flush();
    });
    return flushPromise;
  };

  return {
    get closed() {
      return closed;
    },
    deliverComment(comment) {
      if (closed || liveQueue.length > 0) return;
      liveQueue.push(`: ${comment}\n\n`);
      if (!replaying) void flush();
    },
    deliverLive(event) {
      if (closed || event.id <= highWater) return;
      if (liveQueue.length >= queueLimit) {
        disconnect();
        return;
      }
      liveQueue.push(event);
      if (!replaying) void flush();
    },
    async finishReplay() {
      replaying = false;
      await flush();
    },
    markClosed() {
      closed = true;
      liveQueue.length = 0;
    },
    writeReplay(event) {
      return writeChunk(encodeEvent(event));
    },
  };
}
