// One tool-less prompt on OpenCode (GH-984, docs/spec.md "Commit box"): a temporary session of the folder, no tools, no MCP, deleted afterwards.
// Version 1 (this file) uses the synchronous message route; version 2 is opencode2-oneshot.ts.
import { errorText, type OpenCodeError as OpenCodeErrorBody } from "./opencode-errors.ts";
import type { OpenCodeServer } from "./opencode-server.ts";

/** What a catalogue's `oneShot` takes. `model` is `provider/model`; `signal` aborts the run. */
export type OneShotRequest = { cwd: string; system: string; text: string; model: string; signal: AbortSignal };

/** `provider/model` of OpenCode as its two ids. A value without `/` is no model (the caller asked for a pick). */
export function modelIds(model: string): { providerID: string; modelID: string } {
  const [providerID, ...rest] = model.split("/");
  if (!providerID || !rest.length) throw new Error(`OpenCode model "${model}" is not provider/model`);
  return { providerID, modelID: rest.join("/") };
}

type Answer = { info?: { error?: OpenCodeErrorBody }; parts?: { type: string; text?: string; synthetic?: boolean; ignored?: boolean }[] };

/**
 * OpenCode 1: `POST /session` (every permission denied), `POST /session/:id/message` (answers when the turn ended, no tools), then `DELETE`.
 * `transient` holds the session id while it exists: the catalogue's session list skips it. Never tracked, never in the link store.
 */
export async function oneShot1(server: Pick<OpenCodeServer, "request">, o: OneShotRequest, transient: Set<string>): Promise<string> {
  const model = modelIds(o.model);
  if (o.signal.aborted) throw new Error("cancelled");
  let id: string | undefined;
  const abort = () => {
    if (id) void server.request(`/session/${id}/abort`, { method: "POST", directory: o.cwd }).catch(() => undefined);
  };
  try {
    const row = await server.request<{ id: string }>("/session", { method: "POST", directory: o.cwd, timeoutMs: 0, body: { title: "Commit message", permission: [{ permission: "*", pattern: "*", action: "deny" }] } });
    id = row.id;
    transient.add(id);
    // The create runs to its end (no signal): an aborted create would leave a session nobody deletes.
    o.signal.addEventListener("abort", abort, { once: true });
    if (o.signal.aborted) abort();
    const answer = await server.request<Answer>(`/session/${id}/message`, { method: "POST", directory: o.cwd, timeoutMs: 0, signal: o.signal, body: { model, system: o.system, tools: { "*": false }, parts: [{ type: "text", text: o.text }] } });
    if (answer.info?.error) throw new Error(errorText(answer.info.error, { model: o.model }));
    return (answer.parts ?? []).filter((p) => p.type === "text" && !p.synthetic && !p.ignored).map((p) => p.text ?? "").join("");
  } finally {
    o.signal.removeEventListener("abort", abort);
    if (id) {
      const gone = id;
      // Best effort: a failed delete leaves a session titled "Commit message" in OpenCode; it never shows in the list meanwhile.
      await server.request(`/session/${gone}`, { method: "DELETE", directory: o.cwd }).then(() => undefined, () => undefined);
      transient.delete(gone);
    }
  }
}
