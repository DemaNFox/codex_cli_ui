import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const EXTERNAL_WEB_URL = /^(?:https?:)?\/\//i;

const markdownComponents: Components = {
  a: ({ node, href, children, ...props }) => {
    void node;
    if (!href) return <span>{children}</span>;
    const external = href ? EXTERNAL_WEB_URL.test(href) : false;
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

export function AgentMessageContent({ text }: { text: string }) {
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
