# Engine interface with capability flags, not per-engine UI

Sessions run on an Engine (Claude or OpenCode) behind one daemon interface that emits the shared Part/Event stream. The web app shows one UI and reads capability flags from the session info (permission modes, effort, rewind, fork, steering, slash commands, plan meter, account, shell) to hide or disable controls; it never branches on the engine name.

Considered: a second Session class and OpenCode-specific Part types (duplicates every feature, UI forks); emulating missing features in the daemon (fake checkpoints and plan meter, diverges from the Engine's truth). Capability flags make "full parity" mean "every feature the Engine supports", and a new Engine only fills the flags.

## Consequences

- The protocol owns its model info type; the web app has no engine SDK import.
- A feature OpenCode cannot support is hidden with a stated reason and tracked as a follow-up issue, not emulated.

## Amendment: support tables and the conformance suite

A capability flag is no longer written by hand per adapter. Each adapter (Claude, OpenCode 1, OpenCode 2) has a support table (`Engine.support`, type `SupportTable` in `packages/protocol/src/support.ts`): per feature, `"supported"` or `{ gap: reason }`. The flags of `EngineCapabilities` derive from it (`capabilitiesFromSupport`); the wire shape does not change, and the gap reason stays in the daemon. A flag not yet covered by a table stays hand-written until its feature joins the table.

The engine conformance suite (`packages/daemon/test/conformance`) runs every scenario against every adapter, replaying recorded fixtures through a whole `Session`, and compares the Parts it emits with one hand-written, engine-neutral reference sequence per scenario (structure only: part kinds, tool status, error flags; no text, ids or timestamps). A scenario whose feature is a gap for the adapter is skipped, the reason in the test name.

- A new feature that an adapter can lack gets a table entry for every adapter and a scenario in the suite, not an adapter-specific test.
- A gap is an entry in the table, never an optional method or a silent no-op. The method of a gap throws the table's reason (`deniedRetry`: `allowDenied` and `alwaysAllowDenied` of OpenCode throw `DeniedRetryError("unsupported", reason)`).
- A feature no recording can show (Allow and retry needs a call auto mode denied) has no scenario; the suite checks that the engine's behaviour follows its table entry.
- Scenarios replay real recordings; a fixture is recorded only where none exists.
