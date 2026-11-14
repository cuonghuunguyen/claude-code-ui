import { Children, isValidElement, type ComponentProps } from "react";

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
  // As streamdown's own `p`: an image-only paragraph (or a block code) goes out of the <p>, a <div> inside it is invalid DOM.
  const kids = Children.toArray(children).filter((c) => !(typeof c === "string" && !c.trim()));
  if (kids.length === 1 && isValidElement<{ node?: { tagName?: string }; "data-block"?: unknown }>(kids[0])) {
    const el = kids[0];
    if (el.props.node?.tagName === "img" || (el.props.node?.tagName === "code" && el.props["data-block"] !== undefined)) return <>{children}</>;
  }
  const first = Array.isArray(children) ? children[0] : children;
  const block = typeof first === "string" && /^\s*(?:\$\$|\\\[)/.test(first);
  return (
    <p {...rest} className={[className, block && "min-h-14"].filter(Boolean).join(" ") || undefined}>
      {children}
    </p>
  );
}
