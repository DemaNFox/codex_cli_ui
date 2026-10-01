import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { HttpError } from './auth.js';

export const MAX_TRANSCRIPTION_BYTES = 10 * 1_024 * 1_024;
export const MAX_TRANSCRIPTION_DURATION_SECONDS = 120;
export const DEFAULT_TRANSCRIPTION_MODEL = 'onnx-community/whisper-base';
export const DEFAULT_TRANSCRIPTION_MODEL_REVISION = '1846881b6b3a3024392c1eea3ad983695bc23925';
export const DEFAULT_TRANSCRIPTION_LANGUAGE = 'russian';
const TRANSCRIPTION_SAMPLE_RATE = 16_000;
const MINIMUM_AUDIO_RMS = 0.002;
const LOCAL_MODEL_MANIFEST = 'codex-web-ui-transcription-manifest.json';

const AUDIO_FORMATS: Readonly<Record<string, readonly string[]>> = {
  'audio/wav': ['.wav'],
  'audio/x-wav': ['.wav'],
};

export interface TranscriptionUpload {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
}

export interface AudioTranscriptionClient {
  transcribe(upload: TranscriptionUpload, idempotencyKey: string): Promise<string>;
}

function quotedParameter(value: string, name: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${name}="([^"]*)"`, 'i').exec(value);
  return match?.[1]?.replaceAll('\\"', '"') ?? null;
}

function hasExpectedSignature(bytes: Buffer): boolean {
  return (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WAVE'
  );
}

export function parseAudioMultipart(contentType: string, body: Buffer): TranscriptionUpload {
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
  const headerMap = new Map<string, string>();
  for (const line of body.subarray(opening.length, headerEnd).toString('utf8').split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw new HttpError(400, 'MULTIPART_HEADERS_INVALID');
    const key = line.slice(0, separator).trim().toLowerCase();
    if (headerMap.has(key)) throw new HttpError(400, 'MULTIPART_HEADERS_INVALID');
    headerMap.set(key, line.slice(separator + 1).trim());
  }
  const disposition = headerMap.get('content-disposition') ?? '';
  if (!/^form-data(?:;|$)/i.test(disposition) || quotedParameter(disposition, 'name') !== 'file')
    throw new HttpError(400, 'MULTIPART_FILE_REQUIRED');
  const name = quotedParameter(disposition, 'filename');
  if (
    name === null ||
    name.length === 0 ||
    name.length > 180 ||
    /[\\/]/u.test(name) ||
    [...name].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  )
    throw new HttpError(400, 'AUDIO_NAME_INVALID');
  const mimeType = (headerMap.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
  const extensions = AUDIO_FORMATS[mimeType];
  if (!extensions) throw new HttpError(415, 'AUDIO_TYPE_NOT_ALLOWED');
  if (!extensions.some((extension) => name.toLowerCase().endsWith(extension)))
    throw new HttpError(415, 'AUDIO_EXTENSION_MISMATCH');
  const dataStart = headerEnd + 4;
  const dataEnd = body.indexOf(closing, dataStart);
  if (dataEnd < 0) throw new HttpError(400, 'MULTIPART_BODY_INVALID');
  const trailer = body.subarray(dataEnd + closing.length);
  if (!(trailer.length === 0 || trailer.equals(Buffer.from('\r\n'))))
    throw new HttpError(400, 'MULTIPART_MULTIPLE_FILES_NOT_ALLOWED');
  const bytes = body.subarray(dataStart, dataEnd);
  if (bytes.length === 0) throw new HttpError(400, 'AUDIO_EMPTY');
  if (bytes.length > MAX_TRANSCRIPTION_BYTES)
    throw new HttpError(413, 'AUDIO_TOO_LARGE', 'Request failed');
  if (!hasExpectedSignature(bytes)) throw new HttpError(415, 'AUDIO_SIGNATURE_INVALID');
  return { name, mimeType, bytes };
}

interface LocalAsrOutput {
  readonly text: string;
}

interface LocalAsrPipeline {
  (audio: Float32Array, options: Record<string, unknown>): Promise<LocalAsrOutput>;
  dispose?(): Promise<void>;
}

export interface LocalTranscriptionOptions {
  readonly cachePath: string;
  readonly model?: string;
  readonly revision?: string;
  readonly language?: string;
}

type LocalAsrLoader = (options: Required<LocalTranscriptionOptions>) => Promise<LocalAsrPipeline>;

interface LocalModelFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface LocalModelManifest {
  readonly schemaVersion: 1;
  readonly model: string;
  readonly revision: string;
  readonly dtype: 'q8';
  readonly files: readonly LocalModelFile[];
}

function localModelFile(value: unknown): value is LocalModelFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === 'string' &&
    /^[A-Za-z0-9._/-]+$/u.test(entry.path) &&
    !entry.path.includes('..') &&
    !path.isAbsolute(entry.path) &&
    typeof entry.bytes === 'number' &&
    Number.isSafeInteger(entry.bytes) &&
    entry.bytes > 0 &&
    typeof entry.sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(entry.sha256)
  );
}

function safeModelRoot(cachePath: string, model: string, revision: string): string {
  const root = path.resolve(cachePath);
  const candidate = path.resolve(root, ...model.split('/'), revision);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`))
    throw new Error('Invalid local transcription model path');
  return candidate;
}

async function hashFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readFile(filePath);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function listModelFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error('Local transcription model contains a symlink');
    if (entry.isDirectory()) files.push(...(await listModelFiles(root, absolute)));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error('Local transcription model contains an unsupported entry');
  }
  return files.sort();
}

export async function writeLocalModelManifest(options: {
  readonly cachePath: string;
  readonly model: string;
  readonly revision: string;
  readonly expectedFiles?: readonly LocalModelFile[];
}): Promise<void> {
  const root = safeModelRoot(options.cachePath, options.model, options.revision);
  const files = await listModelFiles(root);
  if (files.length === 0) throw new Error('Local transcription model is empty');
  const entries = await Promise.all(
    files.map(async (relativePath) => ({
      path: relativePath,
      ...(await hashFile(path.join(root, ...relativePath.split('/')))),
    })),
  );
  if (
    options.expectedFiles &&
    JSON.stringify(entries) !==
      JSON.stringify(
        [...options.expectedFiles].sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
        ),
      )
  )
    throw new Error('Downloaded transcription model does not match the trusted artifact inventory');
  const manifest: LocalModelManifest = {
    schemaVersion: 1,
    model: options.model,
    revision: options.revision,
    dtype: 'q8',
    files: entries,
  };
  await writeFile(
    path.join(options.cachePath, LOCAL_MODEL_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );
}

export async function verifyLocalModelManifest(
  options: Required<LocalTranscriptionOptions>,
): Promise<void> {
  const manifestPath = path.join(options.cachePath, LOCAL_MODEL_MANIFEST);
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
    throw new Error('Local transcription model manifest is not a regular file');
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<LocalModelManifest>;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.model !== options.model ||
    parsed.revision !== options.revision ||
    parsed.dtype !== 'q8' ||
    !Array.isArray(parsed.files) ||
    parsed.files.length === 0
  )
    throw new Error('Local transcription model manifest does not match configuration');
  const root = safeModelRoot(options.cachePath, options.model, options.revision);
  const files: LocalModelFile[] = [];
  for (const entry of parsed.files as readonly unknown[]) {
    if (!localModelFile(entry)) throw new Error('Local transcription model manifest is invalid');
    files.push(entry);
  }
  const actualPaths = await listModelFiles(root);
  const manifestedPaths = files.map((entry) => entry.path).sort();
  if (
    actualPaths.length !== manifestedPaths.length ||
    actualPaths.some((actualPath, index) => actualPath !== manifestedPaths[index])
  )
    throw new Error('Local transcription model file inventory does not match manifest');
  for (const entry of files) {
    const filePath = path.resolve(root, ...entry.path.split('/'));
    if (!filePath.startsWith(`${root}${path.sep}`))
      throw new Error('Local transcription model manifest escapes its root');
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Local transcription model artifact is not a regular file');
    const actual = await hashFile(filePath);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256)
      throw new Error('Local transcription model artifact failed integrity verification');
  }
}

function decodePcm16MonoWav(bytes: Buffer): Float32Array {
  if (!hasExpectedSignature(bytes)) throw new HttpError(415, 'AUDIO_SIGNATURE_INVALID');
  let format: {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    byteRate: number;
    blockAlign: number;
    bitsPerSample: number;
  } | null = null;
  let pcm: Buffer | null = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const chunkId = bytes.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > bytes.length) throw new HttpError(415, 'AUDIO_WAV_INVALID');
    if (chunkId === 'fmt ') {
      if (format || chunkSize < 16) throw new HttpError(415, 'AUDIO_WAV_INVALID');
      format = {
        audioFormat: bytes.readUInt16LE(dataStart),
        channels: bytes.readUInt16LE(dataStart + 2),
        sampleRate: bytes.readUInt32LE(dataStart + 4),
        byteRate: bytes.readUInt32LE(dataStart + 8),
        blockAlign: bytes.readUInt16LE(dataStart + 12),
        bitsPerSample: bytes.readUInt16LE(dataStart + 14),
      };
    } else if (chunkId === 'data') {
      if (pcm) throw new HttpError(415, 'AUDIO_WAV_INVALID');
      pcm = bytes.subarray(dataStart, dataEnd);
    }
    offset = dataEnd + (chunkSize % 2);
  }
  if (
    !format ||
    !pcm ||
    format.audioFormat !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== TRANSCRIPTION_SAMPLE_RATE ||
    format.bitsPerSample !== 16 ||
    format.blockAlign !== 2 ||
    format.byteRate !== TRANSCRIPTION_SAMPLE_RATE * 2 ||
    pcm.length === 0 ||
    pcm.length % 2 !== 0
  )
    throw new HttpError(415, 'AUDIO_WAV_FORMAT_UNSUPPORTED');
  const sampleCount = pcm.length / 2;
  if (sampleCount > MAX_TRANSCRIPTION_DURATION_SECONDS * TRANSCRIPTION_SAMPLE_RATE)
    throw new HttpError(413, 'AUDIO_TOO_LONG', 'Recording is too long');
  const samples = new Float32Array(sampleCount);
  let squareSum = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = pcm.readInt16LE(index * 2) / 32_768;
    samples[index] = sample;
    squareSum += sample * sample;
  }
  if (Math.sqrt(squareSum / sampleCount) < MINIMUM_AUDIO_RMS)
    throw new HttpError(422, 'AUDIO_SILENT', 'No speech was detected');
  return samples;
}

async function loadLocalPipeline(
  options: Required<LocalTranscriptionOptions>,
): Promise<LocalAsrPipeline> {
  await verifyLocalModelManifest(options);
  const { env, pipeline } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  const loaded = await pipeline('automatic-speech-recognition', options.model, {
    revision: options.revision,
    cache_dir: options.cachePath,
    local_files_only: true,
    dtype: 'q8',
    device: 'cpu',
  });
  return loaded as LocalAsrPipeline;
}

export class LocalAudioTranscriptionClient implements AudioTranscriptionClient {
  private constructor(
    readonly model: string,
    private readonly language: string,
    private readonly transcriber: LocalAsrPipeline,
  ) {}

  static async create(
    options: LocalTranscriptionOptions,
    loader: LocalAsrLoader = loadLocalPipeline,
  ): Promise<LocalAudioTranscriptionClient> {
    const resolved: Required<LocalTranscriptionOptions> = {
      cachePath: options.cachePath,
      model: options.model ?? DEFAULT_TRANSCRIPTION_MODEL,
      revision: options.revision ?? DEFAULT_TRANSCRIPTION_MODEL_REVISION,
      language: options.language ?? DEFAULT_TRANSCRIPTION_LANGUAGE,
    };
    const transcriber = await loader(resolved);
    return new LocalAudioTranscriptionClient(resolved.model, resolved.language, transcriber);
  }

  async transcribe(upload: TranscriptionUpload): Promise<string> {
    if (upload.mimeType !== 'audio/wav' && upload.mimeType !== 'audio/x-wav')
      throw new HttpError(415, 'AUDIO_TYPE_NOT_ALLOWED');
    const audio = decodePcm16MonoWav(upload.bytes);
    try {
      const result = await this.transcriber(audio, {
        language: this.language,
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const text = result.text.trim();
      if (!text || text.length > 100_000)
        throw new HttpError(422, 'TRANSCRIPTION_EMPTY', 'No speech was detected');
      return text;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'TRANSCRIPTION_LOCAL_ERROR', 'Transcription failed');
    }
  }
}
