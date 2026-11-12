# Files

The **Files** pane: a file tree and a simple editor for the session's folder. It lives in the side panel by default; it can also be a tab in the main area (see [Panes & layout](panes)).

![The file tree with cart.ts open in the editor](/screenshots/files.png)

## How to use

1. Open the side panel and pick **files** (or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>).
2. Click a file in the tree to open it in an editor tab.
3. Edit it and press <kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd> <kbd>S</kbd> on Mac) to save.
4. To find a file by name, press <kbd>Ctrl</kbd>+<kbd>P</kbd> (**Open file**).

## File view

- The tree shows a file-type icon and a git status mark (modified, added, untracked…) for each file. A file inside a nested repository or a submodule gets the mark of its own repository. A repository folder shows a repository icon and a submodule an archive icon; neither gets a single `U` from the parent. Right-click one for **Show changes** or **Show graph**: they switch the [repository selector](changes#repositories) of Changes and Git graph.
- Open tabs and unsaved edits come back after a page reload.
- A single click opens a **preview tab** (its title is in italics); the next single click replaces it. Double click the tab or the tree row, or edit the file, to keep it open.
- A breadcrumb path and an unsaved marker (●) sit above the editor. Markdown files can show a rendered preview.
- Markdown preview shows tables at full height; the preview scrolls.
- Binary and very large files show a clear message instead of opening.
- **Filter files** and `@` in the prompt box also find files inside nested repositories and submodules.
- With no file open, the tree fills the tab. From 672px of panel width the tree sits beside the editor; below that it is a drawer (the **Files** button or <kbd>Ctrl</kbd>+<kbd>\\</kbd>).

## File dialog

Click **Pop out** in the Files tab to open the tree, tabs and editor in a large dialog. It is the same state: open tabs, unsaved edits, cursor and undo history carry over, and back (**Open in editor**).

A **Read** card in the timeline, a file path in Claude's answer (`src/cart.js:12`) and **Open in file dialog** in the tree menu open the file there, at its line. A bare file name in Claude's answer (`cart.js`) opens the matching file of the project. The match ignores case. When several files match, a file picker opens filtered by the name. With no match, a **File not found** message shows.

## File tree menu

Right-click (long press, or <kbd>Shift</kbd>+<kbd>F10</kbd>) a file or folder:

| Item | Does |
| --- | --- |
| **New file…**, **New folder…** | Creates it in that folder. The same items are in the menu of empty tree space. |
| **Rename** (<kbd>F2</kbd>), **Duplicate** | Renames or copies the file. |
| **Delete** (<kbd>Delete</kbd>) | Deletes it after you confirm. |
| **Cut**, **Copy**, **Paste** | Moves or copies files and folders. See [Copy, cut, paste and drag](#copy-cut-paste-and-drag). |
| **Copy path**, **Copy relative path** | Copies the path. |
| **Reveal in Finder** (**Reveal in File Explorer** on Windows, **Open Containing Folder** on Linux) | Shows the file or folder in the file manager of the computer that runs claude-code-ui. |
| **Open in** *editor* | Opens the file or folder in VS Code, Cursor or IntelliJ IDEA, when it is installed on that computer. |
| **Open with Default App** | Opens a file with the app your system picked for its type. Not for folders. |
| **Open in tab** | Moves the file into its own tab next to its session (also middle click on the row). See [Panes & layout](panes#one-file-or-one-artifact-as-a-tab). |
| **Add to prompt** | Inserts the file into the prompt box as an @mention. |

### Open in the file manager, an editor or the default app

The three **Reveal**, **Open in** and **Open with Default App** items start a program on the computer that runs the daemon, so they show only when the browser runs on that computer (`localhost`) or the file is in a WSL [side](wsl-docker). A phone, a Tailscale browser, a Docker or an SSH side does not get them. On Linux, **Open Containing Folder** opens the folder without selecting the file. The same items are in the menus of Changes rows. The command palette has **Open in file manager** (no default key) for the open file, the selected Changes row or the session folder. **Settings › Open in app** can add your own editor command.

## Copy, cut, paste and drag

- **Copy** or **Cut** a row (menu, <kbd>Ctrl</kbd>+<kbd>C</kbd> or <kbd>Ctrl</kbd>+<kbd>X</kbd>; <kbd>⌘</kbd> on Mac), then **Paste** into a folder (menu on a folder or on empty tree space, <kbd>Ctrl</kbd>+<kbd>V</kbd>). A cut row is dimmed until you paste it.
- Drag a row onto a folder to move it. It always asks first ("Move … into …?"). Hold <kbd>Alt</kbd> (<kbd>Option</kbd> on Mac) to copy.
- It works across [sides](wsl-docker): copy a file on your computer and paste it into a WSL distro, a container or an SSH host. The bytes go through the browser, 1 MiB at a time. The dialog then says "Copy … into … on *side*?".
- Files and folders dragged from your system into the tree are uploaded. Files pasted from your system clipboard are uploaded too. A folder pasted from the system clipboard is refused; drag it instead.
- A name that exists in the target asks: **Replace**, **Skip** or **Keep both** ("name copy.ext"), with **Apply to all** when more clashes wait. **Replace** saves the replaced file in [Local history](timeline#local-history-file-timeline).
- A progress line "Copying 12 of 340 files" with **Cancel** shows for a long copy. Cancel leaves nothing behind. Limits: 10,000 entries and 512 MiB per paste. Links are not copied between machines.

## Find in files

<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> (<kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>F</kbd> on Mac, or **Find in files** in the command palette) searches the text of the project's files with `git grep`, so git must be installed. Text selected in the editor or a text field becomes the query.

- Results are grouped by file, with two lines of context and the hits marked. <kbd>Enter</kbd> or a click opens the match at its line.
- The regex button switches to a regular expression (Perl-compatible, as `git grep -P`: `\d`, `\w` and `\b` work; a git built without PCRE says so). **Files to include** takes patterns such as `*.ts, *.tsx`.
- Ignored files are skipped in a git project; the eye button includes them. A folder that is not a git project searches everything, ignored files included, and the button hides them.
- <kbd>↑</kbd> and <kbd>↓</kbd> in the boxes recall earlier searches; in the result list (<kbd>Tab</kbd>) they move between matches.
- A search stops after 5 s, 200 files or 2000 matches, and says so. Binary files are skipped.

## Keys

| Key | Where | Does |
| --- | --- | --- |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | Anywhere | Open a file by name. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> in the list inserts `@path` into the prompt instead. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> | Anywhere | Find in files |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Editor | Save |
| <kbd>Alt</kbd>+<kbd>K</kbd> | Editor | Insert the file and the selected lines into the prompt box (<kbd>⌥</kbd> <kbd>K</kbd> on Mac) |
| <kbd>Ctrl</kbd>+<kbd>\\</kbd> | Anywhere | Show or hide the file tree |

## Good to know

- Images and videos open as a preview. SVG files can switch between preview and text (**Show preview**).
- If the file changed on disk while you edited it, you choose: reload it or overwrite it.
- The browser warns you before you leave the page with unsaved changes.
- Only files inside the allowed roots can be opened. See [`--roots`](../reference/cli).
