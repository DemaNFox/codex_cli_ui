import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, api, projectFileDownloadUrl } from './api.js';

const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

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
  const [downloading, setDownloading] = useState(false);
  const downloadInFlight = useRef(false);
  const availabilityRequest = useRef(0);
  const name = projectFileName(path);

  const checkAvailability = useCallback(() => {
    const requestId = ++availabilityRequest.current;
    setAvailability('checking');
    void api
      .projectFileAvailable(threadId, path)
      .then((available) => {
        if (availabilityRequest.current === requestId)
          setAvailability(available ? 'available' : 'unavailable');
      })
      .catch(() => {
        if (availabilityRequest.current === requestId) setAvailability('error');
      });
  }, [path, threadId]);

  useEffect(() => {
    checkAvailability();
    return () => {
      availabilityRequest.current += 1;
    };
  }, [checkAvailability]);

  const retry = () => {
    checkAvailability();
  };

  const download = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (downloadInFlight.current) return;
    downloadInFlight.current = true;
    setDownloading(true);
    try {
      const blob = await api.downloadProjectFile(threadId, path);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = name;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      queueMicrotask(() => URL.revokeObjectURL(objectUrl));
    } catch (error) {
      setAvailability(error instanceof ApiError && error.status === 404 ? 'unavailable' : 'error');
    } finally {
      downloadInFlight.current = false;
      setDownloading(false);
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
