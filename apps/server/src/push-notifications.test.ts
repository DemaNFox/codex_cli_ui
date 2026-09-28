import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PUSH_STORAGE_LIMITS, PushStorageLimitError, SqliteRepository } from './database.js';
import {
  PushNotificationDispatcher,
  isAllowedPushEndpoint,
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
  it('allows only browser push-provider endpoints without local or arbitrary hosts', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/token')).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/token')).toBe(
      true,
    );
    expect(isAllowedPushEndpoint('https://web.push.apple.com/QH/test')).toBe(true);
    expect(isAllowedPushEndpoint('https://db5.notify.windows.com/w/?token=test')).toBe(true);
    for (const endpoint of [
      'https://127.0.0.1/push',
      'https://[::1]/push',
      'https://localhost/push',
      'https://example.com/push',
      'https://evil-notify.windows.com/push',
      'https://fcm.googleapis.com:8443/push',
    ])
      expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  it('purges unsafe legacy endpoints before applying startup storage caps', async () => {
    const temporaryPath = await mkdtemp(path.join(os.tmpdir(), 'codex-push-sanitize-'));
    temporaryPaths.push(temporaryPath);
    const databasePath = path.join(temporaryPath, 'state.sqlite3');
    const firstRepository = new SqliteRepository(databasePath, 100);
    seedThread(firstRepository, 'thread-sanitize');
    const allowedEndpoint = 'https://fcm.googleapis.com/older-valid-device';
    firstRepository.upsertPushSubscription('thread-sanitize', {
      endpoint: allowedEndpoint,
      expirationTime: null,
      keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
    });
    const insertSubscription = firstRepository.database.prepare(
      `INSERT INTO push_subscriptions(
         id,endpoint,expiration_time,p256dh,auth,created_at,updated_at
       ) VALUES(?,?,NULL,?,?,?,?)`,
    );
    const insertMapping = firstRepository.database.prepare(
      `INSERT INTO thread_push_subscriptions(thread_id,subscription_id,created_at)
       VALUES('thread-sanitize',?,?)`,
    );
    for (let index = 0; index < 64; index += 1) {
      const id = `unsafe-${index}`;
      const createdAt = `2099-01-01T00:00:${String(index).padStart(2, '0')}.000Z`;
      insertSubscription.run(
        id,
        `https://unsafe-${index}.example.test/push`,
        'p'.repeat(65),
        'a'.repeat(24),
        createdAt,
        createdAt,
      );
      if (index < 16) insertMapping.run(id, createdAt);
    }
    firstRepository.close();

    const sanitized = new SqliteRepository(databasePath, 100);
    try {
      expect(sanitized.hasPushSubscription('thread-sanitize', allowedEndpoint)).toBe(true);
      expect(
        sanitized.database.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get(),
      ).toEqual({ count: 1 });
      expect(
        sanitized.database.prepare('SELECT COUNT(*) AS count FROM thread_push_subscriptions').get(),
      ).toEqual({ count: 1 });
    } finally {
      sanitized.close();
    }
  });

  it('resumes a durable pending delivery when a new dispatcher starts', async () => {
    const temporaryPath = await mkdtemp(path.join(os.tmpdir(), 'codex-push-replay-'));
    temporaryPaths.push(temporaryPath);
    const databasePath = path.join(temporaryPath, 'state.sqlite3');
    const firstRepository = new SqliteRepository(databasePath, 100);
    seedThread(firstRepository, 'thread-replay');
    firstRepository.upsertPushSubscription('thread-replay', {
      endpoint: 'https://fcm.googleapis.com/replayed-device',
      expirationTime: null,
      keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
    });
    firstRepository.enqueuePushDeliveries('thread-replay', 'turn-replay', {
      threadId: 'thread-replay',
      status: 'completed',
    });
    expect(
      firstRepository.database.prepare('SELECT payload_json FROM push_deliveries').get(),
    ).toEqual({ payload_json: '{"status":"completed"}' });
    firstRepository.database.prepare('UPDATE push_deliveries SET payload_json=?').run(
      JSON.stringify({
        threadId: 'thread-replay',
        threadName: 'Private legacy title',
        status: 'failed',
      }),
    );
    firstRepository.close();

    const deliveries: PushNotificationPayload[] = [];
    const sender: PushSender = {
      send(_subscription, payload) {
        deliveries.push(payload);
        return Promise.resolve();
      },
    };
    const secondRepository = new SqliteRepository(databasePath, 100);
    expect(
      secondRepository.database.prepare('SELECT payload_json FROM push_deliveries').get(),
    ).toEqual({ payload_json: '{"status":"failed"}' });
    const dispatcher = new PushNotificationDispatcher(secondRepository, sender);
    try {
      dispatcher.start();
      await vi.waitFor(() => expect(deliveries).toHaveLength(1));
      expect(deliveries[0]).toEqual({
        threadId: 'thread-replay',
        status: 'failed',
      });
    } finally {
      await dispatcher.close();
      secondRepository.close();
    }
  });

  it('drains more than one batch and permanently deduplicates successful replay', async () => {
    const repository = new SqliteRepository(':memory:', 100);
    for (let index = 0; index < 21; index += 1) {
      const threadId = `thread-batch-${index}`;
      seedThread(repository, threadId);
      repository.upsertPushSubscription(threadId, {
        endpoint: `https://fcm.googleapis.com/device-${index}`,
        expirationTime: null,
        keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
      });
      repository.enqueuePushDeliveries(threadId, 'turn-batch', {
        threadId,
        status: 'completed',
      });
    }
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
        repository.enqueuePushDeliveries('thread-batch-0', 'turn-batch', {
          threadId: 'thread-batch-0',
          status: 'completed',
        }),
      ).toEqual({ enqueued: 0, dropped: 0 });
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
      endpoint: 'https://fcm.googleapis.com/shared-device',
      expirationTime: null,
      keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
    };
    repository.upsertPushSubscription('thread-one', subscription);
    repository.upsertPushSubscription('thread-two', subscription);
    repository.enqueuePushDeliveries('thread-one', 'turn-unsubscribe', {
      threadId: 'thread-one',
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

  it('atomically caps subscriptions, mappings, pending work and receipts', () => {
    const repository = new SqliteRepository(':memory:', 100);
    for (let threadIndex = 0; threadIndex < 65; threadIndex += 1)
      seedThread(repository, `thread-limit-${threadIndex}`);

    for (let index = 0; index < PUSH_STORAGE_LIMITS.mappingsPerThread; index += 1) {
      repository.upsertPushSubscription('thread-limit-0', {
        endpoint: `https://fcm.googleapis.com/thread-cap-${index}`,
        expirationTime: null,
        keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
      });
    }
    expect(() =>
      repository.upsertPushSubscription('thread-limit-0', {
        endpoint: 'https://fcm.googleapis.com/thread-cap-overflow',
        expirationTime: null,
        keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
      }),
    ).toThrow(PushStorageLimitError);

    for (let index = PUSH_STORAGE_LIMITS.mappingsPerThread; index < 64; index += 1) {
      const threadIndex = Math.floor(index / PUSH_STORAGE_LIMITS.mappingsPerThread);
      repository.upsertPushSubscription(`thread-limit-${threadIndex}`, {
        endpoint: `https://fcm.googleapis.com/global-cap-${index}`,
        expirationTime: null,
        keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
      });
    }
    expect(() =>
      repository.upsertPushSubscription('thread-limit-4', {
        endpoint: 'https://fcm.googleapis.com/global-cap-overflow',
        expirationTime: null,
        keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
      }),
    ).toThrow(PushStorageLimitError);

    for (let turn = 0; turn < 5; turn += 1) {
      const result = repository.enqueuePushDeliveries('thread-limit-0', `turn-cap-${turn}`, {
        threadId: 'thread-limit-0',
        status: 'completed',
      });
      expect(result).toEqual(
        turn < 4 ? { enqueued: 16, dropped: 0 } : { enqueued: 0, dropped: 16 },
      );
    }
    expect(
      repository.database.prepare('SELECT COUNT(*) AS count FROM push_deliveries').get(),
    ).toEqual({ count: PUSH_STORAGE_LIMITS.pendingPerThread });

    repository.database.prepare('DELETE FROM push_deliveries').run();
    for (let turn = 0; turn <= PUSH_STORAGE_LIMITS.receiptsPerThread; turn += 1) {
      repository.enqueuePushDeliveries('thread-limit-0', `receipt-${turn}`, {
        threadId: 'thread-limit-0',
        status: 'completed',
      });
      for (const delivery of repository.claimDuePushDeliveries(20))
        repository.completePushDelivery(delivery.id);
    }
    expect(
      repository.database
        .prepare('SELECT COUNT(*) AS count FROM push_delivery_receipts WHERE thread_id=?')
        .get('thread-limit-0'),
    ).toEqual({ count: PUSH_STORAGE_LIMITS.receiptsPerThread });

    repository.close();

    const queueRepository = new SqliteRepository(':memory:', 100);
    for (let threadIndex = 0; threadIndex < 65; threadIndex += 1)
      seedThread(queueRepository, `queue-thread-${threadIndex}`);
    for (let mappingIndex = 0; mappingIndex < 16; mappingIndex += 1) {
      queueRepository.upsertPushSubscription('queue-thread-0', {
        endpoint: `https://fcm.googleapis.com/queue-device-${mappingIndex}`,
        expirationTime: null,
        keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
      });
    }
    for (let threadIndex = 0; threadIndex < 64; threadIndex += 1) {
      for (let mappingIndex = 0; mappingIndex < 16; mappingIndex += 1) {
        queueRepository.upsertPushSubscription(`queue-thread-${threadIndex}`, {
          endpoint: `https://fcm.googleapis.com/queue-device-${mappingIndex}`,
          expirationTime: null,
          keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
        });
      }
      expect(
        queueRepository.enqueuePushDeliveries(
          `queue-thread-${threadIndex}`,
          `global-pending-${threadIndex}`,
          { threadId: `queue-thread-${threadIndex}`, status: 'completed' },
        ),
      ).toEqual({ enqueued: 16, dropped: 0 });
    }
    queueRepository.upsertPushSubscription('queue-thread-64', {
      endpoint: 'https://fcm.googleapis.com/queue-device-0',
      expirationTime: null,
      keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
    });
    expect(
      queueRepository.enqueuePushDeliveries('queue-thread-64', 'global-overflow', {
        threadId: 'queue-thread-64',
        status: 'completed',
      }),
    ).toEqual({ enqueued: 0, dropped: 1 });
    expect(
      queueRepository.database.prepare('SELECT COUNT(*) AS count FROM push_deliveries').get(),
    ).toEqual({ count: PUSH_STORAGE_LIMITS.pendingGlobal });
    queueRepository.close();
  });

  it('aborts and awaits an active send before close returns', async () => {
    const repository = new SqliteRepository(':memory:', 100);
    seedThread(repository, 'thread-close');
    repository.upsertPushSubscription('thread-close', {
      endpoint: 'https://fcm.googleapis.com/hanging-device',
      expirationTime: null,
      keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) },
    });
    repository.enqueuePushDeliveries('thread-close', 'turn-close', {
      threadId: 'thread-close',
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
