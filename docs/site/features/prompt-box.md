# The prompt box

The box at the bottom of a session. You type prompts here, and pick the model, mode and effort.

## Keys

| Key | Does |
| --- | --- |
| <kbd>Enter</kbd> | Send |
| <kbd>Shift</kbd>+<kbd>Enter</kbd> | New line |
| <kbd>Enter</kbd> while Claude works | **Steer**: your message joins the running turn right away |
| <kbd>Esc</kbd> | Stop the running turn (same as the **Stop** button) |
| <kbd>Shift</kbd>+<kbd>Tab</kbd> | Next [permission mode](permissions) |
| <kbd>Ctrl</kbd>+<kbd>L</kbd> | Jump to the prompt box from anywhere |

## Bash mode: `!`

1. Type `!` as the first character. The box turns into a shell prompt.
2. Type a command, for example `! npm test`, and press <kbd>Enter</kbd>.
3. It runs in the session's folder. The output shows in the timeline, and Claude sees it in the next turn.
4. **Stop** kills a command that hangs. <kbd>Esc</kbd> (or <kbd>Backspace</kbd> in an empty box) leaves bash mode.

`!` also works in a new session's box: it starts the session and runs the command.

## Slash commands: `/`

- Type `/` to list commands and skills. Pick one with the arrows and <kbd>Enter</kbd>. <kbd>Tab</kbd> inserts it.
- A `/command` works in the middle of a message too, like in Claude Code.
- Some open a dialog instead of being sent: `/mcp`, `/skills` (or `/help`), `/plugins`, `/resume`. See [MCP, skills & plugins](config-dialogs).
- `/clear` starts a fresh session in the same tab.

## Files and images

- Type `@` and part of a file name to mention a file.
- Paste or drop images into the box, or click **+** (**Add images and files**). PNG, JPEG, GIF and WebP go to Claude as images.
- Other files are uploaded and added to the prompt as a path.

## Pickers under the box

| Picker | Options |
| --- | --- |
| Permission mode | Ask before edits, Edit automatically, Plan mode, Auto mode, Don't ask, Bypass permissions (only with `--allow-bypass`) |
| Model | The models your Claude account offers |
| Thinking effort | Default, Low, Medium, High, Extra high, Max (what the model supports) |

On a phone the three pickers fold into one settings chip.

## Good to know

- The formatting row has Bold (<kbd>Ctrl</kbd>+<kbd>B</kbd>), Italic (<kbd>Ctrl</kbd>+<kbd>I</kbd>), Inline code (<kbd>Ctrl</kbd>+<kbd>E</kbd>), Code block, Link and Bullet list. It writes plain Markdown.
- What you type is saved as a draft in this browser. It survives a reload. Images are not saved in drafts.
- The box grows with your text, then scrolls.
- The ring next to the send button is the context meter. See [Usage & context](usage).
