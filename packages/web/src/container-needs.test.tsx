// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SideCheck, SideInfo } from "@claude-ui/protocol";
import { ContainerNeeds, needsOf } from "./container-needs.tsx";
import { SidePanel } from "./side-panel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => (root?.unmount(), (document.body.innerHTML = "")));
const mount = async (el: React.ReactElement) => {
  const div = document.createElement("div");
  document.body.append(div);
  root = createRoot(div);
  await act(async () => root!.render(el));
};
const rows = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"] [data-testid="needs-row"]`)].map((r) => `${r.getAttribute("data-ok")} ${r.textContent!.replace(/^(not )?found:/, "")}`);

const bundleCheck: SideCheck = {
  verdict: "install",
  key: "k",
  facts: { reachable: true, running: true, installed: "none", writable: ["/tmp"], buildTools: { make: false, python3: false, cxx: false }, target: { arch: "x86_64", libc: "glibc", glibc: "2.36" }, install: { method: "bundle" }, tools: { tar: true, gzip: true, npm: false, git: false, cxxRuntime: true }, network: false },
};
const muslCheck: SideCheck = {
  verdict: "blocked",
  reason: "node_missing",
  key: "k",
  facts: { reachable: true, running: true, installed: "none", writable: ["/tmp"], buildTools: { make: false, python3: false, cxx: false }, target: { arch: "x86_64", libc: "musl" }, install: { method: "npm", reason: "the container uses musl (for example Alpine); the bundle needs glibc" }, tools: { tar: true, gzip: true, npm: false, git: true, cxxRuntime: false }, network: true },
};

describe("What this container needs", () => {
  it("without a check: the bundle path, no marks", () => {
    const n = needsOf();
    expect(n.method).toBe("bundle");
    expect(n.needed.every((i) => i.ok === undefined)).toBe(true);
    expect(n.needed.map((i) => i.name)).toEqual(["sh, tar and gzip", "Linux on x86_64 or arm64 with glibc 2.28+ and libstdc++", "Node.js 22 or newer (used when present, not required)", "A writable /tmp, /dev/shm or home folder", "git, for the Git panel (optional)"]);
  });

  it("collapsed at first; expands to the needed items with a ✓ or ✗ each after a check; no path sentence, no login (bundle path)", async () => {
    await mount(<ContainerNeeds check={bundleCheck} />);
    const d = document.querySelector<HTMLDetailsElement>('[data-testid="container-needs"]')!;
    expect(d.open).toBe(false);
    expect(d.querySelector("summary")!.textContent).toBe("What this container needs");
    await act(async () => d.querySelector("summary")!.click());
    expect(d.open).toBe(true);
    expect(rows("needs-needed")).toEqual([
      "true sh, tar and gzip",
      "true Linux on x86_64 or arm64 with glibc 2.28+ and libstdc++",
      "false Node.js 22 or newer (used when present, not required)",
      "true A writable /tmp, /dev/shm or home folder",
      "false git, for the Git panel (optional)",
    ]);
    expect(document.querySelector('[data-testid="needs-path"]')).toBeNull();
    expect(d.textContent).not.toMatch(/login|not needed/i);
  });

  it("bundle path lists Node.js as optional, ✓ when found", () => {
    const row = (nodeOk?: boolean) => needsOf({ ...bundleCheck, facts: { ...bundleCheck.facts, nodeOk } }).needed.find((i) => i.name.startsWith("Node.js"))!;
    expect(row(true)).toMatchObject({ ok: true, optional: true });
    expect(row(false)).toMatchObject({ ok: false, optional: true });
  });

  it("npm path (musl): rows match the npm install and the reason shows", async () => {
    await mount(<ContainerNeeds check={muslCheck} />);
    expect(rows("needs-needed")[0]).toBe("false Node.js 22 or newer");
    expect(rows("needs-needed")).toContain("true Network access to the npm registry");
    expect(document.querySelector('[data-testid="needs-path"]')!.textContent).toBe("Claude UI installs with npm inside this container because the container uses musl (for example Alpine); the bundle needs glibc.");
  });
});

describe("side panel, Docker", () => {
  const side = (o: Partial<SideInfo> = {}): SideInfo => ({ id: "docker:dev", label: "Docker: dev", state: "off", ...o });

  it("bundle check: no Node.js or build tools rows; the guide shows; WSL has no guide", async () => {
    await mount(<SidePanel side={side()} state={{ check: bundleCheck }} onRun={() => {}} onCheck={() => {}} />);
    const r = [...document.querySelectorAll('[data-testid="side-check-row"]')].map((x) => x.textContent);
    expect(r).toEqual(["ReachableYes, running", "Containerx86_64, glibc 2.36: bundle", "claude-ui for this buildNot installed"]);
    expect(document.querySelector('[data-testid="side-install"]')!.textContent).toBe("Install");
    expect(document.querySelector('[data-testid="container-needs"]')).not.toBeNull();
    root!.unmount();
    document.body.innerHTML = "";
    await mount(<SidePanel side={{ id: "wsl:U", label: "WSL: U", state: "off" }} state={{ check: bundleCheck }} onRun={() => {}} onCheck={() => {}} />);
    expect(document.querySelector('[data-testid="container-needs"]')).toBeNull();
  });

  it("progress: downloading, unpacking for a bundle, and the npm fallback reason", async () => {
    await mount(<SidePanel side={side({ state: "starting", phase: "downloading", bundle: true })} state={{ busy: { mode: "needed" } }} onRun={() => {}} onCheck={() => {}} />);
    expect(document.querySelector('[data-testid="side-progress"]')!.textContent).toMatch(/^Downloading Node\.js and Claude Code…/);
    await act(async () => root!.render(<SidePanel side={side({ state: "starting", phase: "installing", bundle: true })} state={{ busy: { mode: "needed" } }} onRun={() => {}} onCheck={() => {}} />));
    expect(document.querySelector('[data-testid="side-progress"]')!.textContent).toMatch(/^Unpacking claude-ui in the container…/);
    await act(async () => root!.render(<SidePanel side={side({ state: "starting", phase: "installing", fallback: "the container uses musl" })} state={{ busy: { mode: "needed" } }} onRun={() => {}} onCheck={() => {}} />));
    expect(document.querySelector('[data-testid="side-progress"]')!.textContent).toMatch(/^Installing \(npm, can take minutes\)…/);
    expect(document.querySelector('[data-testid="side-fallback"]')!.textContent).toBe("Installing with npm in the container because the container uses musl.");
  });
});

describe("side panel, WSL", () => {
  const wsl = (o: Partial<SideInfo> = {}): SideInfo => ({ id: "wsl:U", label: "WSL: U", state: "off", ...o });
  const noop = { onRun: () => {}, onCheck: () => {} };

  it("a bundle check says Distro, not Container; the npm note says distro", async () => {
    await mount(<SidePanel side={wsl()} state={{ check: bundleCheck }} {...noop} />);
    expect([...document.querySelectorAll('[data-testid="side-check-row"]')].map((x) => x.textContent)).toContain("Distrox86_64, glibc 2.36: bundle");
    await act(async () => root!.render(<SidePanel side={wsl()} state={{ check: { ...muslCheck, verdict: "install", reason: undefined, facts: { ...muslCheck.facts, install: { method: "npm", reason: "the distro uses musl" } } } }} {...noop} />));
    expect(document.querySelector('[data-testid="side-check-npm"]')!.textContent).toBe("Installs with npm in the distro because the distro uses musl.");
  });

  it("progress: preparing before the first phase, downloading, unpacking for a bundle, the npm fallback reason; all with the word distro", async () => {
    const busy = { busy: { mode: "needed" as const } };
    await mount(<SidePanel side={wsl({ state: "starting" })} state={busy} {...noop} />);
    expect(document.querySelector('[data-testid="side-progress"]')!.textContent).toMatch(/^Preparing claude-ui…/);
    await act(async () => root!.render(<SidePanel side={wsl({ state: "starting", phase: "downloading", bundle: true })} state={busy} {...noop} />));
    expect(document.querySelector('[data-testid="side-progress"]')!.textContent).toMatch(/^Downloading Node\.js and Claude Code…/);
    await act(async () => root!.render(<SidePanel side={wsl({ state: "starting", phase: "installing", bundle: true })} state={busy} {...noop} />));
    expect(document.querySelector('[data-testid="side-progress"]')!.textContent).toMatch(/^Unpacking claude-ui in the distro…/);
    await act(async () => root!.render(<SidePanel side={wsl({ state: "starting", phase: "installing", fallback: "the distro uses musl" })} state={busy} {...noop} />));
    expect(document.querySelector('[data-testid="side-progress"]')!.textContent).toMatch(/^Installing \(npm, can take minutes\)…/);
    expect(document.querySelector('[data-testid="side-fallback"]')!.textContent).toBe("Installing with npm in the distro because the distro uses musl.");
  });
});
