import { describe, expect, it } from "vitest";
import { rewindOptions } from "./rewind.ts";

const preview = (filesChanged: string[], conversation: boolean) => ({ filesChanged, insertions: 1, deletions: 0, conversation });

describe("rewindOptions", () => {
  it("offers the three /rewind modes when the checkpoint has tracked file changes", () => {
    expect(rewindOptions(preview(["/r/a.ts"], true)).map((o) => o.mode)).toEqual(["both", "conversation", "code"]);
  });

  it("hides code options when the checkpoint has no tracked file changes", () => {
    expect(rewindOptions(preview([], true)).map((o) => o.mode)).toEqual(["conversation"]);
  });

  it("offers only code for the first prompt, nothing when it changed no files", () => {
    expect(rewindOptions(preview(["/r/a.ts"], false)).map((o) => o.mode)).toEqual(["code"]);
    expect(rewindOptions(preview([], false))).toEqual([]);
  });
});
