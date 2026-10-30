# Changelog

All notable changes to `claude-code-ui` (npm). Versions follow [Semantic Versioning](https://semver.org/).

## 1.0.0 - 2026-10-30

### Added

- Panes in the main area: Plan, Files, Git graph, Terminal and Artifacts can each be a tab next to your sessions, in the project's group of the tab strip ("Plan · *session*", "Terminal · *project*"), and keep showing their project or session while you work in another one. Right-click a pane tab (also Shift+F10 or a long press) and pick **Move to main area**; the tab's own menu has **Move Plan to side panel**, **Move Plan to bottom panel** and so on, and closing the tab that way offers **Undo** in a toast. Git graph always takes the whole area; Changes stays in its panel ([#395](https://github.com/cuonghuunguyen/claude-code-ui/issues/395), [#396](https://github.com/cuonghuunguyen/claude-code-ui/issues/396)).
- Terminal in the main area: Settings › Layout › Terminal › **Terminal position** has a third choice, **Main area**. Ctrl+`, **New terminal** and the terminal buttons then open or focus one "Terminal · *project*" tab per project folder; moving it keeps the running shells. After a reload each folder shows the terminal you selected in it ([#397](https://github.com/cuonghuunguyen/claude-code-ui/issues/397), [#490](https://github.com/cuonghuunguyen/claude-code-ui/issues/490), [#491](https://github.com/cuonghuunguyen/claude-code-ui/issues/491)).
- Plan pane: the session's newest plan, with the same text as the plan card. It is listed only while the session has a plan; while the plan waits for your answer it says so, with **Go to request**. **Open in tab** on a plan card or on the plan approval, and the palette command "Show plan", show it wherever it lives ([#395](https://github.com/cuonghuunguyen/claude-code-ui/issues/395)).
- Split view with a pane (screens from 1024px): **Split right** and **Split down** (tab menu, palette, or a drag to an edge of the session area) work on Plan, Files, Terminal, file and artifact tabs too, so a session sits beside its plan, its project's terminal, a file or an artifact. A split always holds at least one session. After a split the typing focus is in the new split, also in a terminal ([#398](https://github.com/cuonghuunguyen/claude-code-ui/issues/398), [#501](https://github.com/cuonghuunguyen/claude-code-ui/issues/501)).
- A file as a tab: **Open in tab** on a file tree row (or a middle click on it), in the header of the Files editor and of the file dialog, in an editor tab's menu, in the palette, or Alt+Enter (or a middle click) in "Open file" moves the file into its own tab right of its session's tab. It is the same editor and has the keyboard focus. **Move to Files** puts it back; a file is open in one place only ([#399](https://github.com/cuonghuunguyen/claude-code-ui/issues/399), [#504](https://github.com/cuonghuunguyen/claude-code-ui/issues/504)).
- Artifacts pane: lists the artifacts a session published with Claude's Artifact tool, shown only while the session has published one (palette: "Show artifacts"). Pick one to preview it. **Open in tab** there or on a published Artifact card shows the page in its own tab at full height; **Move to Artifacts** puts it back ([#176](https://github.com/cuonghuunguyen/claude-code-ui/issues/176), [#400](https://github.com/cuonghuunguyen/claude-code-ui/issues/400)).
- Session in the side or bottom panel (screens from 1024px): right-click a session tab and pick **Move to side panel** or **Move to bottom panel**, or run "Move session to side panel" / "Move session to bottom panel" in the palette. The session stays there with its timeline, prompt box, requests, file links, **Quote**, **Open in tab** and image attachments while you work in other sessions, for example to watch a worker. **Move to main area** in its dock tab's menu brings it back; on a window narrower than 1024px it is a normal tab ([#401](https://github.com/cuonghuunguyen/claude-code-ui/issues/401), [#503](https://github.com/cuonghuunguyen/claude-code-ui/issues/503)).
- Drag panes (wide screens, mouse or pen): drag a pane tab onto the side panel, the bottom panel, the tab strip or the session area to move it there; dropped on an edge of the session area it opens in a split there. Every drag has a menu or palette equivalent ([#402](https://github.com/cuonghuunguyen/claude-code-ui/issues/402)).
- Aside: type `/btw` and a question in the prompt box, or run "Ask aside" in the palette, to ask a side question about the session in a floating popup, also while a turn runs; the turn goes on undisturbed. The aside is read-only (no Edit, Write or NotebookEdit, no workers) and has its own timeline, prompt box and requests; Focus lists them as "Aside: *title*". Drag the popup by its header, resize it at its corner, or click **Minimize aside** to fold it into a chip at the bottom right. **Close aside** deletes it, **Keep as session** turns it into a normal session in a tab. On a phone the popup fills the screen. An aside that is not kept is deleted when no longer needed, also one of a daemon on another port, so it does not show in `claude --resume` ([#465](https://github.com/cuonghuunguyen/claude-code-ui/issues/465), [#466](https://github.com/cuonghuunguyen/claude-code-ui/issues/466), [#467](https://github.com/cuonghuunguyen/claude-code-ui/issues/467), [#495](https://github.com/cuonghuunguyen/claude-code-ui/issues/495)).
- Settings › Appearance › Theme: Catppuccin, Tokyo Night, Solarized, Nord, Dracula and One next to Default. A theme recolors the app, the editor, diffs, the terminal and the git graph at once, and is kept per browser. The titlebar theme button still cycles System, Light and Dark inside the theme; Dracula has no light colors and shows Default in light mode ([#468](https://github.com/cuonghuunguyen/claude-code-ui/issues/468)).
- Nested repositories and submodules: found as VS Code finds them, with VS Code's `git.*` settings in Settings › Git (**Auto repository detection**, **Repository scan max depth**, **Detect submodules** and the others). A project folder that only holds repositories gets the Changes git modes and the Git graph too. A **repository selector** in the Changes toolbar (git modes) and first in the Git graph filter row picks the repository; the choice is kept per project in this browser and shared by both. **Fetch** and the branch menu's push and pull act on the selected repository. A changed submodule shows as a **submodule** row ("modified content (N files)" for uncommitted changes) with **Show changes in** *path*; a commit that moved a submodule offers **Show graph of** *path* ([#388](https://github.com/cuonghuunguyen/claude-code-ui/issues/388), [#389](https://github.com/cuonghuunguyen/claude-code-ui/issues/389), [#390](https://github.com/cuonghuunguyen/claude-code-ui/issues/390), [#391](https://github.com/cuonghuunguyen/claude-code-ui/issues/391)).
- File tree with nested repositories: a file gets the git mark of its own repository; a repository folder shows a repository icon and a submodule an archive icon. Right-click one for **Show changes** or **Show graph**, which switch the repository selector. **Filter files** and `@` in the prompt box also find files inside nested repositories and submodules, also on WSL and in large workspaces ([#392](https://github.com/cuonghuunguyen/claude-code-ui/issues/392), [#393](https://github.com/cuonghuunguyen/claude-code-ui/issues/393), [#502](https://github.com/cuonghuunguyen/claude-code-ui/issues/502)).
- Run in background: on the card of a running Bash command, also one a subagent runs or a `!` command of bash mode, click **Run in background**, press Ctrl+Shift+B or run "Run in background" in the palette. The command keeps running, the turn goes on, and Claude learns when the command ends ([#440](https://github.com/cuonghuunguyen/claude-code-ui/issues/440), [#485](https://github.com/cuonghuunguyen/claude-code-ui/issues/485), [#492](https://github.com/cuonghuunguyen/claude-code-ui/issues/492)).
- Background shells list: click **N shells** in the status bar under the prompt box, run "Background shells" in the palette, or type `/tasks` (or `/bashes`). It lists the session's shells, running ones first, with status and run time; open one for its output, live while it runs, and **Kill** to stop it. A shell started before `/clear` still shows its output. **Stop** and Esc stop the turn, not the background shells ([#442](https://github.com/cuonghuunguyen/claude-code-ui/issues/442), [#496](https://github.com/cuonghuunguyen/claude-code-ui/issues/496)).
- Pasted text: a paste of more than 800 characters or more than 2 line breaks shows as `[Pasted text #1 +120 lines]` in the prompt box and in the sent message, with a chip above the box to view or remove it. Backspace deletes it like one character; Claude gets the whole text ([#441](https://github.com/cuonghuunguyen/claude-code-ui/issues/441)).
- `.worktreeinclude`: a new worktree gets a copy of each gitignored file of the main checkout that `.worktreeinclude` at its root lists (`.gitignore` syntax), for example `.env`. Tracked files and links are never copied; files beyond 2 GiB or 50,000 files per worktree are skipped with a warning in the daemon log ([#439](https://github.com/cuonghuunguyen/claude-code-ui/issues/439)).
- Sidebar: **Copy path** in the menu of a project row and of a worktree row (right click, long press or Shift+F10) copies the folder path; for a WSL or Docker side, the path inside the side ([#456](https://github.com/cuonghuunguyen/claude-code-ui/issues/456)).
- Focus page: a session stopped by the usage limit gets a row also while auto-continue is off ("Wait for the usage limit to reset: resets at *time*", with **Open session** instead of **Cancel continue**); a worker's row sits under its coordinator's ([#305](https://github.com/cuonghuunguyen/claude-code-ui/issues/305), [#306](https://github.com/cuonghuunguyen/claude-code-ui/issues/306)).
- Settings › Focus › **Next for you** (off by default): after a turn Claude predicts your next prompt, and the session's finished row on the Focus page shows it as a chip. Click the chip to put the text into that session's prompt box ([#307](https://github.com/cuonghuunguyen/claude-code-ui/issues/307), [#505](https://github.com/cuonghuunguyen/claude-code-ui/issues/505)).
- Orchestration, worker trees: a worker can start workers of its own. Settings › Orchestration has **Maximum workers per tree** (1 to 20, default 4: one coordinator you start and every worker below it), **Maximum workers in total** (0 to 100 for the whole daemon, 0 = no limit, the default), **Maximum tree depth** (1 to 5, default 2) and **Maximum workers per coordinator** (1 to 20, default 4). A worker's workers show in the sidebar under the same coordinator, named `parent › child` ([#454](https://github.com/cuonghuunguyen/claude-code-ui/issues/454), [#484](https://github.com/cuonghuunguyen/claude-code-ui/issues/484)).
- Orchestration plugin: `claude plugin marketplace add cuonghuunguyen/claude-code-ui`, then `claude plugin install orchestration@claude-ui` (or the Plugins dialog), adds the agent types `orchestration:planner`, `orchestration:implementer`, `orchestration:ui-tester` and `orchestration:reviewer`, which `worker_start` takes as `agent`, and the `orchestrate-tickets` skill that runs a ticket through them ([#454](https://github.com/cuonghuunguyen/claude-code-ui/issues/454)).
- Orchestration: `worker_start` takes a project or worktree name instead of a folder path, and the new `worker_targets` tool lists the coordinator's projects and worktrees with the live sessions in each ([#457](https://github.com/cuonghuunguyen/claude-code-ui/issues/457)).

### Changed

- Settings: the groups sit under four headings, App, Sessions, Integrations and System. **General** holds Timeline, Sending and Screen, **Layout** holds Sidebar, Tabs, Changes and Terminal, **Help & about** holds Guide and About.
- Files tab: open editor tabs, their order, the active one and preview tabs come back after a page reload (kept per browser); unsaved edits come back in the same browser tab. A file deleted meanwhile is dropped ([#366](https://github.com/cuonghuunguyen/claude-code-ui/issues/366)).
- Bash mode: a `!` command sent while Claude works waits in the queue like a message and runs when the session is idle, instead of being rejected ([#443](https://github.com/cuonghuunguyen/claude-code-ui/issues/443)).
- Clean up: the worktree scan is much faster and no longer stalls the status bar; it shows the fetch of the default branch ("Fetching…", "Fetched … ago" or "Fetch failed: …"). A worktree whose branch was squash-merged counts as **Safe**. Every worktree queued for removal shows **Removing…** at once ([#461](https://github.com/cuonghuunguyen/claude-code-ui/issues/461), [#494](https://github.com/cuonghuunguyen/claude-code-ui/issues/494)).
- Remove worktree (a worktree row's trash icon; on a phone its menu › **Delete worktree…**): the dialog opens at once with **Checking…**; after you confirm, the row shows **Removing…** while the removal runs in the background ([#462](https://github.com/cuonghuunguyen/claude-code-ui/issues/462)).
- Worktree status is cached, so the remove dialog and Clean up show results at once with their age ("checked 5m"); removing always checks again ([#463](https://github.com/cuonghuunguyen/claude-code-ui/issues/463)).
- WSL and Docker sides come back with Claude UI: a side that ran once starts with it, and starts again by itself when it stops (after 2 s, 10 s and 60 s; a fourth stop within ten minutes shows the error with **Retry**). After a new Claude UI build the side updates from the bundle; one that needs npm shows **Needs an update** with **Update** under its project in the sidebar. Its projects stay in the sidebar while it starts. Settings › Sides › **Start with Claude UI** and **Update automatically** turn this off per side ([#458](https://github.com/cuonghuunguyen/claude-code-ui/issues/458)).
- WSL and Docker: a distro or container that has Node.js 22 or newer (also from nvm) runs Claude UI with it; the bundle brings Node.js only when there is none ([#464](https://github.com/cuonghuunguyen/claude-code-ui/issues/464)).
- Sidebar: a coordinator's workers start collapsed.

### Fixed

- Themes: text, borders and controls meet the contrast targets in every theme, light and dark, instead of some colors being too faint to read ([#468](https://github.com/cuonghuunguyen/claude-code-ui/issues/468)).
- Focus page: the side and bottom panels stay while Focus shows, so the prompt box no longer jumps when you switch between Focus and a session; Focus opens also while the bottom panel is maximized; a request's detail shows the tool and its command once, in the request card, instead of repeating it above; error rows and unread finished rows are still there after a page reload or a daemon restart ([#367](https://github.com/cuonghuunguyen/claude-code-ui/issues/367), [#499](https://github.com/cuonghuunguyen/claude-code-ui/issues/499), [#455](https://github.com/cuonghuunguyen/claude-code-ui/issues/455), [#308](https://github.com/cuonghuunguyen/claude-code-ui/issues/308)).
- Settings › Jira: the token is sent only to the Jira host it was saved for, and changing the host clears it; the Jira URL must be https (http only for `localhost` and `127.0.0.1`); a damaged `secrets.json` no longer puts the token into the daemon log ([#451](https://github.com/cuonghuunguyen/claude-code-ui/issues/451), [#487](https://github.com/cuonghuunguyen/claude-code-ui/issues/487)).
- Create worktree: a long ticket summary is shortened to a valid name instead of failing over the 64-character folder limit, and an error shows only for a name you typed; the **Branch** tab checks out a branch whose name is over 64 characters, with a shortened folder name; `fix-123` with no such ticket also searches summaries; a slow branch list no longer replaces the fetched one; `feat/x` next to a branch `feat` gets a clear message instead of a generic git error; your own `worktree-*` branch checked out through the **Branch** tab is kept when the worktree is deleted; a ticket key typed in upper case on the **Name** tab keeps its case ([#452](https://github.com/cuonghuunguyen/claude-code-ui/issues/452), [#453](https://github.com/cuonghuunguyen/claude-code-ui/issues/453), [#460](https://github.com/cuonghuunguyen/claude-code-ui/issues/460), [#486](https://github.com/cuonghuunguyen/claude-code-ui/issues/486)).
- Worker row › **Remove worker…** with "Also remove worktree": the worktree is checked again before removal, instead of being removed on the status the dialog showed ([#493](https://github.com/cuonghuunguyen/claude-code-ui/issues/493)).
- Docker side bundle: two installs on a cold cache share one download; the fallback reasons read right (a checksum mismatch, a failed probe no longer shown as an unknown CPU, a failed `docker exec` quotes its error); leftover temporary tars are removed; parts of an older Claude UI version are removed 7 days after their last use ([#448](https://github.com/cuonghuunguyen/claude-code-ui/issues/448), [#449](https://github.com/cuonghuunguyen/claude-code-ui/issues/449), [#450](https://github.com/cuonghuunguyen/claude-code-ui/issues/450)).
- Settings: a second number field edited right after the first keeps its value instead of being reset; on a phone, saving a field such as the Jira URL stays in its group instead of returning to the Settings list ([#498](https://github.com/cuonghuunguyen/claude-code-ui/issues/498), [#500](https://github.com/cuonghuunguyen/claude-code-ui/issues/500)).
- Markdown file preview: tables show at full height instead of being cut at 300px ([#444](https://github.com/cuonghuunguyen/claude-code-ui/issues/444)).
- Phone: swiping on the tab name moves it with your finger and settles on the next or previous tab, or springs back, instead of animating badly ([#507](https://github.com/cuonghuunguyen/claude-code-ui/issues/507)).

## 0.8.0 - 2026-10-25

### Added

- Create worktree modal: the project row's branch-plus button, "Create worktree…" in the project menu and "New worktree…" in the palette open a modal with three branch sources. **Ticket** picks a Jira ticket and names the branch after it (or checks out an existing branch with its key), **Branch** checks out an existing local or remote branch, **Name** takes any name. A new branch starts from a **Base** (default: the remote default branch). Shift+click, or "New worktree" in the project menu, still creates one at once ([#447](https://github.com/cuonghuunguyen/claude-code-ui/issues/447)).
- Create worktree: paste a pull request link (GitHub, GitLab, Bitbucket Server) to list the branch it was opened from, or a ticket link or key to list the branches named after the ticket ([#447](https://github.com/cuonghuunguyen/claude-code-ui/issues/447)).
- Settings › Jira: Jira URL, email, an API token or personal access token (kept on the daemon's computer only, in `secrets.json`, never shown again), a branch template and a Ticket filter (JQL) for the tickets the Ticket tab lists. Works with Jira Cloud and Data Center ([#447](https://github.com/cuonghuunguyen/claude-code-ui/issues/447)).

### Changed

- Docker containers on Linux x86_64 or arm64 with glibc 2.28+ install from a bundle your computer assembles: Node.js, the terminal support, the Claude Agent SDK and Claude Code are downloaded once, checked against their published checksums and cached in `~/.cache/claude-ui/side`. The container needs no Node.js, npm, network or build tools (`--network none` works). Other containers (Alpine, other CPUs) install with npm as before, and the dialog says why. Open project shows **What this container needs** with a ✓ or ✗ per item ([#446](https://github.com/cuonghuunguyen/claude-code-ui/issues/446)).
- WSL distros with the same requirements install from the same checked parts, read from the cache on Windows: no npm, network or compile in the distro. A first install takes about 10 to 15 seconds, a new build with the same parts about a second. Musl distros install with npm as before.
- WSL and Docker: the side check no longer looks for a Claude login. A session started without a login says so. The Open project dialog drops the login row and **Install anyway**.
- Deleting a worktree deletes every branch claude-ui created for it (marked in git config), not only `worktree-*` branches ([#447](https://github.com/cuonghuunguyen/claude-code-ui/issues/447)).

## 0.7.1 - 2026-10-19

### Changed

- New session tab (screens from 1024px): it shows the side panel and the bottom panel of its project, so sending the first message no longer makes the panels (and a remembered terminal) appear at once; Files, Graph and Terminal work as for a session, Changes shows "No changes yet" while its git modes work, and switching the project moves the panels ([#430](https://github.com/cuonghuunguyen/claude-code-ui/issues/430)).
- Terminal: a terminal remembered as open shows only when its folder has running shells, and a shell starts only when you open the terminal (Toggle terminal, Ctrl+`, New terminal, a click on its tab), never on a reload, a session or project switch or a reconnect; a terminal that shows without being asked for never takes the focus ([#430](https://github.com/cuonghuunguyen/claude-code-ui/issues/430)).
- Compact tab groups: on desktop the group chip's hover menu lists only the group's tabs; Move group, Clean up group, Close other groups and Close group are in the chip's right-click menu (also Shift+F10, or a long press on a touch tablet) ([#431](https://github.com/cuonghuunguyen/claude-code-ui/issues/431)).

### Fixed

- The titlebar terminal button shows the terminal icon, and it and the side panel's terminal button use the same quiet pressed style as the sidebar toggle instead of a heavy outline, also in dark mode ([#430](https://github.com/cuonghuunguyen/claude-code-ui/issues/430), [#434](https://github.com/cuonghuunguyen/claude-code-ui/issues/434)).
- Phone: a long project name in the New session tab's project chip ends with "…" instead of being cut off at both screen edges ([#435](https://github.com/cuonghuunguyen/claude-code-ui/issues/435)).

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
