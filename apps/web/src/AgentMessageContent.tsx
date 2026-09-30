import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const EXTERNAL_WEB_URL = /^(?:https?:)?\/\//i;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

function projectFileDownload(
  threadId: string | undefined,
  href: string,
): { url: string; name: string } | null {
  if (
    !threadId ||
    href.startsWith('/') ||
    href.startsWith('#') ||
    EXTERNAL_WEB_URL.test(href) ||
    URI_SCHEME.test(href)
  )
    return null;
  let decodedHref: string;
  try {
    decodedHref = decodeURIComponent(href);
  } catch {
    return null;
  }
  const name = decodedHref.split(/[\\/]/).at(-1)?.trim();
  if (!name) return null;
  return {
    url: `/api/threads/${encodeURIComponent(threadId)}/project-files/download?path=${encodeURIComponent(decodedHref)}`,
    name,
  };
}

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
  const markdownComponents: Components = {
    ...staticMarkdownComponents,
    a: ({ node, href, children, ...props }) => {
      void node;
      if (!href) return <span>{children}</span>;
      const external = EXTERNAL_WEB_URL.test(href);
      const download = projectFileDownload(threadId, href);
      return (
        <a
          {...props}
          className={download ? 'generated-file-link' : props.className}
          href={download?.url ?? href}
          download={download?.name}
          rel={external ? 'noopener noreferrer' : undefined}
          target={external ? '_blank' : undefined}
          title={download ? 'Скачать файл из проекта' : props.title}
        >
          {children}
        </a>
      );
    },
  };
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
