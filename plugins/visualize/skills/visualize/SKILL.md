---
name: visualize
description: Draw a chart, diagram, flow, comparison, formula or small interactive widget inline in the reply as a ```visualize fence. Use when a picture explains data, structure or behaviour better than text; not for plain lists or tables.
---
# visualize

One ```` ```visualize ```` fence per visual. claude-ui draws it inline in a sandboxed frame.

How:
1. Write the visual as a self-contained HTML fragment (no `<html>` wrapper) with the Write tool to `visualize/<short-name>.html` inside the claude-ui uploads folder: the additional working directory whose path ends in `/uploads/<session id>`.
2. In the reply, put only that file's absolute path in the fence:

```visualize
/abs/path/to/uploads/<session id>/visualize/<short-name>.html
```

Writing the file keeps the HTML out of the streamed reply. No such uploads folder (other engine, no additional directory): put the HTML fragment itself in the fence instead.

Use it for: data charts, flows and architecture diagrams, comparisons, math, UI mock-ups, small interactive widgets (sliders, toggles). Do not use it for plain lists or tables: write Markdown.

Rules:
- Inline CSS and JS only. Keep the fragment under ~200 KB.
- Prefer plain inline SVG for simple charts and diagrams: no network needed.
- Libraries only from `cdn.jsdelivr.net`, `cdnjs.cloudflare.com` or `unpkg.com` (Chart.js, D3, Mermaid ESM, ...). Any other host is blocked.
- No `fetch`/XHR, no storage or cookies, no forms, no popups, no access to the page around the frame. All are blocked.
- Colours: use the host CSS variables so the visual follows the light/dark theme: `--background`, `--foreground`, `--primary`, `--primary-foreground`, `--muted`, `--muted-foreground`, `--border`, `--accent`. Use them for text, axes, lines and the main series (`fill="var(--primary)"`); pick your own hex colours for further series, readable on both light and dark.
- The page is transparent with 13px sans-serif text. The frame height follows the content; make the width fluid (`width:100%`, `viewBox`), height at most ~800px.
- The frame is as tall as the root box: keep every element in normal flow inside it. No `position:absolute`/`fixed` content outside the root box, no negative margins pushing out, no `100vh`/`100%`-height layouts; give the root an explicit height when a chart library needs one.
- Add one short sentence of text outside the fence about what the visual shows.

Example fragment (the file content, or the fence content without an uploads folder):

```visualize
<svg viewBox="0 0 240 120" width="100%"><rect x="20" y="70" width="40" height="40" fill="var(--primary)"/><rect x="90" y="40" width="40" height="70" fill="#3b82f6"/><rect x="160" y="10" width="40" height="100" fill="#f59e0b"/></svg>
```
