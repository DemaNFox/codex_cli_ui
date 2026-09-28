import { z } from 'zod';

import { HttpError } from './auth.js';

export const MAX_TRANSCRIPTION_BYTES = 10 * 1_024 * 1_024;
export const MAX_TRANSCRIPTION_DURATION_SECONDS = 120;
export const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-transcribe';
const TRANSCRIPTION_TIMEOUT_MS = 30_000;

const AUDIO_FORMATS: Readonly<Record<string, readonly string[]>> = {
  'audio/flac': ['.flac'],
  'audio/mp4': ['.m4a', '.mp4'],
  'audio/mpeg': ['.mp3', '.mpga', '.mpeg'],
  'audio/ogg': ['.ogg'],
  'audio/wav': ['.wav'],
  'audio/webm': ['.webm'],
  'audio/x-m4a': ['.m4a'],
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

function hasExpectedSignature(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === 'audio/flac') return bytes.subarray(0, 4).toString('ascii') === 'fLaC';
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav')
    return (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WAVE'
    );
  if (mimeType === 'audio/webm')
    return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mimeType === 'audio/mp4' || mimeType === 'audio/x-m4a')
    return bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mimeType === 'audio/mpeg')
    return (
      bytes.subarray(0, 3).toString('ascii') === 'ID3' ||
      (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
    );
  if (mimeType === 'audio/ogg') return bytes.subarray(0, 4).toString('ascii') === 'OggS';
  return false;
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
  if (!hasExpectedSignature(mimeType, bytes)) throw new HttpError(415, 'AUDIO_SIGNATURE_INVALID');
  return { name, mimeType, bytes };
}

const responseSchema = z.object({ text: z.string().trim().min(1).max(100_000) });

export class OpenAIAudioTranscriptionClient implements AudioTranscriptionClient {
  constructor(
    private readonly apiKey: string,
    readonly model: string = DEFAULT_TRANSCRIPTION_MODEL,
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = TRANSCRIPTION_TIMEOUT_MS,
  ) {}

  async transcribe(upload: TranscriptionUpload, idempotencyKey: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    try {
      const form = new FormData();
      form.set('model', this.model);
      form.set(
        'file',
        new Blob([Uint8Array.from(upload.bytes)], { type: upload.mimeType }),
        upload.name,
      );
      const response = await this.request('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'idempotency-key': idempotencyKey,
        },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 429)
          throw new HttpError(429, 'TRANSCRIPTION_RATE_LIMITED', 'Transcription is unavailable');
        throw new HttpError(502, 'TRANSCRIPTION_UPSTREAM_ERROR', 'Transcription failed');
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success)
        throw new HttpError(502, 'TRANSCRIPTION_UPSTREAM_INVALID', 'Transcription failed');
      return parsed.data.text;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (controller.signal.aborted)
        throw new HttpError(504, 'TRANSCRIPTION_TIMEOUT', 'Transcription timed out');
      throw new HttpError(502, 'TRANSCRIPTION_UPSTREAM_ERROR', 'Transcription failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}
