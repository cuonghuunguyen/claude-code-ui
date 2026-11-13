---
name: visualize
description: Draw a ```visualize fence beside the text whenever the reply covers architecture, flow, sequence, comparison, metrics, a UI mock-up, a plan or a tunable value. Also under terse styles. Plain lists and short answers stay text.
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

Draw one whenever the reply covers, also under terse styles and without being asked:
- How something is built or works: architecture, data flow, sequence, state machine, lifecycle, dependencies, ER model, file tree.
- Options or before/after: comparison, trade-offs.
- Numbers: chart, trend, benchmark, test or CI results, cost, progress.
- A UI or layout: mock-up, wireframe.
- A tunable value: slider, calculator, regex or cron tester.
- A formula or algorithm.
- A bug or review: call graph, root cause, request waterfall, risk by file.
- A plan: roadmap, ticket dependencies, decision tree, pipeline status.

Plain lists, tables and short answers stay Markdown.

In a question (AskUserQuestion), optional:
- The question text and each option's `preview` are Markdown: a `visualize` or `mermaid` fence there is drawn. Previews of all options show side by side, so use them to compare options (mock-ups, charts, diagrams).
- An interactive visual in the question or a preview can hand the user's pick to the answer field: `parent.postMessage({v:1,type:"answer",text:"..."},"*")` (string, at most 2000 characters). It fills the "own answer" field; the user still submits. Use it for answers that options cannot express: a slider value, a ranking, a point or area on a diagram.

Rules:
- Inline CSS and JS only. Keep the fragment under ~200 KB.
- Prefer plain inline SVG for simple charts and diagrams: no network needed.
- Libraries only from `cdn.jsdelivr.net`, `cdnjs.cloudflare.com` or `unpkg.com` (Chart.js, D3, Mermaid ESM, ...). Any other host is blocked.
- No `fetch`/XHR, no storage or cookies, no forms, no popups, no access to the page around the frame. All are blocked.
- Theme: the frame follows the app's light/dark mode and colour theme (Default, Catppuccin, Nord, ...) and recolours live on a switch. Every colour comes from a host CSS variable; never a hex, rgb or named colour, never a library's default palette.
  - Surfaces and text: `--background`, `--foreground`, `--card`, `--card-foreground`, `--secondary`, `--muted`, `--muted-foreground`, `--border`, `--accent`, `--ring`.
  - Emphasis: `--primary` with `--primary-foreground` on it.
  - Status: `--success`, `--warning`, `--destructive`, `--info`.
  - Series, in order: `--chart-1` … `--chart-8` (distinct hues, readable on `--background`).
  - Shape and type: `--radius`, `--font-sans`.
  - SVG: `fill="var(--chart-1)"`. JS (canvas, Chart.js, D3): read with `getComputedStyle(document.documentElement).getPropertyValue("--chart-1").trim()` and redraw on `addEventListener("themechange", draw)` (fired after a theme switch updates the variables; CSS `var()` updates by itself).
- The page has `--background`, `--foreground` text, 13px `--font-sans`. The frame height follows the content; make the width fluid (`width:100%`, `viewBox`), height at most ~800px.
- The frame is as tall as the root box: keep every element in normal flow inside it. No `position:absolute`/`fixed` content outside the root box, no negative margins pushing out, no `100vh`/`100%`-height layouts; give the root an explicit height when a chart library needs one.
- Add one short sentence of text outside the fence about what the visual shows.

Example fragment (the file content, or the fence content without an uploads folder):

```visualize
<svg viewBox="0 0 240 120" width="100%"><rect x="20" y="70" width="40" height="40" fill="var(--primary)"/><rect x="90" y="40" width="40" height="70" fill="var(--chart-2)"/><rect x="160" y="10" width="40" height="100" fill="var(--chart-3)"/></svg>
```
