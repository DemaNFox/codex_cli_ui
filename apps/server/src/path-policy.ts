import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class ProjectPathError extends Error {
  constructor(readonly code: 'PATH_NOT_FOUND' | 'PATH_NOT_DIRECTORY' | 'PATH_OUTSIDE_ROOTS') {
    super(code);
  }
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export class ProjectPathPolicy {
  private constructor(readonly roots: readonly string[]) {}

  static async create(configuredRoots: readonly string[]): Promise<ProjectPathPolicy> {
    const canonicalRoots = await Promise.all(configuredRoots.map(async (root) => realpath(root)));
    for (const root of canonicalRoots) {
      if (!(await stat(root)).isDirectory()) throw new ProjectPathError('PATH_NOT_DIRECTORY');
    }
    return new ProjectPathPolicy([...new Set(canonicalRoots)].sort());
  }

  async canonicalize(candidate: string): Promise<string> {
    const canonical = await this.canonicalizeExisting(candidate);
    if (!(await stat(canonical)).isDirectory()) throw new ProjectPathError('PATH_NOT_DIRECTORY');
    return canonical;
  }

  async canonicalizeExisting(candidate: string): Promise<string> {
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      throw new ProjectPathError('PATH_NOT_FOUND');
    }
    if (!this.roots.some((root) => contains(root, canonical))) {
      throw new ProjectPathError('PATH_OUTSIDE_ROOTS');
    }
    return canonical;
  }
}
