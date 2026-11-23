# Addon parts {#addon-parts}

A theme addon styles claude-ui with CSS. To find the element to style, select a **part**: an element that carries `data-part="<name>"`. A part name is stable. The class names and the `data-testid` values of the app are not: they may change in any release and break your theme.

```css
:root[data-theme="addon:my-addon:night"] [data-part="user-message"] {
  border-left: 3px solid var(--primary);
}
:root[data-theme="addon:my-addon:night"] [data-part="tab"][data-state="running"] {
  outline: 1px solid var(--ring);
}
```

## Rules {#rules}

- Select `[data-part="..."]`, never `[data-testid="..."]`. `data-testid` is a test hook.
- State is an attribute on the part itself. The table lists the attributes a part has. Other attributes are not part of the contract.
- A part is removed only after one minor release in which it is marked **deprecated** in the table. A new part gets a `since` version.
- Parts marked **reserved** are named already, but the app does not render them yet.
- The list is also in `packages/protocol/src/addon-parts.ts` (`PARTS`, `PART_NAMES`, `PartName`, `PARTS_VERSION`).

## Cascade {#cascade}

The CSS file of an addon (`css` in `addon.json`) is loaded in its own cascade layer, `addon.<name>`, after the styles of the app itself. Order: `theme, base, components, utilities, host, addon`.

- Your rules win over the app's rules without `!important` and without a long selector. Do not add `!important` to win over the app.
- Exception, libraries: the styles of CodeMirror (`.cm-*`, the file editor), the terminal (`.xterm*`), KaTeX (`.katex*`) and the code highlighter are not in a layer, so they beat your rules whatever the selector. Add `!important` to override them.
- Exception: a declaration with `!important` inside the app's built-in Neon theme beats yours, and only while Neon is the picked theme.
- An inline `style` attribute of an element still wins over a layer. Add `!important` in your rule to override it. A few app elements use Tailwind `!important` utilities (for example `px-0!`); they beat your `!important` too.
- Your own layers inside the file work as usual, for example `@layer base, effects;`; they sit inside `addon.<name>`.

## Lifecycle {#lifecycle}

Attributes that say what the open session is doing, so a theme can react. The app sets them from the session state, for every engine (Claude Code and OpenCode).

| Attribute | On | Value |
|---|---|---|
| `data-phase` | `session-area` and `<html>`, for the open session | `thinking` (a turn runs, an OpenCode retry too), `waiting` (a permission or a question needs you), `idle`. On the Focus page and a new tab: `idle`. |
| `data-just-finished` | `session-area` | Present for 1200 ms after the open session went from `thinking` to `idle`. Gone when a new turn starts. Not set after `waiting`, and not when you switch to another session. |
| `data-focus-opened` | `focus-page` | Present for 1200 ms after the Focus page opens. |
| `data-motion` | `<html>` | `on` or `off`. `off` while the system asks for reduced motion (live). |
| `data-page-hidden` | `<html>` | Present while the browser tab is hidden. The app pauses every CSS animation then, yours included (`animation-play-state: paused !important` in the `host` layer, which beats your `!important`). |

```css
[data-part="session-area"][data-just-finished] { animation: flash 1.2s ease-out; }
:root[data-motion="off"] * { animation: none !important; }
```

The 1200 ms hold is on purpose: a CSS animation stops when its selector stops matching, so one frame is too short.

Performance budget for animations:

- Animate `transform` and `opacity` only. Do not animate `filter`, `box-shadow` or `backdrop-filter` on large surfaces.
- Few infinite animations (3 or less at the same time). Prefer one on the whole page to one per row.
- Respect `data-motion="off"`: a theme with motion needs a still version.

## Parts {#parts}

| Part | Element | State attributes | Since |
|---|---|---|---|
| `titlebar` | Top bar with the tab strip | | 1.5 |
| `sidebar` | Session list column | | 1.5 |
| `session-item` | One session button in the sidebar | `data-state`: `running`, `needs_input`, `idle`, `error`, `closed` | 1.5 |
| `session-search` | Search box of the session list | | 1.5 |
| `group-toggle` | Project group header in the session list | | 1.5 |
| `day-header` | Day heading in the session list | | 1.5 |
| `work-area` | Column that holds the session area and the bottom panel | | 1.5 |
| `session-area` | The open session: header, timeline, prompt box | `data-phase`: `thinking`, `waiting`, `idle`; `data-just-finished` (see [Lifecycle](#lifecycle)) | 1.5 |
| `session-header` | Header of the open session | | 1.5 |
| `tab` | One tab in the tab strip | `data-state`: `new`, `running`, `needs_input`, `unread`, `idle`; `data-active` on the open tab | 1.5 |
| `focus-tab` | The Focus tab | | 1.5 |
| `terminal-tab` | One terminal tab | | 1.5 |
| `side-panel` | Panel next to the chat (files, changes, graph) | | 1.5 |
| `files-panel` | Files pane | | 1.5 |
| `file-tree` | File tree inside the files pane | | 1.5 |
| `graph-panel` | Git graph pane | | 1.5 |
| `terminal` | Terminal panel | | 1.5 |
| `user-message` | A message you sent | | 1.5 |
| `assistant-text` | A text reply of Claude | | 1.5 |
| `thinking` | The thinking row | | 1.5 |
| `tool-card` | A tool call | `data-status`: `pending`, `running`, `done`, `error`, `denied`, `stopped` | 1.5 |
| `permission-panel` | Permission question above the prompt box | | 1.5 |
| `question-panel` | Question from Claude above the prompt box | | 1.5 |
| `plan-window` | One usage window row of the plan meter | `data-level`: `ok`, `warning`, `limit` | 1.5 |
| `prompt-box` | The prompt box | | 1.5 |
| `prompt-toolbar` | Toolbar row of the prompt box | | 1.5 |
| `markdown-toolbar` | Markdown formatting toolbar | | 1.5 |
| `send` | Send button (not the stop button) | `data-state`: `idle`, `running`, `needs_input`, `disconnected` | 1.5 |
| `context-meter` | Context usage meter | | 1.5 |
| `context-bar` | Bar inside the context usage popup | | 1.5 |
| `status-bar` | Status line under the prompt box | | 1.5 |
| `focus-page` | The Focus page | `data-focus-opened` (see [Lifecycle](#lifecycle)) | 1.5 |
| `focus-row` | One row of the Focus list | | 1.5 |
| `focus-queue` | Queue column of the Focus page | | 1.5 |
| `toast-region` | Area that holds the toasts | | 1.5 |
| `scroll-to-bottom` | Button that jumps to the newest message | | 1.5 |
| `palette` | Command palette | | 1.5 |
| `commit-message` | Commit message field | | 1.5 |
| `changed-file` | One file row in the changes list | | 1.5 |
| `file-diff` | Diff of one file | | 1.5 |
| `loader` | Reserved: the loading mark of a running turn | | 1.5 |
| `done-icon` | Reserved: the done mark of a finished tool call | | 1.5 |
| `backdrop` | Reserved: full-window background layer | | 1.5 |

## Checks {#checks}

The Addons dialog lists **Checks** under each addon: warnings from the addon lint. A warning never blocks an install or an enable. Each shows the file and, where it has one, the line.

| Check | Meaning | Fix |
|---|---|---|
| `selects-testid` | A selector uses `[data-testid]`. It is a test hook and changes without notice. | Select `[data-part="..."]`. |
| `unknown-part` | `[data-part="x"]` names a part that is not in the table. It matches nothing. | Fix the name (see the table). |
| `unprefixed-name` | An `@keyframes`, `@font-face` family or `@property` name has no addon prefix. These names are global and can replace a name of the app. The daemon renames the `@keyframes`, `@counter-style` and `@font-palette-values` of a `themes[].css` itself (the top-level `css` is not renamed); `@font-face` and `@property` stay global. | Name it `<addon>-name` (`--<addon>-name` for `@property`). |
| `top-level-css` | `css` in `addon.json` applies to every theme, and the addon has themes. | Move it to `themes[].css`. |
| `css-broken` | The CSS does not parse: an unclosed block, comment or `url(`, a stray `}`, or groups nested over 32 deep. A theme CSS is then served empty: the theme keeps its palette and loses its rules. | Fix it. |
| `css-too-large` | The file is larger than 512 KB. A theme CSS is then served empty: the theme keeps its palette and loses its rules. | Split or shrink it. |

A selector with `^=`, `$=`, `*=` or `|=` on `data-part` is not checked.

## Changelog {#changelog}

- Parts version 1: the parts above.
- Lifecycle attributes `data-phase`, `data-just-finished`, `data-focus-opened`, `data-motion`, `data-page-hidden` (not a part change).
