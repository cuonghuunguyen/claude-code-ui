// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { trapTab } from "./focus-trap.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

function tab(shiftKey = false) {
  const e = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(e);
  return e;
}

async function mount(hidden: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root!.render(
      <div onKeyDown={trapTab}>
        <button data-testid="a">a</button>
        {hidden}
        <button data-testid="b">b</button>
        <button data-testid="c">c</button>
      </div>
    )
  );
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  return q;
}

it("Tab skips a display:none first element and lands on the next rendered one", async () => {
  const q = await mount(<button data-testid="x" style={{ display: "none" }}>x</button>);
  q("a").focus();
  tab();
  expect(document.activeElement).toBe(q("b"));
  tab(true);
  expect(document.activeElement).toBe(q("a"));
});

it("skips visibility:hidden, hidden and inert elements and ones under a display:none ancestor", async () => {
  const q = await mount(
    <>
      <button style={{ visibility: "hidden" }}>v</button>
      <button hidden>h</button>
      <div {...({ inert: true } as object)}><button>i</button></div>
      <div style={{ display: "none" }}><button>d</button></div>
    </>
  );
  q("a").focus();
  tab();
  expect(document.activeElement).toBe(q("b"));
});

it("wraps past a hidden last element", async () => {
  const q = await mount(null);
  q("c").focus();
  q("c").style.display = "none";
  q("b").focus();
  tab();
  expect(document.activeElement).toBe(q("a"));
});
