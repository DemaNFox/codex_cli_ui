import { useEffect, useRef, useState } from 'react';

import { api } from './api.js';

interface VoiceInputButtonProps {
  available: boolean;
  csrfToken: string;
  disabled: boolean;
  maxBytes: number;
  maxDurationSeconds: number;
  onError: (message: string) => void;
  onTranscript: (text: string) => void;
}

type VoiceState = 'idle' | 'requesting' | 'recording' | 'transcribing';

const PREFERRED_AUDIO_TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const;

function recordingType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return PREFERRED_AUDIO_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function formatRecordingTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function pcm16Wav(samples: Float32Array, sampleRate: number): Blob {
  const headerBytes = 44;
  const buffer = new ArrayBuffer(headerBytes + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32_768 : sample * 32_767, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function blobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('Не удалось прочитать запись.'));
    });
    reader.addEventListener('error', () => reject(new Error('Не удалось прочитать запись.')));
    reader.readAsArrayBuffer(blob);
  });
}

async function recordingToWav(recording: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blobArrayBuffer(recording));
    const targetRate = 16_000;
    const targetLength = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const output = new Float32Array(targetLength);
    const ratio = decoded.sampleRate / targetRate;
    for (let targetIndex = 0; targetIndex < targetLength; targetIndex += 1) {
      const sourcePosition = targetIndex * ratio;
      const leftIndex = Math.min(Math.floor(sourcePosition), decoded.length - 1);
      const rightIndex = Math.min(leftIndex + 1, decoded.length - 1);
      const weight = sourcePosition - leftIndex;
      let mixed = 0;
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const data = decoded.getChannelData(channel);
        mixed += (data[leftIndex] ?? 0) * (1 - weight) + (data[rightIndex] ?? 0) * weight;
      }
      output[targetIndex] = mixed / decoded.numberOfChannels;
    }
    return pcm16Wav(output, targetRate);
  } finally {
    await context.close();
  }
}

export function VoiceInputButton({
  available,
  csrfToken,
  disabled,
  maxBytes,
  maxDurationSeconds,
  onError,
  onTranscript,
}: VoiceInputButtonProps) {
  const [state, setState] = useState<VoiceState>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      discardRef.current = true;
      const recorder = recorderRef.current;
      if (recorder?.state === 'recording') recorder.stop();
      recorder?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (state !== 'recording') return undefined;
    const timer = window.setInterval(() => {
      setElapsedSeconds((current) => {
        const next = current + 1;
        if (next >= maxDurationSeconds && recorderRef.current?.state === 'recording') {
          recorderRef.current.stop();
        }
        return Math.min(next, maxDurationSeconds);
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [maxDurationSeconds, state]);

  async function startRecording(): Promise<void> {
    if (!available) {
      onError('Локальная модель распознавания голоса не установлена на сервере.');
      return;
    }
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined' ||
      typeof AudioContext === 'undefined'
    ) {
      onError('Этот браузер не поддерживает запись голоса.');
      return;
    }

    setState('requesting');
    setElapsedSeconds(0);
    discardRef.current = false;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const activeStream = stream;
      const mediaType = recordingType();
      const recorder = new MediaRecorder(activeStream, {
        ...(mediaType ? { mimeType: mediaType } : {}),
        audioBitsPerSecond: 64_000,
      });
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener('stop', () => {
        activeStream.getTracks().forEach((track) => track.stop());
        const discard = discardRef.current;
        const chunks = chunksRef.current;
        chunksRef.current = [];
        recorderRef.current = null;
        if (discard || !mountedRef.current) {
          if (mountedRef.current) setState('idle');
          return;
        }

        const type = recorder.mimeType || mediaType || 'audio/webm';
        const blob = new Blob(chunks, { type });
        if (!blob.size) {
          setState('idle');
          onError('Запись получилась пустой. Попробуйте ещё раз.');
          return;
        }
        setState('transcribing');
        void recordingToWav(blob)
          .then((wav) => {
            if (wav.size > maxBytes)
              throw new Error('Запись слишком большая. Запишите более короткое сообщение.');
            return api.transcribeAudio(
              csrfToken,
              new File([wav], `voice-${Date.now()}.wav`, { type: 'audio/wav' }),
            );
          })
          .then(({ text }) => {
            if (!mountedRef.current) return;
            onTranscript(text);
            setState('idle');
          })
          .catch((cause: unknown) => {
            if (!mountedRef.current) return;
            setState('idle');
            onError(cause instanceof Error ? cause.message : 'Не удалось распознать запись.');
          });
      });
      recorder.start(1000);
      setState('recording');
    } catch (cause) {
      stream?.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      chunksRef.current = [];
      setState('idle');
      onError(
        cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? 'Нет доступа к микрофону. Разрешите его в настройках браузера.'
          : 'Не удалось включить микрофон.',
      );
    }
  }

  function stopRecording(discard: boolean): void {
    discardRef.current = discard;
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') recorder.stop();
  }

  const recording = state === 'recording';
  const blocked = disabled || state === 'requesting' || state === 'transcribing';
  const label = recording
    ? `Остановить запись, ${formatRecordingTime(elapsedSeconds)}`
    : state === 'transcribing'
      ? 'Распознаётся…'
      : state === 'requesting'
        ? 'Подключение микрофона…'
        : 'Голосовой ввод';

  return (
    <div
      className={`voice-input ${recording ? 'recording' : ''} ${state === 'transcribing' ? 'transcribing' : ''}`}
    >
      <button
        type="button"
        className="voice-button"
        aria-label={label}
        aria-busy={state === 'transcribing'}
        title={available ? label : 'Локальная модель голоса не установлена на сервере'}
        aria-pressed={recording}
        disabled={blocked}
        onClick={() => (recording ? stopRecording(false) : void startRecording())}
      >
        {recording ? (
          <span>{formatRecordingTime(elapsedSeconds)}</span>
        ) : state === 'transcribing' ? (
          <span className="voice-transcribing-spinner" aria-hidden="true" />
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 15.25a3.75 3.75 0 0 0 3.75-3.75v-5a3.75 3.75 0 1 0-7.5 0v5A3.75 3.75 0 0 0 12 15.25Zm-6-4a6 6 0 0 0 12 0M12 17.25V21M9.5 21h5" />
          </svg>
        )}
      </button>
      {state === 'transcribing' && (
        <span className="visually-hidden" role="status" aria-live="polite">
          Распознаём голосовое сообщение…
        </span>
      )}
      {recording && (
        <button
          type="button"
          className="voice-cancel"
          aria-label="Отменить запись"
          title="Отменить запись"
          onClick={() => stopRecording(true)}
        >
          ×
        </button>
      )}
    </div>
  );
}
