import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentMessageContent } from './AgentMessageContent.js';

const createObjectUrlMock = vi.fn(() => 'blob:project-file');
const revokeObjectUrlMock = vi.fn();

function availableHead(sizeBytes = 128): Response {
  return new Response(null, {
    status: 204,
    headers: { 'Content-Length': String(sizeBytes) },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  createObjectUrlMock.mockClear();
  revokeObjectUrlMock.mockClear();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectUrlMock,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectUrlMock,
  });
});

describe('AgentMessageContent', () => {
  it('renders CommonMark structure and GFM task lists', () => {
    const { container } = render(
      <AgentMessageContent
        text={'## Result\n\n> Verified\n\n- [x] table\n- [ ] release\n\n1. First\n2. Second'}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Result', level: 2 })).not.toBeNull();
    expect(screen.getByText('Verified').closest('blockquote')).not.toBeNull();
    const completedItem = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    expect(completedItem.checked).toBe(true);
    expect(container.querySelector('ol')).not.toBeNull();
  });

  it('renders GFM tables inside a scrollable region', () => {
    render(<AgentMessageContent text={'| Name | State |\n| --- | --- |\n| Build | Ready |'} />);

    const region = screen.getByRole('region', { name: 'Таблица' });
    const table = within(region).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Name' })).not.toBeNull();
    expect(within(table).getByRole('cell', { name: 'Ready' })).not.toBeNull();
    expect(region.classList.contains('markdown-table-scroll')).toBe(true);
  });

  it('keeps raw HTML inert and never creates script or image elements', () => {
    const { container } = render(
      <AgentMessageContent
        text={'<script>window.pwned = true</script>\n\n<img src="x" onerror="alert(1)">'}
      />,
    );

    expect(screen.getByText(/<script>window\.pwned = true<\/script>/)).not.toBeNull();
    expect(screen.getByText(/<img src="x" onerror="alert\(1\)">/)).not.toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders inline and fenced code without interpreting their contents', () => {
    const { container } = render(
      <AgentMessageContent text={'Use `<unsafe>` here.\n\n```ts\nconst value = "<tag>";\n```'} />,
    );

    expect(screen.getByText('<unsafe>').tagName).toBe('CODE');
    expect(screen.getByText('const value = "<tag>";').tagName).toBe('CODE');
    expect(container.querySelector('tag')).toBeNull();
  });

  it('opens external links safely and leaves relative links in the current context', () => {
    render(
      <AgentMessageContent
        text={
          '[External](https://example.com/path) [Internal](/projects/one) [Unsafe](javascript:alert(1))'
        }
        threadId="thread-1"
      />,
    );

    const external = screen.getByRole('link', { name: 'External' });
    expect(external.getAttribute('href')).toBe('https://example.com/path');
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');

    const internal = screen.getByRole('link', { name: 'Internal' });
    expect(internal.getAttribute('href')).toBe('/projects/one');
    expect(internal.getAttribute('target')).toBeNull();

    expect(screen.getByText('Unsafe').closest('a')).toBeNull();
  });

  it('turns a confirmed relative result into an authenticated project-file download', async () => {
    vi.mocked(fetch).mockResolvedValue(availableHead());
    render(
      <AgentMessageContent
        text={
          '[Скачать отчёт](reports/%D0%B8%D1%82%D0%BE%D0%B3%D0%BE%D0%B2%D1%8B%D0%B9%20%D0%B0%D1%83%D0%B4%D0%B8%D1%82.md) [Раздел](#summary)'
        }
        threadId="thread-1"
      />,
    );

    expect(screen.getByRole('status').textContent).toContain('Проверка файла');
    const download = await screen.findByRole('link', { name: 'Скачать отчёт' });
    expect(download.getAttribute('href')).toBe(
      '/api/threads/thread-1/project-files/download?path=reports%2F%D0%B8%D1%82%D0%BE%D0%B3%D0%BE%D0%B2%D1%8B%D0%B9%20%D0%B0%D1%83%D0%B4%D0%B8%D1%82.md',
    );
    expect(download.getAttribute('download')).toBe('итоговый аудит.md');
    expect(download.getAttribute('title')).toBe('Скачать файл из проекта');
    expect(screen.getByRole('link', { name: 'Раздел' }).getAttribute('href')).toBe('#summary');
    expect(fetch).toHaveBeenCalledWith(
      '/api/threads/thread-1/project-files/download?path=reports%2F%D0%B8%D1%82%D0%BE%D0%B3%D0%BE%D0%B2%D1%8B%D0%B9%20%D0%B0%D1%83%D0%B4%D0%B8%D1%82.md',
      expect.objectContaining({ credentials: 'same-origin', method: 'HEAD' }),
    );
  });

  it('does not present a missing project file as a download link', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(availableHead());
    render(<AgentMessageContent text="[Отчёт](reports/missing.md)" threadId="thread-1" />);

    expect(await screen.findByText('Файл недоступен на сервере')).not.toBeNull();
    expect(screen.queryByRole('link', { name: 'Отчёт' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Проверить снова' }));
    expect(await screen.findByRole('link', { name: 'Отчёт' })).not.toBeNull();
  });

  it('reports when a file disappears after availability was confirmed', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(availableHead())
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    render(<AgentMessageContent text="[Отчёт](reports/vanished.md)" threadId="thread-1" />);

    fireEvent.click(await screen.findByRole('link', { name: 'Отчёт' }));

    expect(await screen.findByText('Файл недоступен на сервере')).not.toBeNull();
    expect(screen.queryByRole('link', { name: 'Отчёт' })).toBeNull();
  });

  it('guards a busy download from duplicate clicks', async () => {
    let finishDownload!: (response: Response) => void;
    const pendingDownload = new Promise<Response>((resolve) => {
      finishDownload = resolve;
    });
    vi.mocked(fetch).mockResolvedValueOnce(availableHead()).mockReturnValueOnce(pendingDownload);
    render(<AgentMessageContent text="[Отчёт](reports/final.md)" threadId="thread-1" />);

    const link = await screen.findByRole('link', { name: 'Отчёт' });
    fireEvent.click(link);
    fireEvent.click(link);

    expect(link.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('Скачивание');
    expect(fetch).toHaveBeenCalledTimes(2);

    const timeoutSpy = vi.spyOn(window, 'setTimeout');
    finishDownload(new Response(new Blob(['ready']), { status: 200 }));
    await waitFor(() => expect(link.getAttribute('aria-busy')).toBeNull());
    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
    const revokeCall = timeoutSpy.mock.calls.find((call) => call[1] === 60_000);
    expect(revokeCall).toBeDefined();
    const revoke = revokeCall?.[0];
    if (typeof revoke === 'function') revoke();
    expect(revokeObjectUrlMock).toHaveBeenCalledWith('blob:project-file');
  });

  it('offers a retry after a network availability error', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(availableHead());
    render(<AgentMessageContent text="[Отчёт](reports/final.md)" threadId="thread-1" />);

    expect(await screen.findByRole('alert')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('link', { name: 'Отчёт' })).not.toBeNull();
  });

  it('normalizes query and fragment suffixes while rejecting unsafe relative paths', async () => {
    vi.mocked(fetch).mockResolvedValue(availableHead());
    render(
      <AgentMessageContent
        text={
          '[Отчёт](reports/report.md?download=1#section) [Traversal](../secret.txt) [Encoded](%2e%2e/secret.txt) [Unsafe](javascript:alert(1)) [Mail](mailto:test@example.test) [Root](/help) [Fragment](#part) [External](https://example.test/report)'
        }
        threadId="thread-1"
      />,
    );

    const report = await screen.findByRole('link', { name: 'Отчёт' });
    expect(report.getAttribute('href')).toBe(
      '/api/threads/thread-1/project-files/download?path=reports%2Freport.md',
    );
    expect(screen.getByText('Traversal').closest('a')).toBeNull();
    expect(screen.getByText('Encoded').closest('a')).toBeNull();
    expect(screen.getByText('Unsafe').closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: 'Mail' }).getAttribute('href')).toBe(
      'mailto:test@example.test',
    );
    expect(screen.getByRole('link', { name: 'Root' }).getAttribute('href')).toBe('/help');
    expect(screen.getByRole('link', { name: 'Fragment' }).getAttribute('href')).toBe('#part');
    expect(screen.getByRole('link', { name: 'External' }).getAttribute('href')).toBe(
      'https://example.test/report',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves availability and a busy download across a parent rerender', async () => {
    let finishDownload!: (response: Response) => void;
    const pendingDownload = new Promise<Response>((resolve) => {
      finishDownload = resolve;
    });
    vi.mocked(fetch).mockResolvedValueOnce(availableHead()).mockReturnValueOnce(pendingDownload);
    const { rerender } = render(
      <AgentMessageContent text="Готово: [Отчёт](reports/final.md)" threadId="thread-1" />,
    );

    const link = await screen.findByRole('link', { name: 'Отчёт' });
    fireEvent.click(link);
    rerender(
      <AgentMessageContent text="Обновлено: [Отчёт](reports/final.md)" threadId="thread-1" />,
    );

    const rerenderedLink = screen.getByRole('link', { name: 'Отчёт' });
    expect(rerenderedLink.getAttribute('aria-busy')).toBe('true');
    expect(fetch).toHaveBeenCalledTimes(2);

    finishDownload(new Response(new Blob(['ready']), { status: 200 }));
    await waitFor(() => expect(rerenderedLink.getAttribute('aria-busy')).toBeNull());
  });

  it('aborts a pending controlled download on unmount without creating an object URL', async () => {
    let finishDownload!: (response: Response) => void;
    let downloadSignal: AbortSignal | undefined;
    const pendingDownload = new Promise<Response>((resolve) => {
      finishDownload = resolve;
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(availableHead())
      .mockImplementationOnce((_input, init) => {
        downloadSignal = init?.signal ?? undefined;
        return pendingDownload;
      });
    const { unmount } = render(
      <AgentMessageContent text="[Отчёт](reports/final.md)" threadId="thread-1" />,
    );

    fireEvent.click(await screen.findByRole('link', { name: 'Отчёт' }));
    unmount();
    expect(downloadSignal?.aborted).toBe(true);

    await act(async () => {
      finishDownload(new Response(new Blob(['late']), { status: 200 }));
      await pendingDownload;
    });
    expect(createObjectUrlMock).not.toHaveBeenCalled();
  });

  it('keeps confirmed large files on the browser streaming path without a Blob GET', async () => {
    vi.mocked(fetch).mockResolvedValue(availableHead(16 * 1024 * 1024 + 1));
    render(<AgentMessageContent text="[Архив](reports/large.zip)" threadId="thread-1" />);

    const link = await screen.findByRole('link', { name: 'Архив' });
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(createObjectUrlMock).not.toHaveBeenCalled();
  });
});
