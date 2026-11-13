# Changes & diffs

The **Changes** pane shows what changed, as diffs, file by file.

![The Changes panel with a diff](/screenshots/changes.png)

## How to use

1. Open the side panel and pick **changes** (or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>).
2. Choose a **diff mode**:

   | Mode | Shows |
   | --- | --- |
   | **Session changes** | What Claude changed in this session |
   | **Uncommitted** | Your uncommitted git changes |
   | **Against branch** | Everything that differs from a branch you pick |

3. Click a file in the list, or use <kbd>←</kbd> / <kbd>→</kbd> for the previous or next file.

The tab opens in **Uncommitted** unless you saved another default in [Settings › Layout › Changes](../reference/settings#changes).

## Repositories

A project folder can hold several repositories: nested ones, or submodules. In the git modes, the **repository selector** in the toolbar shows the selected one (name and branch). It opens a tree: the project's own repository, its submodules, then the nested repositories. Pick one to see its changes. The choice is kept per project in this browser and is shared with the [Git graph](git-graph).

- A project folder that is not a repository itself but holds some still gets the git modes.
- A submodule with other commits than recorded shows a **submodule** badge instead of a text diff. One with uncommitted changes shows "modified content (N files)". An embedded repository folder shows a **repository** row. **Show changes in** *path* on these rows switches the selector.
- Which repositories are found follows the settings in [Settings › Git](../reference/settings#git).

## Tell Claude about a change

- **Add to prompt:** right-click a row (long press, <kbd>Shift</kbd>+<kbd>F10</kbd>) and pick **Add to prompt**. It inserts the file as an `@` mention. Not for a deleted file. It is also in the menu in **Session changes** mode.
- **Selection menu:** in the diff of a text file, select lines on the line numbers (click, <kbd>Shift</kbd>+click or drag). A small menu appears next to the selection: **Add to chat** or **Quote**. <kbd>Alt</kbd>+<kbd>K</kbd> (<kbd>⌥</kbd> <kbd>K</kbd> on Mac) does the same as **Add to chat**. With **Add to chat** the prompt box gets the file name, the line numbers and the selected lines, removed lines marked `-` and added lines `+`. **Quote** adds the selected lines as a quote block. You edit it and send it. The same menu appears when you select text in a file editor.
- Both are also in the [command palette](palette) (**Add file to prompt**, **Add selection to chat**), without a default key.

## Status badges

Each row has a letter badge: **M** modified, **A** added, **D** deleted, **R** renamed. A new file that git does not track yet shows a red **U** (untracked) instead of **A**. A file you added to the index with `git add` stays **A**.

## Commit, roll back, resolve

In **Uncommitted** mode a commit box sits above the list: check files, write or generate a message, **Commit** or **Commit and Push**, **Amend**, **Rollback**. A banner shows an unfinished merge or rebase with **Continue**, **Abort** and **Resolve with Claude**. See [Git operations](git).

## Good to know

- **Uncommitted** and **Against branch** need a git repository.
- **Files shown: Project / All:** only the session's folder, or the whole repository.
- Switch between **Split diff** and **Unified diff**. Narrow screens always use unified.
- Drag the edge of the file list to resize it, or focus it and press <kbd>←</kbd> / <kbd>→</kbd>. Double click the edge to restore the width. It is kept per browser.
- **Filter files** narrows the list by name.
- A folder with a single child folder shows as one row (`src/components`). **View as list** shows the files flat, each by its path; **View as tree** goes back. The choice is kept per browser.
- Pick the mode the pane opens in at [Settings › Layout › Changes](../reference/settings#changes).
- The status bar under the prompt box shows the branch and a `+added −removed` count.
