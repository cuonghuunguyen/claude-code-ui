// The areas of one connection (CONTEXT.md "Area"): each owns the handlers of a set of client message types.
// A type set is a template-literal `Extract`, so a new type in wire.ts is a typecheck error until its area handles it.
import type { ClientMessage, ServerMessage } from "@claude-ui/protocol";
import { createEngineArea } from "./area-engine.ts";
import { createSettingsArea } from "./area-settings.ts";
import type { DaemonContext } from "./daemon-context.ts";
import { createDispatch, type ClientType, type Connection, type DispatchedType, type Handlers } from "./dispatch.ts";

export type EngineTypes = Extract<ClientType, `opencode.${string}`>;
export type SettingsTypes = "settings.get" | "settings.set" | "launcher.shortcut" | Extract<ClientType, `jira.${string}` | `claude.account.${string}` | `perf.${string}` | `push.${string}` | `addons.${string}` | `update.${string}`>;

/** The areas of one connection and the one dispatch over them. `fallback` answers the types no area handles yet (until the switch of server.ts is gone). */
export function connectAreas(ctx: DaemonContext, conn: Connection, fallback?: (msg: ClientMessage, out: (m: ServerMessage) => void) => Promise<void>) {
  const engine = createEngineArea(ctx);
  const settings = createSettingsArea(ctx, conn);
  // Every dispatched type has a handler: a missing key is a typecheck error (relaxed to Partial until every area exists).
  const handlers = { ...engine.handlers, ...settings.handlers } satisfies Partial<Handlers<DispatchedType>>;
  void handlers;
  return createDispatch([engine, settings], fallback);
}
export type { Handlers };
