import { describe, expect, it } from "vitest";
import type { Part } from "@claude-ui/protocol";
import { emptySession, type SessionView } from "./store.ts";
import { sessionArtifacts } from "./artifacts.ts";

const URL1 = "https://claude.ai/artifact/abc123";
const pub = (id: string, input: Record<string, unknown>, endedAt?: number, status: "done" | "running" = "done"): Part => ({ type: "tool_call", id, toolUseId: id, tool: "Artifact", input, status, ...(endedAt !== undefined && { endedAt }) });
const res = (id: string, output: string): Part => ({ type: "tool_result", id: `${id}:result`, toolUseId: id, output, isError: false });
const view = (parts: Part[], aux: Part[] = []): SessionView => ({ ...emptySession(), order: parts.map((p) => p.id), parts: new Map(parts.map((p) => [p.id, p])), aux: aux.map((part, i) => ({ part, pos: i + 1 })) });

describe("sessionArtifacts", () => {
  it("lists done publishes newest first, aux (older) after the loaded ones", () => {
    const rows = sessionArtifacts(view([pub("p3", { file_path: "/w/c.html" }, 3000)], [pub("p1", { file_path: "/w/a.html", title: "Report" }, 1000), pub("p2", { file_path: "/w/b.md" }, 2000)]));
    expect(rows.map((r) => r.partId)).toEqual(["p3", "p2", "p1"]);
    expect(rows[2]).toMatchObject({ title: "Report", fileName: "a.html", at: 1000, previewable: true });
    expect(rows[1]).toMatchObject({ fileName: "b.md", previewable: false });
  });

  it("one row per artifact: the newest publish of a claude.ai URL, else input.url, else file_path", () => {
    const rows = sessionArtifacts(view([], [pub("a1", { file_path: "/w/chart.html" }), res("a1", `ok ${URL1}`), pub("a2", { file_path: "/w/other.html" }), pub("a3", { file_path: "/w/chart2.html" }), res("a3", `ok ${URL1}`), pub("b1", { url: "https://claude.ai/artifact/zzz", file_path: "/w/x.html" }), pub("b2", { url: "https://claude.ai/artifact/zzz", file_path: "/w/y.html" }), pub("c1", { file_path: "/w/same.html" }), pub("c2", { file_path: "/w/same.html" })]));
    expect(rows.map((r) => r.partId)).toEqual(["c2", "b2", "a3", "a2"]);
    expect(rows.find((r) => r.partId === "a3")!.url).toBe(URL1);
  });

  it("skips running publishes, other actions and asset uploads; a type_url create is listed without preview", () => {
    const rows = sessionArtifacts(view([pub("r", { file_path: "a.html" }, undefined, "running"), pub("q", { action: "quickstart" }), pub("u", { asset: true, file_path: "a.png" }), pub("t", { type_url: "https://x/y", title: "Deck" }), { type: "tool_call", id: "d", toolUseId: "d", tool: "ArtifactData", input: {}, status: "done" }]));
    expect(rows).toEqual([expect.objectContaining({ partId: "t", title: "Deck", previewable: false })]);
  });

  it("ignores a result of another call", () => {
    expect(sessionArtifacts(view([pub("p", { file_path: "a.html" }), res("zz", URL1)]))[0]!.url).toBeUndefined();
  });
});
