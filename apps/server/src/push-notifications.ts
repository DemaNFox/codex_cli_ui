import type { PushSubscriptionInput } from '@codex-web/contracts';
import webPush from 'web-push';
import { request } from 'node:https';

import type { SqliteRepository } from './database.js';

export interface PushNotificationPayload {
  readonly threadId: string;
  readonly threadName: string;
  readonly status: 'completed' | 'interrupted' | 'failed';
}

export interface PushSender {
  send(
    subscription: PushSubscriptionInput,
    payload: PushNotificationPayload,
    signal: AbortSignal,
  ): Promise<void>;
}

export class WebPushSender implements PushSender {
  constructor(publicKey: string, privateKey: string, subject: string) {
    webPush.setVapidDetails(subject, publicKey, privateKey);
  }

  async send(
    subscription: PushSubscriptionInput,
    payload: PushNotificationPayload,
    signal: AbortSignal,
  ): Promise<void> {
    const details = webPush.generateRequestDetails(subscription, JSON.stringify(payload), {
      TTL: 300,
      urgency: 'normal',
    });
    await new Promise<void>((resolve, reject) => {
      const pushRequest = request(
        details.endpoint,
        { method: details.method, headers: details.headers, signal },
        (response) => {
          response.resume();
          if (
            response.statusCode !== undefined &&
            response.statusCode >= 200 &&
            response.statusCode < 300
          ) {
            resolve();
            return;
          }
          reject(
            Object.assign(new Error('Push service rejected the notification'), {
              statusCode: response.statusCode,
            }),
          );
        },
      );
      pushRequest.once('error', reject);
      if (details.body) pushRequest.write(details.body);
      pushRequest.end();
    });
  }
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

export class PushNotificationDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private closed = false;
  private activeDrain: Promise<void> | null = null;
  private activeAbort: AbortController | null = null;

  constructor(
    private readonly repository: SqliteRepository,
    private readonly sender: PushSender,
  ) {}

  start(): void {
    const purged = this.repository.purgeExhaustedPushDeliveries();
    if (purged > 0) this.repository.audit('push.delivery', 'exhausted-purged', { count: purged });
    this.schedule(0);
  }

  enqueue(
    threadId: string,
    turnId: string,
    threadName: string | null,
    status: PushNotificationPayload['status'],
  ): void {
    this.repository.enqueuePushDeliveries(threadId, turnId, {
      threadId,
      threadName: threadName?.trim() || 'Codex chat',
      status,
    });
    this.schedule(0);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.activeAbort?.abort();
    await this.activeDrain;
  }

  private schedule(delayMs: number): void {
    if (this.closed || this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.activeDrain = this.drain().finally(() => {
        this.activeDrain = null;
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      for (const delivery of this.repository.claimDuePushDeliveries(20)) {
        if (this.closed) break;
        if (!this.repository.isPushDeliveryActive(delivery.id)) continue;
        const abort = new AbortController();
        this.activeAbort = abort;
        try {
          await this.sender.send(
            delivery.subscription,
            delivery.payload,
            AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
          );
          this.repository.completePushDelivery(delivery.id);
        } catch (error) {
          const code = statusCode(error);
          if (code === 404 || code === 410) {
            this.repository.removePushSubscriptionGlobally(delivery.subscriptionId);
            this.repository.audit('push.delivery', 'stale-subscription', {
              subscriptionId: delivery.subscriptionId,
              statusCode: code,
            });
          } else {
            this.repository.failPushDelivery(delivery.id);
            this.repository.audit('push.delivery', 'failed', {
              deliveryId: delivery.id,
              attempt: delivery.attempt,
              ...(code === undefined ? {} : { statusCode: code }),
            });
          }
        } finally {
          if (this.activeAbort === abort) this.activeAbort = null;
        }
      }
    } finally {
      this.running = false;
      if (!this.closed) {
        const delay = this.repository.nextPushDeliveryDelayMs();
        if (delay !== null) this.schedule(delay);
      }
    }
  }
}
