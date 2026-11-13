// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserLogsSection } from "./browser-logs-settings.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const fake = (over: Partial<{ count: number; state: "ready" | "unavailable" }> = {}) => {
  let count = over.count ?? 3;
  return {
    stats: vi.fn(async () => ({ count, oldest: count ? Date.UTC(2026, 10, 1) : undefined })),
    exportText: vi.fn(async () => '{"a":1}\n'),
    clear: vi.fn(async () => void (count = 0)),
    state: () => over.state ?? ("ready" as const),
    setEnabled: vi.fn(),
  };
};
const mount = async (logger: ReturnType<typeof fake>) => {
  await act(async () => root.render(<BrowserLogsSection logger={logger} />));
  await act(async () => {});
};
const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const click = async (id: string) => act(async () => void q(id)!.click());

describe("BrowserLogsSection", () => {
  it("shows count and oldest time", async () => {
    await mount(fake());
    expect(q("settings-browser-logs-status")!.textContent).toMatch(/^3 entries since /);
  });

  it("says logs are unavailable when storage is blocked", async () => {
    await mount(fake({ count: 0, state: "unavailable" }));
    expect(q("settings-browser-logs-status")!.textContent).toBe("Browser logs are unavailable: this browser blocks storage.");
    expect(q("settings-browser-logs-export")!.disabled).toBe(true);
    expect(q("settings-browser-logs-clear")!.disabled).toBe(true);
  });

  it("Export downloads claude-ui-browser-logs-<date>.log", async () => {
    const logger = fake();
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    await mount(logger);
    await click("settings-browser-logs-export");
    expect(logger.exportText).toHaveBeenCalled();
    expect(names[0]).toMatch(/^claude-ui-browser-logs-\d{4}-\d{2}-\d{2}\.log$/);
  });

  it("Clear asks first and clears on confirm", async () => {
    const logger = fake();
    await mount(logger);
    await click("settings-browser-logs-clear");
    expect(q("settings-browser-logs-clear-confirm")).not.toBeNull();
    await act(async () => void [...host.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click());
    expect(logger.clear).not.toHaveBeenCalled();
    expect(q("settings-browser-logs-clear-confirm")).toBeNull();
    await click("settings-browser-logs-clear");
    await click("settings-browser-logs-clear-yes");
    expect(logger.clear).toHaveBeenCalledTimes(1);
    expect(q("settings-browser-logs-status")!.textContent).toBe("No entries yet.");
  });

  it("Keep browser logs switch turns capture off", async () => {
    const logger = fake();
    await mount(logger);
    expect(q("settings-browser-logs-keep")!.getAttribute("aria-checked")).toBe("true");
    await click("settings-browser-logs-keep");
    expect(localStorage.getItem("claude-ui.browserLogs")).toBe("off");
    expect(logger.setEnabled).toHaveBeenCalledWith(false);
    expect(q("settings-browser-logs-status")!.textContent).toBe("Off: nothing is kept.");
  });
});
