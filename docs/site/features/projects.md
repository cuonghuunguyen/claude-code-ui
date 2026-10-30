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

### Create a worktree

1. Hover the project row and click the branch-plus button **Create worktree** (or run "New worktree…" in the [command palette](palette), or pick **Create worktree…** in the project menu).
2. Pick where its branch comes from:
   - **Ticket**: pick a Jira ticket (your open tickets show first; type a key, words of the summary, or paste the ticket link or a pull request link whose branch names the ticket). The branch name comes from the ticket, e.g. `bugfix/PRJ-123-login-fails`; you can edit it. If a branch with the key exists already, **Check out** it instead. Set up Jira in [Settings › Jira](../reference/settings#jira).
   - **Branch**: check out an existing local or remote branch. A remote-only branch gets a local branch of the same name that tracks it. A branch that is checked out in another worktree cannot be picked. Paste a pull request link (GitHub, GitLab, Bitbucket Server) to list the branch it was opened from, or a ticket link or key to list the branches named after the ticket.
   - **Name**: type any name. `Fix Login Ü` becomes the branch `fix-login-u`; `feat/x` stays `feat/x`.
3. For a new branch, **Base** picks the start point (default: the remote default branch, e.g. `origin/main`).
4. The modal shows the branch and its folder (`.claude/worktrees/<branch with / replaced by ->`). Click **Create**. A new session tab opens in the worktree.

A new worktree also gets the gitignored files that the `.worktreeinclude` file at the root of the main checkout lists (`.gitignore` syntax), for example `.env`. A file is copied only when a pattern matches it and git ignores it. Large files and large totals are skipped with a warning in the daemon log.

A long ticket summary is shortened, so a generated name is always valid. An error shows only for a name you typed or edited. A folder name is at most 64 characters, also when you check out an existing branch with the **Branch** tab.

**Shift+click** the button, or pick **New worktree** in the project menu, to create one at once with a generated name.

The **Run session in** chip of a new session calls the main checkout **Primary worktree**.

To remove many at once, see [Clean up](clean-up). To remove one, click its trash icon (on a phone: its menu › **Delete worktree…**). The dialog opens at once with **Checking…**. After you confirm, the row shows **Removing…** while the removal runs in the background.

The menu of a project row and of a worktree row has **Copy path**.

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
- Removing a worktree deletes the branch claude-code-ui created for it (from **Ticket**, **Name**, a generated name or a worker). A branch you checked out with **Branch**, or made yourself, stays; [Clean up](clean-up) offers to delete it when it is merged.
- With WSL or Docker, **Open project** also lets you pick a side. See [WSL & Docker](wsl-docker).
