# Files

The **Files** pane in the side panel: a file tree and a simple editor for the session's folder.

## How to use

1. Open the side panel and pick **files** (or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>).
2. Click a file in the tree to open it in an editor tab.
3. Edit it and press <kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd> <kbd>S</kbd> on Mac) to save.
4. To find a file by name, press <kbd>Ctrl</kbd>+<kbd>P</kbd> (**Open file**).

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
