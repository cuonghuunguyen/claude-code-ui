import { describe, expect, it } from "vitest";
import { agentMentions } from "../src/index.ts";

const names = ["explore", "general"];
const at = (text: string) => agentMentions(text, names).map((m) => [m.name, m.start, m.end, m.value]);

describe("agentMentions", () => {
  it("finds a token at the start, after whitespace and before punctuation, with exclusive end offsets", () => {
    expect(at("@general look")).toEqual([["general", 0, 8, "@general"]]);
    expect(at("hi\n@explore, then @general.")).toEqual([["explore", 3, 11, "@explore"], ["general", 18, 26, "@general"]]);
  });
  it("is no mention for a folder, a file, a longer name, an email-like prefix or an unknown name", () => {
    for (const t of ["@explore/src", "@explore.md", "@explorer", "a@explore", "@nobody"]) expect(at(t)).toEqual([]);
  });
  it("accepts an opening bracket or quote before, and an ellipsis after", () => {
    expect(at('(@explore) "@general"')).toEqual([["explore", 1, 9, "@explore"], ["general", 12, 20, "@general"]]);
    expect(at("@explore...")).toEqual([["explore", 0, 8, "@explore"]]);
  });
  it("keeps the first occurrence per name only", () => {
    expect(at("@explore and @explore")).toEqual([["explore", 0, 8, "@explore"]]);
  });
  it("ignores a token inside a pasted-content block", () => {
    const t = 'see\n\n<pasted_content id="ab12">\n@explore\n</pasted_content id="ab12">\n @general';
    expect(at(t).map((m) => m[0])).toEqual(["general"]);
  });
});
