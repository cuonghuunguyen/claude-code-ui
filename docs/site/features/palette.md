# Command palette

One search box for commands, sessions, files and message text.

![The command palette](/screenshots/palette.png)

## How to use

1. Press <kbd>Ctrl</kbd>+<kbd>K</kbd> (<kbd>⌘</kbd> <kbd>K</kbd> on Mac), or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>, or click the search icon at the top right.
2. Type a few letters.
3. Pick a row with the arrows and press <kbd>Enter</kbd>.

## What it finds

| Group | Examples |
| --- | --- |
| **Commands** | New session, New worktree…, Toggle terminal, Show git graph, Toggle signal only, Open settings, Show guide, Open Focus, Stop, Change model, Change thinking effort, Change permission mode, Rewind, Switch Claude account…, Open in file manager, Add file to prompt, Send selection to Claude |
| **Git** | Git: Commit, Git: Push, Git: Rollback…, Git: New branch…, Git: Checkout…, Git: Smart checkout…, Git: Stash…, Git: Annotate (Blame), Git: Merge…, Git: Rebase… |
| **Customize** | MCP servers, Slash commands, Manage plugins |
| **Sessions** | Your sessions, newest first |
| **Files** | Files of the current project |
| **Messages** | Text inside your sessions, newest first |

## Good to know

- Only commands that make sense right now are listed. For example, Rewind is hidden while Claude works.
- The git commands show in a git repository. Rollback, Checkout, Merge and Rebase open the matching dialog or the branch list in the Git graph, so you pick the branch there. **Send selection to Claude** shows while diff lines are selected in Changes, and **Switch Claude account…** with two or more accounts.
- The Rollback, New branch, Checkout, Smart checkout, Stash, Annotate, Merge, Rebase, Open in file manager, Add to prompt, Send selection and Switch account commands have no default key. Bind one in **Keyboard shortcuts**.
- Each command shows its keyboard shortcut. All of them are on the [Keyboard shortcuts](../reference/shortcuts) page.
- To open a file directly, <kbd>Ctrl</kbd>+<kbd>P</kbd> (**Open file**) is faster.
