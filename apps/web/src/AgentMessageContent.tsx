import { useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { normalizeProjectFilePath, ProjectFileDownload } from './ProjectFileDownload.js';

const EXTERNAL_WEB_URL = /^(?:https?:)?\/\//i;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const staticMarkdownComponents: Components = {
  img: ({ node, alt }) => {
    void node;
    return <span className="markdown-image-alt">{alt ?? ''}</span>;
  },
  table: ({ node, ...props }) => {
    void node;
    return (
      <div className="markdown-table-scroll" role="region" aria-label="Таблица" tabIndex={0}>
        <table {...props} />
      </div>
    );
  },
};

export function AgentMessageContent({ text, threadId }: { text: string; threadId?: string }) {
  const markdownComponents = useMemo<Components>(
    () => ({
      ...staticMarkdownComponents,
      a: ({ node, href, children, ...props }) => {
        void node;
        if (!href) return <span>{children}</span>;
        const external = EXTERNAL_WEB_URL.test(href);
        const preserved =
          external || href.startsWith('/') || href.startsWith('#') || URI_SCHEME.test(href);
        if (!preserved && threadId) {
          const projectPath = normalizeProjectFilePath(href);
          if (!projectPath) return <span>{children}</span>;
          return (
            <ProjectFileDownload
              threadId={threadId}
              path={projectPath}
              className="generated-file-link"
            >
              {children}
            </ProjectFileDownload>
          );
        }
        return (
          <a
            {...props}
            href={href}
            rel={external ? 'noopener noreferrer' : undefined}
            target={external ? '_blank' : undefined}
          >
            {children}
          </a>
        );
      },
    }),
    [threadId],
  );
  return (
    <div className="message-text markdown-content">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
        urlTransform={defaultUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
