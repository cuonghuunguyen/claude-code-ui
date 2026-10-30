# Background shells

A shell command can run in the background: the turn goes on, the command keeps running, and its end is reported to Claude.

## Move a command to the background

- On the card of a running Bash command, click **Run in background**, or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> (<kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>B</kbd> on a Mac) while the session runs one. The card becomes a background shell card. Cards of Bash commands that a subagent runs have the button too.
- A `!` command of [bash mode](prompt-box#bash-mode) has the same button.
- While Claude works, a `!` command you type waits in the queue like a message and runs when the session is idle.

## The shells list

1. Click **N shells** in the status bar under the prompt box, run **Background shells** in the [command palette](palette), or type `/tasks` (or `/bashes`) in the prompt box.
2. The list shows every shell of the session, running ones first, with command, description, status (running, completed, failed or killed) and run time.
3. Open a shell to read its output. It updates live while the shell runs. A shell started before `/clear` still shows its output.
4. **Kill** stops a running shell after you confirm.

## Good to know

- **Stop** or <kbd>Esc</kbd> stops the turn, not the background shells.
- A running shell counts as work: the session shows as working, and is not closed as idle.
- Claude learns of a shell you killed with your next message.
