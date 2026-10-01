import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { HttpError } from './auth.js';
import {
  LocalAudioTranscriptionClient,
  MAX_TRANSCRIPTION_BYTES,
  parseAudioMultipart,
  verifyLocalModelManifest,
  writeLocalModelManifest,
} from './audio-transcription.js';

const MODEL = 'onnx-community/whisper-base';
const REVISION = '1846881b6b3a3024392c1eea3ad983695bc23925';

function wav(samples: readonly number[], sampleRate = 16_000): Buffer {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, 44 + index * 2));
  return bytes;
}

function multipart(name: string, mimeType: string, bytes: Buffer, boundary = 'audio-test'): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

function captureHttpError(action: () => void): HttpError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error('Expected HttpError');
}

describe('audio transcription boundary', () => {
  it('accepts only one allowlisted audio file with a matching signature', () => {
    const bytes = wav([1000, -1000]);
    expect(
      parseAudioMultipart(
        'multipart/form-data; boundary=audio-test',
        multipart('voice.wav', 'audio/wav', bytes),
      ),
    ).toEqual({
      name: 'voice.wav',
      mimeType: 'audio/wav',
      bytes,
    });
    expect(
      captureHttpError(() =>
        parseAudioMultipart(
          'multipart/form-data; boundary=audio-test',
          multipart('voice.exe', 'application/octet-stream', Buffer.from('MZ')),
        ),
      ),
    ).toMatchObject({ code: 'AUDIO_TYPE_NOT_ALLOWED' });
    expect(
      captureHttpError(() =>
        parseAudioMultipart(
          'multipart/form-data; boundary=audio-test',
          multipart('voice.wav', 'audio/wav', Buffer.from('spoofed')),
        ),
      ),
    ).toMatchObject({ code: 'AUDIO_SIGNATURE_INVALID' });
  });

  it('hard-limits audio bytes before any upstream request', () => {
    expect(
      captureHttpError(() =>
        parseAudioMultipart(
          'multipart/form-data; boundary=audio-test',
          multipart(
            'voice.wav',
            'audio/wav',
            Buffer.concat([wav([1000]), Buffer.alloc(MAX_TRANSCRIPTION_BYTES - 3)]),
          ),
        ),
      ),
    ).toMatchObject({ statusCode: 413, code: 'AUDIO_TOO_LARGE' });
  });

  it('loads one offline local model and transcribes normalized PCM without an external request', async () => {
    const transcriber = vi.fn().mockResolvedValue({ text: ' Проверить сервер ' });
    const loader = vi.fn().mockResolvedValue(transcriber);
    const client = await LocalAudioTranscriptionClient.create(
      {
        cachePath: '/var/lib/codex-web-ui/models',
        model: 'onnx-community/whisper-base',
        revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
        language: 'russian',
      },
      loader,
    );
    await expect(
      client.transcribe({
        name: 'voice.wav',
        mimeType: 'audio/wav',
        bytes: wav([2000, -2000, 3000, -3000]),
      }),
    ).resolves.toBe('Проверить сервер');
    expect(loader).toHaveBeenCalledOnce();
    expect(transcriber).toHaveBeenCalledWith(expect.any(Float32Array), {
      language: 'russian',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    });
  });

  it('rejects malformed, unsupported and silent WAV before local inference', async () => {
    const transcriber = vi.fn().mockResolvedValue({ text: 'unused' });
    const client = await LocalAudioTranscriptionClient.create({ cachePath: '/models' }, () =>
      Promise.resolve(transcriber),
    );
    await expect(
      client.transcribe({
        name: 'voice.wav',
        mimeType: 'audio/wav',
        bytes: wav([2000], 48_000),
      }),
    ).rejects.toMatchObject({ code: 'AUDIO_WAV_FORMAT_UNSUPPORTED' });
    await expect(
      client.transcribe({
        name: 'voice.wav',
        mimeType: 'audio/wav',
        bytes: wav([0, 0, 0]),
      }),
    ).rejects.toMatchObject({ code: 'AUDIO_SILENT' });
    expect(transcriber).not.toHaveBeenCalled();
  });

  it('verifies the complete pinned local model inventory and rejects unmanifested files', async () => {
    const cachePath = await mkdtemp(path.join(tmpdir(), 'codex-web-ui-model-'));
    const modelRoot = path.join(cachePath, ...MODEL.split('/'), REVISION);
    try {
      await mkdir(path.join(modelRoot, 'onnx'), { recursive: true });
      await writeFile(path.join(modelRoot, 'config.json'), '{"model_type":"whisper"}\n');
      await writeFile(path.join(modelRoot, 'onnx', 'encoder_model_quantized.onnx'), 'fixture');
      await expect(
        writeLocalModelManifest({
          cachePath,
          model: MODEL,
          revision: REVISION,
          expectedFiles: [{ path: 'config.json', bytes: 1, sha256: '0'.repeat(64) }],
        }),
      ).rejects.toThrow('trusted artifact inventory');
      await writeLocalModelManifest({ cachePath, model: MODEL, revision: REVISION });

      await expect(
        verifyLocalModelManifest({
          cachePath,
          model: MODEL,
          revision: REVISION,
          language: 'russian',
        }),
      ).resolves.toBeUndefined();

      await writeFile(path.join(modelRoot, 'unmanifested.bin'), 'tampered');
      await expect(
        verifyLocalModelManifest({
          cachePath,
          model: MODEL,
          revision: REVISION,
          language: 'russian',
        }),
      ).rejects.toThrow('file inventory does not match manifest');
    } finally {
      await rm(cachePath, { recursive: true, force: true });
    }
  });
});
