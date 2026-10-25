// @vitest-environment jsdom
import type { GitRepo } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { forgetRepoChoices, getRepoChoice, REPO_CHOICE_MAX, repoProjectKey, resolveRepoChoice, selectorVisible, setRepoChoice, useRepoChoice, useSelectedRepo, type RepoList } from "./repo-choice.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const KEY = "claude-ui.repoChoice";
const r = (rel: string, kind: GitRepo["kind"], extra: Partial<GitRepo> = {}): GitRepo => ({ path: rel ? `/p/${rel}` : "/p", rel, kind, ...(kind !== "main" && { parent: "/p" }), ...extra });
const main = r("", "main");
const sub = r("libs/lib", "submodule");

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  forgetRepoChoices();
});

it("resolveRepoChoice returns the stored rel when listed and usable", () => {
  expect(resolveRepoChoice([main, sub], "libs/lib")).toBe(sub);
});

it("resolveRepoChoice falls back to own when the stored rel is outsideRoots or missing", () => {
  expect(resolveRepoChoice([main, sub], "x")).toBe(main);
  expect(resolveRepoChoice([main, { ...sub, outsideRoots: true }], "libs/lib")).toBe(main);
});

it("resolveRepoChoice without own falls back to the first usable root", () => {
  const list = [r("api", "nested", { outsideRoots: true }), r("web", "nested")];
  expect(resolveRepoChoice(list, undefined)?.rel).toBe("web");
  expect(resolveRepoChoice(list, "")?.rel).toBe("web");
});

it("resolveRepoChoice of an empty list is undefined", () => {
  expect(resolveRepoChoice([], "a")).toBeUndefined();
  expect(resolveRepoChoice([{ ...main, outsideRoots: true }], undefined)).toBeUndefined();
});

it("selectorVisible: 2+ repositories, or no main entry; hidden for only own", () => {
  expect(selectorVisible([])).toBe(false);
  expect(selectorVisible([main])).toBe(false);
  expect(selectorVisible([main, sub])).toBe(true);
  expect(selectorVisible([r("web", "nested")])).toBe(true);
});

it("setRepoChoice keeps at most 200 projects, dropping the oldest written", () => {
  for (let i = 0; i < REPO_CHOICE_MAX; i++) setRepoChoice(`/k${i}`, "a");
  setRepoChoice("/k0", "b");
  setRepoChoice("/extra", "c");
  expect(getRepoChoice("/k0")).toBe("b");
  expect(getRepoChoice("/k1")).toBeUndefined();
  expect(getRepoChoice("/extra")).toBe("c");
  expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!))).toHaveLength(REPO_CHOICE_MAX);
});

it("storage blocked: getItem/setItem throw, the choice lasts in memory", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(getRepoChoice("/p")).toBeUndefined();
  expect(() => setRepoChoice("/p", "libs/lib")).not.toThrow();
  expect(getRepoChoice("/p")).toBe("libs/lib");
});

it("setItem failing while getItem works keeps the choice in memory for the session", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  setRepoChoice("/p", "libs/lib");
  expect(getRepoChoice("/p")).toBe("libs/lib");
  setRepoChoice("/q", "web");
  expect(getRepoChoice("/p")).toBe("libs/lib");
  expect(getRepoChoice("/q")).toBe("web");
});

it("a corrupt stored value reads as no choice", () => {
  localStorage.setItem(KEY, "[1");
  expect(getRepoChoice("/p")).toBeUndefined();
  localStorage.setItem(KEY, '{"/p":1}');
  expect(getRepoChoice("/p")).toBeUndefined();
  localStorage.setItem(KEY, '{"/p":"a","/q":2}');
  expect(getRepoChoice("/p")).toBe("a");
});

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
function Probe({ k, id }: { k: string; id: string }) {
  return <i data-id={id}>{useRepoChoice(k) ?? "-"}</i>;
}
const text = (id: string) => el.querySelector(`[data-id=${id}]`)!.textContent;

it("a storage event of the key re-renders subscribers; other keys do not", async () => {
  await act(async () => root.render(<Probe k="/p" id="a" />));
  expect(text("a")).toBe("-");
  localStorage.setItem(KEY, JSON.stringify({ "/p": "x" }));
  await act(async () => void window.dispatchEvent(new StorageEvent("storage", { key: "other" })));
  expect(text("a")).toBe("-");
  await act(async () => void window.dispatchEvent(new StorageEvent("storage", { key: KEY })));
  expect(text("a")).toBe("x");
  await act(async () => root.render(null));
});

it("two components of one project update together; another project keeps its choice", async () => {
  await act(async () =>
    root.render(
      <>
        <Probe k="/p" id="a" />
        <Probe k="/p" id="b" />
        <Probe k="/q" id="c" />
      </>,
    ),
  );
  await act(async () => setRepoChoice("/p", "libs/lib"));
  expect([text("a"), text("b"), text("c")]).toEqual(["libs/lib", "libs/lib", "-"]);
  await act(async () => root.render(null));
});

function Sel({ repos, cwd }: { repos?: RepoList; cwd: string }) {
  const s = useSelectedRepo(repos, cwd);
  return <i data-repo={s.repo?.rel ?? "none"} data-target={s.target === undefined ? "undef" : s.target === null ? "null" : s.target.dir} />;
}
const attr = (a: string) => el.querySelector("i")!.getAttribute(a);

it("useSelectedRepo target: undefined for null/undefined list, null for [], dir from repoDir", async () => {
  await act(async () => root.render(<Sel cwd="/p" />));
  expect(attr("data-target")).toBe("undef");
  await act(async () => root.render(<Sel cwd="/p" repos={{ list: null, projectKey: "/p" }} />));
  expect(attr("data-target")).toBe("undef");
  await act(async () => root.render(<Sel cwd="/p" repos={{ list: [], projectKey: "/p" }} />));
  expect(attr("data-target")).toBe("null");
  setRepoChoice("/p", "libs/lib");
  await act(async () => root.render(<Sel cwd="/p" repos={{ list: [main, sub], projectKey: "/p" }} />));
  expect(attr("data-target")).toBe("/p/libs/lib");
  await act(async () => root.render(null));
});

it("an unresolvable stored value is kept", async () => {
  setRepoChoice("/p", "libs/lib");
  const before = localStorage.getItem(KEY);
  await act(async () => root.render(<Sel cwd="/p" repos={{ list: [main], projectKey: "/p" }} />));
  expect(attr("data-repo")).toBe("");
  expect(getRepoChoice("/p")).toBe("libs/lib");
  expect(localStorage.getItem(KEY)).toBe(before);
  await act(async () => root.render(null));
});

it("repoProjectKey waits for the worktree list and maps a linked worktree to its project", () => {
  const wt = { "/p": [{ path: "/p", branch: "main", main: true }, { path: "/wt", branch: "x", main: false }] };
  expect(repoProjectKey("/wt", {}, false)).toBeUndefined();
  expect(repoProjectKey(undefined, wt, true)).toBeUndefined();
  expect(repoProjectKey("/wt", wt, true)).toBe("/p");
  expect(repoProjectKey("/other", wt, true)).toBe("/other");
});
