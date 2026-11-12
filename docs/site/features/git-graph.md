# Git graph

The **Graph** pane shows the project's commit history as a graph, like `git log --graph`. It reads the history and runs git actions from its menus: **Fetch**, Push, Pull, Merge, Rebase, Checkout, New branch, commit actions and stashes. It lives in the side panel by default and can be a tab in the main area, where it takes the whole area (see [Panes & layout](panes)).

![The git graph with branches, tags and commits](/screenshots/git-graph.png)

## How to use

1. Open the side panel and pick **graph** (or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>).
2. In a folder with several repositories, pick the repository first (see [Changes](changes#repositories)). The choice is shared with Changes.
3. Pick which branch to show: **HEAD** (the default) or **All branches**, or one branch.
4. Search with **Text or hash**, or filter by **Author**.
5. Click a commit to see its details and the diff of each file.

## Good to know

- Labels are colored by kind: HEAD, local branches, remote branches and tags.
- It loads 200 commits at a time. Older ones load as you scroll down.
- **Refresh** reloads the graph.
- **Fetch** and the branch menu act on the selected repository. Fetching a submodule fetches only its own remotes.
- A commit that moved a submodule shows "Submodule *path* → *commit*" instead of a diff, with **Show graph of** *path*.

## Branch menu

Click **›** on a branch in the branch popup, or right-click a branch label, to open the actions of that branch. What can never work is absent (the current branch has no Checkout, Merge or Rebase). A temporary block is disabled and says why. Each action asks in a dialog that shows the exact git command; Cancel runs nothing.

- **Checkout**, or **Checkout as new local branch** for a remote branch. With local changes in the way, **Smart checkout** offers to carry them.
- **Push**, **Force push…** (red, names the commits it replaces) and **Pull** (fast-forward only).
- **Merge into** *current*… and **Rebase** *current* **onto** *branch*….
- **New branch from** *branch*….

Merge, rebase, new branch, checkout and Smart checkout are described on [Git operations](git).

## Commit menu

Right-click a commit (long press, <kbd>Shift</kbd>+<kbd>F10</kbd>) for the commit actions:

| Item | Does |
| --- | --- |
| **Copy Revision Number** | Copies the full hash. |
| **Cherry-Pick** | Applies the commit to the current branch. |
| **Reset Current Branch to Here…** | Moves the branch to this commit: **Soft** (keeps changes staged), **Mixed** (default, keeps them unstaged) or **Hard** (discards changes of tracked files; lists the files it overwrites, and the confirm button is **Reset hard**). |
| **Revert Commit** | Adds a commit that undoes this one. |
| **Undo Commit** | Only on HEAD's commit, and not once it is pushed: removes the commit and keeps its changes staged. |
| **New Branch…** | Creates a branch at this commit. |

Cherry-Pick, Revert and Undo run at once. If a cherry-pick or revert stops on conflicts, the banner of [Changes](git#conflicts) takes over. Reset hard keeps the replaced file texts in [Local history](timeline#local-history-file-timeline).

## Stashes

The **Stashes** toggle opens a strip with the stash list: **Stash changes…**, and **Apply**, **Pop** and **Drop** per entry. See [Git operations](git#stashes).
