import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ImagePreviewDialogProps {
  name: string;
  src: string;
  originalUrl?: string;
  onClose: () => void;
}

export function ImagePreviewDialog({ name, src, originalUrl, onClose }: ImagePreviewDialogProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const returnFocusTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab') {
        const controls = [
          ...(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
          ) ?? []),
        ];
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocusTo?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="image-preview-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="image-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <h2 id={titleId}>{name}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="image-preview-close"
            aria-label="Закрыть предпросмотр"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="image-preview-canvas">
          <img src={src} alt={name} />
        </div>
        {originalUrl && (
          <footer>
            <a className="image-preview-original" href={originalUrl} download={name}>
              Скачать оригинал
            </a>
          </footer>
        )}
      </section>
    </div>,
    document.body,
  );
}
