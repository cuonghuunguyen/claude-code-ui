---
name: write-addon
description: >-
  Write, extend or fix a claude-ui addon: a folder with addon.json and sandboxed HTML views that
  adds a colour theme, a pane next to the chat, a band above the prompt box, a slash command
  `/<addon>:<cmd>` or a renderer for a code-fence language or a tool's result to the claude-ui web
  app. Scaffolds the manifest, copies the typed addon SDK (claude-ui-addon.js + .d.ts), writes
  `// @ts-check` view scripts and type-checks them. Use when the user asks for a claude-ui addon,
  theme, pane, band, addon command or renderer, or to change one. Not for Claude Code plugins,
  skills, hooks or mods: those change Claude Code, an addon changes the claude-ui browser app.
---

# Write a claude-ui addon

An addon is a folder. claude-ui serves its files as committed (no build) into iframes with
`sandbox="allow-scripts"`: no cookies, no storage, no parent DOM, no inline scripts, no network
except the `net:` origins the owner approves. Everything else goes through the bridge, which the
SDK wraps. Full reference: `docs/site/features/addons.md` in the claude-ui repository
(https://github.com/cuonghuunguyen/claude-code-ui/blob/main/docs/site/features/addons.md).
Complete working example: `examples/addons/example/`.

## 1. Pin down what the addon does

Map each wish to a part and the capabilities it needs. Ask only when the wish fits none of them.

| Wish | Manifest | Capabilities |
| --- | --- | --- |
| Colours of the whole app | `themes` (and/or `css`) | none |
| A panel next to the chat | `views[] kind: "pane"` | `ui.pane` |
| A strip above the prompt box | `views[] kind: "band"` | `ui.band` |
| `/<addon>:<cmd>` that fills the prompt box | `commands`, `commandsEntry` | `ui.command`, `prompt.insert` |
| Draw ` ```<lang> ` blocks | `renderers[] {fence}` | `render.fence:<lang>` |
| Draw a tool's result | `renderers[] {tool}` | `render.tool:<tool name>` |
| Read the session's messages and tool calls | in a pane, band or command | `session.read` |
| Status bar text, toasts | | `ui.status`, `ui.toast` |
| Debug lines the owner can read in the Addons dialog | `log(text, level)` | `log` |
| Call an HTTP API | `fetch` from a view | `net:<origin>` (the API must allow CORS for `Origin: null`) |

Where code runs decides when it runs. A pane frame loads lazily: nothing runs until the user first
shows the pane, and a pane tab in the main area runs only while that tab exists. A band and the
hidden command frame load with the session that shows. Status text that must be current before the
pane was ever opened belongs in a band (or, with commands, the command frame). Choose the frame by
that, and tell the user which you chose and why.

Impossible, whatever is approved: send a prompt, read or write files, run shell or git, answer
permissions, read the session from a renderer (renderers get only `ui.ready` and `ui.toast`).
Say so instead of working around it.

Request no capability the addon does not use: the owner approves each one, and every new one in
an update needs approval again.

## 2. Scaffold

```
<addon>/
  addon.json
  claude-ui-addon.js      # SDK, copied, never edited
  claude-ui-addon.d.ts    # SDK types, copied, never edited
  <view>.html, <view>.js  # one pair per view, command handler or renderer
  jsconfig.json           # only for the type check
```

Copy the SDK of the claude-ui version the user runs (`claude-ui --version` prints it):

```sh
v=$(claude-ui --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
for f in claude-ui-addon.js claude-ui-addon.d.ts; do
  curl -fsSL "https://raw.githubusercontent.com/cuonghuunguyen/claude-code-ui/v$v/packages/addon-sdk/$f" -o "$f" ||
  curl -fsSL "https://raw.githubusercontent.com/cuonghuunguyen/claude-code-ui/main/packages/addon-sdk/$f" -o "$f"
done
```

From a claude-ui checkout, copy `packages/addon-sdk/claude-ui-addon.{js,d.ts}` instead. A tag
without the SDK (older than the SDK) falls back to `main`; then tell the user the SDK may be
newer than their claude-ui.

`addon.json`:

```json
{
  "name": "my-addon",
  "version": "0.1.0",
  "description": "One line shown in the Addons dialog",
  "capabilities": ["ui.pane", "session.read"],
  "views": [{ "id": "main", "title": "My pane", "entry": "pane.html", "kind": "pane" }]
}
```

- `name`: `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64. It namespaces commands (`/my-addon:cmd`) and
  pane ids, and never changes between versions.
- `views`: `{id, title, entry, kind: "pane" | "band", phone?}`; `phone: false` hides it below 640 px.
- `commands`: `{name, description, argumentHint?}`; `commandsEntry`: the `.html` that handles them
  (default: the first view's entry). It runs in a hidden frame per session.
- `renderers`: `{fence: "<lang>", entry}` or `{tool: "<tool name>", entry}`.
- `themes`: `{id, name, light?, dark?}`. A given mode needs all 19 keys as `#rrggbb`: `bg`, `card`,
  `side`, `fg`, `muted`, `border`, `primary`, `pfg`, `kw`, `str`, `fn`, `type`, `num`, `cmt`,
  `varc`, `err`, `warn`, `ok`, `info`. Copy the theme of `examples/addons/example/addon.json` and
  change the values; keep text on `bg`/`card` at a 4.5:1 contrast.
- `css`: one `.css` applied app-wide while enabled; it cannot load external images or `@import`.
- Paths are relative, without `..` or `\`, and must exist. Every view, command and renderer needs
  its capability, or install fails naming it.

Each `.html` loads its script as a module and has no inline script or style:

```html
<!doctype html>
<meta charset="utf-8" />
<link rel="stylesheet" href="pane.css" />
<div id="out"></div>
<script type="module" src="pane.js"></script>
```

`jsconfig.json`:

```json
{ "compilerOptions": { "checkJs": true, "strict": true, "target": "ES2023", "module": "ESNext", "moduleResolution": "Bundler", "lib": ["ES2023", "DOM", "DOM.Iterable"], "noEmit": true }, "exclude": ["claude-ui-addon.js", "*.test.mjs"] }
```

## 3. Write the views with the SDK

Start every script with `// @ts-check` and import from `./claude-ui-addon.js`.

| SDK | Use for |
| --- | --- |
| `watchSession(fn)` | Pane or band showing session data: `fn(parts)` after `init`, again with all parts on every change. Call at module top level |
| `on("command.run", (m) => …)` | Command handler: `m.name`, `m.args` |
| `on("render", (m) => …)` | Renderer: `"fence" in m` → `m.fence.lang`, `m.fence.source`; else `m.tool.name`, `.input`, `.result` |
| `on("init", (m) => …)`, `on("theme.changed", …)` | `m.addon`, `m.view`, `m.role`, `m.session`, `m.theme`, `m.mode` (`light`/`dark`) |
| `autoHeight()` | Every band and renderer: keeps the frame as tall as the content (band 24-160 px, renderer up to 480) |
| `insertPrompt(text)` | Fill the prompt box (≤ 32 KiB); the user sends it |
| `setStatus(text \| null)`, `toast(text)` | ≤ 80 and ≤ 200 characters |
| `log(text, level?)` | A line in the addon's log (≤ 500 characters, 20 per second); works in renderers too |
| `call(type, payload)` | Any request; rejects with `AddonError` (`code`: `refused`, `bad_request`, `unknown`) |

Parts: narrow by `p.type`. The useful ones: `user_text` and `assistant_text` (`text`),
`tool_call` (`tool`, `input`, `status`), `tool_result` (`toolUseId`, `output`, `isError`),
`turn_result` (`durationMs`, `costUsd`, `usage`), `todo_update` (`items`), `subagent`. The full
union is `Part` in `claude-ui-addon.d.ts`. A part is sent again when it changes (same `id`):
key by `id`, as `watchSession` does.

Rules:
- Build DOM with `textContent`/`createElement`, never `innerHTML` with session or tool data.
- Style through a `.css` file or `element.style`; inline `<style>` and `style=""` attributes are
  blocked by the frame's CSP.
- The SDK sets `color-scheme` from the app's mode; use `light-dark()` or
  `@media (prefers-color-scheme)` in CSS for your own colours.
- Keep a pane usable at 390 px wide: no fixed widths, wrap text.
- Put logic that is more than glue (a parser, sums, formatting) in its own module without DOM or
  bridge calls, and check it with a small `node:assert` script (`node <name>.test.mjs`). A frame
  is hard to debug: catching a parsing bug there costs a page reload and a guess.

## 4. Check

1. Types: `npx -y -p typescript tsc -p jsconfig.json` in the addon folder. Fix every error; never silence one
   with `any` or `@ts-ignore`.
2. Logic: run each `*.test.mjs`.
3. Manifest: every path exists; every view, command and renderer has its capability; no unused
   capability.
4. Run it (needs the user's claude-ui running; ask before touching their install): `/addons` in the
   prompt box › **Local folder** › absolute path of the addon › **Install** › **Approve and
   enable**. A local folder is re-read when the dialog opens: after an edit, reopen the dialog
   (and reload the page for view scripts). A row in **Error** names what failed; a refused call
   shows a toast and is listed under the addon's row.

Report to the user: the folder, what each part does, the capabilities it asks for and why, and
the type-check result.
