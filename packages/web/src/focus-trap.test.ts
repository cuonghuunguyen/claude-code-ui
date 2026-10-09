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
