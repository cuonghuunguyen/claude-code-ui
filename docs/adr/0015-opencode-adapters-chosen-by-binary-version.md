# One OpenCode Engine with two adapters, chosen by the installed binary version

OpenCode 2 rebuilt the server API and plugin API. The OpenCode Engine gets a second adapter for version 2; the version 1 adapter stays unchanged. The Daemon reads `opencode --version` from `opencode.path` and uses the matching adapter. The user sees one Engine: `EngineName`, settings, picker and sidebar tag do not change.

OpenCode 2 Session IDs also start with `ses_`, so the ID does not tell the adapter. The Daemon records the adapter of every Session it creates under version 2, in its own file (`opencode-adapters.json`), and of a Session with no record at its first version 2 turn. A Session with no record belongs to version 1 unless the installed version 2 has it: version 2 imports the version 1 history at its first start, so the user's earlier Sessions stay available after the upgrade, and the Daemon opens them with version 2. Which adapter opens a Session:

| Installed binary | Record | Result |
|---|---|---|
| version 2 | `2` | version 2 |
| version 2 | none | version 2 when version 2 has the Session; else "needs an OpenCode 1 binary" |
| version 1 | none | version 1 |
| version 1 | `2` | "needs an OpenCode 2 binary", also when version 1 still has an older copy: the copy misses the version 2 turns |

A mismatched Session is not converted.

## Considered options

- **Separate Engine `opencode2` with its own path, picker entry and catalogue**: allows both versions at once, but one binary is normal on a machine, so most users would see a disabled entry; adds settings, picker, tag and i18n work.
- **Ask both servers which one has the ID**: needs both binaries installed and running; after OpenCode 2 imported the OpenCode 1 history an ID exists in both stores, so the answer is ambiguous.
- **Daemon-side ID prefix for version 2**: every call translates the ID; hard to reverse.
- **A Session with no record never opens with version 2** (the first wording of this ADR): after the upgrade the Sessions the user made with OpenCode 1 would disappear from the Daemon although OpenCode 2 shows them. Rejected.
- **One Engine, two adapters, stored record** (chosen).

## Consequences

- A machine uses one version at a time, the one `opencode.path` points to.
- The version check has a minimum per major version: 1.18.0 for version 1, 2.3.0 (the tested version) for version 2.
- Spike result (OpenCode 2.3.0): both versions use one file, `opencode.db`, with separate tables. Version 2 imports version 1 history once, at its first start; later version 1 messages are not imported, and version 1 cannot see version 2 sessions.
- Both versions run as `opencode serve` with the same argv, port line, Basic auth and stop behaviour, so the Daemon shares one server process layer between the adapters. Only the health route (`/api/info`, not `/global/health`), the event route (`/api/event`) and the event shape (`{type, data, location, durable?}` instead of `{directory, payload}`) differ.
- The record is a separate file, not `sessions.json`: that one drops entries past 1000 and prunes entries without a transcript, which would turn a version 2 Session into a "version 1" one. Only version 2 is written; the Daemon never prunes a recorded Session's settings entry under a version 1 binary.
- After the first version 2 turn of an imported Session, its version 1 copy and its version 2 copy differ. The record makes the Daemon show the version 2 one only.
- The spike ran both servers at the same time on one store without errors, and a version 2 server started on a store that version 1 had started on first. Checked again with the real binaries (OpenCode 2.3.0 and `opencode-ai` 1.19.5, a scratch home, no login): the order matters. Version 1 first, then version 2, then version 1 again: all three start. A fresh store started by version 2 first: `opencode-ai` 1.19.5 then fails with "Database is not empty and has no session table" (issue "OpenCode 2: after a v2 start the OpenCode 1 binary cannot start on the same opencode.db"). The mismatch text "set the path to an OpenCode 1 binary" is therefore not guaranteed to work after a version 2 start on a fresh store; the Daemon starts the version 2 server only when a version 2 adapter needs it.
- Version 1 gets critical fixes only; no removal date.
