import { describe, expect, it } from "vitest";
import { fileRef, identityOf, isItem, isPaneRef, KIND_LABEL, kindOf, pathOf, ownerOf, paneTabFor, paneTabTitle, parseRef, refOf, splittable } from "./pane-ref.ts";

const U = "0f8e7d6c-1234-4abc-8def-0123456789ab";

describe("pane refs", () => {
  it("parseRef reads plan:<uuid> and rejects sessions, new, focus, other kinds and bad uuids", () => {
    expect(parseRef(`plan:${U}`)).toEqual({ kind: "plan", owner: U });
    for (const id of [U.toUpperCase().replace("PLAN", "plan"), `plan:${U.toUpperCase()}`, U, "new", "focus", `changes:${U}`, `files:${U.toUpperCase()}`, "plan:abc", `plan:${U}x`, "", undefined]) expect(parseRef(id)).toBeUndefined();
    expect(isPaneRef(`plan:${U}`)).toBe(true);
    expect(isPaneRef(U)).toBe(false);
    expect(isPaneRef(undefined)).toBe(false);
  });
  it("refOf round-trips parseRef", () => {
    expect(refOf(parseRef(`plan:${U}`)!)).toBe(`plan:${U}`);
  });
  it("ownerOf returns the owner of a ref and the id itself otherwise", () => {
    expect(ownerOf(`plan:${U}`)).toBe(U);
    expect(ownerOf(U)).toBe(U);
    expect(ownerOf("new")).toBe("new");
    expect(kindOf(`plan:${U}`)).toBe("plan");
    expect(kindOf(U)).toBeUndefined();
  });
  it("GH-398 splittable is true for plan, files and terminal refs and false for Git graph, sessions and junk", () => {
    for (const k of ["plan", "files", "terminal"]) expect(splittable(`${k}:${U}`)).toBe(true);
    for (const x of [`graph:${U}`, U, "new", ""]) expect(splittable(x)).toBe(false);
  });
  it("paneTabTitle is \"Plan · <title>\"", () => {
    expect(paneTabTitle("plan", "Fix bug")).toBe("Plan · Fix bug");
  });
  it("parseRef reads files:<uuid> and graph:<uuid>", () => {
    expect(parseRef(`files:${U}`)).toEqual({ kind: "files", owner: U });
    expect(parseRef(`graph:${U}`)).toEqual({ kind: "graph", owner: U });
  });
  it("terminal refs parse and are one per folder", () => {
    const V = U.replace("0f8e", "1f8e");
    const W = U.replace("0f8e", "2f8e");
    const cwd = (o: string) => (o === W ? "/p/other" : "/p/demo");
    expect(parseRef(`terminal:${U}`)).toEqual({ kind: "terminal", owner: U });
    expect(paneTabFor([`terminal:${U}`], "terminal", V, cwd)).toBe(`terminal:${U}`);
    expect(paneTabFor([`terminal:${U}`], "terminal", W, cwd)).toBe(`terminal:${W}`);
  });
  it("identityOf is <kind>@<cwd> for files and graph, the ref for plan and for an unknown cwd", () => {
    const cwd = (o: string) => (o === U ? "/p/demo" : undefined);
    expect(identityOf(`files:${U}`, cwd)).toBe("files@/p/demo");
    expect(identityOf(`graph:${U}`, cwd)).toBe("graph@/p/demo");
    expect(identityOf(`plan:${U}`, cwd)).toBe(`plan:${U}`);
    const V = U.replace("0f8e", "1f8e");
    expect(identityOf(`files:${V}`, cwd)).toBe(`files:${V}`);
    expect(identityOf(U, cwd)).toBe(U);
  });
  it("paneTabFor returns the open tab of another session in the same folder, else a new ref; never matches across kinds or folders", () => {
    const V = U.replace("0f8e", "1f8e");
    const W = U.replace("0f8e", "2f8e");
    const cwd = (o: string) => (o === W ? "/p/other" : "/p/demo");
    expect(paneTabFor([U, `files:${U}`], "files", V, cwd)).toBe(`files:${U}`);
    expect(paneTabFor([U, `files:${U}`], "graph", V, cwd)).toBe(`graph:${V}`);
    expect(paneTabFor([U, `files:${U}`], "files", W, cwd)).toBe(`files:${W}`);
    expect(paneTabFor([`plan:${U}`], "plan", V, cwd)).toBe(`plan:${V}`);
  });
  it("paneTabTitle gives \"Files · demo\" and \"Git graph · demo · feature\"", () => {
    expect(paneTabTitle("files", "demo")).toBe("Files · demo");
    expect(paneTabTitle("graph", "demo · feature")).toBe("Git graph · demo · feature");
  });
});

describe("GH-399 file refs", () => {
  const V = U.replace("0f8e", "1f8e");
  it("parse and refOf a file ref, POSIX and Windows path; junk rejected", () => {
    for (const path of ["/p/a.ts", "C:\\a\\b.ts", "/p/with space:colon.ts"]) {
      expect(parseRef(`file:${U}:${path}`)).toEqual({ kind: "file", owner: U, path });
      expect(refOf(parseRef(`file:${U}:${path}`)!)).toBe(`file:${U}:${path}`);
      expect(fileRef(U, path)).toBe(`file:${U}:${path}`);
      expect(pathOf(`file:${U}:${path}`)).toBe(path);
    }
    for (const id of [`file:${U}`, `file:${U}:`, `file:abc:/p/a.ts`, `file:${U.toUpperCase()}:/p/a.ts`, `files:${U}:/p/a.ts`]) expect(parseRef(id)).toBeUndefined();
    expect(pathOf(`plan:${U}`)).toBeUndefined();
    expect(ownerOf(`file:${U}:/p/a.ts`)).toBe(U);
  });
  it("identity is the path, whatever the owner; paneTabFor finds the open file tab", () => {
    const cwd = () => "/p";
    expect(identityOf(`file:${U}:/p/a.ts`, cwd)).toBe("file@/p/a.ts");
    expect(identityOf(`file:${V}:/p/a.ts`, cwd)).toBe("file@/p/a.ts");
    expect(paneTabFor([`file:${U}:/p/a.ts`], "file", V, cwd, "/p/a.ts")).toBe(`file:${U}:/p/a.ts`);
    expect(paneTabFor([`file:${U}:/p/a.ts`], "file", V, cwd, "/p/b.ts")).toBe(`file:${V}:/p/b.ts`);
  });
  it("file tabs are splittable items with the label File", () => {
    expect(splittable(`file:${U}:/p/a.ts`)).toBe(true);
    expect(isItem(`file:${U}:/p/a.ts`)).toBe(true);
    expect(isItem(`files:${U}`)).toBe(false);
    expect(isItem(U)).toBe(false);
    expect(KIND_LABEL.file).toBe("File");
  });
});
