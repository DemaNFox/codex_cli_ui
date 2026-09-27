import { userInputQuestionSchema, type UserInputQuestion } from '@codex-web/contracts';
import path from 'node:path';

import { sanitizePublicText } from './event-normalizer.js';
import type { ProjectPathPolicy } from './path-policy.js';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
}

export interface UserInputRequestDetails {
  readonly itemId: string;
  readonly isBlocking: boolean;
  readonly questions: UserInputQuestion[];
}

export interface PermissionRequestDetails {
  readonly itemId: string;
  readonly cwd: string;
  readonly reason: string | null;
  readonly permissions: Record<string, unknown>;
}

export function normalizePermissionRequest(params: unknown):
  | (Omit<PermissionRequestDetails, 'permissions'> & {
      threadId: string;
      turnId: string;
      permissions: unknown;
    })
  | null {
  const source = record(params);
  if (
    !source ||
    !exactKeys(source, [
      'cwd',
      'environmentId',
      'itemId',
      'permissions',
      'reason',
      'startedAtMs',
      'threadId',
      'turnId',
    ]) ||
    typeof source.cwd !== 'string' ||
    typeof source.itemId !== 'string' ||
    !('permissions' in source) ||
    typeof source.threadId !== 'string' ||
    typeof source.turnId !== 'string' ||
    (source.environmentId !== null &&
      source.environmentId !== undefined &&
      typeof source.environmentId !== 'string') ||
    !Number.isSafeInteger(source.startedAtMs) ||
    Number(source.startedAtMs) < 0 ||
    (source.reason !== null && source.reason !== undefined && typeof source.reason !== 'string')
  ) {
    return null;
  }
  return {
    threadId: source.threadId,
    turnId: source.turnId,
    itemId: source.itemId,
    cwd: source.cwd,
    reason: typeof source.reason === 'string' ? sanitizePublicText(source.reason, 4_000) : null,
    permissions: source.permissions,
  };
}

export function normalizeUserInputRequest(
  params: unknown,
): (UserInputRequestDetails & { threadId: string; turnId: string }) | null {
  const source = record(params);
  if (
    !source ||
    !exactKeys(source, [
      'autoResolutionMs',
      'isBlocking',
      'itemId',
      'questions',
      'threadId',
      'turnId',
    ]) ||
    typeof source.threadId !== 'string' ||
    typeof source.turnId !== 'string' ||
    typeof source.itemId !== 'string' ||
    typeof source.isBlocking !== 'boolean' ||
    !Array.isArray(source.questions) ||
    source.questions.length === 0 ||
    source.questions.length > 20
  ) {
    return null;
  }
  const questions: UserInputQuestion[] = [];
  const ids = new Set<string>();
  for (const value of source.questions) {
    const question = record(value);
    if (
      !question ||
      !exactKeys(question, ['id', 'header', 'question', 'options', 'isOther', 'isSecret']) ||
      typeof question.id !== 'string' ||
      question.id.length === 0 ||
      question.id.length > 200 ||
      ids.has(question.id) ||
      typeof question.header !== 'string' ||
      typeof question.question !== 'string' ||
      question.question.length === 0 ||
      (question.isOther !== undefined && typeof question.isOther !== 'boolean') ||
      (question.isSecret !== undefined && typeof question.isSecret !== 'boolean')
    ) {
      return null;
    }
    let options: UserInputQuestion['options'] = null;
    if (question.options !== null && question.options !== undefined) {
      if (!Array.isArray(question.options) || question.options.length > 20) return null;
      const labels = new Set<string>();
      options = [];
      for (const valueOption of question.options) {
        const option = record(valueOption);
        if (
          !option ||
          !exactKeys(option, ['label', 'description']) ||
          typeof option.label !== 'string' ||
          typeof option.description !== 'string'
        ) {
          return null;
        }
        const label = sanitizePublicText(option.label, 500);
        if (labels.has(label)) return null;
        labels.add(label);
        options.push({
          label,
          description: sanitizePublicText(option.description, 2_000),
        });
      }
    }
    ids.add(question.id);
    questions.push(
      userInputQuestionSchema.parse({
        id: question.id,
        header: sanitizePublicText(question.header, 200),
        question: sanitizePublicText(question.question, 4_000),
        options,
        isOther: question.isOther === true,
        isSecret: question.isSecret === true,
      }),
    );
  }
  return {
    threadId: source.threadId,
    turnId: source.turnId,
    itemId: source.itemId,
    isBlocking: source.isBlocking,
    questions,
  };
}

export function validateUserInputAnswers(
  request: UserInputRequestDetails,
  answers: Record<string, { answers: string[] }>,
): boolean {
  const answerIds = Object.keys(answers).sort();
  const questionIds = request.questions.map((question) => question.id).sort();
  if (answerIds.length !== questionIds.length) return false;
  if (answerIds.some((id, index) => id !== questionIds[index])) return false;
  for (const question of request.questions) {
    const values = answers[question.id]?.answers;
    if (!values || new Set(values).size !== values.length) return false;
    if (request.isBlocking && values.length === 0) return false;
    if (question.options === null) {
      if (values.length > 1) return false;
      continue;
    }
    const labels = new Set(question.options.map((option) => option.label));
    const custom = values.filter((value) => !labels.has(value));
    if ((!question.isOther && custom.length > 0) || custom.length > 1) return false;
  }
  return true;
}

async function canonicalPermissionPath(
  value: string,
  cwd: string,
  pathPolicy: ProjectPathPolicy,
): Promise<string> {
  if (/[?*[\]{}]/.test(value)) throw new Error('PERMISSION_GLOB_DENIED');
  const candidate = path.resolve(path.isAbsolute(value) ? value : path.resolve(cwd, value));
  const lexicalRelative = path.relative(cwd, candidate);
  if (
    lexicalRelative === '..' ||
    lexicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(lexicalRelative)
  )
    throw new Error('PERMISSION_PATH_OUTSIDE_PROJECT');
  try {
    const canonical = await pathPolicy.canonicalizeExisting(candidate);
    const relative = path.relative(cwd, canonical);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('PERMISSION_PATH_OUTSIDE_PROJECT');
    return canonical;
  } catch {
    throw new Error('PERMISSION_PATH_NOT_EXISTING_OR_SAFE');
  }
}

async function canonicalPathList(
  value: unknown,
  cwd: string,
  pathPolicy: ProjectPathPolicy,
): Promise<string[] | null | undefined> {
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value) || value.length > 50) throw new Error('PERMISSION_PATHS_INVALID');
  const paths = value.filter((item): item is string => typeof item === 'string');
  if (paths.length !== value.length) throw new Error('PERMISSION_PATHS_INVALID');
  return Promise.all(paths.map(async (item) => canonicalPermissionPath(item, cwd, pathPolicy)));
}

export async function validatePermissionProfile(
  value: unknown,
  cwd: string,
  pathPolicy: ProjectPathPolicy,
): Promise<Record<string, unknown>> {
  const permissions = record(value);
  if (!permissions || !exactKeys(permissions, ['fileSystem', 'network']))
    throw new Error('PERMISSIONS_INVALID');
  const output: Record<string, unknown> = {};

  if (permissions.fileSystem !== undefined) {
    if (permissions.fileSystem === null) output.fileSystem = null;
    else {
      const fileSystem = record(permissions.fileSystem);
      if (
        !fileSystem ||
        !exactKeys(fileSystem, ['entries', 'globScanMaxDepth', 'read', 'write']) ||
        fileSystem.globScanMaxDepth !== undefined
      ) {
        throw new Error('PERMISSION_FILESYSTEM_INVALID');
      }
      const normalized: Record<string, unknown> = {};
      if (fileSystem.read !== undefined)
        normalized.read = await canonicalPathList(fileSystem.read, cwd, pathPolicy);
      if (fileSystem.write !== undefined)
        normalized.write = await canonicalPathList(fileSystem.write, cwd, pathPolicy);
      if (fileSystem.entries !== undefined) {
        if (fileSystem.entries === null) normalized.entries = null;
        else {
          if (!Array.isArray(fileSystem.entries) || fileSystem.entries.length > 50)
            throw new Error('PERMISSION_ENTRIES_INVALID');
          normalized.entries = await Promise.all(
            fileSystem.entries.map(async (valueEntry) => {
              const entry = record(valueEntry);
              const permissionPath = record(entry?.path);
              if (
                !entry ||
                !exactKeys(entry, ['access', 'path']) ||
                !['read', 'write', 'deny'].includes(String(entry.access)) ||
                !permissionPath ||
                !exactKeys(permissionPath, ['type', 'path']) ||
                permissionPath.type !== 'path' ||
                typeof permissionPath.path !== 'string'
              ) {
                throw new Error('PERMISSION_ENTRY_UNSAFE');
              }
              return {
                access: entry.access,
                path: {
                  type: 'path',
                  path: await canonicalPermissionPath(permissionPath.path, cwd, pathPolicy),
                },
              };
            }),
          );
        }
      }
      output.fileSystem = normalized;
    }
  }

  if (permissions.network !== undefined) {
    if (permissions.network === null) output.network = null;
    else {
      const network = record(permissions.network);
      if (!network || !exactKeys(network, ['enabled']) || typeof network.enabled !== 'boolean')
        throw new Error('PERMISSION_NETWORK_INVALID');
      output.network = { enabled: network.enabled };
    }
  }
  return output;
}
