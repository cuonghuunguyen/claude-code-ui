// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ToolStatusMark } from "@/components/ai-elements/tool";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// prefers-reduced-motion: reduce, set before motion reads it.
window.matchMedia = ((query: string) => ({
  matches: query.includes("reduce"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as never;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);

it("under prefers-reduced-motion the shimmer is plain text and the spinner does not spin", async () => {
  await act(async () =>
    root.render(
      <>
        <Shimmer as="span">Thinking</Shimmer>
        <ToolStatusMark state="input-available" />
      </>,
    ),
  );
  const shimmer = el.querySelector("span")!;
  expect(shimmer.textContent).toBe("Thinking");
  expect(shimmer.className).not.toContain("text-transparent");
  expect(el.querySelector("svg.animate-spin")?.getAttribute("class")).toContain("motion-reduce:animate-none");
});
