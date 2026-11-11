// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ClaudeLoginContext, RawPart } from "./raw-part.tsx";

const render = async (message: unknown, onLogin?: () => void) => {
  const el = document.createElement("div");
  document.body.append(el);
  await act(async () => createRoot(el).render(<ClaudeLoginContext value={onLogin}><RawPart message={message} /></ClaudeLoginContext>));
  return el;
};

describe("RawPart login", () => {
  it("authentication_failed shows the login button, a click opens the login", async () => {
    const onLogin = vi.fn();
    const el = await render({ type: "assistant", error: "authentication_failed" }, onLogin);
    const b = el.querySelector<HTMLButtonElement>('[data-testid="claude-login"]');
    expect(b?.textContent).toBe("Log in to Claude");
    await act(async () => b!.click());
    expect(onLogin).toHaveBeenCalledOnce();
  });

  it("other errors, and a missing login handler, show no button", async () => {
    expect((await render({ error: "rate_limit" }, vi.fn())).querySelector('[data-testid="claude-login"]')).toBeNull();
    expect((await render({ error: "authentication_failed" })).querySelector('[data-testid="claude-login"]')).toBeNull();
  });
});
