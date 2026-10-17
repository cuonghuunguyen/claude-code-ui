# Panes & layout

Changes, Files, Git graph and Terminal are **panes**. Each one is a tab of the side panel or of the bottom panel, and you choose where it lives.

![The workspace with the terminal docked at the bottom](/screenshots/panes.png)

## How to use

1. Right-click a pane tab (<kbd>Shift</kbd>+<kbd>F10</kbd> on the keyboard, long press on touch) and pick **Move to bottom panel** or **Move to side panel**.
2. Or open the panel's **⋯** menu (**Side panel actions** or **Bottom panel actions**) and pick **Move … to bottom panel** or **Move … to side panel**.
3. Or drag a pane tab onto another tab or onto a panel. A dashed **Side panel** or **Bottom panel** strip shows where an empty panel is. <kbd>Esc</kbd> cancels the drag.
4. To dock the side panel on the other side, use **Move side panel to left** (or **right**) in its **⋯** menu.
5. To undo all of it, pick **Reset layout** in a pane tab's menu, a panel's **⋯** menu or the [command palette](palette).

## The terminal

The [terminal](terminal) is in the bottom panel by default, under the session and the side panel. The bottom panel resizes (drag the handle above it), maximizes (**Maximize panel** / **Restore panel**) and hides (**Hide bottom panel**). Press <kbd>Ctrl</kbd>+<kbd>`</kbd> or use the terminal button in the titlebar to show or hide it.

To keep the terminal in the side panel, set **Terminal position** to **Side panel** in [Settings › Terminal](../reference/settings#terminal), or move its tab.

## Good to know

- A moved pane keeps its state: open files, running terminals, the loaded graph. Its tab keeps the keyboard focus.
- A panel with no pane is hidden. Git graph only shows in a git folder.
- The layout is kept per browser. The side panel and the bottom panel reopen on the tab you selected last, also after a reload.
- **Reset layout** restores the default layout and forgets the remembered tabs. It does not change sizes.
- On a phone there is no docking: the pane switcher opens on the pane you used last.
