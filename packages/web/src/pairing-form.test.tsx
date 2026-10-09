// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PairingForm } from "./pairing-form.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const TOKEN = "aB3_-xYz0123456789abcdefghijklmnopqrstuv";

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const reload = vi.fn();
beforeEach(() => {
  localStorage.clear();
  reload.mockClear();
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  act(() => root.render(<PairingForm reload={reload} />));
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});

const input = () => el.querySelector<HTMLInputElement>('[data-testid="pairing-input"]')!;
const error = () => el.querySelector('[data-testid="pairing-error"]');
const paste = async (value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = () => act(async () => void el.querySelector("form")!.requestSubmit());

it("explains the card, labels the field and focuses it", () => {
  expect(el.querySelector('[data-testid="pairing-needed"]')!.textContent).toContain("it is not paired");
  expect(el.querySelector("label")!.textContent).toBe("Pairing link or token");
  expect(document.activeElement).toBe(input());
  expect(input().getAttribute("autocomplete")).toBe("off");
});

it("a value that is not a pairing link or token shows an error and asks the daemon nothing", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await paste("hello");
  await submit();
  expect(error()!.textContent).toBe("That is not a pairing link or token.");
  expect(error()!.getAttribute("role")).toBe("alert");
  expect(input().getAttribute("aria-describedby")).toBe(error()!.id);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(localStorage.getItem("claude-ui.token")).toBeNull();
});

it("a token the daemon accepts (204) is stored and the page reloads; the token is sent only as a bearer header", async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  await paste(`https://box.tail1234.ts.net/#token=${TOKEN}`);
  await submit();
  expect(fetchMock).toHaveBeenCalledWith("/auth", { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(localStorage.getItem("claude-ui.token")).toBe(TOKEN);
  expect(reload).toHaveBeenCalledOnce();
  expect(input().value).toBe("");
});

it("a token the daemon refuses (401) shows the message and stores nothing", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
  await paste(TOKEN);
  await submit();
  expect(error()!.textContent).toContain("does not accept that token");
  expect(localStorage.getItem("claude-ui.token")).toBeNull();
  expect(reload).not.toHaveBeenCalled();
});

it("an unreachable daemon shows its own message", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("network"))));
  await paste(TOKEN);
  await submit();
  expect(error()!.textContent).toBe("Cannot reach the daemon.");
  expect(localStorage.getItem("claude-ui.token")).toBeNull();
});
