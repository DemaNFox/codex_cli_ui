import { describe, expect, it, vi } from 'vitest';

import { HttpError } from './auth.js';
import {
  MAX_TRANSCRIPTION_BYTES,
  OpenAIAudioTranscriptionClient,
  parseAudioMultipart,
} from './audio-transcription.js';

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
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]);
    expect(
      parseAudioMultipart(
        'multipart/form-data; boundary=audio-test',
        multipart('voice.webm', 'audio/webm', bytes),
      ),
    ).toEqual({
      name: 'voice.webm',
      mimeType: 'audio/webm',
      bytes,
    });
    expect(
      parseAudioMultipart(
        'multipart/form-data; boundary=audio-test',
        multipart('voice.ogg', 'audio/ogg; codecs=opus', Buffer.from('OggS\0')),
      ),
    ).toMatchObject({ name: 'voice.ogg', mimeType: 'audio/ogg' });
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
          multipart('voice.webm', 'audio/webm', Buffer.from('spoofed')),
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
            'voice.webm',
            'audio/webm',
            Buffer.concat([
              Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
              Buffer.alloc(MAX_TRANSCRIPTION_BYTES - 3),
            ]),
          ),
        ),
      ),
    ).toMatchObject({ statusCode: 413, code: 'AUDIO_TOO_LARGE' });
  });

  it('sends the server credential and fixed model while returning only bounded text', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ text: 'hello' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new OpenAIAudioTranscriptionClient('server-secret', 'gpt-transcribe', request);
    await expect(
      client.transcribe(
        {
          name: 'voice.webm',
          mimeType: 'audio/webm',
          bytes: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
        },
        '00000000-0000-4000-8000-000000000001',
      ),
    ).resolves.toBe('hello');
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init?.headers).toEqual({
      authorization: 'Bearer server-secret',
      'idempotency-key': '00000000-0000-4000-8000-000000000001',
    });
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('gpt-transcribe');
    expect(form.get('file')).toBeInstanceOf(File);
  });

  it('maps timeout and upstream failures without exposing credentials or response bodies', async () => {
    const timeoutRequest = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const timeoutClient = new OpenAIAudioTranscriptionClient(
      'timeout-secret',
      'gpt-transcribe',
      timeoutRequest,
      1,
    );
    const upload = {
      name: 'voice.webm',
      mimeType: 'audio/webm',
      bytes: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    };
    await expect(
      timeoutClient.transcribe(upload, '00000000-0000-4000-8000-000000000002'),
    ).rejects.toMatchObject({
      statusCode: 504,
      code: 'TRANSCRIPTION_TIMEOUT',
    });

    const failedClient = new OpenAIAudioTranscriptionClient(
      'private-key',
      'gpt-transcribe',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('upstream says private-key is invalid', { status: 401 })),
    );
    let error: unknown;
    try {
      await failedClient.transcribe(upload, '00000000-0000-4000-8000-000000000003');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      statusCode: 502,
      code: 'TRANSCRIPTION_UPSTREAM_ERROR',
      message: 'Transcription failed',
    });
    expect(String(error)).not.toContain('private-key');
  });
});
