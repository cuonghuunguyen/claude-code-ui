# Engine interface with capability flags, not per-engine UI

Sessions run on an Engine (Claude or OpenCode) behind one daemon interface that emits the shared Part/Event stream. The web app shows one UI and reads capability flags from the session info (permission modes, effort, rewind, fork, steering, slash commands, plan meter, account, shell) to hide or disable controls; it never branches on the engine name.

Considered: a second Session class and OpenCode-specific Part types (duplicates every feature, UI forks); emulating missing features in the daemon (fake checkpoints and plan meter, diverges from the Engine's truth). Capability flags make "full parity" mean "every feature the Engine supports", and a new Engine only fills the flags.

## Consequences

- The protocol owns its model info type; the web app has no engine SDK import.
- A feature OpenCode cannot support is hidden with a stated reason and tracked as a follow-up issue, not emulated.
