// Area: the requests only one Engine answers (the OpenCode account: provider login, server restart). server.ts names no Engine (ADR 0012):
// the catalogue registers its types in `ctx.engineRequests`, this area routes `opencode.*` to them.
import type { EngineTypes } from "./areas.ts";
import type { DaemonContext } from "./daemon-context.ts";
import type { Area, Handler, Handlers } from "./dispatch.ts";

export type EngineAreaContext = Pick<DaemonContext, "engineRequests">;

/** A record, so a new `opencode.*` type in wire.ts is a typecheck error until it is listed. */
const TYPES: Record<EngineTypes, true> = { "opencode.status": true, "opencode.restart": true, "opencode.providers": true, "opencode.login": true, "opencode.loginFinish": true, "opencode.loginCancel": true, "opencode.logout": true };

export function createEngineArea(ctx: EngineAreaContext): Area<EngineTypes> {
  // OpenCode is off (no catalogue registers the type): unknown_type, as for any other type.
  const own: Handler<EngineTypes> = async (msg, r) => {
    const request = ctx.engineRequests.get(msg.type);
    if (!request) return r.fail("unknown_type", `unknown message type ${msg.type}`);
    return request(msg, r.reply, r.fail);
  };
  const handlers = Object.fromEntries(Object.keys(TYPES).map((t) => [t, own])) as unknown as Handlers<EngineTypes>;
  return { handlers };
}
