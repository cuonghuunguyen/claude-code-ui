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

## Good to know

- **Uncommitted** and **Against branch** need a git repository.
- **Files shown: Project / All:** only the session's folder, or the whole repository.
- Switch between **Split diff** and **Unified diff**. Narrow screens always use unified.
- **Filter files** narrows the list by name.
- Pick the mode the pane opens in at [Settings › Changes](../reference/settings#changes).
- The status bar under the prompt box shows the branch and a `+added −removed` count.
