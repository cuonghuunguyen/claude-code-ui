# Permissions & modes

Before Claude runs a tool (a command, a file edit), it may ask you. This works exactly like Claude Code, with the same rules.

## How to answer a permission request

A card appears above the prompt box. It shows the tool and what it wants to do (the command, or a diff for an edit).

| Button | Does |
| --- | --- |
| **Allow once** | Runs it this time. |
| **Allow always** | Runs it and saves a rule so Claude does not ask again for the same thing. The card shows the rule first. |
| **Deny** | Blocks it. Type in **No, and tell Claude what to do differently** to tell Claude why. |

- For a file edit, **Edit content** lets you change the text before you allow it.
- A request waiting for you is also listed on the [Focus page](focus) and can send a [notification](notifications).

## Questions

Sometimes Claude asks you a multiple-choice question. Pick an option (or type your own answer) and click **Submit**. Several questions show one page at a time with **Back** and **Next**. **Dismiss** skips the question and stops the turn, like <kbd>Esc</kbd> in Claude Code.

## Permission modes

The mode decides what happens before a tool runs. Change it with the picker under the prompt box, or press <kbd>Shift</kbd>+<kbd>Tab</kbd> to cycle.

| Mode | What happens |
| --- | --- |
| **Ask before edits** | Asks before edits and commands (the default). |
| **Edit automatically** | File edits run without asking. Commands still ask. |
| **Plan mode** | Claude only reads and plans. It shows the plan and asks before it starts. |
| **Auto mode** | A classifier decides what is safe to run. |
| **Don't ask** | Denies anything not already allowed by a saved rule. |
| **Bypass permissions** | Runs everything without asking. Hidden unless you start with `--allow-bypass`. |

## Plan mode

When Claude finishes a plan, the card shows it with three buttons:

- **Yes, manually approve edits:** start, and ask before edits.
- **Yes, and auto-accept edits:** start, and edit without asking.
- **No, keep planning:** stay in plan mode. Type what to change.

## Good to know

- Rules you save with **Allow always** are Claude Code's own rules. The `claude` CLI uses them too.
- The models and modes on offer depend on your Claude account.
- Changing the mode while a card is open does not answer the card.
