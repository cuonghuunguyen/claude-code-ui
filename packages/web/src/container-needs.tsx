// "What this container needs" (Open project, Docker; docs/spec.md "Sides"): what the install path the container will use needs
// and does not need, with a ✓ or ✗ per item once a check has run. Bundle path: the hub brings Node.js and Claude Code; npm path
// (musl, other CPUs, no bundle): the container installs claude-ui itself.
import { CheckIcon, XIcon } from "lucide-react";
import type { SideCheck } from "@claude-ui/protocol";

/** One item; `ok`: found (true), not found (false), not known (undefined: no check yet or not checkable). `optional`: a missing one is no problem. */
export type NeedItem = { name: string; ok?: boolean; optional?: boolean };
export type Needs = { method: "bundle" | "npm"; reason?: string; needed: NeedItem[]; notNeeded: NeedItem[] };

/** The items for the path the check says the container will use (no check: the bundle path). */
export function needsOf(check?: SideCheck): Needs {
  const f = check?.facts;
  const t = f?.tools;
  const method = f?.install?.method ?? "bundle";
  const writable = { name: "A writable /tmp, /dev/shm or home folder", ok: f?.writable ? f.writable.length > 0 : undefined };
  const login = { name: "A Claude login (claude login, or a key in the environment)", ok: f?.credentialsFile };
  const git = { name: "git, for the Git panel (optional)", ok: t?.git, optional: true };
  const tools = f?.buildTools ? f.buildTools.make && f.buildTools.python3 && f.buildTools.cxx : undefined;
  const node = f ? (f.node ? f.nodeOk : false) : undefined;
  const npm = t?.npm;
  const tarGzip = t ? t.tar && t.gzip : undefined;
  if (method === "bundle")
    return {
      method,
      needed: [
        { name: "sh, tar and gzip", ok: tarGzip },
        { name: "Linux on x86_64 or arm64 with glibc 2.28+ and libstdc++", ok: f?.install ? true : undefined },
        writable,
        login,
        git,
      ],
      notNeeded: [
        { name: "Node.js", ok: f ? !!f.node : undefined },
        { name: "npm", ok: npm },
        { name: "Network access", ok: f?.network },
        { name: "Build tools (make, python3, g++)", ok: tools },
      ],
    };
  return {
    method,
    reason: f?.install?.reason,
    needed: [{ name: "Node.js 22 or newer", ok: node }, { name: "npm", ok: npm }, { name: "Network access to the npm registry", ok: f?.network }, { name: "Build tools (make, python3, g++)", ok: tools }, writable, login, git],
    notNeeded: [{ name: "tar and gzip", ok: tarGzip }],
  };
}

function Mark({ ok, needed, optional }: { ok?: boolean; needed: boolean; optional?: boolean }) {
  if (ok === undefined) return <span className="size-4 shrink-0" aria-hidden />;
  // Only a missing needed item is a problem; presence of a not-needed one is information.
  const tone = ok ? (needed ? "text-success" : "text-muted-foreground") : needed && !optional ? "text-destructive" : "text-muted-foreground";
  const Icon = ok ? CheckIcon : XIcon;
  return (
    <>
      <Icon className={`size-4 shrink-0 self-center ${tone}`} aria-hidden />
      <span className="sr-only">{ok ? "found:" : "not found:"}</span>
    </>
  );
}

function List({ title, items, needed }: { title: string; items: NeedItem[]; needed: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={needed ? "needs-needed" : "needs-not-needed"}>
      <h4 className="text-xs font-medium uppercase text-muted-foreground">{title}</h4>
      <ul className="flex flex-col gap-1">
        {items.map((i) => (
          <li key={i.name} className="flex items-baseline gap-2 [overflow-wrap:anywhere]" data-testid="needs-row" data-ok={i.ok === undefined ? "unknown" : String(i.ok)}>
            <Mark ok={i.ok} needed={needed} optional={i.optional} />
            <span>{i.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ContainerNeeds({ check }: { check?: SideCheck }) {
  const n = needsOf(check);
  return (
    <details className="w-full max-w-md shrink-0 rounded-md border border-border text-left text-sm" data-testid="container-needs">
      <summary className="cursor-pointer select-none px-3 py-2 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:py-3">What this container needs</summary>
      <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
        <p className="text-muted-foreground" data-testid="needs-path">
          {n.method === "bundle"
            ? "Claude UI copies in its own Node.js, terminal support and Claude Code, so the container needs no Node.js, npm, network or build tools."
            : `Claude UI installs with npm inside this container${n.reason ? ` because ${n.reason}` : ""}.`}
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <List title="Needed" items={n.needed} needed />
          <List title="Not needed" items={n.notNeeded} needed={false} />
        </div>
      </div>
    </details>
  );
}
