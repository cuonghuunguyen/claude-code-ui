# Changelog

All notable changes to `claude-code-ui` (npm). Versions follow [Semantic Versioning](https://semver.org/).

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
