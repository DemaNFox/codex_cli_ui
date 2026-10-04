import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ImagePreviewDialogProps {
  name: string;
  src: string;
  onClose: () => void;
}

export function ImagePreviewDialog({ name, src, onClose }: ImagePreviewDialogProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

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
        event.preventDefault();
        closeButtonRef.current?.focus();
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
      </section>
    </div>,
    document.body,
  );
}
