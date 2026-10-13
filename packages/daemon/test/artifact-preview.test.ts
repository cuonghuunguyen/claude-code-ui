import { describe, expect, it } from "vitest";
import type { Part } from "@claude-ui/protocol";
import { ARTIFACT_CSP, artifactFileOf } from "../src/artifact-preview.ts";

const call = (input: unknown, status: string = "done", tool = "Artifact"): Part => ({ type: "tool_call", id: "t", toolUseId: "t", tool, input, status }) as Part;

describe("artifactFileOf", () => {
  it("accepts a done publish of an .html/.htm page, absolute or relative to the cwd", () => {
    expect(artifactFileOf(call({ file_path: "/t/a.html" }), "/c")).toEqual({ path: "/t/a.html" });
    expect(artifactFileOf(call({ file_path: "a/p.HTM" }), "/c")).toEqual({ path: "/c/a/p.HTM" });
    expect(artifactFileOf(call({ action: "publish", file_path: "/t/a.html" }), "/c")).toEqual({ path: "/t/a.html" });
  });

  it("refuses other tools, other actions, asset uploads, unfinished calls and missing paths (unknown_part)", () => {
    const bad = [
      call({ file_path: "/t/a.html" }, "done", "Read"),
      { type: "tool_result", id: "r", toolUseId: "t", output: "x", isError: false } as unknown as Part,
      undefined,
      call({ action: "read", file_path: "/t/a.html" }),
      call({ action: "list", file_path: "/t/a.html" }),
      call({ asset: true, file_path: "/t/a.html" }),
      ...["error", "denied", "pending", "running"].map((s) => call({ file_path: "/t/a.html" }, s)),
      call({ file_path: "" }),
      call({ file_path: 5 }),
      call({ file_path: "a\0.html" }),
      call("x"),
      call(null),
    ];
    for (const p of bad) expect(artifactFileOf(p, "/c"), JSON.stringify(p)).toMatchObject({ code: "unknown_part" });
  });

  it("refuses a non-HTML file_path (unsupported_type)", () => {
    for (const f of ["/t/a.txt", "/t/a.html.txt", "/t/noext"]) expect(artifactFileOf(call({ file_path: f }), "/c")).toMatchObject({ code: "unsupported_type" });
  });
});

describe("ARTIFACT_CSP", () => {
  const dirs = new Map(ARTIFACT_CSP.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));

  it("has no allow-same-origin, no network source and frames only from the own origin", () => {
    expect(dirs.get("sandbox")).toEqual(["allow-scripts"]);
    expect(dirs.get("default-src")).toEqual(["'none'"]);
    expect(dirs.get("frame-ancestors")).toEqual(["'self'"]);
    expect(dirs.has("connect-src")).toBe(false);
    expect(dirs.has("frame-src")).toBe(false);
    for (const [k, v] of dirs) {
      if (k === "frame-ancestors") continue;
      for (const s of v) expect(s, k).not.toMatch(/^(https?:|\*|'self')/);
    }
    expect(dirs.get("script-src")).not.toContain("'unsafe-eval'");
  });
});
