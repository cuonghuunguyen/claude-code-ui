import type { ComponentProps } from "react";

/**
 * Stand-ins while the math and mermaid plugins load (GH-790). Each reserves about the height of the final render, so the
 * text below does not jump when the plugin arrives (layout shift of 0.19 at 390 px without them).
 */

/** Rendered by streamdown for a ```mermaid fence until the mermaid plugin has loaded. */
export function MermaidPlaceholder() {
  return <div data-testid="mermaid-placeholder" aria-busy="true" className="my-4 min-h-44 rounded-lg border border-border bg-muted/30" />;
}

/** The `p` of a text while the math plugin loads: a paragraph that starts with a `$$` block keeps the room of a display formula. */
export function MathPlaceholderParagraph({ node: _node, children, className, ...rest }: ComponentProps<"p"> & { node?: unknown }) {
  const first = Array.isArray(children) ? children[0] : children;
  const block = typeof first === "string" && /^\s*(?:\$\$|\\\[)/.test(first);
  return (
    <p {...rest} className={[className, block && "min-h-14"].filter(Boolean).join(" ") || undefined}>
      {children}
    </p>
  );
}
