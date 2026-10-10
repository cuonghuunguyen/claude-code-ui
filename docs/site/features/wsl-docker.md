# WSL & Docker

One claude-code-ui can also run sessions inside your WSL distros (on Windows) and inside running Docker containers. Each of these is a **side**: its own Claude install, its own `~/.claude`, its own files.

::: warning Known issue in 0.5.0
WSL and Docker sides stop about 15 seconds after they start, with "stopped (exit code 1)". This is a bug, tracked in [#263](https://github.com/cuonghuunguyen/claude-code-ui/issues/263).
:::

## How to open a project in WSL or Docker

1. Start claude-code-ui on the host (on Windows: in Windows, not inside WSL).
2. Click **Open project**.
3. In **Where to open projects**, pick **WSL** (then a distro) or **Docker** (then a running container).
4. The first time, click **Install**. claude-code-ui copies itself into the side (`~/.local/share/claude-ui/side`) and starts it there.
5. Pick a folder and open it.

Later, **Check again** shows the side's state, and **Update** or **Reinstall** refreshes it.

## What the side needs

| | WSL distro | Docker container |
| --- | --- | --- |
| Node.js 22+ | Yes | Yes |
| Claude login | `claude login` in the distro | Copy `~/.claude/.credentials.json` in, run `claude login` in it, or set `CLAUDE_CODE_OAUTH_TOKEN` |
| Build tools for the terminal | `build-essential python3` | make, python3, g++ (the `node:22` image has them) |
| Network access to npm | Yes | Yes |

If something is missing, the dialog tells you what to run.

## Good to know

- Projects and sessions of all sides share one sidebar. A badge shows the side (for example `WSL` or `Docker`).
- A session on a side runs that side's Claude, opens that side's terminal and uses that side's config.
- A typed path picks its side: `C:\...` is Windows, `/home/...` is WSL, `\\wsl.localhost\<distro>\...` is that distro.
- Docker and Rancher Desktop's own WSL distros are skipped.
- In a container you can browse its home folder and the image's working directory. Set `CLAUDE_UI_ROOTS` in the container to change that.
- Without Docker, or while its engine is stopped, nothing changes. The Docker tab shows a hint.
