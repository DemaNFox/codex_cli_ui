import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, api, projectFileDownloadUrl } from './api.js';

const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;
export const CONTROLLED_PROJECT_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const PROJECT_FILE_OBJECT_URL_REVOKE_MS = 60_000;

export function normalizeProjectFilePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  const suffixIndex = value.search(/[?#]/u);
  const hrefPath = suffixIndex >= 0 ? value.slice(0, suffixIndex) : value;
  if (!hrefPath) return null;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(hrefPath);
  } catch {
    return null;
  }
  if (
    !decodedPath ||
    decodedPath !== decodedPath.trim() ||
    decodedPath.startsWith('/') ||
    decodedPath.startsWith('\\') ||
    URI_SCHEME.test(decodedPath) ||
    [...decodedPath].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    return null;

  const segments = decodedPath.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => segment === '..')) return null;
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
  return normalized || null;
}

export function projectFileName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

type Availability = 'checking' | 'available' | 'unavailable' | 'error';

export function ProjectFileDownload({
  threadId,
  path,
  children,
  className,
  title = 'Скачать файл из проекта',
}: {
  threadId: string;
  path: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const [availability, setAvailability] = useState<Availability>('checking');
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const downloadInFlight = useRef(false);
  const availabilityAbort = useRef<AbortController | null>(null);
  const downloadAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const name = projectFileName(path);

  const checkAvailability = useCallback(() => {
    availabilityAbort.current?.abort();
    const controller = new AbortController();
    availabilityAbort.current = controller;
    setAvailability('checking');
    setSizeBytes(null);
    void api
      .projectFileAvailable(threadId, path, controller.signal)
      .then((result) => {
        if (!mounted.current || controller.signal.aborted) return;
        setSizeBytes(result.sizeBytes);
        setAvailability(result.available ? 'available' : 'unavailable');
      })
      .catch((error: unknown) => {
        if (!mounted.current || controller.signal.aborted || isAbortError(error)) return;
        setAvailability('error');
      });
  }, [path, threadId]);

  useEffect(() => {
    mounted.current = true;
    checkAvailability();
    return () => {
      mounted.current = false;
      availabilityAbort.current?.abort();
      downloadAbort.current?.abort();
    };
  }, [checkAvailability]);

  const retry = () => {
    checkAvailability();
  };

  const download = async (event: MouseEvent<HTMLAnchorElement>) => {
    const controlledDownload = sizeBytes !== null && sizeBytes <= CONTROLLED_PROJECT_FILE_MAX_BYTES;
    if (!controlledDownload) return;
    event.preventDefault();
    if (downloadInFlight.current) return;
    const controller = new AbortController();
    downloadAbort.current = controller;
    downloadInFlight.current = true;
    setDownloading(true);
    try {
      const blob = await api.downloadProjectFile(threadId, path, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = name;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), PROJECT_FILE_OBJECT_URL_REVOKE_MS);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted || isAbortError(error)) return;
      setAvailability(error instanceof ApiError && error.status === 404 ? 'unavailable' : 'error');
    } finally {
      if (downloadAbort.current === controller) {
        downloadInFlight.current = false;
        if (mounted.current && !controller.signal.aborted) setDownloading(false);
      }
    }
  };

  if (availability === 'checking') {
    return (
      <span className="project-file-state" role="status" aria-live="polite" aria-busy="true">
        <span>{children}</span>
        <span className="project-file-status">Проверка файла…</span>
      </span>
    );
  }
  if (availability === 'unavailable') {
    return (
      <span className="project-file-state unavailable" role="status" aria-live="polite">
        <span>{children}</span>
        <span className="project-file-status">Файл недоступен на сервере</span>
        <button type="button" className="project-file-retry" onClick={retry}>
          Проверить снова
        </button>
      </span>
    );
  }
  if (availability === 'error') {
    return (
      <span className="project-file-state error" role="alert">
        <span>{children}</span>
        <span className="project-file-status">Не удалось проверить доступность файла.</span>
        <button type="button" className="project-file-retry" onClick={retry}>
          Повторить
        </button>
      </span>
    );
  }

  return (
    <span className="project-file-state">
      <a
        className={className}
        href={projectFileDownloadUrl(threadId, path)}
        download={name}
        title={title}
        aria-disabled={downloading || undefined}
        aria-busy={downloading || undefined}
        onClick={(event) => void download(event)}
      >
        {children}
      </a>
      {downloading ? (
        <span className="project-file-status" role="status" aria-live="polite">
          Скачивание…
        </span>
      ) : null}
    </span>
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
