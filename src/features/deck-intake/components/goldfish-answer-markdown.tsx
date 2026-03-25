import ReactMarkdown from "react-markdown"

type GoldfishAnswerMarkdownProps = {
  content: string
}

export function GoldfishAnswerMarkdown({
  content,
}: GoldfishAnswerMarkdownProps) {
  return (
    <div className="mt-2 text-sm leading-6 text-stone-300">
      <ReactMarkdown
        components={{
          h1: ({ node: _node, ...props }) => (
            <h1
              className="mt-4 mb-2 text-xl font-semibold tracking-tight text-stone-50 first:mt-0"
              {...props}
            />
          ),
          h2: ({ node: _node, ...props }) => (
            <h2
              className="mt-4 mb-2 text-lg font-semibold tracking-tight text-stone-100 first:mt-0"
              {...props}
            />
          ),
          h3: ({ node: _node, ...props }) => (
            <h3
              className="mt-4 mb-2 text-base font-semibold text-stone-100 first:mt-0"
              {...props}
            />
          ),
          p: ({ node: _node, ...props }) => (
            <p className="my-2 whitespace-pre-wrap first:mt-0 last:mb-0" {...props} />
          ),
          ul: ({ node: _node, ...props }) => (
            <ul className="my-2 list-disc space-y-1 pl-5" {...props} />
          ),
          ol: ({ node: _node, ...props }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />
          ),
          li: ({ node: _node, ...props }) => <li className="pl-1" {...props} />,
          blockquote: ({ node: _node, ...props }) => (
            <blockquote
              className="my-3 border-l-2 border-amber-400/40 bg-black/20 px-4 py-2 italic text-stone-300"
              {...props}
            />
          ),
          a: ({ node: _node, ...props }) => (
            <a
              className="text-sky-300 underline decoration-sky-400/60 underline-offset-4 transition hover:text-sky-200"
              target="_blank"
              rel="noreferrer"
              {...props}
            />
          ),
          code: ({ node: _node, className, children, ...props }) => {
            const isBlock = Boolean(className)

            if (isBlock) {
              return (
                <code
                  className="block overflow-x-auto rounded-2xl border border-white/10 bg-stone-950/90 px-4 py-3 font-mono text-[13px] leading-6 text-emerald-200"
                  {...props}
                >
                  {children}
                </code>
              )
            }

            return (
              <code
                className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[13px] text-amber-100"
                {...props}
              >
                {children}
              </code>
            )
          },
          pre: ({ node: _node, ...props }) => (
            <pre className="my-3 overflow-x-auto whitespace-pre-wrap" {...props} />
          ),
          hr: ({ node: _node, ...props }) => (
            <hr className="my-4 border-white/10" {...props} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
