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
- The list is also in `packages/protocol/src/addon-parts.ts` (`PARTS`, `PARTS_VERSION`).

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
| `session-area` | The open session: header, timeline, prompt box | | 1.5 |
| `session-header` | Header of the open session | | 1.5 |
| `tab` | One tab in the tab strip | `data-state`: same values as `session-item`; `data-active` on the open tab | 1.5 |
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
| `plan-window` | One usage window row of the plan meter | `data-level` | 1.5 |
| `prompt-box` | The prompt box | | 1.5 |
| `prompt-toolbar` | Toolbar row of the prompt box | | 1.5 |
| `markdown-toolbar` | Markdown formatting toolbar | | 1.5 |
| `send` | Send button (not the stop button) | `data-state`: `idle`, `running`, `needs_input`, `disconnected` | 1.5 |
| `context-meter` | Context usage meter | | 1.5 |
| `context-bar` | Bar inside the context usage popup | | 1.5 |
| `status-bar` | Status line under the prompt box | | 1.5 |
| `focus-page` | The Focus page | | 1.5 |
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

## Changelog {#changelog}

- Parts version 1: the parts above.
