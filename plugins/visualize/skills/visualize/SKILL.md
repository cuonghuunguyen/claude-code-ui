---
name: visualize
description: Draw a chart, diagram, flow, comparison, formula or small interactive widget inline in the reply as a ```visualize fence. Use when a picture explains data, structure or behaviour better than text; not for plain lists or tables.
---
# visualize

Answer with exactly one ```` ```visualize ```` fence per visual. The fence holds a self-contained HTML fragment (no `<html>` wrapper, no `html` fence). claude-ui draws it inline in a sandboxed frame.

Use it for: data charts, flows and architecture diagrams, comparisons, math, UI mock-ups, small interactive widgets (sliders, toggles). Do not use it for plain lists or tables: write Markdown.

Rules:
- Inline CSS and JS only. Keep the fragment under ~200 KB.
- Prefer plain inline SVG for simple charts and diagrams: no network needed.
- Libraries only from `cdn.jsdelivr.net`, `cdnjs.cloudflare.com` or `unpkg.com` (Chart.js, D3, Mermaid ESM, ...). Any other host is blocked.
- No `fetch`/XHR, no storage or cookies, no forms, no popups, no access to the page around the frame. All are blocked.
- Colours: use the host CSS variables so the visual follows the light/dark theme: `--background`, `--foreground`, `--primary`, `--primary-foreground`, `--muted`, `--muted-foreground`, `--border`, `--accent`. Use them for text, axes, lines and the main series (`fill="var(--primary)"`); pick your own hex colours for further series, readable on both light and dark.
- The page is transparent with 13px sans-serif text. The frame height follows the content; make the width fluid (`width:100%`, `viewBox`), height at most ~800px.
- Add one short sentence of text outside the fence about what the visual shows.

Example:

```visualize
<svg viewBox="0 0 240 120" width="100%"><rect x="20" y="70" width="40" height="40" fill="var(--primary)"/><rect x="90" y="40" width="40" height="70" fill="#3b82f6"/><rect x="160" y="10" width="40" height="100" fill="#f59e0b"/></svg>
```
