# Updates

claude-code-ui checks npm for a new version when it starts and once a day, and can update itself.

## How to update from the app

1. When a new version exists, a notice shows **Update available**.
2. Click **Update and restart**. It installs the new version while your sessions keep running.
3. It restarts once no session is working. **Restart now** does not wait: it ends running turns and closes terminals.
4. The page reconnects by itself. Your sessions come back.

**Not yet** hides the notice until the next version.

## How to update from a terminal

```sh
claude-ui update
```

The next start runs the new version.

## Good to know

- Updates go into the `versions/` folder of the [config folder](../reference/cli#files). No global install and no `sudo` needed. It also works when you run it with `npx`.
- `npm i -g claude-code-ui@latest` still works too.
- If a new version does not start, claude-code-ui starts the previous one and says so. To retry, delete `versions/<version>` in the config folder and restart.
- A source checkout (`npm start`) does not update itself.
- Turn the check off with `--no-update-check`. Use a registry mirror with `CLAUDE_UI_UPDATE_REGISTRY=https://npm.example.com`.
- The check only asks npm for the latest version number. Nothing about you or your sessions is sent.
