# WSL, Docker & SSH

One claude-code-ui can also run sessions inside your WSL distros (on Windows), inside running Docker containers and on machines you reach over SSH. Each of these is a **side**: its own Claude install, its own `~/.claude`, its own files.

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

## Coming back after a restart

A side that has run once starts again with Claude UI, and again by itself if it stops (after 2 s, 10 s and 60 s; the fourth stop within ten minutes shows an error with **Retry**). A container that runs again starts within about 30 seconds. After a new Claude UI build, the side updates from the downloaded bundle; if its distro or container needs npm, it stays off and the sidebar shows **Needs an update** with **Update**. While a side starts, its projects stay in the sidebar. In **Settings › Sides**, **Start with Claude UI** turns this off for a side (its projects leave the sidebar) and **Update automatically** stops the automatic update.

## SSH hosts

Every `Host` entry of your ssh config (`~/.ssh/config`, and the files it `Include`s) is a side named `SSH: <alias>`. It needs `ssh` on your computer. Linux and macOS hosts work. Windows hosts do not yet.

Sessions and terminals get the environment of your login shell on the host (`~/.zprofile`, `~/.zshrc`, `~/.bash_profile` ...), so tools from Homebrew, nvm or sdkman are found. After you edit those files, restart the host's Hub (stop the side, then start it). fish and tcsh: plain environment.

### How to open a project on an SSH host

1. Click **Open project**.
2. In **Where to open projects**, pick **SSH host**, then a host. A host that is not in the list: click **Add SSH host…**, type its ssh command and check the parsed host in the preview. **Add host** writes a `Host` entry into your ssh config. To rename or remove it, edit that file.
3. The first time, click **Install**. claude-code-ui copies itself to `~/.local/share/claude-ui/side` on the host over ssh, from your computer: the host needs no internet. A host the bundle does not fit (musl, other CPUs, macOS, BSD) installs with npm and needs Node.js 22+ and npm there. The dialog names what is missing.
4. Pick a folder and open it.

ssh runs without prompts (`BatchMode`): no password, no passphrase question. Use a key, an agent or a `ProxyJump` in your ssh config. If the host key is unknown or the login is refused, run `ssh <alias>` once in a terminal, then try again. The host keeps its own Claude login.

### One Hub per machine

A side is the Hub of that machine. If the host already runs a Claude UI, yours attaches to it and does not start a second one. If none runs, yours starts one there (on `127.0.0.1` only) and attaches. A Hub you started yourself on the host is never stopped, restarted or reconfigured. Its settings (allowed roots, bypass, default mode) limit the attached sessions.

Several Claude UIs can attach to one host at once, like several browsers to one Hub.

### When the connection drops

- A dropped ssh connection does not stop the host's turns, terminals or prompts. The side shows **Reconnecting…** and attaches again by itself.
- After you restart your Claude UI, it attaches again to the hosts it had attached. Turns and terminals are as they were.
- A Hub that your Claude UI started on the host ends when no Claude UI is attached, no browser is connected and no turn runs for the **Grace period**. Set it per side in **Settings › Sides** (**Keep running without Claude UI (minutes)**, default 30).
- If attaching fails for good, the row shows the reason and **Retry**.

### Versions

When the Claude UI on the host and yours cannot work together, the row names both versions: "Claude UI 1.1.0 there, 1.2.0 here: they cannot work together." If the one there is older, **Update** (in the Open project panel and in Settings › Sides) runs `claude-ui update` there. Your Claude UI attaches again by itself after the restart. If the one there is newer, update this Claude UI.

**Start with Claude UI** is off by default for an SSH host. Turn it on in Settings › Sides to connect at every start.

## Good to know

- Projects and sessions of all sides share one sidebar. A badge shows the side (for example `WSL`, `Docker` or `SSH: demo-host`).
- A project and a side can have your own name and icon. See [Custom names and icons](projects#custom-names-and-icons).
- A session on a side runs that side's Claude, opens that side's terminal and uses that side's config.
- A typed path picks its side: `C:\...` is Windows, `/home/...` is WSL, `\\wsl.localhost\<distro>\...` is that distro.
- Docker and Rancher Desktop's own WSL distros are skipped.
- In a container you can browse its home folder and the image's working directory. Set `CLAUDE_UI_ROOTS` in the container to change that.
- Without Docker, or while its engine is stopped, nothing changes. The Docker tab shows a hint.
