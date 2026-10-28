# Settings

Open **Settings** with <kbd>Ctrl</kbd>+<kbd>,</kbd> (<kbd>⌘</kbd> <kbd>,</kbd> on Mac) or the **Settings** button at the bottom of the sidebar. Pick a group on the left.

![The Settings dialog](/screenshots/settings.png)

Most settings are **kept in this browser** only. Orchestration, Usage limits (except the ring), Jira and desktop notifications are saved in the daemon and apply to every browser.

## Timeline

| Setting | Does |
| --- | --- |
| Signal only | Folds each run of tool calls into one line, like "4 tool calls · Read 3 · Grep 1". Your prompts, Claude's text, errors and waiting requests stay. Also <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd>. |

## Sending

| Setting | Does |
| --- | --- |
| While Claude works, Enter | **Steers the turn** (default; <kbd>Alt</kbd>+<kbd>Enter</kbd> queues) or **queues the message** (<kbd>Alt</kbd>+<kbd>Enter</kbd> steers). A queued message waits and starts its own turn when Claude is idle. The send button follows the choice. |

## Notifications

| Setting | Does |
| --- | --- |
| In-app notifications | A card in this page when another session needs input or finishes. On by default. |
| Push notifications | Notifications from this browser, also with the page closed. Needs HTTPS or localhost. |
| Desktop notifications on *computer* | The daemon's computer shows a system notification when no browser has push on. For every browser. |

See [Notifications](../features/notifications).

## Screen

| Setting | Does |
| --- | --- |
| Keep screen awake | Holds the screen on while claude-ui is open. See [Keep screen awake](../features/keep-awake). |
| Only while a session is running | Holds it only while a session runs or waits for you. |

## Changes

| Setting | Options |
| --- | --- |
| Default diff view | Session changes, Uncommitted, Against branch |

## Sidebar

| Setting | Does |
| --- | --- |
| Show only active sessions | Lists only sessions that run or need input. Search still finds all. |
| Group by | **Worktree** groups a project's sessions by worktree. **Project** lists them right under the project, with their state as text. |

## Tabs

| Setting | Does |
| --- | --- |
| Tab grouping | By project, By worktree, or None |
| Compact tabs | Shows each group as one chip. Open its tabs from the chip. Needs a tab grouping. |

## Terminal

| Setting | Does |
| --- | --- |
| Terminal position | **Bottom** (default) or **Side panel**. See [Panes & layout](../features/panes). |

## Keyboard

Opens the [Keyboard shortcuts](shortcuts) dialog, where you can rebind every shortcut.

## Guide

**Guided tour:** restart the short tour of projects, tabs, files, changes, git graph and terminal.

## Orchestration

Lets a session start and steer worker sessions. Off by default. **Notifications from workers** turns notifications for worker sessions on or off. Every setting is described on the [Orchestration](../features/orchestration#settings) page.

## Usage limits

| Setting | Does |
| --- | --- |
| Continue automatically after a usage limit resets | Sends "continue" to a session that the plan limit stopped, once the limit resets. |
| Usage ring shows | Highest usage, Session (5 h) or Weekly. Kept in this browser. |

## Jira

One Jira connection for the **Ticket** tab of [Create worktree](../features/projects#create-a-worktree).

| Setting | Does |
| --- | --- |
| Jira URL | Cloud: `https://<site>.atlassian.net`. Data Center or Server: the https address of your Jira (http only for `localhost` and `127.0.0.1`). Changing the host clears the saved token. |
| Email | Your Atlassian account email. Only for Jira Cloud. |
| API token / Personal access token | Cloud: an API token from id.atlassian.com › Security › API tokens. Data Center or Server: a personal access token from your Jira profile. Saved on the daemon's computer only (`secrets.json`), never shown again: the row then says **Token set**, with **Replace** and **Clear**. |
| Branch template | How a ticket names its branch. Default `{type}/{key}-{summary}`: `{type}` is `bugfix` for a Bug, `feature` for a Story, Task or New Feature, else empty; `{key}` is the ticket key; `{summary}` is the summary, shortened. |
| Ticket filter (JQL) | The tickets the Ticket tab lists, e.g. `project = ABC AND statusCategory != Done`. Typed text searches inside it; a key or ticket URL ignores it. Empty: your open tickets. |
| Test connection | Shows "Connected as *your name*" or the error. |

## About

The version of the web app and of the daemon.

## Not in Settings

- **Theme:** the theme button at the top right cycles System → Light → Dark.
- **Model, mode, effort:** per session, in the [prompt box](../features/prompt-box).
- **Server options** (port, roots, remote access): [CLI flags](cli).
