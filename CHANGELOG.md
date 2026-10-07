# Changelog

All notable changes to `claude-code-ui` (npm). Versions follow [Semantic Versioning](https://semver.org/).

## 0.4.1 - 2026-10-07

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
