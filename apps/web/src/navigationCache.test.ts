import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearNavigationCache,
  readNavigationCache,
  writeNavigationCache,
} from './navigationCache.js';

describe('saved navigation cache', () => {
  beforeEach(() => clearNavigationCache());

  it('restores bounded titles only for the authenticated account and clears on sign-out', () => {
    const navigation = {
      projects: [{ id: 'project-1', name: 'Project' }],
      threads: [{ id: 'thread-1', projectId: 'project-1', name: 'Chat' }],
    } as Parameters<typeof writeNavigationCache>[1];
    writeNavigationCache('owner', navigation);
    expect(readNavigationCache('owner')).toEqual(navigation);
    expect(readNavigationCache('other')).toBeNull();
    clearNavigationCache();
    expect(readNavigationCache('owner')).toBeNull();
  });

  it('ignores corrupt data', () => {
    localStorage.setItem('codex-web-ui-navigation-v1', '{broken');
    expect(readNavigationCache('owner')).toBeNull();
  });
});
