// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ToolCard } from "./tool-card.tsx";
import { AllowDeniedContext, AlwaysAllowDeniedContext, LocalSettingsFileContext } from "./viewer.ts";
import type { ToolCall } from "./store.ts";

type Always = (id: string, scope: "session" | "local") => Promise<unknown>;
const call = (over: Partial<ToolCall> = {}): ToolCall =>
  ({
    type: "tool_call",
    id: "t1",
    toolUseId: "t1",
    tool: "Bash",
    input: { command: "git push --force origin main" },
    status: "denied",
    denial: { by: "classifier", reason: "[Git Destructive]", rule: "Bash(git push --force origin main)" },
    ...over,
  }) as ToolCall;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));

const render = (c: ToolCall, always?: Always, allow: (id: string) => Promise<unknown> = async () => {}, file?: () => Promise<string>) =>
  act(async () =>
    root.render(
      <AllowDeniedContext value={allow}>
        <AlwaysAllowDeniedContext value={always}>
          <LocalSettingsFileContext value={file}>
            <ToolCard call={c} />
          </LocalSettingsFileContext>
        </AlwaysAllowDeniedContext>
      </AllowDeniedContext>,
    ),
  );
const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => act(async () => void q(id)!.click());

it("shows Always allow next to Allow and retry, only with a handler, on a classifier denial not allowed yet", async () => {
  const h = async () => {};
  await render(call(), h);
  expect(q("always-allow")?.textContent).toBe("Always allow");
  expect(q("allow-and-retry")).not.toBeNull();
  await render(call(), undefined);
  expect(q("always-allow")).toBeNull();
  await render(call({ denial: undefined }), h);
  expect(q("always-allow")).toBeNull();
  await render(call({ denial: { by: "classifier", rule: "Bash(x)", allowed: true } }), h);
  expect(q("always-allow")).toBeNull();
  expect(q("allow-and-retry")?.textContent).toBe("Allowed once");
});

it("opens an inline panel with the exact rule, and Cancel closes it", async () => {
  await render(call(), async () => {});
  expect(q("always-allow-panel")).toBeNull();
  await click("always-allow");
  expect(q("always-allow")!.getAttribute("aria-expanded")).toBe("true");
  expect(q("always-allow-rule")?.textContent).toBe("Bash(git push --force origin main)");
  expect(q("always-allow-session")?.textContent).toBe("This session");
  expect(q("always-allow-local")?.textContent).toBe("This project");
  await click("always-allow-cancel");
  expect(q("always-allow-panel")).toBeNull();
});

it("a scope button sends the call id and the scope, and disables both while it runs", async () => {
  let done!: () => void;
  const h = vi.fn<Always>(() => new Promise<void>((r) => (done = r)));
  await render(call(), h);
  await click("always-allow");
  await click("always-allow-local");
  expect(h).toHaveBeenCalledWith("t1", "local");
  expect((q("always-allow-session") as HTMLButtonElement).disabled).toBe(true);
  expect((q("always-allow-local") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => done());
  expect(q("always-allow-panel")).toBeNull();
  await click("always-allow");
  await click("always-allow-session");
  expect(h).toHaveBeenLastCalledWith("t1", "session");
});

it("a rejection shows an alert; auto mode ignoring the rule names the rule and the reason", async () => {
  await render(call(), async () => {
    throw Object.assign(new Error("Claude Code drops this kind of rule in auto mode."), { code: "ignored_in_auto" });
  });
  await click("always-allow");
  await click("always-allow-session");
  const alert = el.querySelector('[role="alert"]')!;
  expect(alert.getAttribute("data-testid")).toBe("always-allow-error");
  expect(alert.textContent).toBe("Not saved: auto mode ignores the rule Bash(git push --force origin main). Claude Code drops this kind of rule in auto mode.");
  expect(q("allow-and-retry") && (q("allow-and-retry") as HTMLButtonElement).disabled).toBe(false);
  await render(call(), async () => {
    throw Object.assign(new Error("cannot write x"), { code: "settings_write_failed" });
  });
  await click("always-allow-local");
  expect(q("always-allow-error")?.textContent).toBe("Could not save: cannot write x");
});

it("after Always allow the header shows one disabled label per scope", async () => {
  const h = async () => {};
  await render(call({ denial: { by: "classifier", rule: "Bash(x)", allowed: true, always: "session" } }), h);
  expect(q("always-allowed")?.textContent).toBe("Always allowed (session)");
  expect((q("always-allowed") as HTMLButtonElement).disabled).toBe(true);
  expect(q("always-allow")).toBeNull();
  expect(q("allow-and-retry")).toBeNull();
  await render(call({ denial: { by: "classifier", rule: "Bash(x)", allowed: true, always: "local" } }), h);
  expect(q("always-allowed")?.textContent).toBe("Always allowed (project)");
});

it("a call without a rule says why, with no scope buttons", async () => {
  const h = async () => {};
  await render(call({ tool: "Monitor", input: {}, denial: { by: "classifier" } }), h);
  await click("always-allow");
  expect(q("always-allow-unavailable")?.textContent).toBe("Always allow is not available for Monitor calls: auto mode ignores these rules.");
  expect(q("always-allow-session")).toBeNull();
  await click("always-allow-cancel");
  await render(call({ tool: "Skill", input: {}, denial: { by: "classifier" } }), h);
  await click("always-allow");
  expect(q("always-allow-unavailable")?.textContent).toBe("Always allow is not available for Skill calls: no exact rule fits this call.");
});

it("the project hint names the file the daemon writes, once known", async () => {
  const h = async () => {};
  await render(call(), h, undefined, async () => "/home/me/main-checkout/.claude/settings.local.json");
  await click("always-allow");
  expect(q("always-allow-local-hint")?.textContent).toBe("This project saves to /home/me/main-checkout/.claude/settings.local.json");
  await render(call(), h, undefined, async () => {
    throw new Error("x");
  });
  await click("always-allow-cancel");
  await click("always-allow");
  expect(q("always-allow-local-hint")?.textContent).toBe("This project saves to the local settings file of the repository (.claude/settings.local.json)");
});

it("a failure after the rule was saved says so and names what failed", async () => {
  await render(call(), async () => {
    throw Object.assign(new Error("CLI closed"), { code: "rule_saved" });
  });
  await click("always-allow");
  await click("always-allow-local");
  expect(q("always-allow-error")?.textContent).toBe("The rule Bash(git push --force origin main) was saved, but the call was not retried: CLI closed");
});
