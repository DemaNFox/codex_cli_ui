import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ImagePreviewDialog } from './ImagePreviewDialog.js';

describe('ImagePreviewDialog', () => {
  it('renders an accessible preview and closes with the visible control', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<ImagePreviewDialog name="макет.png" src="blob:preview" onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'макет.png' })).not.toBeNull();
    expect(screen.getByRole('img', { name: 'макет.png' }).getAttribute('src')).toBe('blob:preview');
    expect(screen.queryByRole('link', { name: 'Скачать оригинал' })).toBeNull();
    const close = screen.getByRole('button', { name: 'Закрыть предпросмотр' });
    expect(document.activeElement).toBe(close);
    await user.click(close);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes only for the backdrop itself and for Escape', () => {
    const onClose = vi.fn();
    render(<ImagePreviewDialog name="photo.jpg" src="/safe/photo.jpg" onClose={onClose} />);

    fireEvent.mouseDown(screen.getByRole('img', { name: 'photo.jpg' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('offers the persisted original, traps focus across controls, and restores the opener', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(
      <ImagePreviewDialog
        name="photo.jpg"
        src="/safe/photo.jpg"
        originalUrl="/api/threads/thread-1/attachments/photo/content"
        onClose={() => undefined}
      />,
    );
    const close = screen.getByRole('button', { name: 'Закрыть предпросмотр' });
    const original = screen.getByRole('link', { name: 'Скачать оригинал' });
    expect(original.getAttribute('href')).toBe('/api/threads/thread-1/attachments/photo/content');
    expect(original.getAttribute('download')).toBe('photo.jpg');

    await user.tab();
    expect(document.activeElement).toBe(original);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(original);
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe('');
    opener.remove();
  });
});
