// "What this container needs" (Open project, Docker; docs/spec.md "Sides"): what the install path the container will use needs,
// with a ✓ or ✗ per item once a check has run. Bundle path: the hub brings Node.js and Claude Code; npm path (musl, other CPUs,
// no bundle): the container installs claude-ui itself.
import { CheckIcon, XIcon } from "lucide-react";
import type { SideCheck } from "@claude-ui/protocol";

/** One item; `ok`: found (true), not found (false), not known (undefined: no check yet or not checkable). `optional`: a missing one is no problem. */
export type NeedItem = { name: string; ok?: boolean; optional?: boolean };
export type Needs = { method: "bundle" | "npm"; reason?: string; needed: NeedItem[] };

/** The items for the path the check says the container will use (no check: the bundle path). */
export function needsOf(check?: SideCheck): Needs {
  const f = check?.facts;
  const t = f?.tools;
  const method = f?.install?.method ?? "bundle";
  const writable = { name: "A writable /tmp, /dev/shm or home folder", ok: f?.writable ? f.writable.length > 0 : undefined };
  const git = { name: "git, for the Git panel (optional)", ok: t?.git, optional: true };
  if (method === "bundle")
    return {
      method,
      needed: [
        { name: "sh, tar and gzip", ok: t ? t.tar && t.gzip : undefined },
        { name: "Linux on x86_64 or arm64 with glibc 2.28+ and libstdc++", ok: f?.install ? true : undefined },
        writable,
        git,
      ],
    };
  const tools = f?.buildTools ? f.buildTools.make && f.buildTools.python3 && f.buildTools.cxx : undefined;
  return {
    method,
    reason: f?.install?.reason,
    needed: [
      { name: "Node.js 22 or newer", ok: f ? (f.node ? f.nodeOk : false) : undefined },
      { name: "npm", ok: t?.npm },
      { name: "Network access to the npm registry", ok: f?.network },
      { name: "Build tools (make, python3, g++)", ok: tools },
      writable,
      git,
    ],
  };
}

function Mark({ ok, optional }: { ok?: boolean; optional?: boolean }) {
  if (ok === undefined) return <span className="size-4 shrink-0" aria-hidden />;
  const tone = ok ? "text-success" : optional ? "text-muted-foreground" : "text-destructive";
  const Icon = ok ? CheckIcon : XIcon;
  return (
    <>
      <Icon className={`size-4 shrink-0 self-center ${tone}`} aria-hidden />
      <span className="sr-only">{ok ? "found:" : "not found:"}</span>
    </>
  );
}

export function ContainerNeeds({ check }: { check?: SideCheck }) {
  const n = needsOf(check);
  return (
    <details className="w-full max-w-md shrink-0 rounded-md border border-border text-left text-sm" data-testid="container-needs">
      <summary className="cursor-pointer select-none px-3 py-2 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:py-3">What this container needs</summary>
      <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
        {n.method === "npm" && (
          <p className="text-muted-foreground" data-testid="needs-path">
            {`Claude UI installs with npm inside this container${n.reason ? ` because ${n.reason}` : ""}.`}
          </p>
        )}
        <ul className="flex flex-col gap-1" data-testid="needs-needed">
          {n.needed.map((i) => (
            <li key={i.name} className="flex items-baseline gap-2 [overflow-wrap:anywhere]" data-testid="needs-row" data-ok={i.ok === undefined ? "unknown" : String(i.ok)}>
              <Mark ok={i.ok} optional={i.optional} />
              <span>{i.name}</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
