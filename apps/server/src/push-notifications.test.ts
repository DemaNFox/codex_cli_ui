import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SqliteRepository } from './database.js';
import {
  PushNotificationDispatcher,
  type PushNotificationPayload,
  type PushSender,
} from './push-notifications.js';

const temporaryPaths: string[] = [];

function seedThread(repository: SqliteRepository, threadId: string): void {
  const project = repository.createProject({
    name: `Project ${threadId}`,
    path: `/srv/${threadId}`,
    defaultModel: null,
    defaultReasoningEffort: null,
    defaultPermissionPreset: 'workspace-write',
  });
  repository.upsertThread({
    id: threadId,
    projectId: project.id,
    name: 'Replay chat',
    preview: '',
    model: null,
    status: 'idle',
    activeTurnId: null,
    archived: false,
    instructionSources: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((temporaryPath) => rm(temporaryPath, { recursive: true })),
  );
});

describe('push notification dispatcher', () => {
  it('resumes a durable pending delivery when a new dispatcher starts', async () => {
    const temporaryPath = await mkdtemp(path.join(os.tmpdir(), 'codex-push-replay-'));
    temporaryPaths.push(temporaryPath);
    const databasePath = path.join(temporaryPath, 'state.sqlite3');
    const firstRepository = new SqliteRepository(databasePath, 100);
    seedThread(firstRepository, 'thread-replay');
    firstRepository.upsertPushSubscription('thread-replay', {
      endpoint: 'https://push.example.test/replayed-device',
      expirationTime: null,
      keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
    });
    firstRepository.enqueuePushDeliveries('thread-replay', 'turn-replay', {
      threadId: 'thread-replay',
      threadName: 'Replay chat',
      status: 'completed',
    });
    firstRepository.close();

    const deliveries: PushNotificationPayload[] = [];
    const sender: PushSender = {
      send(_subscription, payload) {
        deliveries.push(payload);
        return Promise.resolve();
      },
    };
    const secondRepository = new SqliteRepository(databasePath, 100);
    const dispatcher = new PushNotificationDispatcher(secondRepository, sender);
    try {
      dispatcher.start();
      await vi.waitFor(() => expect(deliveries).toHaveLength(1));
      expect(deliveries[0]).toEqual({
        threadId: 'thread-replay',
        threadName: 'Replay chat',
        status: 'completed',
      });
    } finally {
      await dispatcher.close();
      secondRepository.close();
    }
  });

  it('drains more than one batch and permanently deduplicates successful replay', async () => {
    const repository = new SqliteRepository(':memory:', 100);
    seedThread(repository, 'thread-batch');
    for (let index = 0; index < 21; index += 1) {
      repository.upsertPushSubscription('thread-batch', {
        endpoint: `https://push.example.test/device-${index}`,
        expirationTime: null,
        keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
      });
    }
    repository.enqueuePushDeliveries('thread-batch', 'turn-batch', {
      threadId: 'thread-batch',
      threadName: 'Batch chat',
      status: 'completed',
    });
    let delivered = 0;
    const dispatcher = new PushNotificationDispatcher(repository, {
      send() {
        delivered += 1;
        return Promise.resolve();
      },
    });
    try {
      dispatcher.start();
      await vi.waitFor(() => expect(delivered).toBe(21));
      expect(
        repository.enqueuePushDeliveries('thread-batch', 'turn-batch', {
          threadId: 'thread-batch',
          threadName: 'Batch chat',
          status: 'completed',
        }),
      ).toBe(0);
    } finally {
      await dispatcher.close();
      repository.close();
    }
  });

  it('purges exhausted deliveries and queued work for a per-thread unsubscribe', () => {
    const repository = new SqliteRepository(':memory:', 100);
    seedThread(repository, 'thread-one');
    seedThread(repository, 'thread-two');
    const subscription = {
      endpoint: 'https://push.example.test/shared-device',
      expirationTime: null,
      keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
    };
    repository.upsertPushSubscription('thread-one', subscription);
    repository.upsertPushSubscription('thread-two', subscription);
    repository.enqueuePushDeliveries('thread-one', 'turn-unsubscribe', {
      threadId: 'thread-one',
      threadName: 'One',
      status: 'failed',
    });
    const claimedBeforeUnsubscribe = repository.claimDuePushDeliveries(1)[0]!;
    repository.removeThreadPushSubscription('thread-one', subscription.endpoint);
    expect(repository.isPushDeliveryActive(claimedBeforeUnsubscribe.id)).toBe(false);
    expect(
      repository.database.prepare('SELECT COUNT(*) AS count FROM push_deliveries').get(),
    ).toEqual({ count: 0 });
    expect(repository.hasPushSubscription('thread-two', subscription.endpoint)).toBe(true);

    repository.upsertPushSubscription('thread-one', subscription);
    repository.enqueuePushDeliveries('thread-one', 'turn-exhausted', {
      threadId: 'thread-one',
      threadName: 'One',
      status: 'failed',
    });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const delivery = repository.claimDuePushDeliveries(1)[0];
      expect(delivery?.attempt).toBe(attempt);
      if (attempt < 5) repository.failPushDelivery(delivery!.id);
      repository.database.prepare('UPDATE push_deliveries SET next_attempt_at=0').run();
    }
    expect(repository.purgeExhaustedPushDeliveries()).toBe(1);
    expect(
      repository.database.prepare('SELECT COUNT(*) AS count FROM push_deliveries').get(),
    ).toEqual({ count: 0 });
    repository.close();
  });

  it('aborts and awaits an active send before close returns', async () => {
    const repository = new SqliteRepository(':memory:', 100);
    seedThread(repository, 'thread-close');
    repository.upsertPushSubscription('thread-close', {
      endpoint: 'https://push.example.test/hanging-device',
      expirationTime: null,
      keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
    });
    repository.enqueuePushDeliveries('thread-close', 'turn-close', {
      threadId: 'thread-close',
      threadName: 'Close chat',
      status: 'completed',
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let settled = false;
    const dispatcher = new PushNotificationDispatcher(repository, {
      send(_subscription, _payload, signal) {
        entered();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              settled = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      },
    });
    dispatcher.start();
    await started;
    await dispatcher.close();
    expect(settled).toBe(true);
    expect(() => repository.database.prepare('SELECT 1').get()).not.toThrow();
    repository.close();
  });
});
