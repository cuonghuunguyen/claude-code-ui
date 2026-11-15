# The browser keeps a cache of session views, never a source of truth

A reload re-downloads the list and every open session over a slow phone link. The browser keeps the last session list, session infos, titles and views in IndexedDB (`claude-ui-cache`) and draws them before the socket opens; after connect each view resumes against the daemon, which sends only what changed. The cache never decides anything: the daemon's answer replaces or confirms every cached view, a cache that cannot be read means a start as without one, and no feature depends on its content.

Decision (accepted by the owner in the ticket: same exposure as the laptop): this stores session content (prompts, answers, tool output, file contents seen in tool results) on the device, in the browser profile, unencrypted. The cache is dropped when the daemon identity or the token changes, on unpair, and by the caps below (4 M characters per session, 40 M and 60 sessions in total, 14 days).

## Considered options

- **No cache, only cheaper wire messages**: no data on the device, but a reload still pays for the list and the last page of every open tab before anything is drawn.
- **Resume by "events after the newest cached part id"**: smallest request, but the restored session differs from the live one the cache was written from: no cost/duration footer or permission history after a restart (ADR 0001: the transcript is the only store), a part cached mid-stream is final after restore, and OpenCode `turn_result` / `notice` ids are per run. The view would differ from a fresh load.
- **Per-part hash refs** (chosen): the page sends `[partId, hash]` of the parts it holds in `session.subscribe`; the daemon answers a snapshot where unchanged parts are `{ref}` and changed, new and unknown parts come whole. Only a content check gives a view equal to a fresh load. Cost: about 50 bytes per unchanged part.
- **`daemon_hello` plus a persistent `daemonId`** (chosen, part of the same decision): the page must know the daemon's `logEpoch` before it decides to upload hashes (a same-epoch reload uploads none, it replays from `sinceSeq`), and it needs a stable identity to know the cache belongs to another daemon on the same origin. The id is a random UUID in `<config dir>/daemon-id`; ADR 0001 allows config-dir data that has no home in the transcript. When the file cannot be written the id is per run, and the cache is simply dropped at each daemon start.

## Consequences

- The cache is optional: no IndexedDB, private mode, quota error, an open blocked over 3 s, or a read over 300 ms means a start as today. A read over 300 ms is "unknown", never "another daemon": the hello reads the stored meta itself and clears only when one is stored and differs; the late read is drawn only while nothing newer was applied. It fails silently and never writes to the console (it would feed the browser logs).
- Cached content can be stale: a session deleted while the page was closed shows until the first list reply; after a daemon restart the footers of cached turns disappear when the resync lands (parity with a fresh load).
- Side sessions upload hashes on the first subscribe after a reload (the hub's hello has no side epochs).
- Two pages of one origin saving one session: the last write wins, each record is consistent.
- Any code that changes a stored part in place makes every resume resend that part: correct, only slower.
- Browsers may evict IndexedDB (iOS Safari after 7 days without use): the next load starts without a cache.
