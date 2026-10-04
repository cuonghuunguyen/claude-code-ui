import { describe, expect, it } from "vitest";
import { activeMention, insertAtCaret, insertMention, splitUploads } from "./mentions.ts";

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

describe("insertAtCaret", () => {
  it("inserts the token at the caret with a space on each side where needed", () => {
    expect(insertAtCaret("", 0, "@a.ts#2")).toEqual({ text: "@a.ts#2 ", caret: 8 });
    expect(insertAtCaret("fix this", 3, "@a.ts#2")).toEqual({ text: "fix @a.ts#2 this", caret: 11 });
    expect(insertAtCaret("fix ", 4, "@a.ts")).toEqual({ text: "fix @a.ts ", caret: 10 });
    expect(insertAtCaret("line\n", 5, "@a.ts")).toEqual({ text: "line\n@a.ts ", caret: 11 });
    expect(insertAtCaret("fix\nthis", 3, "@a.ts")).toEqual({ text: "fix @a.ts\nthis", caret: 9 });
  });
});

describe("splitUploads", () => {
  it("takes attached files (upload paths) out of the text, keeping other mentions", () => {
    expect(splitUploads('read @/tmp/claude-ui-Ab12Cd/u-Xy34Ef/notes.txt and @"/t/u-Zz99Qq/my notes.md" @src/a.ts')).toEqual({
      text: "read and @src/a.ts",
      files: [
        { path: "/tmp/claude-ui-Ab12Cd/u-Xy34Ef/notes.txt", name: "notes.txt" },
        { path: "/t/u-Zz99Qq/my notes.md", name: "my notes.md" },
      ],
    });
  });

  it("takes out attached files with Windows upload paths, quoted when the path has spaces", () => {
    expect(splitUploads('read @C:\\Users\\me\\AppData\\Local\\Temp\\claude-ui-1Fk6g9\\u-Uexatz\\notes.txt and @"C:\\Users\\First Last\\Temp\\u-Zz99Qq\\my notes.md" @src\\a.ts')).toEqual({
      text: "read and @src\\a.ts",
      files: [
        { path: "C:\\Users\\me\\AppData\\Local\\Temp\\claude-ui-1Fk6g9\\u-Uexatz\\notes.txt", name: "notes.txt" },
        { path: "C:\\Users\\First Last\\Temp\\u-Zz99Qq\\my notes.md", name: "my notes.md" },
      ],
    });
  });

  it("takes out an attached file followed by a newline", () => {
    expect(splitUploads("secret word in @/tmp/claude-ui-E8LKGI/u-DRFNWD/notes.txt\nThanks.")).toEqual({
      text: "secret word in \nThanks.",
      files: [{ path: "/tmp/claude-ui-E8LKGI/u-DRFNWD/notes.txt", name: "notes.txt" }],
    });
  });

  it("leaves text without uploads as it is", () => {
    expect(splitUploads("see @src/u-main.ts  me@/x/u-abcdef/y")).toEqual({ text: "see @src/u-main.ts  me@/x/u-abcdef/y", files: [] });
    expect(splitUploads("see @src\\u-abcdef\\x.ts").files).toEqual([]);
  });
});
