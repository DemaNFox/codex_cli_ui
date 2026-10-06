import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(resolve('public/push-service-worker.js'), 'utf8');

async function notificationFor(status) {
  const handlers = {};
  const shown = [];
  const scope = {
    location: { origin: 'https://codex.example' },
    addEventListener(type, handler) {
      handlers[type] = handler;
    },
    registration: {
      async showNotification(title, options) {
        shown.push({ title, options });
      },
    },
    clients: { matchAll: async () => [], openWindow: async () => undefined },
  };
  new Function('self', workerSource)(scope);
  let completion;
  handlers.push({
    data: { json: () => ({ threadId: 'thread-1', status }) },
    waitUntil(promise) {
      completion = promise;
    },
  });
  await completion;
  return shown[0];
}

describe('push service worker', () => {
  it.each([
    ['completed', 'Работа в чате завершена.'],
    ['interrupted', 'Работа в чате остановлена.'],
    ['failed', 'Работа в чате завершилась с ошибкой.'],
    ['unknown', 'Состояние работы в чате изменилось.'],
  ])('uses status-specific copy for %s', async (status, body) => {
    expect(await notificationFor(status)).toEqual({
      title: 'Codex',
      options: {
        body,
        tag: 'codex-thread:thread-1',
        data: { url: '/' },
      },
    });
  });
});
