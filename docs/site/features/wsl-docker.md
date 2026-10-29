# WSL & Docker

One claude-code-ui can also run sessions inside your WSL distros (on Windows) and inside running Docker containers. Each of these is a **side**: its own Claude install, its own `~/.claude`, its own files.

::: warning Known issue in 0.5.0
WSL and Docker sides stop about 15 seconds after they start, with "stopped (exit code 1)". This is a bug, tracked in [#263](https://github.com/cuonghuunguyen/claude-code-ui/issues/263).
:::

## How to open a project in WSL or Docker

1. Start claude-code-ui on the host (on Windows: in Windows, not inside WSL).
2. Click **Open project**.
3. In **Where to open projects**, pick **WSL** (then a distro) or **Docker** (then a running container).
4. The first time, click **Install**. claude-code-ui copies itself into the side (`~/.local/share/claude-ui/side`) and starts it there. In a Docker container it brings Claude Code, and its own Node.js only when the container has none in range (see below).
5. Pick a folder and open it.

Later, **Check again** shows the side's state, and **Update** or **Reinstall** refreshes it.

## What the side needs

Most Docker containers (Linux on x86_64 or arm64 with glibc 2.28+, for example Debian, Ubuntu or Fedora images) get a **bundle**: your computer downloads the terminal support (node-pty) and Claude Code once (and Node.js only when the container or distro has no Node.js 22 or newer; one that has it is used as it is, also from nvm), checks each against its published checksum, keeps them in `~/.cache/claude-ui/side`, and copies one file into the container. Other containers (Alpine and other musl images, other CPUs) install with npm inside the container.

A WSL distro with the same requirements (glibc 2.28+, x86_64 or arm64) uses the same checked parts. Nothing is copied: the distro reads them from the cache on Windows. A first install takes about 10 to 15 seconds. A new claude-code-ui build with the same parts takes about a second, because the distro reuses the files of its earlier install. Other distros (musl) install with npm in the distro. If the distro does not answer the first check, the dialog says so and claude-code-ui installs with npm.

A WSL distro on the bundle path needs `bash`, `tar` and `gzip` (not only `sh`), and no Node.js for claude-code-ui itself. Hooks and MCP servers of your projects that call `node` or `npx` still need a Node.js in the distro.

| | WSL distro (bundle) | WSL distro (npm) | Docker container (bundle) | Docker container (npm, e.g. Alpine) |
| --- | --- | --- | --- | --- |
| `sh`, `tar`, `gzip` | Yes | | Yes | |
| Node.js 22+ | Used when present, not required | Yes | Used when present, not required | Yes |
| Claude login | `claude login` in the distro | Same | Copy `~/.claude/.credentials.json` in, run `claude login` in it, or set `CLAUDE_CODE_OAUTH_TOKEN` | Same |
| Build tools for the terminal | No | `build-essential python3` | No | make, python3, g++ (Alpine: `apk add make python3 g++`) |
| Network access to npm | No | Yes | No (`--network none` works) | Yes |
| A writable `/tmp`, `/dev/shm` or home folder | | | Yes | Yes |
| `git` (Git panel) | Optional | Optional | Optional | Optional |

In Open project, **What this container needs** lists these items for the container you picked, with a ✓ or ✗ for each after the check. If something is missing, the dialog tells you what to run. When the container installs with npm, the dialog says why. The Claude login is not checked: log in as the table says, and a session started without a login says so.

The bundle needs your computer to reach nodejs.org and the npm registry once per claude-code-ui version (`CLAUDE_UI_UPDATE_REGISTRY` sets a registry mirror). Without them and without a cached copy, the container installs with npm instead.

## Good to know

- Projects and sessions of all sides share one sidebar. A badge shows the side (for example `WSL` or `Docker`).
- A session on a side runs that side's Claude, opens that side's terminal and uses that side's config.
- A typed path picks its side: `C:\...` is Windows, `/home/...` is WSL, `\\wsl.localhost\<distro>\...` is that distro.
- Docker and Rancher Desktop's own WSL distros are skipped.
- In a container you can browse its home folder and the image's working directory. Set `CLAUDE_UI_ROOTS` in the container to change that.
- Without Docker, or while its engine is stopped, nothing changes. The Docker tab shows a hint.
