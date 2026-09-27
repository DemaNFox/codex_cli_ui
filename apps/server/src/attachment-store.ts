import type { Attachment } from '@codex-web/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { HttpError } from './auth.js';

export const MAX_ATTACHMENT_BYTES = 20 * 1_024 * 1_024;
export const MAX_THREAD_ATTACHMENT_BYTES = 50 * 1_024 * 1_024;

const MIME_RULES: Readonly<
  Record<string, { kind: Attachment['kind']; extensions: readonly string[] }>
> = {
  'image/png': { kind: 'image', extensions: ['.png'] },
  'image/jpeg': { kind: 'image', extensions: ['.jpg', '.jpeg'] },
  'image/gif': { kind: 'image', extensions: ['.gif'] },
  'image/webp': { kind: 'image', extensions: ['.webp'] },
  'application/pdf': { kind: 'file', extensions: ['.pdf'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    kind: 'file',
    extensions: ['.docx'],
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    kind: 'file',
    extensions: ['.xlsx'],
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    kind: 'file',
    extensions: ['.pptx'],
  },
  'application/json': { kind: 'file', extensions: ['.json'] },
  'text/plain': {
    kind: 'file',
    extensions: [
      '.txt',
      '.log',
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.py',
      '.rb',
      '.rs',
      '.go',
      '.java',
      '.kt',
      '.c',
      '.h',
      '.cpp',
      '.hpp',
      '.cs',
      '.sh',
      '.ps1',
      '.sql',
      '.toml',
      '.yaml',
      '.yml',
      '.xml',
      '.html',
      '.css',
      '.scss',
      '.env.example',
    ],
  },
  'text/markdown': { kind: 'file', extensions: ['.md', '.markdown'] },
  'text/csv': { kind: 'file', extensions: ['.csv'] },
};

const INFERRED_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MIME_RULES).flatMap(([mimeType, rule]) =>
    rule.extensions.map((extension) => [extension, mimeType]),
  ),
);

export interface ParsedUpload {
  readonly name: string;
  readonly mimeType: string;
  readonly kind: Attachment['kind'];
  readonly bytes: Buffer;
}

function validImageSignature(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/gif') {
    const signature = bytes.subarray(0, 6).toString('ascii');
    if (signature !== 'GIF87a' && signature !== 'GIF89a') return false;
    if (bytes.length < 13) return false;
    let offset = 13;
    const packed = bytes[10]!;
    if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1);
    let frames = 0;
    const skipSubBlocks = (): boolean => {
      while (offset < bytes.length) {
        const length = bytes[offset++]!;
        if (length === 0) return true;
        offset += length;
        if (offset > bytes.length) return false;
      }
      return false;
    };
    while (offset < bytes.length) {
      const marker = bytes[offset++]!;
      if (marker === 0x3b) return frames === 1;
      if (marker === 0x21) {
        offset += 1;
        if (!skipSubBlocks()) return false;
        continue;
      }
      if (marker !== 0x2c || offset + 9 > bytes.length) return false;
      frames += 1;
      const imagePacked = bytes[offset + 8]!;
      offset += 9;
      if ((imagePacked & 0x80) !== 0) offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
      offset += 1;
      if (!skipSubBlocks()) return false;
    }
    return false;
  }
  if (mimeType === 'image/webp')
    return (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  return true;
}

function validateUpload(name: string, mimeType: string | undefined, bytes: Buffer): ParsedUpload {
  const normalizedName = name.normalize('NFC').trim();
  if (
    normalizedName.length === 0 ||
    normalizedName.length > 180 ||
    normalizedName !== path.basename(normalizedName) ||
    /[\\/]/u.test(normalizedName) ||
    [...normalizedName].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    }) ||
    normalizedName === '.' ||
    normalizedName === '..'
  )
    throw new HttpError(400, 'ATTACHMENT_NAME_INVALID');
  if (bytes.length === 0) throw new HttpError(400, 'ATTACHMENT_EMPTY');
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'ATTACHMENT_TOO_LARGE');
  const suppliedMime = mimeType?.split(';', 1)[0]!.trim().toLowerCase() ?? '';
  const extension = Object.keys(INFERRED_MIME_BY_EXTENSION)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => normalizedName.toLowerCase().endsWith(candidate));
  const inferredMime = extension === undefined ? undefined : INFERRED_MIME_BY_EXTENSION[extension];
  const normalizedMime =
    suppliedMime === '' ||
    suppliedMime === 'application/octet-stream' ||
    (suppliedMime === 'video/mp2t' && extension === '.ts')
      ? inferredMime
      : suppliedMime;
  if (!normalizedMime) throw new HttpError(415, 'ATTACHMENT_TYPE_REQUIRED');
  const rule = MIME_RULES[normalizedMime];
  if (!rule) throw new HttpError(415, 'ATTACHMENT_TYPE_NOT_ALLOWED');
  const lowerName = normalizedName.toLowerCase();
  if (!rule.extensions.some((extension) => lowerName.endsWith(extension)))
    throw new HttpError(415, 'ATTACHMENT_EXTENSION_MISMATCH');
  if (rule.kind === 'image' && !validImageSignature(normalizedMime, bytes))
    throw new HttpError(415, 'ATTACHMENT_SIGNATURE_INVALID');
  if (normalizedMime === 'application/pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-')
    throw new HttpError(415, 'ATTACHMENT_SIGNATURE_INVALID');
  if (
    normalizedMime.startsWith('application/vnd.openxmlformats-officedocument.') &&
    !(
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
        (bytes[2] === 0x05 && bytes[3] === 0x06) ||
        (bytes[2] === 0x07 && bytes[3] === 0x08))
    )
  )
    throw new HttpError(415, 'ATTACHMENT_SIGNATURE_INVALID');
  if (normalizedMime.startsWith('text/')) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new HttpError(415, 'ATTACHMENT_CONTENT_INVALID');
    }
  }
  if (normalizedMime === 'application/json') {
    try {
      JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new HttpError(415, 'ATTACHMENT_CONTENT_INVALID');
    }
  }
  return { name: normalizedName, mimeType: normalizedMime, kind: rule.kind, bytes };
}

function quotedParameter(value: string, name: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${name}="([^"]*)"`, 'i').exec(value);
  return match?.[1]?.replaceAll('\\"', '"') ?? null;
}

export function parseSingleFileMultipart(contentType: string, body: Buffer): ParsedUpload {
  const boundaryMatch = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary || boundary.length > 70 || /[^\x21-\x7e]/u.test(boundary))
    throw new HttpError(400, 'MULTIPART_BOUNDARY_INVALID');
  const opening = Buffer.from(`--${boundary}\r\n`);
  const closing = Buffer.from(`\r\n--${boundary}--`);
  if (!body.subarray(0, opening.length).equals(opening))
    throw new HttpError(400, 'MULTIPART_BODY_INVALID');
  const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), opening.length);
  if (headerEnd < 0 || headerEnd - opening.length > 8_192)
    throw new HttpError(400, 'MULTIPART_HEADERS_INVALID');
  const headers = body.subarray(opening.length, headerEnd).toString('utf8').split('\r\n');
  const headerMap = new Map<string, string>();
  for (const line of headers) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw new HttpError(400, 'MULTIPART_HEADERS_INVALID');
    const key = line.slice(0, separator).trim().toLowerCase();
    if (headerMap.has(key)) throw new HttpError(400, 'MULTIPART_HEADERS_INVALID');
    headerMap.set(key, line.slice(separator + 1).trim());
  }
  const disposition = headerMap.get('content-disposition') ?? '';
  if (!/^form-data(?:;|$)/i.test(disposition) || quotedParameter(disposition, 'name') !== 'file')
    throw new HttpError(400, 'MULTIPART_FILE_REQUIRED');
  const filename = quotedParameter(disposition, 'filename');
  if (filename === null) throw new HttpError(400, 'MULTIPART_FILENAME_REQUIRED');
  const mimeType = headerMap.get('content-type');
  const dataStart = headerEnd + 4;
  const dataEnd = body.indexOf(closing, dataStart);
  if (dataEnd < 0) throw new HttpError(400, 'MULTIPART_BODY_INVALID');
  const trailer = body.subarray(dataEnd + closing.length);
  if (!(trailer.length === 0 || trailer.equals(Buffer.from('\r\n'))))
    throw new HttpError(400, 'MULTIPART_MULTIPLE_FILES_NOT_ALLOWED');
  return validateUpload(filename, mimeType, body.subarray(dataStart, dataEnd));
}

export class AttachmentStore {
  private readonly locks = new Map<string, Promise<void>>();
  readonly root: string;

  constructor(root: string) {
    const resolved = path.resolve(root);
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    this.root = realpathSync(resolved);
  }

  private directoryKey(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  async withThreadLock<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(threadId, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(threadId) === queued) this.locks.delete(threadId);
    }
  }

  storageName(id: string, name: string): string {
    const extension = path.extname(name).toLowerCase().slice(0, 16);
    return `${id}${extension}`;
  }

  localPath(projectId: string, threadId: string, storageName: string): string {
    if (
      storageName !== path.basename(storageName) ||
      !/^[0-9a-f-]{36}\.[a-z0-9.]{1,16}$/u.test(storageName)
    )
      throw new Error('ATTACHMENT_STORAGE_NAME_INVALID');
    return path.join(
      this.root,
      this.directoryKey(projectId),
      this.directoryKey(threadId),
      storageName,
    );
  }

  async write(
    projectId: string,
    threadId: string,
    name: string,
    bytes: Buffer,
  ): Promise<{ id: string; storageName: string }> {
    const id = randomUUID();
    const storageName = this.storageName(id, name);
    const directory = path.dirname(this.localPath(projectId, threadId, storageName));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonicalDirectory = await realpath(directory);
    this.assertContained(canonicalDirectory);
    await writeFile(path.join(canonicalDirectory, storageName), bytes, { flag: 'wx', mode: 0o600 });
    return { id, storageName };
  }

  async read(projectId: string, threadId: string, storageName: string): Promise<Buffer> {
    const canonical = await realpath(this.localPath(projectId, threadId, storageName));
    this.assertContained(canonical);
    return readFile(canonical);
  }

  async remove(projectId: string, threadId: string, storageName: string): Promise<void> {
    const target = this.localPath(projectId, threadId, storageName);
    try {
      const canonical = await realpath(target);
      this.assertContained(canonical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rm(target, { force: true });
  }

  private assertContained(candidate: string): void {
    const relative = path.relative(this.root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('ATTACHMENT_PATH_OUTSIDE_ROOT');
  }
}
