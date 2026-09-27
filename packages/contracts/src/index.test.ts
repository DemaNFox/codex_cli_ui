import { describe, expect, it } from 'vitest';

import {
  createProjectRequestSchema,
  resolvePermissionRequestSchema,
  resolveUserInputRequestSchema,
  startTurnRequestSchema,
} from './index.js';

describe('contracts', () => {
  it('rejects traversal-like empty project values before filesystem policy', () => {
    expect(createProjectRequestSchema.safeParse({ name: '', path: '' }).success).toBe(false);
  });

  it('requires an idempotency key for a turn', () => {
    expect(startTurnRequestSchema.safeParse({ text: 'test' }).success).toBe(false);
  });

  it('bounds typed user-input answers and one-turn permission decisions', () => {
    expect(
      resolveUserInputRequestSchema.safeParse({
        answers: { choice: { answers: ['Safe option'] } },
      }).success,
    ).toBe(true);
    expect(resolvePermissionRequestSchema.parse({ decision: 'grant' }).scope).toBe('turn');
    expect(
      resolvePermissionRequestSchema.safeParse({ decision: 'grant', scope: 'session' }).success,
    ).toBe(false);
  });
});
