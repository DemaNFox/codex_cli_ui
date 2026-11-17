import type { Project, Thread } from '@codex-web/contracts';

import type { SavedNavigation } from './api.js';

const KEY = 'codex-web-ui-navigation-v1';
const MAX_BYTES = 256 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredNavigation {
  username: string;
  savedAt: number;
  projects: Project[];
  threads: Thread[];
}

export function readNavigationCache(username: string): SavedNavigation | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw || raw.length > MAX_BYTES) return null;
    const value = JSON.parse(raw) as Partial<StoredNavigation>;
    if (
      value.username !== username ||
      typeof value.savedAt !== 'number' ||
      Date.now() - value.savedAt > MAX_AGE_MS ||
      !Array.isArray(value.projects) ||
      !Array.isArray(value.threads) ||
      !value.projects.every(
        (item) => item && typeof item.id === 'string' && typeof item.name === 'string',
      ) ||
      !value.threads.every(
        (item) => item && typeof item.id === 'string' && typeof item.projectId === 'string',
      )
    )
      return null;
    return { projects: value.projects, threads: value.threads };
  } catch {
    return null;
  }
}

export function writeNavigationCache(username: string, navigation: SavedNavigation): void {
  try {
    const raw = JSON.stringify({ username, savedAt: Date.now(), ...navigation });
    if (raw.length <= MAX_BYTES) localStorage.setItem(KEY, raw);
  } catch {
    // Browsers can disable storage; server navigation remains available.
  }
}

export function clearNavigationCache(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage may already be unavailable.
  }
}
