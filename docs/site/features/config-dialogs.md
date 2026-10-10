# MCP, skills & plugins

Three dialogs manage Claude Code's MCP servers, skills and plugins, the same way the VS Code extension does. Changes are saved to Claude Code's own config files, so the `claude` CLI sees them too.

## How to open them

| Dialog | Type in the prompt box | Or in the [palette](palette) |
| --- | --- | --- |
| **MCP servers** | `/mcp` | MCP servers |
| **Slash commands** (skills) | `/skills` or `/help` | Slash commands |
| **Manage Plugins** | `/plugins`, `/plugin` or `/marketplace` | Manage plugins |

## MCP servers

- See each server and its status. Open one to see its tools.
- Turn a server on or off, reconnect it, sign in to it, or remove it.
- **Add MCP server:** give a name, pick the **Transport** (stdio, SSE or HTTP) and the **Scope**, then **Add server**.
- If a server needs a browser sign-in, finish it and paste the **Callback URL** back into the dialog when asked.

## Slash commands

Lists every command and skill. Each skill has a **state**:

| State | Claude sees it | You can run it |
| --- | --- | --- |
| On | Name and description | Yes |
| Name only | Name only | Yes |
| User only | No | Yes |
| Off | No | No |

## Plugins

- **Plugins** tab: installed and available plugins. Install, turn on or off, **Update plugin**, **Uninstall**.
- **Marketplaces** tab: add or remove plugin catalogs, or refresh one.

## Scopes

Where a setting is saved:

| Scope | Applies to | Saved in |
| --- | --- | --- |
| **Local** | This project, only you | `~/.claude.json` |
| **User** | All your projects | Your user settings |
| **Project** | Everyone who uses the repo | `.mcp.json` / `.claude/settings.json` in the repo |
