# Files

The **Files** pane in the side panel: a file tree and a simple editor for the session's folder.

## How to use

1. Open the side panel and pick **files** (or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>).
2. Click a file in the tree to open it in an editor tab.
3. Edit it and press <kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd> <kbd>S</kbd> on Mac) to save.
4. To find a file by name, press <kbd>Ctrl</kbd>+<kbd>P</kbd> (**Open file**).

## File view

- The tree shows a file-type icon and a git status mark (modified, added, untracked…) for each file.
- A single click opens a **preview tab** (its title is in italics); the next single click replaces it. Double click the tab or the tree row, or edit the file, to keep it open.
- A breadcrumb path and an unsaved marker (●) sit above the editor. Markdown files can show a rendered preview.
- Binary and very large files show a clear message instead of opening.
- With no file open, the tree fills the tab. From 672px of panel width the tree sits beside the editor; below that it is a drawer (the **Files** button or <kbd>Ctrl</kbd>+<kbd>\\</kbd>).

## File dialog

Click **Pop out** in the Files tab to open the tree, tabs and editor in a large dialog. It is the same state: open tabs, unsaved edits, cursor and undo history carry over, and back (**Open in editor**).

A **Read** card in the timeline, a file path in Claude's answer (`src/cart.js:12`) and **Open in file dialog** in the tree menu open the file there, at its line.

## File tree menu

Right-click (long press, or <kbd>Shift</kbd>+<kbd>F10</kbd>) a file or folder:

| Item | Does |
| --- | --- |
| **New file…**, **New folder…** | Creates it in that folder. The same items are in the menu of empty tree space. |
| **Rename** (<kbd>F2</kbd>), **Duplicate** | Renames or copies the file. |
| **Delete** (<kbd>Delete</kbd>) | Deletes it after you confirm. |
| **Copy path**, **Copy relative path** | Copies the path. |
| **Add to prompt** | Inserts the file into the prompt box as an @mention. |

## Keys

| Key | Where | Does |
| --- | --- | --- |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | Anywhere | Open a file by name. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> in the list inserts `@path` into the prompt instead. |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Editor | Save |
| <kbd>Alt</kbd>+<kbd>K</kbd> | Editor | Insert the file and the selected lines into the prompt box (<kbd>⌥</kbd> <kbd>K</kbd> on Mac) |
| <kbd>Ctrl</kbd>+<kbd>\\</kbd> | Anywhere | Show or hide the file tree |

## Good to know

- Images and videos open as a preview. SVG files can switch between preview and text (**Show preview**).
- If the file changed on disk while you edited it, you choose: reload it or overwrite it.
- The browser warns you before you leave the page with unsaved changes.
- Only files inside the allowed roots can be opened. See [`--roots`](../reference/cli).
