// "What this container needs" (Open project, Docker; docs/spec.md "Sides"): what the install path the container will use needs,
// with a ✓ or ✗ per item once a check has run. Bundle path: the hub brings Claude Code, and Node.js only when the container has none in range; npm path (musl, other CPUs,
// no bundle): the container installs claude-ui itself.
import { CheckIcon, XIcon } from "lucide-react";
import { NODE_MIN, type SideCheck } from "@claude-ui/protocol";
import { t, useT } from "./i18n.ts";

/** One item; `ok`: found (true), not found (false), not known (undefined: no check yet or not checkable). `optional`: a missing one is no problem. */
export type NeedItem = { name: string; ok?: boolean; optional?: boolean };
export type Needs = { method: "bundle" | "npm"; reason?: string; needed: NeedItem[] };

/** The items for the path the check says the container will use (no check: the bundle path). */
export function needsOf(check?: SideCheck): Needs {
  const f = check?.facts;
  const tools0 = f?.tools;
  const method = f?.install?.method ?? "bundle";
  const writable = { name: t("sidebar.needs.writable"), ok: f?.writable ? f.writable.length > 0 : undefined };
  const git = { name: t("sidebar.needs.git"), ok: tools0?.git, optional: true };
  if (method === "bundle")
    return {
      method,
      needed: [
        { name: t("sidebar.needs.shell"), ok: tools0 ? tools0.tar && tools0.gzip : undefined },
        { name: t("sidebar.needs.linux"), ok: f?.install ? true : undefined },
        { name: t("sidebar.needs.nodeOptional", { min: NODE_MIN }), ok: f ? !!f.nodeOk : undefined, optional: true },
        writable,
        git,
      ],
    };
  const tools = f?.buildTools ? f.buildTools.make && f.buildTools.python3 && f.buildTools.cxx : undefined;
  return {
    method,
    reason: f?.install?.reason,
    needed: [
      { name: t("sidebar.needs.node", { min: NODE_MIN }), ok: f ? (f.node ? f.nodeOk : false) : undefined },
      { name: t("sidebar.needs.npm"), ok: tools0?.npm },
      { name: t("sidebar.needs.network"), ok: f?.network },
      { name: t("sidebar.needs.build"), ok: tools },
      writable,
      git,
    ],
  };
}

function Mark({ ok, optional }: { ok?: boolean; optional?: boolean }) {
  const t = useT();
  if (ok === undefined) return <span className="size-4 shrink-0" aria-hidden />;
  const tone = ok ? "text-success" : optional ? "text-muted-foreground" : "text-destructive";
  const Icon = ok ? CheckIcon : XIcon;
  return (
    <>
      <Icon className={`size-4 shrink-0 self-center ${tone}`} aria-hidden />
      <span className="sr-only">{t(ok ? "sidebar.needs.found" : "sidebar.needs.notFound")}</span>
    </>
  );
}

export function ContainerNeeds({ check }: { check?: SideCheck }) {
  const t = useT();
  const n = needsOf(check);
  return (
    <details className="w-full max-w-md shrink-0 rounded-md border border-border text-left text-sm" data-testid="container-needs">
      <summary className="cursor-pointer select-none px-3 py-2 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:py-3">{t("sidebar.needs.summary")}</summary>
      <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
        {n.method === "npm" && (
          <p className="text-muted-foreground" data-testid="needs-path">
            {n.reason ? t("sidebar.needs.npmPathReason", { reason: n.reason }) : t("sidebar.needs.npmPath")}
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
