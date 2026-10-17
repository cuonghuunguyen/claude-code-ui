# Changelog

All notable changes to `claude-code-ui` (npm). Versions follow [Semantic Versioning](https://semver.org/).

## 0.7.0 - 2026-10-17

### Added

- Settings > Orchestration > Notifications from workers: turn it off and a worker that finishes, needs input or fails no longer sends push, desktop or in-app notifications (its coordinator still hears); a request the coordinator escalates to you still does ([#387](https://github.com/cuonghuunguyen/claude-code-ui/issues/387)).
- File dialog: the Files tab's Pop out button opens the tree, editor tabs and editor in a large dialog on the same state, so open tabs, unsaved edits, cursor and undo history carry over and back; a Read card, a file reference in assistant text and the tree's "Open in file dialog" open the file there at its line, and Open in editor returns to the Files tab ([#394](https://github.com/cuonghuunguyen/claude-code-ui/issues/394)).
- Files tab and file dialog look like the Changes tab: the tree sits beside the editor from 672px of panel width and is a drawer (Files button or Ctrl+\) below it, a path header with the breadcrumb, Pop out or Open in editor, Changes-style tabs, gutter and font, 44px targets on a phone, and the editor has the keyboard focus right after Pop out ([#394](https://github.com/cuonghuunguyen/claude-code-ui/issues/394)).
- Terminal docked at the bottom by default, under the session view and the side panel; Settings > Terminal or a move of its pane tab puts it back into the side panel. The bottom terminal resizes, maximizes, and has a titlebar toggle ([#354](https://github.com/cuonghuunguyen/claude-code-ui/issues/354)).
- Movable panes: Changes, Files, Git graph and Terminal are tabs of the side panel or the bottom panel. Move a pane with its tab's context menu (right click, Shift+F10, long press), the panel's ⋯ menu, or drag and drop; the side panel docks left or right; the layout is kept per browser and "Reset layout" restores the default. A moved pane keeps its state and its tab keeps the focus ([#355](https://github.com/cuonghuunguyen/claude-code-ui/issues/355), [#374](https://github.com/cuonghuunguyen/claude-code-ui/issues/374)).
- Movable panes: the side panel and the bottom panel reopen on the tab selected last after a reload, and on a phone the pane switcher reopens on the last selected pane; "Reset layout" forgets them ([#381](https://github.com/cuonghuunguyen/claude-code-ui/issues/381)).
- Clean up dialog: remove worktrees and workers in bulk from the palette, a project's or coordinator's menu, with Safe / Has work / Blocked badges, filters and a result summary. Any linked worktree inside the roots can be removed now, also one made by hand or by another tool (not a locked or symlinked one) ([#377](https://github.com/cuonghuunguyen/claude-code-ui/issues/377)).
- Sidebar context menus: right click, long press or Shift+F10 on a project or worktree row (new session or worktree, Hide inactive sessions, Archive idle sessions older than 1, 7 or 30 days, remove), on a worker row (Close worker, Remove worker… with an option to remove its worktree), on a coordinator or its "N workers" row (Close finished workers, Remove closed workers…) and on any session row (Copy session ID, Close tab) ([#358](https://github.com/cuonghuunguyen/claude-code-ui/issues/358)).
- Split view on screens from 1024px wide: show two session tabs side by side or stacked, each with its own timeline, prompt box and scroll. Use "Split right" or "Split down" in a session tab's context menu, or the palette; focus and layout shortcuts are rebindable in the keymap ([#356](https://github.com/cuonghuunguyen/claude-code-ui/issues/356)).
- Better file view: file-type icons and git status marks in the file tree, preview tabs (single click previews in italics, double click pins), a breadcrumb path and an unsaved marker above the editor, a rendered Markdown preview, clear messages for binary or large files, and file paths in chat that open in the Files tab at the line ([#357](https://github.com/cuonghuunguyen/claude-code-ui/issues/357)).
- Tab context menu: Close other tabs, Close tabs to the right, Close all tabs (with a "Closed N tabs" toast and Undo), Pin tab, Copy session ID and Reveal in sidebar. The close and pin commands are also in the palette and the keymap ([#359](https://github.com/cuonghuunguyen/claude-code-ui/issues/359)).
- File tree context menu (right click, long press or Shift+F10): create a file or folder, rename (F2), duplicate, delete (Delete key, with confirmation), copy path, and add a file to the prompt as an @mention; the same actions are available on empty tree space ([#360](https://github.com/cuonghuunguyen/claude-code-ui/issues/360)).
- Keep screen awake: a coffee button in the titlebar, a switch in Settings > Screen and the palette command "Toggle keep screen awake" hold the screen on while claude-ui is open, optionally only while a session is running. It is kept per browser ([#361](https://github.com/cuonghuunguyen/claude-code-ui/issues/361)).
- Clean up tabs: "Clean up tabs…" in the tab menu and the palette, "Clean up group" on a group chip and the phone close button close idle, finished, archived or deleted, worker or long unused tabs by rule, with counts, a "Closed N tabs" toast and Undo. Active, pinned, running and unread tabs are kept ([#378](https://github.com/cuonghuunguyen/claude-code-ui/issues/378)).

### Changed

- Code colors: the editor and every diff (Changes tab, tool cards, popup) use one palette, pierre's hues made dark enough (light) or light enough (dark) to read at 4.5:1 on the code background, the active line and the added and removed lines; the dark diff sits on the card surface, and the editor now colours parameters, operators, decorators, JSON keys, CSS and Markdown like the diff does ([#394](https://github.com/cuonghuunguyen/claude-code-ui/issues/394)).
- The artifact preview loads the supporting files of a multi-file publish (CSS, scripts, images, fonts, JSON) that sit in the project or next to the page; files it does not serve are named under the preview ([#335](https://github.com/cuonghuunguyen/claude-code-ui/issues/335)).
- The "Run session in" chip and menu name the main checkout "Primary worktree" (were "Local" and "Local repository").

### Fixed

- Files tab: the file tree fills the tab while no file is open, instead of an empty editor area with "Open a file from the tree.".
- The Changes tab's file list beside the diff can be resized: drag its edge or press ←/→ on it (kept per browser, double click restores the default width).
- Moving a pane tab on a slow connection: a key pressed before the terminal has loaded no longer lets the terminal take the focus from the control you tabbed to ([#382](https://github.com/cuonghuunguyen/claude-code-ui/issues/382)).
- Phone: sending the first message from the New session tab shows the new session, instead of jumping back to another open tab once the tab switcher had been used; a /clear keeps showing its new session the same way ([#417](https://github.com/cuonghuunguyen/claude-code-ui/issues/417)).

## 0.6.0 - 2026-10-15

### Added

- `claude-ui` opens the web UI in this computer's browser when it starts. Turn it off with `--no-open` or `CLAUDE_UI_OPEN=0`. It does not open after an update restart, over SSH, or on Linux without a display.
- Queue a message while Claude works: Alt+Enter adds it as a chip above the prompt box, and it is sent when Claude is idle. Settings > Sending picks what Enter does while Claude works (steer, the default, or queue); Alt+Enter does the other, and a hint above the send button says which ([#77](https://github.com/cuonghuunguyen/claude-code-ui/issues/77)).
- Git graph: a Fetch button and a branch menu with push, force push and pull ([#221](https://github.com/cuonghuunguyen/claude-code-ui/issues/221)).
- The agent map shows orchestration workers with their live state ([#254](https://github.com/cuonghuunguyen/claude-code-ui/issues/254)).
- The artifact publish card shows a sandboxed local preview of the page ([#175](https://github.com/cuonghuunguyen/claude-code-ui/issues/175)).
- Client commands: `claude-ui status`, `open`, `sessions` (`ls`), `projects` and `workers` ask the running daemon from another terminal, with `--json`. The daemon writes `daemon.json` (port, pid, version) to its config folder. `claude-ui update` does not replace the global launcher: run `npm i -g claude-code-ui` to get the new launcher (an old launcher marks the new version as failed when a client command exits non-zero within 10 seconds, for example when the daemon is not running).

### Changed

- `/clear` in a coordinator session keeps its workers: notices, permission requests and `worker_start` follow the new session ([#334](https://github.com/cuonghuunguyen/claude-code-ui/issues/334)).
- Usage errors (a bad flag or an unknown command) now exit 2 (were 1).

### Fixed

- `claude-ui update` that fails within 10 seconds no longer marks the running version as failed to start.
- Windows: a terminal whose shell exits by itself (`exit`) no longer stays in the daemon's memory; an error in node-pty's output pipe, output worker or process-list helper ends only that terminal instead of the daemon; input typed before the shell's first output counts against the 1 MiB input cap ([#268](https://github.com/cuonghuunguyen/claude-code-ui/issues/268)).
- WSL projects: the Git graph and git status run inside the distro ([#275](https://github.com/cuonghuunguyen/claude-code-ui/issues/275)); projects opened by their `\\wsl$` path also search and run the safety scan inside the distro ([#298](https://github.com/cuonghuunguyen/claude-code-ui/issues/298)).
- A WSL or Docker side builds node-pty against the side's own installed Node headers ([#260](https://github.com/cuonghuunguyen/claude-code-ui/issues/260)).

## 0.5.1 - 2026-10-10

### Fixed

- A WSL or Docker side no longer stops with "exit code 1" about 15 seconds after you open it: the daemon's keep-alive ping crashed it. When a side does stop, the message now ends with the last lines it printed ([#263](https://github.com/cuonghuunguyen/claude-code-ui/issues/263)).
- Windows: the daemon no longer crashes with `write EAGAIN` when a terminal is closed, or its shell ends, while it still has unread input; Windows terminal input is now capped at 1 MiB (`input_backlog`) like on macOS and Linux ([#266](https://github.com/cuonghuunguyen/claude-code-ui/issues/266)).

## 0.5.0 - 2026-10-10

### Added

- Install as an app on Android and iOS: HTTPS through `--tailscale`, PNG and apple-touch icons, offline shell caching, reconnect on wake, a pairing field, and prompt drafts that survive a reload ([#177](https://github.com/cuonghuunguyen/claude-code-ui/issues/177)).
- Focus page: one place for every session that needs you ([#159](https://github.com/cuonghuunguyen/claude-code-ui/issues/159)).
- In-app notifications, with a Notifications group in Settings ([#158](https://github.com/cuonghuunguyen/claude-code-ui/issues/158)).
- Interactive guide on first use: a skippable tour of projects, tabs, files, diff, git, terminal and keyboard shortcuts ([#156](https://github.com/cuonghuunguyen/claude-code-ui/issues/156)).
- Keyboard shortcuts: one registry, Alt+1..9 to switch tabs, an Alt+A prefix and a shortcuts dialog ([#155](https://github.com/cuonghuunguyen/claude-code-ui/issues/155)).
- Shortcut recorder handles AltGr brackets, Option on Mac, Alt+numpad and editing keys ([#195](https://github.com/cuonghuunguyen/claude-code-ui/issues/195)).
- Compact tabs switch: tabs group into chips with a menu listing the group's sessions and their state ([#154](https://github.com/cuonghuunguyen/claude-code-ui/issues/154)).
- Close a tab group with a middle click, the menu or a shortcut; on the phone, swipe to close tabs and to switch tabs ([#209](https://github.com/cuonghuunguyen/claude-code-ui/issues/209)).
- Sidebar classic layout: sessions listed under each project with their state ([#222](https://github.com/cuonghuunguyen/claude-code-ui/issues/222)).
- Projects header actions like IntelliJ: select the active session, expand or collapse all, options menu ([#152](https://github.com/cuonghuunguyen/claude-code-ui/issues/152)).
- Changes panel can diff the session, your uncommitted work or a branch ([#148](https://github.com/cuonghuunguyen/claude-code-ui/issues/148)).
- Markdown formatting buttons in the prompt box and markdown with colored code in your own messages ([#153](https://github.com/cuonghuunguyen/claude-code-ui/issues/153)).
- Image thumbnails keep their shape and open in a lightbox ([#207](https://github.com/cuonghuunguyen/claude-code-ui/issues/207)).
- TodoWrite card shows its todo list after the turn ends ([#230](https://github.com/cuonghuunguyen/claude-code-ui/issues/230)).
- Copy response button on every finished assistant turn ([#151](https://github.com/cuonghuunguyen/claude-code-ui/issues/151)).
- Cards for Artifact, ArtifactComments and ArtifactData calls ([#101](https://github.com/cuonghuunguyen/claude-code-ui/issues/101)).
- `/resume` opens session search filtered to the current project ([#100](https://github.com/cuonghuunguyen/claude-code-ui/issues/100)).
- Sessions stopped by the plan usage limit continue by themselves after the reset (setting) ([#164](https://github.com/cuonghuunguyen/claude-code-ui/issues/164)).
- Usage ring setting: choose which usage window the titlebar ring shows.
- Settings: a two-pane dialog with a group list, and an About group with the web app and daemon versions.
- The terminal panel shows Nerd Font icons ([#149](https://github.com/cuonghuunguyen/claude-code-ui/issues/149)).

### Changed

- Signal only is one switch in Settings instead of a per-session control ([#205](https://github.com/cuonghuunguyen/claude-code-ui/issues/205)).
- One Stop button, in the prompt box, and more room to read the transcript on phones ([#165](https://github.com/cuonghuunguyen/claude-code-ui/issues/165), [#166](https://github.com/cuonghuunguyen/claude-code-ui/issues/166)).
- `/clear` keeps your prompt box and shows the new session at once ([#150](https://github.com/cuonghuunguyen/claude-code-ui/issues/150)).
- Open project picks WSL or Docker from one row and a dropdown ([#161](https://github.com/cuonghuunguyen/claude-code-ui/issues/161)).
- Compact tab chip: the group menu opens at once on hover ([#206](https://github.com/cuonghuunguyen/claude-code-ui/issues/206)).
- Graph: the branch filter defaults to HEAD.
- Reinstall builds the new install in a temporary folder and keeps the old one until the new one runs ([#197](https://github.com/cuonghuunguyen/claude-code-ui/issues/197)).
- Orchestration: a coordinator can stop workers, read-only git commands are low risk, and the worker mode is a setting ([#163](https://github.com/cuonghuunguyen/claude-code-ui/issues/163)).
- Orchestration: a new `worker_remove` tool lets the coordinator clear a finished worker ([#253](https://github.com/cuonghuunguyen/claude-code-ui/issues/253)).
- Open project: picking a WSL distro or Docker container no longer starts an install. Select inside the content, then use the Check button and the Install, Update or Reinstall button. The Docker tab always shows, with a hint when Docker is not found ([#248](https://github.com/cuonghuunguyen/claude-code-ui/issues/248)).

### Fixed

- Tab order stays put after reloading the page, and a tab that never resolves no longer hides group chips ([#196](https://github.com/cuonghuunguyen/claude-code-ui/issues/196), [#201](https://github.com/cuonghuunguyen/claude-code-ui/issues/201)).
- A session no longer stays "running" after its last turn ended ([#239](https://github.com/cuonghuunguyen/claude-code-ui/issues/239)).
- Docker side: installing claude-ui works on containers with a read-only file system, and errors name the missing file ([#231](https://github.com/cuonghuunguyen/claude-code-ui/issues/231)).
- A WSL or Docker side without the SDK's Linux binary is installed again.
- Scrolling a session with long code prompts no longer stutters ([#188](https://github.com/cuonghuunguyen/claude-code-ui/issues/188)).
- Colored code in your messages: a very long line, an error or a failed load no longer freezes the page ([#202](https://github.com/cuonghuunguyen/claude-code-ui/issues/202)).
- Settings and dialogs: Tab moves from the group list into the panel on desktop and skips controls in closed sections ([#214](https://github.com/cuonghuunguyen/claude-code-ui/issues/214), [#216](https://github.com/cuonghuunguyen/claude-code-ui/issues/216)).
- Notifications: focus no longer jumps into a card ([#217](https://github.com/cuonghuunguyen/claude-code-ui/issues/217)).
- Docker side on Windows: packing claude-ui no longer fails on a package path that ends in a backslash ([#246](https://github.com/cuonghuunguyen/claude-code-ui/issues/246)).
- Open project: a long error text scrolls inside the dialog and no longer covers the Docker container select ([#247](https://github.com/cuonghuunguyen/claude-code-ui/issues/247)).
- Compact tab chips no longer overlap on the phone ([#251](https://github.com/cuonghuunguyen/claude-code-ui/issues/251)).
- Header diff stats never run repository diff drivers; the session list no longer blocks the daemon.

## 0.4.1 - 2026-10-07

### Added

- `!` in the new-session prompt box: Enter starts the session with the chosen model, mode and effort and runs the command; a failed command keeps the session for the retry.

### Changed

- npm package links to the now public GitHub repository (repository, homepage, issues).

## 0.4.0 - 2026-10-07

### Added

- `--tailscale` (or `CLAUDE_UI_TAILSCALE=1`): checks Tailscale, runs `tailscale serve` and prints the `https://<machine>.ts.net` pairing link; refuses Funnel and a port 443 that serves something else ([#113](https://github.com/cuonghuunguyen/claude-code-ui/issues/113)).
- Docker containers as sides, like WSL distros ([#134](https://github.com/cuonghuunguyen/claude-code-ui/issues/134)).
- Tab grouping setting: by project, by worktree, or none ([#135](https://github.com/cuonghuunguyen/claude-code-ui/issues/135)).
- Graph tab filters by HEAD; ref labels colored by kind ([#136](https://github.com/cuonghuunguyen/claude-code-ui/issues/136)).

### Changed

- A session opens at its latest turns and loads older ones on scroll up ([#137](https://github.com/cuonghuunguyen/claude-code-ui/issues/137)).
- The first prompt shows at once; skeletons until the session arrives ([#133](https://github.com/cuonghuunguyen/claude-code-ui/issues/133)).
- Mobile sidebar keeps project and worktree names readable; secondary actions move into `...` menus ([#132](https://github.com/cuonghuunguyen/claude-code-ui/issues/132)).
- An idle session with no open tab closes its CLI and MCP servers after 10 minutes (`CLAUDE_UI_IDLE_CLOSE_MINUTES`, 0 = never); the next prompt resumes it with the same model, mode and session permissions ([#140](https://github.com/cuonghuunguyen/claude-code-ui/issues/140)).
- Orchestration: every session but a worker gets the worker tools while orchestration is on; coordinators can use every permission mode.
- Orchestration: a worker starts in its coordinator's permission mode (bypass becomes auto); a worker above the coordinator's mode needs the user's approval card ([#142](https://github.com/cuonghuunguyen/claude-code-ui/issues/142)).
- The prompt box grows with its content up to 240px, then scrolls ([#102](https://github.com/cuonghuunguyen/claude-code-ui/issues/102)).
- The permission mode picker stays in the permission and question panels ([#145](https://github.com/cuonghuunguyen/claude-code-ui/issues/145)).
- Tab group chips: tinted project color, readable in light and dark.

### Fixed

- Daemon memory: a long streamed reply or running `!` command no longer grows the event log per update ([#139](https://github.com/cuonghuunguyen/claude-code-ui/issues/139)).
- Windows: ending `npm start`, tsx or the launcher stops the daemon, `wsl.exe` and the WSL side; Ctrl+C and terminal close log an exit line ([#141](https://github.com/cuonghuunguyen/claude-code-ui/issues/141)).
- `npm start -- --lan` (and other flags) reach the daemon ([#143](https://github.com/cuonghuunguyen/claude-code-ui/issues/143)).
- The sent user message keeps its line breaks ([#126](https://github.com/cuonghuunguyen/claude-code-ui/issues/126)).
- Composing Vietnamese (Telex, Gboard) no longer sends, picks or cancels mid-word ([#138](https://github.com/cuonghuunguyen/claude-code-ui/issues/138)).
- The prompt box keeps a keyboard selection (Ctrl+A, Shift+arrows).
- Orchestration: a worker started with a full model ID offers auto mode; unknown models are refused.

### Known issues

- Mobile: timeline rows can overlap after attaching an image or returning to the app ([#131](https://github.com/cuonghuunguyen/claude-code-ui/issues/131)).
- Windows checks still open for #140 (npx MCP wrappers exit with claude.exe) and #141 (WSL side and installed launcher paths).

## 0.3.0 - 2026-10-06

### Added

- Worktree support: list, create and remove git worktrees of a project; remove works only under `.claude/worktrees` ([#55](https://github.com/cuonghuunguyen/claude-code-ui/issues/55)).
- Quote part of an answer into the prompt ([#56](https://github.com/cuonghuunguyen/claude-code-ui/issues/56)).
- Auto update from npm: the app restarts on the new version when idle and falls back to the previous version if it fails to start ([#73](https://github.com/cuonghuunguyen/claude-code-ui/issues/73)).
- Show or hide the file bar ([#75](https://github.com/cuonghuunguyen/claude-code-ui/issues/75)).
- Type a `/` command in the middle of a message, like Claude Code ([#76](https://github.com/cuonghuunguyen/claude-code-ui/issues/76)).
- Settings page for app-wide settings, opened from the bottom of the sidebar ([#78](https://github.com/cuonghuunguyen/claude-code-ui/issues/78)).
- Orchestration, off by default: a coordinator session starts and drives worker sessions. Shell commands and permission answers of workers go to you unless "Coordinator may answer permission requests" is on ([#79](https://github.com/cuonghuunguyen/claude-code-ui/issues/79)).
- Desktop notifications sent by the daemon when the page is not on HTTPS (browser notifications unavailable) ([#90](https://github.com/cuonghuunguyen/claude-code-ui/issues/90)).
- Read-only git graph tab: branches, search by text or hash, author filter ([#94](https://github.com/cuonghuunguyen/claude-code-ui/issues/94)).
- Images and videos open in the file explorer ([#95](https://github.com/cuonghuunguyen/claude-code-ui/issues/95)).
- Search chats by content from the command palette ([#96](https://github.com/cuonghuunguyen/claude-code-ui/issues/96)).
- `!` runs a shell command from the prompt box; Stop kills it ([#97](https://github.com/cuonghuunguyen/claude-code-ui/issues/97)).
- Sticky user message: the prompt of the turn in view stays at the top while scrolled up; click to go to it ([#106](https://github.com/cuonghuunguyen/claude-code-ui/issues/106)).
- Sessions sidebar resizes by dragging its edge.
- Tab groups like Chrome, desktop only ([#109](https://github.com/cuonghuunguyen/claude-code-ui/issues/109)).

### Changed

- Duplicated session info removed ([#66](https://github.com/cuonghuunguyen/claude-code-ui/issues/66)).
- Recent agent sessions limited per project ([#67](https://github.com/cuonghuunguyen/claude-code-ui/issues/67)).
- App-styled pickers replace the native selects on mobile ([#104](https://github.com/cuonghuunguyen/claude-code-ui/issues/104)).
- A session with background work still running shows as running ([#110](https://github.com/cuonghuunguyen/claude-code-ui/issues/110)).
- Light theme focus ring meets 3:1 contrast ([#115](https://github.com/cuonghuunguyen/claude-code-ui/issues/115)).

### Fixed

- The daemon survives the Claude CLI closing early; the exit reason is logged ([#59](https://github.com/cuonghuunguyen/claude-code-ui/issues/59)).
- Skill names are checked against the skills list; plugin URL passwords are fully hidden ([#60](https://github.com/cuonghuunguyen/claude-code-ui/issues/60)).
- Session sync and restore fixes ([#61](https://github.com/cuonghuunguyen/claude-code-ui/issues/61)).
- Skills and Plugins dialogs write the right settings file, insert commands, show pending states and errors ([#63](https://github.com/cuonghuunguyen/claude-code-ui/issues/63)).
- Changes tab handles binary files ([#65](https://github.com/cuonghuunguyen/claude-code-ui/issues/65)).
- A damaged `projects.json` no longer brings back removed projects or loses the list ([#103](https://github.com/cuonghuunguyen/claude-code-ui/issues/103)).
- Skills and commands load the first time a session opens ([#105](https://github.com/cuonghuunguyen/claude-code-ui/issues/105)).
- A subagent resumed by SendMessage updates in the UI ([#112](https://github.com/cuonghuunguyen/claude-code-ui/issues/112)).
- Mobile: the sticky user message hides at the bottom of the timeline and while the on-screen keyboard is shown.
- Removing a worktree closes its terminals first (Windows refused to delete the folder).

### Known issues

- Mobile: timeline rows can overlap after attaching an image or returning to the app ([#131](https://github.com/cuonghuunguyen/claude-code-ui/issues/131)).

## 0.2.0 - 2026-10-05

See the git history before `Release claude-code-ui 0.2.0`.
