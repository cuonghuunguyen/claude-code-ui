import { describe, expect, it, vi } from "vitest";
import { ALL_CAPABILITIES, type ModelInfo } from "@claude-ui/protocol";
import { createModelCatalogue } from "./model-catalogue.ts";

const model = (value: string): ModelInfo => ({ value, displayName: value, description: "" }) as ModelInfo;
const withProviders = { ...ALL_CAPABILITIES, providers: true };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("model catalogue", () => {
  it("providersChanged drops the lists and errors of every Side of that Engine only; the next load fetches again", async () => {
    const fetch = vi.fn(async (engine: string, cwd?: string) => [model(`${engine}:${cwd}`)]);
    const c = createModelCatalogue({ fetch });
    const here = { engine: "opencode" as const, capabilities: withProviders, cwd: "/a" };
    const side = { engine: "opencode" as const, capabilities: withProviders, side: "s1", cwd: "/b" };
    c.load(here);
    c.load(side);
    await tick();
    expect(c.list(here)).toHaveLength(1);
    expect(c.list(side)).toHaveLength(1);
    c.setDaemonList([model("claude")]);
    c.providersChanged("opencode");
    expect(c.list(here)).toHaveLength(0);
    expect(c.list(side)).toHaveLength(0);
    expect(c.list({ engine: "claude", capabilities: ALL_CAPABILITIES })).toHaveLength(1);
    c.load(here);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(c.list(here)).toHaveLength(1);
  });

  it("an Engine without providers is never fetched", () => {
    const fetch = vi.fn();
    const c = createModelCatalogue({ fetch });
    c.load({ engine: "claude", capabilities: ALL_CAPABILITIES });
    expect(fetch).not.toHaveBeenCalled();
  });
});
