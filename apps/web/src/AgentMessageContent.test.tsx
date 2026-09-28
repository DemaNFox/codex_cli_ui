import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentMessageContent } from './AgentMessageContent.js';

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
});
