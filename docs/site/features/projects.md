# Projects & worktrees

A **project** is a folder you work in. New sessions start in a project.

![The Open project dialog with recent projects](/screenshots/open-project.png)

## How to open a project

1. Click **Open project** (the folder icon next to **Projects** in the sidebar).
2. Pick a recent project, browse to a folder, or type a path.
3. The project shows in the sidebar. Start a session in it.

## How to remove a project

- Open the project's menu in the sidebar and choose **Remove from list (files stay)**.
- This only hides it. Files and session history stay.

## Worktrees

A **worktree** is an extra git checkout of the same repository, on its own branch. Use one to let Claude work on a branch without touching your main checkout.

1. Hover the project row and click **New worktree** (or run "New worktree…" in the [command palette](palette)).
2. claude-code-ui creates it in `.claude/worktrees/` of the repository and shows it under the project.
3. Start sessions in it like in any project.

The **Run session in** chip of a new session calls the main checkout **Primary worktree**.

To remove many at once, see [Clean up](clean-up). To remove one, click its trash icon (on a phone: its menu › **Delete worktree…**).

## Projects header buttons

| Button | Does |
| --- | --- |
| Open project | Adds a project. |
| Select active session | Scrolls the sidebar to the session you are looking at. |
| Expand all / Collapse all | Opens or closes every project (desktop). |
| Sidebar options (`⋯`) | Layout, show only active sessions, and more. |

## Good to know

- You can only open folders inside the allowed **roots** (default: your home folder). See [`--roots`](../reference/cli).
- Folders that only have sessions from the `claude` CLI show as **recent projects** until you open them.
- Worktrees under `.claude/worktrees/` can be removed from here, and so can any linked worktree inside the roots (not a locked or symlinked one), also one made by hand. Before it removes one, it tells you how many uncommitted changes and commits you would lose.
- With WSL or Docker, **Open project** also lets you pick a side. See [WSL & Docker](wsl-docker).
