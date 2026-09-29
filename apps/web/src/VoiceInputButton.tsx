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

function extensionFor(mediaType: string): string {
  if (mediaType.includes('ogg')) return 'ogg';
  if (mediaType.includes('mp4')) return 'm4a';
  return 'webm';
}

function formatRecordingTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
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
      onError('На сервере не задан API-ключ для расшифровки голоса.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
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
        if (blob.size > maxBytes) {
          setState('idle');
          onError('Запись слишком большая. Запишите более короткое сообщение.');
          return;
        }

        setState('transcribing');
        const file = new File([blob], `voice-${Date.now()}.${extensionFor(type)}`, { type });
        void api
          .transcribeAudio(csrfToken, file)
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
    <div className={`voice-input ${recording ? 'recording' : ''}`}>
      <button
        type="button"
        className="voice-button"
        aria-label={label}
        title={available ? label : 'Голосовой ввод не настроен на сервере'}
        aria-pressed={recording}
        disabled={blocked}
        onClick={() => (recording ? stopRecording(false) : void startRecording())}
      >
        {recording ? (
          <span>{formatRecordingTime(elapsedSeconds)}</span>
        ) : state === 'transcribing' ? (
          '…'
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 15.25a3.75 3.75 0 0 0 3.75-3.75v-5a3.75 3.75 0 1 0-7.5 0v5A3.75 3.75 0 0 0 12 15.25Zm-6-4a6 6 0 0 0 12 0M12 17.25V21M9.5 21h5" />
          </svg>
        )}
      </button>
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
