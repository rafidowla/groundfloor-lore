/**
 * ChatMarkdown — Markdown + Mermaid + syntax-highlighted code renderer
 * for chat bubbles (V2.2).
 *
 * Why a dedicated component: the chat input accepts plain text, the
 * LLM output is commonly Markdown (especially BYOK models like Claude
 * / GPT-4o which default to it), and diagrams are one of the most
 * useful outputs for a dev-intelligence tool. Plain <p>{text}</p>
 * throws all of that away. This component renders:
 *
 *   - Markdown with GFM (tables, strikethrough, task lists, URLs)
 *   - `inline code`, syntax-highlighted code blocks with a copy button
 *   - ```mermaid fences as rendered SVG diagrams
 *   - Safe HTML handling (react-markdown sanitizes by default;
 *     we don't enable rehype-raw)
 *
 * The Mermaid integration is isolated to a single <MermaidBlock>
 * child so dynamic-importing mermaid only pays the cost when a
 * mermaid code block actually appears — text-only answers don't
 * load the ~500 KB library.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/** Copy-to-clipboard button used on all code blocks. Minimal inline
 *  styling so it doesn't drag in a whole UI library. */
function CopyButton({ text }: { text: string }): ReactNode {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            className="chat-code-copy"
            onClick={() => {
                void navigator.clipboard.writeText(text).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                });
            }}
            aria-label="Copy code"
        >
            {copied ? 'copied' : 'copy'}
        </button>
    );
}

/** Mermaid SVG renderer. Loads the library lazily per-component the
 *  first time any ```mermaid fence appears in any bubble. Subsequent
 *  blocks reuse the cached import. Errors render the raw text + a
 *  red "diagram error" strip instead of swallowing — a user whose
 *  LLM produces broken Mermaid sees the offense. */
function MermaidBlock({ source }: { source: string }): ReactNode {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const mermaidModule = await import('mermaid');
                const mermaid = mermaidModule.default;
                // Initialize once — mermaid tracks its own config
                // globally and no-ops on repeat initialize calls.
                mermaid.initialize({
                    startOnLoad: false,
                    securityLevel: 'strict',
                    theme: 'default',
                    // Deterministic SVG IDs help React keep things stable.
                    deterministicIds: true,
                });
                const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
                const { svg } = await mermaid.render(id, source);
                if (!cancelled && containerRef.current) {
                    containerRef.current.innerHTML = svg;
                }
            } catch (err) {
                if (!cancelled) {
                    setError((err as Error).message);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [source]);

    if (error) {
        return (
            <div className="chat-mermaid-error">
                <strong>Diagram error:</strong> {error}
                <pre>{source}</pre>
            </div>
        );
    }
    return <div className="chat-mermaid" ref={containerRef} />;
}

/** react-markdown custom renderers — intercept code blocks to route
 *  ```mermaid to MermaidBlock and add the copy button to every other
 *  fenced block. Inline code uses the default <code>. */
const components: Components = {
    code(props) {
        // The v8+ react-markdown shape is: { className, children, node, ... }
        // Inline code does NOT include a className. Fenced blocks always
        // include one (even if the language is unknown → 'language-').
        const { className, children, ...rest } = props as {
            className?: string;
            children?: ReactNode;
        };
        const childText = String(children ?? '').replace(/\n$/, '');
        const langMatch = /language-(\w+)/.exec(className ?? '');
        const lang = langMatch ? langMatch[1] : null;

        if (!lang) {
            // Inline code.
            return <code className={className} {...rest}>{children}</code>;
        }
        if (lang === 'mermaid') {
            return <MermaidBlock source={childText} />;
        }
        return (
            <div className="chat-code-block">
                <div className="chat-code-header">
                    <span className="chat-code-lang">{lang}</span>
                    <CopyButton text={childText} />
                </div>
                <pre>
                    <code className={className} {...rest}>{children}</code>
                </pre>
            </div>
        );
    },
    // Links open in a new tab by default so the user doesn't lose
    // their chat state when following a reference.
    a(props) {
        return <a {...props} target="_blank" rel="noopener noreferrer" />;
    },
};

export function ChatMarkdown({ source }: { source: string }): ReactNode {
    return (
        <div className="chat-markdown">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={components}
            >
                {source}
            </ReactMarkdown>
        </div>
    );
}
