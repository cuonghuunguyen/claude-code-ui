// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelFlight, FLIGHT_MS, launchFlight, useLanding } from "./flight.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Row({ text }: { text: string }) {
  const r = useRef<HTMLDivElement>(null);
  useLanding(r, text);
  return (
    <div ref={r} data-testid="user-message">
      <div className="is-user">
        <div data-testid="inner">{text}</div>
      </div>
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;
let finish: () => void;
let animate: ReturnType<typeof vi.fn>;
let reduce = false;
const flush = () => act(async () => void (await Promise.resolve()));
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-testid='user-message']")];

beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  reduce = false;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
  const finished = new Promise<Animation>((res) => (finish = () => res(undefined as never)));
  animate = vi.fn(() => ({ finished, cancel: vi.fn() }));
  Element.prototype.animate = animate as never;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  cancelFlight();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.querySelectorAll("[data-flight]").forEach((n) => n.remove());
});

describe("composer to bubble flight", () => {
  it("a sent prompt's bubble hides and a ghost flies from the prompt box rect to it", async () => {
    launchFlight("hi", new DOMRect(10, 500, 300, 40));
    act(() => root.render(<Row text="hi" />));
    await flush();
    expect(document.querySelectorAll("[data-flight]")).toHaveLength(1);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, opts] = animate.mock.calls[0] as unknown as [{ transform: string }[], { duration: number }];
    expect(frames[0]!.transform).toMatch(/^translate\(/);
    expect(opts.duration).toBe(FLIGHT_MS);
    expect(rows()).toHaveLength(1); // the ghost carries no testid
    expect(rows()[0]!.style.opacity).toBe("0");
    finish();
    await flush();
    expect(document.querySelector("[data-flight]")).toBeNull();
    expect(rows()[0]!.style.opacity).toBe("");
  });

  it("a bubble mounted while the ghost flies stays hidden until it lands, with no second ghost", async () => {
    launchFlight("hi", new DOMRect(0, 0, 10, 10));
    act(() => root.render(<Row text="hi" />));
    await flush();
    act(() =>
      root.render(
        <>
          <Row text="hi" />
          <Row text="hi" />
        </>,
      ),
    );
    await flush();
    expect(rows().every((r) => r.style.opacity === "0")).toBe(true);
    expect(animate).toHaveBeenCalledTimes(1);
    finish();
    await flush();
    expect(rows().every((r) => r.style.opacity === "")).toBe(true);
  });

  it("reduced motion: no ghost, no hiding", async () => {
    reduce = true;
    launchFlight("hi", new DOMRect(0, 0, 10, 10));
    act(() => root.render(<Row text="hi" />));
    await flush();
    expect(document.querySelector("[data-flight]")).toBeNull();
    expect(animate).not.toHaveBeenCalled();
    expect(rows()[0]!.style.opacity).toBe("");
  });

  it("another text, or a flight older than 1 s, does not land", async () => {
    launchFlight("other", new DOMRect(0, 0, 10, 10));
    act(() => root.render(<Row text="hi" />));
    await flush();
    expect(animate).not.toHaveBeenCalled();
    act(() => root.render(null));
    const now = performance.now();
    launchFlight("hi", new DOMRect(0, 0, 10, 10));
    vi.spyOn(performance, "now").mockReturnValue(now + 1500);
    act(() => root.render(<Row text="hi" />));
    await flush();
    expect(animate).not.toHaveBeenCalled();
    expect(rows()[0]!.style.opacity).toBe("");
  });

  it("a late rejection of an older prompt does not cancel a newer prompt's flight", async () => {
    launchFlight("old", new DOMRect(0, 0, 10, 10));
    launchFlight("new", new DOMRect(0, 0, 10, 10));
    cancelFlight("old");
    act(() => root.render(<Row text="new" />));
    await flush();
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("two rows with the flight's text in one commit start one ghost", async () => {
    launchFlight("hi", new DOMRect(0, 0, 10, 10));
    act(() =>
      root.render(
        <>
          <Row text="hi" />
          <Row text="hi" />
        </>,
      ),
    );
    await flush();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("[data-flight]")).toHaveLength(1);
  });

  it("cancelFlight: a later bubble with the same text does not animate", async () => {
    launchFlight("hi", new DOMRect(0, 0, 10, 10));
    cancelFlight();
    act(() => root.render(<Row text="hi" />));
    await flush();
    expect(animate).not.toHaveBeenCalled();
  });
});
