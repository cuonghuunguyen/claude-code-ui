import { describe, expect, it, vi } from "vitest";
import { swallowKeyFollowup } from "./context-menu-key.ts";

const event = (isTrusted: boolean) => {
  const e = { nativeEvent: { isTrusted }, preventDefault: vi.fn(), preventBaseUIHandler: vi.fn() };
  return e as unknown as Parameters<typeof swallowKeyFollowup>[0] & typeof e;
};

describe("swallowKeyFollowup", () => {
  it("swallows a trusted contextmenu within the window after the key opened the menu", () => {
    const e = event(true);
    swallowKeyFollowup(e, { current: performance.now() });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.preventBaseUIHandler).toHaveBeenCalled();
  });
  it("lets a later one, an untrusted one (the key's own dispatch) and one without a key press through", () => {
    for (const [trusted, at] of [[true, performance.now() - 5000], [false, performance.now()], [true, -Infinity]] as const) {
      const e = event(trusted);
      swallowKeyFollowup(e, { current: at });
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });
});
