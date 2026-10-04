import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from './api.js';
import { VoiceInputButton } from './VoiceInputButton.js';

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported = () => true;

  readonly mimeType = 'audio/webm;codecs=opus';
  readonly stream: MediaStream;
  state: RecordingState = 'inactive';

  constructor(stream: MediaStream) {
    super();
    this.stream = stream;
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    const dataEvent = new Event('dataavailable') as BlobEvent;
    Object.defineProperty(dataEvent, 'data', {
      value: new Blob(['voice'], { type: this.mimeType }),
    });
    this.dispatchEvent(dataEvent);
    this.dispatchEvent(new Event('stop'));
  }
}

class FakeAudioContext {
  decodeAudioData(): Promise<AudioBuffer> {
    const samples = new Float32Array([0.1, -0.1, 0.2, -0.2]);
    return Promise.resolve({
      duration: samples.length / 16_000,
      length: samples.length,
      numberOfChannels: 1,
      sampleRate: 16_000,
      getChannelData: () => samples,
    } as unknown as AudioBuffer);
  }

  async close(): Promise<void> {}
}

describe('VoiceInputButton', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('records, transcribes and returns editable text', async () => {
    const user = userEvent.setup();
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const transcribe = vi
      .spyOn(api, 'transcribeAudio')
      .mockResolvedValue({ text: 'Проверить сервер' });
    const onTranscript = vi.fn();

    render(
      <VoiceInputButton
        available
        csrfToken="csrf-token"
        disabled={false}
        maxBytes={1024}
        maxDurationSeconds={60}
        onError={vi.fn()}
        onTranscript={onTranscript}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Голосовой ввод/ }));
    await user.click(screen.getByRole('button', { name: /Остановить запись/ }));

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('Проверить сервер'));
    expect(transcribe).toHaveBeenCalledWith('csrf-token', expect.any(File));
    const file = transcribe.mock.calls[0]?.[1];
    expect(file).toMatchObject({ type: 'audio/wav' });
    expect(file?.name).toMatch(/\.wav$/u);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('shows and announces progress while transcribing', async () => {
    const user = userEvent.setup();
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.spyOn(api, 'transcribeAudio').mockImplementation(() => new Promise(() => undefined));

    const { container } = render(
      <VoiceInputButton
        available
        csrfToken="csrf-token"
        disabled={false}
        maxBytes={1024}
        maxDurationSeconds={60}
        onError={vi.fn()}
        onTranscript={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Голосовой ввод/ }));
    await user.click(screen.getByRole('button', { name: /Остановить запись/ }));

    const transcribingButton = await screen.findByRole('button', { name: 'Распознаётся…' });
    expect((transcribingButton as HTMLButtonElement).disabled).toBe(true);
    expect(transcribingButton.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Распознаём голосовое сообщение…');
    expect(
      container.querySelector('.voice-transcribing-spinner')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  it('explains when the server has no local transcription model', async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    render(
      <VoiceInputButton
        available={false}
        csrfToken="csrf-token"
        disabled={false}
        maxBytes={1024}
        maxDurationSeconds={60}
        onError={onError}
        onTranscript={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Голосовой ввод' }));
    expect(onError).toHaveBeenCalledWith(
      'Локальная модель распознавания голоса не установлена на сервере.',
    );
  });

  it('releases the microphone when MediaRecorder cannot start', async () => {
    const user = userEvent.setup();
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    class FailingMediaRecorder {
      static isTypeSupported = () => true;

      constructor() {
        throw new Error('unsupported recorder options');
      }
    }
    vi.stubGlobal('MediaRecorder', FailingMediaRecorder);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const onError = vi.fn();

    render(
      <VoiceInputButton
        available
        csrfToken="csrf-token"
        disabled={false}
        maxBytes={1024}
        maxDurationSeconds={60}
        onError={onError}
        onTranscript={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Голосовой ввод' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Не удалось включить микрофон.'));
    expect(stopTrack).toHaveBeenCalledOnce();
  });
});
