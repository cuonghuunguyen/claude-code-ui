# Reading a session

The middle of the screen is the **timeline**: your prompts, Claude's answers and everything Claude did, newest at the bottom.

![A session: prompt, tool cards and an answer](/screenshots/session.png)

## What you see

- **Tool cards:** one card per thing Claude did. Click a card to open it.
  - Bash: the command and its output.
  - Edit and Write: a diff of the change.
  - Read, Grep, Glob: the file or pattern.
  - TodoWrite: Claude's todo list. While Claude works, the list also sits above the prompt box.
  - Agent: a subagent run. Open it to see the subagent's own timeline.
  - Bash that runs in the background: see [Background shells](background-shells).
  - Artifact: a page Claude published. The card previews it. **Open in tab** shows it in its own tab, and the Artifacts pane lists all of the session (see [Panes & layout](panes)).
- **Markdown answers** with code highlighting, tables, math and Mermaid diagrams.
- **Sticky prompt:** when you scroll up, the prompt of the turn you are reading stays at the top. Click it to jump there.

## How to use

| To | Do |
| --- | --- |
| Fold all tool calls into one line | Turn on **Signal only** (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd>) |
| Copy Claude's answer | **Copy response** under a finished turn |
| Quote part of an answer | Select the text, click **Quote in prompt** |
| Open an image big | Click it |
| Go back in time | Hover your prompt, click **Rewind to before this message** |

## Rewind

Rewind returns the session to before one of your prompts. Pick what to restore:

- **Restore code and conversation**
- **Restore conversation** (files stay as they are)
- **Restore code** (the chat stays)

You can also run "Rewind" from the [command palette](palette). Rewind is not available while Claude is working.

## I'll be back

**I'll be back** (the button next to **Copy response** under a finished reply) marks the reply to come back to later.

1. Click it. The session writes a short brief of the work (**About**, **Focus now**, **Next**) as a turn shown as one collapsed row, "Brief for your mark". A busy session writes it after the current turn.
2. In the panel under the reply, add a **Note** (up to 280 characters) and **Remind me in** (a number and m, h or d, from 1m to 7d: `30m`, `2h`, `1d`). The reminder fires once.
3. Open the brief later: it says how many turns passed since it was written, and **Refresh brief** writes a new one.
4. **Done** removes the mark. Clicking the button again only focuses the panel.

The [Focus page](focus) lists the marks under **Come back to**. A reminder shows as a push notification, or as a card in an open page with **Snooze** and **Dismiss**. A reminder that came due while the daemon was off shows at the next start.

## Local history (file Timeline)

Not to be confused with the session timeline above: the **Timeline** section under the file tree of [Files](files) belongs to the file open in the editor. It lists, newest first, its **Local history** entries and its **Git history** commits. The filter menu (**Filter timeline**) shows one kind or both, kept in this browser.

- **Local history** keeps the previous content of a file each time you save it, Claude edits it or a git action replaces it. An entry holds the text from before the change, so the current text is always on disk.
- Each entry has a reason: "File saved", "Agent edit", "Before rollback", "Before checkout", "Before reset", "Before stash drop", "Before abort", "Before restore", "Before paste" or "Named entry". Reset hard, Smart checkout, stash drop, Abort and [Rollback](git#roll-back-changes) save the replaced text first, so none of them loses work.
- **Create named entry** keeps the file as it is on disk now, under a name you give.
- A row menu offers **Compare with current**, **Compare with previous**, and for Local history rows **Restore**, **Rename** and **Delete**. **Restore** first asks you to save or discard your edits.
- Up to 50 entries and 256 KB per file are kept, in the daemon's config folder. **Settings › Local history** turns it off and lists **Excluded paths** (glob patterns, for example `**/dist/**`). See [Settings](../reference/settings#local-history).

## Good to know

- **Signal only** applies to every session in this browser. Your prompts, Claude's text, errors and requests waiting for you always stay visible.
- Code rewind covers changes made by Claude's Edit and Write tools. It does not undo shell commands.
- Long sessions load the newest turns first. Scroll up for older ones.
- Copy buttons need HTTPS or `localhost`.
