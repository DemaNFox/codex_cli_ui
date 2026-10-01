import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class ProjectPathError extends Error {
  constructor(
    readonly code:
      'PATH_NOT_FOUND' | 'PATH_NOT_DIRECTORY' | 'PATH_OUTSIDE_ROOTS' | 'PATH_UNAVAILABLE',
  ) {
    super(code);
  }
}

export interface ProjectPathResolver {
  canonicalize(candidate: string, kind: 'existing' | 'directory'): Promise<string>;
}

const localResolver: ProjectPathResolver = {
  async canonicalize(candidate, kind) {
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      throw new ProjectPathError('PATH_NOT_FOUND');
    }
    if (kind === 'directory' && !(await stat(canonical)).isDirectory())
      throw new ProjectPathError('PATH_NOT_DIRECTORY');
    return canonical;
  },
};

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export class ProjectPathPolicy {
  private constructor(
    readonly roots: readonly string[],
    private readonly resolver: ProjectPathResolver,
  ) {}

  static async create(
    configuredRoots: readonly string[],
    resolver: ProjectPathResolver = localResolver,
  ): Promise<ProjectPathPolicy> {
    const canonicalRoots = await Promise.all(
      configuredRoots.map(async (root) => resolver.canonicalize(root, 'directory')),
    );
    return new ProjectPathPolicy([...new Set(canonicalRoots)].sort(), resolver);
  }

  async canonicalize(candidate: string): Promise<string> {
    return this.resolve(candidate, 'directory');
  }

  async canonicalizeExisting(candidate: string): Promise<string> {
    return this.resolve(candidate, 'existing');
  }

  private async resolve(candidate: string, kind: 'existing' | 'directory'): Promise<string> {
    const canonical = await this.resolver.canonicalize(candidate, kind);
    if (!this.roots.some((root) => contains(root, canonical))) {
      throw new ProjectPathError('PATH_OUTSIDE_ROOTS');
    }
    return canonical;
  }
}
