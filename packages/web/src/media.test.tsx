// @vitest-environment jsdom
import { omittedImage } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageStrip } from "./images.tsx";
import { MediaContext, useMediaSrc } from "./media.ts";
import { ToolBody } from "./tool-card.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const png = "data:image/png;base64,AAA";

describe("tool_result image left out of a snapshot", () => {
  const read = (loader?: (id: string, i: number) => Promise<string>) => (
    <MediaContext value={loader}>
      <ToolBody
        call={{ type: "tool_call", id: "t1", toolUseId: "t1", tool: "Read", input: { file_path: "/w/a.png" }, status: "done" } as never}
        result={{ type: "tool_result", id: "t1:result", toolUseId: "t1", isError: false, output: [{ type: "text", text: "x" }, { type: "image", source: { type: "omitted", media_type: "image/png", bytes: 1600 } }] } as never}
      />
    </MediaContext>
  );

  it("shows its type and size and loads through MediaContext", async () => {
    const loader = vi.fn(async () => png);
    await act(async () => root.render(read(loader)));
    await flush();
    expect(el.textContent).toContain("image/png, 1.6 KB");
    expect(el.querySelector("img")?.getAttribute("src")).toBe(png);
    expect(loader).toHaveBeenCalledExactlyOnceWith("t1:result", 1);
  });

  it("without a loader shows only its caption", async () => {
    await act(async () => root.render(read()));
    expect(el.textContent).toContain("image/png, 1.6 KB");
    expect(el.querySelector("img")).toBeNull();
  });
});

describe("ImageStrip with an omitted image", () => {
  it("shows a sized placeholder while loading, then the image; inline images need no load", async () => {
    let done!: (u: string) => void;
    const loader = vi.fn(() => new Promise<string>((r) => (done = r)));
    await act(async () => root.render(<MediaContext value={loader}><ImageStrip images={[omittedImage("image/png", 1000), png]} partId="u-strip" /></MediaContext>));
    expect(el.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(el.querySelectorAll("img")).toHaveLength(1);
    await act(async () => done("data:image/png;base64,BBB"));
    expect(el.querySelectorAll("img")).toHaveLength(2);
    expect(loader).toHaveBeenCalledExactlyOnceWith("u-strip", 0);
  });
});

describe("useMediaSrc", () => {
  function Probe({ id }: { id: string }) {
    return <i data-src={useMediaSrc(id, 0, true) ?? ""} />;
  }
  it("loads each part payload once and retries after a failure", async () => {
    const loader = vi.fn(async () => png);
    await act(async () => root.render(<MediaContext value={loader}><Probe id="same" /><Probe id="same" /></MediaContext>));
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect([...el.querySelectorAll("i")].map((i) => i.dataset.src)).toEqual([png, png]);

    const bad = vi.fn(async () => { throw new Error("no"); });
    await act(async () => root.render(<MediaContext value={bad}><Probe id="flaky" /></MediaContext>));
    await flush();
    await act(async () => root.render(<></>));
    await act(async () => root.render(<MediaContext value={bad}><Probe id="flaky" /></MediaContext>));
    await flush();
    expect(bad).toHaveBeenCalledTimes(2);
  });
});
