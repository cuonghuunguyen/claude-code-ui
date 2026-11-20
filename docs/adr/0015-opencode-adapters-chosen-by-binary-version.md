# One OpenCode Engine with two adapters, chosen by the installed binary version

OpenCode 2 rebuilt the server API and plugin API. The OpenCode Engine gets a second adapter for version 2; the version 1 adapter stays unchanged. The Daemon reads `opencode --version` from `opencode.path` and uses the matching adapter. The user sees one Engine: `EngineName`, settings, picker and sidebar tag do not change.

OpenCode 2 Session IDs also start with `ses_`, so the ID does not tell the adapter. The Daemon records the adapter of every Session it creates; a Session with no record belongs to version 1. A Session whose adapter differs from the installed binary shows "needs an OpenCode 1 (or 2) binary" and is not converted.

## Considered options

- **Separate Engine `opencode2` with its own path, picker entry and catalogue**: allows both versions at once, but one binary is normal on a machine, so most users would see a disabled entry; adds settings, picker, tag and i18n work.
- **Ask both servers which one has the ID**: needs both binaries installed and running; after OpenCode 2 imported the OpenCode 1 history an ID exists in both stores, so the answer is ambiguous.
- **Daemon-side ID prefix for version 2**: every call translates the ID; hard to reverse.
- **One Engine, two adapters, stored record** (chosen).

## Consequences

- A machine uses one version at a time, the one `opencode.path` points to.
- The version check has a minimum per major version: 1.18.0 for version 1, 2.3.0 (the tested version) for version 2.
- Spike result (OpenCode 2.3.0): both versions use one file, `opencode.db`, with separate tables. Version 2 imports version 1 history once, at its first start; later version 1 messages are not imported, and version 1 cannot see version 2 sessions.
- Both versions run as `opencode serve` with the same argv, port line, Basic auth and stop behaviour, so the Daemon shares one server process layer between the adapters. Only the health route (`/api/info`, not `/global/health`), the event route (`/api/event`) and the event shape (`{type, data, location, durable?}` instead of `{directory, payload}`) differ.
- The spike ran both servers at the same time on one store without errors. A later UI test found that an OpenCode 1 binary cannot start on an `opencode.db` that OpenCode 2 started on first (issue "OpenCode 2: after a v2 start the OpenCode 1 binary cannot start on the same opencode.db", being triaged). The hint "set the path to an OpenCode 1 binary" is therefore not guaranteed to work after a version 2 start; the Daemon starts the version 2 server only when a version 2 adapter needs it.
- Version 1 gets critical fixes only; no removal date.
