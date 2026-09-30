import { describe, expect, it } from "vitest";
import { activeMention, insertMention } from "./mentions.ts";

describe("activeMention", () => {
  it("is the @word that ends at the caret, at the start or after whitespace", () => {
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMention("see @src/ma", 11)).toEqual({ start: 4, query: "src/ma" });
    expect(activeMention("a\n@x y", 4)).toEqual({ start: 2, query: "x" });
  });

  it("is closed for an e-mail address, after a space, or with the caret elsewhere", () => {
    expect(activeMention("me@host", 7)).toBeUndefined();
    expect(activeMention("@src ", 5)).toBeUndefined();
    expect(activeMention("@src and more", 13)).toBeUndefined();
  });
});

describe("insertMention", () => {
  it("replaces the typed mention with @path and a space, keeping the rest", () => {
    const text = "fix @ma please";
    expect(insertMention(text, { start: 4, query: "ma" }, "src/main.ts")).toEqual({ text: "fix @src/main.ts  please", caret: 17 });
  });

  it("quotes a path with spaces", () => {
    expect(insertMention("@my", { start: 0, query: "my" }, "my file.md").text).toBe('@"my file.md" ');
  });
});
