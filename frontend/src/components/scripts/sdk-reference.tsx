"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useApi } from "@/lib/use-api";

/** The SDK manual (backend/sdk/sdk_reference.md), shared by /docs and the Studio. */
export function SdkReference({ compact = false }: { compact?: boolean }) {
  const { data, error } = useApi<{ markdown: string }>("/api/scripts/reference");
  if (error) return <p className="p-4 text-sm text-down">{error}</p>;
  if (!data) return <p className="p-4 text-sm text-muted">Loading reference…</p>;
  return (
    <article
      className={`prose max-w-none prose-headings:font-display prose-headings:text-fg prose-p:text-fg prose-li:text-fg prose-strong:text-fg prose-a:text-accent prose-code:rounded prose-code:bg-surface-2 prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.85em] prose-code:text-fg prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-border prose-pre:bg-bg prose-pre:text-fg prose-th:text-fg prose-td:text-fg prose-blockquote:border-accent prose-blockquote:text-muted ${compact ? "prose-sm" : ""}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {data.markdown}
      </ReactMarkdown>
    </article>
  );
}
