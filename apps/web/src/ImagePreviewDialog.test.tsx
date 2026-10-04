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

  it('keeps keyboard focus inside and restores the opener on unmount', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(
      <ImagePreviewDialog name="photo.jpg" src="/safe/photo.jpg" onClose={() => undefined} />,
    );
    const close = screen.getByRole('button', { name: 'Закрыть предпросмотр' });

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe('');
    opener.remove();
  });
});
