# One Hub per machine; a Hub attaches to the Hub of a Side machine

A Side machine (SSH host, WSL distro, Docker container) may already run a Hub of its user. A separate `--side` process beside it wrote the same config files and could resume the same session, so two SDK processes appended to one transcript. Instead, `claude-ui side --attach` reads `daemon.json` there: a live Hub whose frame schema range `[min, max]` overlaps ours is attached through its attach socket; with no Hub running, the attaching Hub installs its own build and starts a Hub, then attaches. The `--side` mode and its separate state dir are removed. Side is a role of a Hub, not a process.

## Rules

- A Hub the user started is never stopped, restarted or reconfigured by an attaching Hub; its policy (allowed roots, bypass, default mode) is the ceiling for attached sessions.
- A Hub started by attach listens on 127.0.0.1 like any Hub, and exits after the grace period once no Hub is attached, no browser is connected and no turn runs.
- Schema mismatch with a running Hub: no attach and no fallback process. The row shows the versions and an Update button that runs `claude-ui update` there; after the restart it attaches by itself.
- The attached Hub stops for good: the row shows the disconnect and Retry, which attaches again or starts a Hub.
- The attach socket accepts the same OS user only (mode 0700), no token.
- Several Hubs may attach to one Hub at once, as several browsers connect to it; the takeover rule and Hub id of SSH Sides go away.

## Considered options

- **Separate `--side` process with its own state dir**: no file collisions, but two owners of one session on one machine remain.
- **Fallback Side on mismatch, plus a session lock beside the transcript**: usable at once, but needs a third exception to ADR 0001 and keeps two process kinds.
- **Local Hub as a browser client of the remote Hub**: needs the pairing token and the browser protocol, which does not carry terminals and paths the Side way.

## Consequences

- A container that bind-mounts the host's `~/.claude` runs a second Hub over the same transcripts; that case is not protected.
- The frame schema range is the compatibility contract between independently updated Hubs, and for the bridge too: the attaching Hub runs the bridge of the Hub there (`exec` in its `daemon.json`) and installs its own build only when no Hub runs there or the schemas do not overlap. The bridge command line (`side --attach [--start]`) is part of that contract: a Hub's cli must keep accepting it.
