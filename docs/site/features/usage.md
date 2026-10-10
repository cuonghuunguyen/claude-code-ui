# Usage & context

Two small meters show how much you have left.

| Meter | Where | Shows |
| --- | --- | --- |
| **Plan usage** | Top right of the window | How much of your Claude plan's limits you used |
| **Context window** | Next to the send button | How full this session's context is |

## Plan usage

1. Look at the ring at the top right. It shows a percent.
2. Click it to see every window, like **Current session** and **Current week (all models)**, with when each resets.
3. The ring turns into a warning icon when you get close to a limit, and shows **Limit reached** when you hit one.

Choose which window the ring shows in [Settings › Usage limits](../reference/settings#usage-limits): Highest usage, Session (5 h) or Weekly.

## Continue after a limit

When a session stops because of the plan limit, claude-code-ui can send it "continue" once the limit resets.

1. Turn on **Continue automatically after a usage limit resets** in **Settings › Usage limits**.
2. A note above the prompt box shows when it will continue. **Cancel automatic continue** stops it.

Sending a message yourself also cancels it. Several stopped sessions continue one after another.

## Context window

- Click the ring next to the send button to see what fills the context: messages, system prompt, tools, MCP tools, memory files and skills.
- It also shows tokens and cost for the session.

## Good to know

- The numbers come from your Claude account, the same as `/usage` in Claude Code.
- A daemon restart drops scheduled continues.
- The status bar under the prompt box shows the session's input, output and cached tokens.
