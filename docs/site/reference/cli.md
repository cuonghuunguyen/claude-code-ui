# CLI flags

```sh
claude-ui [options]
claude-ui update     # install the latest version; the next start runs it
```

Example:

```sh
claude-ui --port 5000 --roots ~/projects:~/oss
```

## Flags

| Flag | Environment variable | Default | Does |
| --- | --- | --- | --- |
| `--port <n>` | `PORT` | `4280` | Port to listen on |
| `--roots <paths>` | `CLAUDE_UI_ROOTS` | your home folder | Folders that sessions, files and terminals may use. Separate them like `PATH`: `:` (Windows: `;`) |
| `--tailscale` | `CLAUDE_UI_TAILSCALE=1` | off | Serve on your tailnet with `tailscale serve` and print the HTTPS link. See [Phone & remote access](../features/remote-access) |
| `--hostname <name>` | `CLAUDE_UI_HOSTNAME` | | HTTPS name of your own proxy in front of the daemon. Cannot be used with `--tailscale` |
| `--lan` | `CLAUDE_UI_LAN=1` | off | Also listen on the local network, plain HTTP |
| `--allow-bypass` | `CLAUDE_UI_ALLOW_BYPASS=1` | off | Offer the "Bypass permissions" mode |
| `--no-update-check` | `CLAUDE_UI_UPDATE_CHECK=0` | check on | Do not check npm for a new version |
| `--no-os-notify` | `CLAUDE_UI_OS_NOTIFY=0` | on | No desktop notifications on this computer |
| `-v`, `--version` | | | Print the version |
| `-h`, `--help` | | | Print the help |

A flag wins over its environment variable.

## Environment variables

Only as environment variables:

| Variable | Default | Does |
| --- | --- | --- |
| `CLAUDE_UI_IDLE_CLOSE_MINUTES` | `10` | Close the Claude process of an idle session that no tab shows after this many minutes. `0` = never. The next prompt resumes it. |
| `CLAUDE_UI_UPDATE_REGISTRY` | npm | An npm registry mirror for updates. Must be `https://` (plain `http://` only on localhost). |
| `CLAUDE_UI_CLAUDE_BIN` | the bundled one | Path to a different Claude Code binary. |

## Files

The **config folder** holds the daemon's own data:

| OS | Config folder |
| --- | --- |
| Linux, macOS | `$XDG_CONFIG_HOME/claude-ui`, else `~/.config/claude-ui` |
| Windows | `%APPDATA%\claude-ui` (or `~/.config/claude-ui` if that folder already exists or `XDG_CONFIG_HOME` is set) |

| File | Holds |
| --- | --- |
| `token` | The pairing token. Delete it and restart to unpair every browser. |
| `projects.json` | Your project list |
| `sessions.json` | Each session's model, mode, effort and worker links |
| `settings.json` | App-wide settings (see [Settings](settings)) |
| `vapid.json`, `push-subscriptions.json` | Push notification keys and subscribed browsers |
| `sides.json`, `side-pack/` | WSL and Docker sides |
| `versions/` | Installed updates |

Session history itself is not here. It stays in Claude Code's own transcripts in `~/.claude/projects/`.
