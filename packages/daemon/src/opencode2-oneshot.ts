// One tool-less prompt on OpenCode 2 (GH-984, docs/spec.md "Commit box"): a root session of its own, hidden from the session list (`INLINE_META`), every action denied,
// the system text as an instruction entry, deleted afterwards. The end is read from the stored messages (`storedEnd`), so no event subscription is needed.
import type { OpenCodeClient } from "@opencode/client";
import { ascending } from "./opencode-id.ts";
import { modelIds, type OneShotRequest } from "./opencode-oneshot.ts";
import { INLINE_META, storedEnd } from "./opencode2-inline.ts";
import { loadMessages } from "./opencode2-engine.ts";
import type { OpenCode2Message } from "./opencode2-parts.ts";

const ENTRY = "claude-ui-commit";
/** How often the stored messages are read while the turn runs. */
export const oneShotPoll = { ms: 400 };

const lastText = (messages: readonly OpenCode2Message[]) => {
  for (const m of [...messages].reverse()) {
    const t = m.type === "assistant" ? (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("") : "";
    if (t) return t;
  }
  return "";
};
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(done, ms);
  function done() {
    clearTimeout(t);
    signal.removeEventListener("abort", done);
    r();
  }
  signal.addEventListener("abort", done, { once: true });
});

export async function oneShot2(client: OpenCodeClient, o: OneShotRequest): Promise<string> {
  const { providerID, modelID } = modelIds(o.model);
  if (o.signal.aborted) throw new Error("cancelled");
  let id: string | undefined;
  try {
    const row = await client.session.create({ location: { directory: o.cwd }, title: "Commit message", model: { providerID, id: modelID }, permissions: [{ action: "*", resource: "*", effect: "deny" }], metadata: { [INLINE_META]: "commit-message" } });
    id = row.id;
    await client.experimental.session.instructions.entry.put({ sessionID: id, key: ENTRY, value: o.system });
    if (o.signal.aborted) throw new Error("cancelled");
    await client.session.prompt({ sessionID: id, id: ascending("msg"), text: o.text });
    while (!o.signal.aborted) {
      await sleep(oneShotPoll.ms, o.signal);
      if (o.signal.aborted) break;
      const messages = await loadMessages(client, id);
      if (!messages.some((m) => m.type === "idle")) continue;
      const end = storedEnd([...messages].reverse() as never);
      if (end.status === "error") throw new Error(end.error || "OpenCode failed");
      if (end.status === "stopped") throw new Error("OpenCode stopped the turn");
      return lastText(messages);
    }
    throw new Error("cancelled");
  } finally {
    if (id) {
      const gone = id;
      if (o.signal.aborted) await client.session.interrupt({ sessionID: gone }).catch(() => undefined);
      await client.session.remove({ sessionID: gone }).catch(() => undefined);
    }
  }
}
