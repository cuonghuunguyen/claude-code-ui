# Git operations

Commit, roll back, branch, stash and resolve conflicts without leaving claude-code-ui. The writes sit in two places: the commit box of [Changes](changes) and the branch and commit menus of the [Git graph](git-graph). They act on the selected repository (see [Repositories](changes#repositories)).

![The commit box of the Changes pane, two files checked and a message typed](/screenshots/git.png)

## Commit

In [Changes](changes), mode **Uncommitted**, a commit box sits above the file list.

1. Check the files to commit: the box in front of a row, of a folder, or **Select all files**. The counter shows "2 of 5".
2. Type the message, or click the sparkle button (**Generate commit message**): Claude writes one for the checked files. **Stop generating** cancels it.
3. Click **Commit** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>, <kbd>⌘</kbd> <kbd>↩</kbd> on Mac), or **Commit and Push**.

- Exactly the checked files are committed, with their working-tree content, whatever is staged. Other staged files stay as they are.
- **Amend** (<kbd>Alt</kbd>+<kbd>M</kbd>) puts HEAD's message in the box and replaces the last commit. It is off before the first commit. Unchecking it brings your own text back.
- **Commit and Push** pushes the branch after the commit. On a detached HEAD there is no branch to push: the commit is made and the result says why it was not pushed.
- The result shows as "Committed *hash*".

### Commit message instruction

**Generate commit message** asks Claude with a built-in instruction. Change it in **Settings › Git › Commit message instruction**. The same group has **Commit message instruction for** *project*, which wins for that project. Empty: the built-in text. See [Settings › Git](../reference/settings#git).

## Roll back changes

**Rollback** puts files back to the last commit.

- Check the files and click **Rollback**, or right-click a row (long press, <kbd>Shift</kbd>+<kbd>F10</kbd>) and pick **Rollback…**.
- The dialog **Rollback changes** lists the files. **Delete local copies of added files** also removes files that are new (off by default). Confirm with **Rollback**.
- **Rollback** on a single change: in the diff of a modified or renamed text file, a **Rollback** button follows each changed block ("Roll back this change, lines 12–18"). It acts at once, with no question.
- Every replaced file is saved first in [Local history](timeline#local-history-file-timeline), so **Restore** brings it back. The result reads "Rolled back 2 files".

## Conflicts

While a merge, rebase, cherry-pick, revert or patch apply (`am`) stops on conflicts, or files are unmerged, a banner at the top of Changes names it ("Merge in progress") and lists the conflicted files. Click a file to open it.

| Button | Does |
| --- | --- |
| **Resolve with Claude** | Puts a prompt in the prompt box that names the repository and the conflicted files, and tells Claude to edit them and not to run `git add`, `git commit` or `--continue`. You review it and send it. |
| **Continue** | Continues the operation. For unmerged files the button is **Mark resolved**. |
| **Abort** | Drops the operation and every resolution so far, after you confirm. The changed files are saved in Local history first. |

If the next step stops again, the banner stays and says "Stopped on conflicts".

## Merge and rebase

Open the branch menu of the Git graph (the branch popup, or a right click on a branch label): **Merge into** *current*… and **Rebase** *current* **onto** *branch*…. A dialog shows what will happen. Cancel runs nothing. A conflict stops the operation: resolve it in Changes (see above). A rebase rewrites the commits of the current branch.

The current branch has no Checkout, Merge or Rebase item. A temporary block (for example an unfinished merge) disables the item and says why.

## New branch

**New Branch…** (the branch menu, the commit menu, or **Git: New branch…** in the [command palette](palette)) asks for a **Branch name**. **Check out** (on by default) switches to it after it is created. A branch made at a commit uses that commit as its start.

## Checkout and Smart checkout

**Checkout** in the branch menu switches at once. A remote branch offers **Checkout as new local branch**.

When local changes would be overwritten, git refuses and a dialog offers **Smart checkout**: it stashes your changes, checks out the branch and applies them again. The staged state is not kept. Untracked files in the way are only refused. If applying them stops on conflicts, the branch is still checked out and the conflicts show in Changes. **Git: Smart checkout…** in the command palette does the same from the start.

## Stashes

In the Git graph, the **Stashes** toggle opens a strip with the stash list (`stash@{0}` and so on).

- **Stash changes…** asks for an optional message and **Include untracked files**.
- Each row has **Apply**, **Pop** and **Drop**. **Drop** asks first and saves the file texts of the dropped entry in Local history.
- A stash made in a terminal shows after **Refresh**.

## Annotate (blame)

In the Files editor of a file inside a repository, the **Annotate** toggle shows the commit of each line next to the line numbers: short hash, date and author, once per run of lines. Lines edited or added since HEAD show "not committed". A marker is a button: it opens the [Git graph](git-graph) on that commit. With unsaved edits it says "Save the file to annotate it." It is off by default and kept across tabs.

## Commands in the palette

The [command palette](palette) lists **Git: Rollback…**, **Git: New branch…**, **Git: Checkout…**, **Git: Smart checkout…**, **Git: Stash…**, **Git: Annotate (Blame)**, **Git: Merge…** and **Git: Rebase…** in a git repository. They have no default key. Bind one in [Keyboard shortcuts](../reference/shortcuts).

## Good to know

- Git write actions run `git` on the daemon's computer (or on the [side](wsl-docker)) with your hooks, like a terminal would.
- Reset hard, Smart checkout, stash drop, Abort and Rollback keep the replaced text of each file in the file Timeline, with the reason "Before reset", "Before checkout", "Before stash drop", "Before abort" or "Before rollback". Turn it off in **Settings › Local history**.
- Push, Pull, Fetch and the commit actions Undo, Revert, Cherry-Pick and Reset are on the [Git graph](git-graph) page.
