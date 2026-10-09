// @vitest-environment jsdom
import type { KeyboardEvent } from "react";
import { afterEach, expect, it } from "vitest";
import { trapTab } from "./focus-trap.ts";

afterEach(() => (document.body.innerHTML = ""));

function tab(root: HTMLElement, shiftKey = false) {
  const e = { key: "Tab", shiftKey, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, currentTarget: root, target: document.activeElement, preventDefault() { this.defaultPrevented = true; } };
  trapTab(e as unknown as KeyboardEvent<HTMLElement>);
  return e.defaultPrevented;
}
const dialog = (html: string) => {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
};
const $ = (id: string) => document.getElementById(id)!;

it("Tab skips a display:none control and lands on the next visible one", () => {
  const root = dialog('<button id="list"></button><div><button id="back" style="display:none"></button><button id="first"></button></div>');
  $("list").focus();
  tab(root);
  expect(document.activeElement).toBe($("first"));
});

it("Shift+Tab skips hidden controls too, wrapping past them", () => {
  const root = dialog('<button id="hidden" style="display:none"></button><button id="a"></button><button id="b"></button>');
  $("a").focus();
  tab(root, true);
  expect(document.activeElement).toBe($("b"));
});

it("skips controls inside a hidden ancestor, visibility:hidden, hidden and inert", () => {
  const root = dialog(
    '<button id="a"></button><div style="display:none"><button id="x1"></button></div><button id="x2" style="visibility:hidden"></button><div hidden><button id="x3"></button></div><div inert><button id="x4"></button></div><button id="z"></button>',
  );
  $("a").focus();
  tab(root);
  expect(document.activeElement).toBe($("z"));
});

it("still wraps among visible controls and ignores a root with none", () => {
  const root = dialog('<button id="a"></button><button id="b"></button>');
  $("b").focus();
  tab(root);
  expect(document.activeElement).toBe($("a"));
  const none = dialog('<button style="display:none"></button>');
  expect(tab(none)).toBe(false);
});

it("skips controls in a closed <details> but keeps its summary and an open one", () => {
  const root = dialog(
    '<button id="a"></button><details><summary><button id="sum"></button></summary><button id="x1"></button></details><details open><summary>s</summary><button id="open"></button></details><button id="z"></button>',
  );
  $("a").focus();
  tab(root);
  expect(document.activeElement).toBe($("sum"));
  tab(root);
  expect(document.activeElement).toBe($("open"));
  tab(root, true);
  tab(root, true);
  expect(document.activeElement).toBe($("a"));
  tab(root, true);
  expect(document.activeElement).toBe($("z"));
});

it("skips controls inside a content-visibility:hidden wrapper but not the wrapper's own", () => {
  const root = dialog('<button id="a"></button><div style="content-visibility:hidden"><button id="x1"></button></div><button id="z"></button>');
  $("a").focus();
  tab(root);
  expect(document.activeElement).toBe($("z"));
});

it("tries the next control when focus() does nothing, and does not prevent Tab when none takes focus", () => {
  const root = dialog('<button id="a"></button><button id="stuck"></button><button id="z"></button>');
  $("stuck").focus = () => {};
  $("a").focus();
  expect(tab(root)).toBe(true);
  expect(document.activeElement).toBe($("z"));
  const only = dialog('<button id="s1"></button><button id="s2"></button>');
  $("s1").focus = () => {};
  $("s2").focus = () => {};
  (document.activeElement as HTMLElement).blur();
  expect(tab(only)).toBe(false);
});
