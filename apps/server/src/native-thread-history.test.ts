import { describe, expect, it, vi } from 'vitest';

import {
  findNativeClientMessageEvidence,
  readNativeThreadHistory,
  readNativeTurnHead,
} from './native-thread-history.js';

const turn = (id: string) => ({ id, status: 'completed', items: [], itemsView: 'full' });

describe('native thread history pagination', () => {
  it('reads every page in native descending order and returns chronological turns', async () => {
    const request = vi.fn((_method: string, params: unknown) => {
      const cursor = (params as { cursor?: string }).cursor;
      return Promise.resolve(
        cursor === undefined
          ? { data: [turn('third'), turn('second')], nextCursor: 'opaque-next' }
          : { data: [turn('first')], nextCursor: null },
      );
    });
    const result = await readNativeThreadHistory({ request }, 'thread-1');
    expect(result).toEqual([turn('first'), turn('second'), turn('third')]);
    expect(request).toHaveBeenNthCalledWith(1, 'thread/turns/list', {
      threadId: 'thread-1',
      sortDirection: 'desc',
      itemsView: 'full',
      limit: 25,
    });
    expect(request).toHaveBeenNthCalledWith(2, 'thread/turns/list', {
      threadId: 'thread-1',
      sortDirection: 'desc',
      itemsView: 'full',
      limit: 25,
      cursor: 'opaque-next',
    });
  });

  it('rejects summary-only turns instead of silently losing messages', async () => {
    const request = vi.fn(() =>
      Promise.resolve({
        data: [{ ...turn('first'), itemsView: 'summary' }],
        nextCursor: null,
      }),
    );
    await expect(readNativeThreadHistory({ request }, 'thread-1')).rejects.toThrow(
      'NATIVE_HISTORY_ITEMS_INCOMPLETE',
    );
  });

  it('rejects a repeated cursor rather than looping indefinitely', async () => {
    const request = vi.fn(() => Promise.resolve({ data: [turn('first')], nextCursor: 'same' }));
    await expect(readNativeThreadHistory({ request }, 'thread-1')).rejects.toThrow(
      'NATIVE_HISTORY_DUPLICATE_TURN',
    );
  });

  it('reads only a metadata head to recover the current turn id', async () => {
    const request = vi.fn(() =>
      Promise.resolve({
        data: [
          { ...turn('active'), status: 'inProgress', items: [], itemsView: 'notLoaded' },
          { ...turn('older'), status: 'completed', items: [], itemsView: 'notLoaded' },
        ],
        nextCursor: 'older-turns',
      }),
    );
    expect(await readNativeTurnHead({ request }, 'thread-1')).toEqual([
      { ...turn('older'), status: 'completed', items: [], itemsView: 'notLoaded' },
      { ...turn('active'), status: 'inProgress', items: [], itemsView: 'notLoaded' },
    ]);
    expect(request).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'thread-1',
      sortDirection: 'desc',
      itemsView: 'notLoaded',
      limit: 25,
    });
  });

  it('finds an exact client message on an older page without retaining the full history', async () => {
    const request = vi.fn((_method: string, params: unknown) => {
      const cursor = (params as { cursor?: string }).cursor;
      return Promise.resolve(
        cursor === undefined
          ? { data: [turn('recent')], nextCursor: 'older' }
          : {
              data: [
                {
                  id: 'matching',
                  status: 'inProgress',
                  itemsView: 'full',
                  items: [{ type: 'userMessage', clientId: 'exact-key' }],
                },
              ],
              nextCursor: 'not-needed',
            },
      );
    });
    expect(await findNativeClientMessageEvidence({ request }, 'thread-1', 'exact-key')).toEqual({
      turnId: 'matching',
      matchingTurnIsInProgress: true,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete pages before it can claim a client message is absent', async () => {
    const request = vi.fn(() =>
      Promise.resolve({ data: [{ ...turn('older'), itemsView: 'summary' }], nextCursor: null }),
    );
    await expect(findNativeClientMessageEvidence({ request }, 'thread-1', 'key')).rejects.toThrow(
      'NATIVE_HISTORY_ITEMS_INCOMPLETE',
    );
  });
});
