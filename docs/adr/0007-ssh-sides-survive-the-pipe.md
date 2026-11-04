# SSH Sides survive their pipe

An SSH Side's Daemon detaches from the ssh pipe that started it and keeps running for a grace period (30 min by default, per host) with no Hub attached; the Hub reattaches with `ssh <host> claude-ui side --attach`, which bridges a new pipe to the Daemon's local socket. WSL and Docker Sides keep dying with their pipe and restarting.

- An ssh pipe drops on laptop sleep, Wi-Fi changes and Hub restarts; a WSL or Docker pipe does not. Dying with the pipe would lose running turns, terminals and pending prompts on every lid close.
- The bridge runs over plain ssh stdio: the remote opens no port and needs no `AllowStreamLocalForwarding`.
- A heartbeat every 15 s both ways (plus ssh `ServerAliveInterval`) detects a dead pipe after 45 s. The grace period counts only while nothing runs: a running turn holds the count at 0, so the full period starts again once the Daemon is idle; a turn waiting on a prompt or question counts as idle and is stopped at expiry.
- One Hub at a time: the newest attach takes over and the other Hub does not retry. A Hub restart reattaches to the hosts it had attached and never starts a remote Daemon at boot.
- Considered: die with the pipe and restart like other Sides (simpler, JetBrains Gateway's behavior), rejected for losing unattended work; a remote Daemon with its own port (a second Hub), rejected as a different concept.
- Consequences: a newer Hub reattaches to an older remote Daemon and updates it once idle, so the Side wire protocol must stay compatible one build back. POSIX remotes only for now; Windows OpenSSH kills a session's processes when it ends, so Windows remotes need their own way to detach.
