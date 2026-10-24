import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Answers are Markdown. Raw HTML is never rendered and links open in a new tab. */
export function Markdown({ text, typing = false }: { text: string; typing?: boolean }) {
  return (
    <div className={typing ? "markdown typing" : "markdown"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
