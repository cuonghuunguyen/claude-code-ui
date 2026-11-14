// New Tag and Remove Tag of the Graph's context menu (docs/spec.md "Layout", Graph tab; GH-666): each behind a dialog that shows the exact
// git command. The argv builders live in the protocol package: the daemon runs the request only when it computes the same argv.
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { TagIcon } from "lucide-react";
import { tagCreateArgv, tagDeleteArgv, tagDeleteRemoteArgv, type GitTagInfo, type GitTagRemoteResult, type GitTagResult, type GitTagSigning, type GitTagSigningResult } from "@claude-ui/protocol";
import { cn } from "@/lib/utils";
import type { connect, RequestError } from "./client.ts";
import { command, ofRepo, type MenuItem, type RemoteRequest } from "./git-branch-menu.tsx";
import { ConfirmDialog } from "./session-actions.tsx";
import { t, useT } from "./i18n.ts";

type Client = ReturnType<typeof connect>;
type Run = (msg: RemoteRequest, done: string, running: string, onFail?: (e: RequestError) => boolean, onDone?: () => void) => void;
export type TagRequest =
  | { type: "git.tagCreate"; cwd: string; hash: string; name: string; message?: string; sign?: boolean; argv: string[]; exact?: true }
  | { type: "git.tagDelete"; cwd: string; name: string; hash: string; argv: string[]; remotes?: { remote: string; hash: string; argv: string[] }[]; exact?: true };

const short7 = (h: string) => h.slice(0, 7);
/** Menu items shown for the tags of one commit: the chip menu covers the rest. */
export const MAX_TAG_ITEMS = 5;
const PRE = "max-h-48 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded bg-secondary p-2 font-mono text-muted-foreground text-xs";

/**
 * Name field, optional message, the signing toggle and the live command; mounted only while open, so each open starts blank.
 * The toggle starts at the repository's `tag.gpgSign` (read when the dialog opens). A signed create keeps the dialog open
 * (the signer may wait for a passphrase) with a Cancel that stops it; a failure shows here, a success closes the dialog.
 */
export function NewTagDialog({ client, cwd, exact = false, repoName, hash, onRun, onClose }: { client: Client; cwd: string; exact?: boolean; repoName?: string; hash: string; onRun: Run; onClose: () => void }) {
  const t = useT();
  const [n, setN] = useState("");
  const [m, setM] = useState("");
  /** undefined: still reading; null: unknown (the read failed): the daemon then decides by the config. */
  const [cfg, setCfg] = useState<GitTagSigning | null | undefined>(undefined);
  const [pick, setPick] = useState<boolean>();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    client.request<GitTagSigningResult>({ type: "git.tagSigning", cwd, ...(exact && { exact: true as const }) }).then(
      (r) => live.current && setCfg(r.signing ?? null),
      () => live.current && setCfg(null),
    );
    return () => void (live.current = false);
  }, [client, cwd, exact]);
  const name = n.trim();
  const signing = pick ?? cfg?.gpgSign ?? false;
  // true: sign; false: tag.gpgSign is on and the user turned it off; undefined: git's config decides.
  const sign = signing ? true : cfg?.gpgSign ? false : undefined;
  const message = m.trim() ? m : undefined;
  const cancel = () => {
    if (waiting) client.request({ type: "git.tagCancel", cwd, ...(exact && { exact: true as const }) }).catch(() => {});
    onClose();
  };
  const go = () => {
    if (!name || cfg === undefined || waiting) return;
    const msg: TagRequest = { type: "git.tagCreate", cwd, ...(exact && { exact: true as const }), hash, name, ...(message && { message }), ...(sign !== undefined && { sign }), argv: tagCreateArgv(name, hash, message, sign) };
    const done = ofRepo(t("sidebar.git.tagCreated", { name, at: short7(hash) }), repoName);
    const running = ofRepo(t("sidebar.git.tagCreating", { name }), repoName);
    if (sign !== true) {
      onClose();
      return onRun(msg, done, running);
    }
    setError(undefined);
    setWaiting(true);
    onRun(
      msg,
      done,
      running,
      (e) => {
        if (live.current && e.code !== "cancelled") (setError(e.message || t("sidebar.git.failed")), setWaiting(false));
        return true;
      },
      onClose,
    );
  };
  return (
    <ConfirmDialog open title={t("sidebar.git.tagNewTitle")} description={t("sidebar.git.tagNewText", { at: short7(hash) })} confirm={t("sidebar.git.tagCreate")} confirmDisabled={!name || cfg === undefined || waiting} onConfirm={go} onCancel={cancel} testId="git-new-tag">
      <input autoFocus aria-label={t("sidebar.git.tagName")} placeholder={t("sidebar.git.tagName")} value={n} disabled={waiting} onChange={(e) => (setN(e.target.value), setError(undefined))} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), go())} className="h-9 rounded-md border bg-transparent px-2 text-sm max-md:h-11 focus-visible:outline-2 focus-visible:outline-ring" data-testid="git-new-tag-name" />
      <textarea rows={3} aria-label={t("sidebar.git.tagMessage")} placeholder={t("sidebar.git.tagMessage")} value={m} disabled={waiting} onChange={(e) => setM(e.target.value)} className="rounded-md border bg-transparent px-2 py-1.5 text-sm max-md:min-h-11 focus-visible:outline-2 focus-visible:outline-ring" data-testid="git-new-tag-message" />
      <label className="flex items-center gap-2 text-sm max-md:min-h-11" data-testid="git-new-tag-signing">
        <input type="checkbox" className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring" checked={signing} disabled={waiting || cfg === undefined} onChange={() => (setPick(!signing), setError(undefined))} data-testid="git-new-tag-sign" />
        <span className="[overflow-wrap:anywhere]">{t(cfg?.gpgSign ? "sidebar.git.tagSignConfigured" : "sidebar.git.tagSign", { how: cfg ? `${cfg.format}${cfg.key ? `, ${cfg.key}` : ""}` : "git" })}</span>
      </label>
      {waiting && (
        <div role="status" className="text-muted-foreground text-xs" data-testid="git-new-tag-waiting">
          {t("sidebar.git.tagSigningWait")}
        </div>
      )}
      {error && (
        <div role="alert" className="whitespace-pre-wrap text-destructive text-xs [overflow-wrap:anywhere]" data-testid="git-new-tag-error">
          {error}
        </div>
      )}
      <pre className={PRE} data-testid="git-command">
        {command(tagCreateArgv(name || "<name>", hash, m, sign))}
      </pre>
    </ConfirmDialog>
  );
}

type RemoteState = { state: "checking" } | { state: "has"; hash: string } | { state: "absent" } | { state: "error"; reason: string };

/** `git.tag` of `name` (the local tag and the configured remotes), then one `git.tagRemote` per remote in parallel. */
export function useTagRemotes(client: Client, cwd: string, exact: boolean, name: string) {
  const [s, setS] = useState<{ tag?: GitTagInfo; error?: string; remotes: Record<string, RemoteState> }>({ remotes: {} });
  useEffect(() => {
    let live = true;
    setS({ remotes: {} });
    const ex = exact ? { exact: true as const } : {};
    const put = (remote: string, r: RemoteState) => live && setS((p) => ({ ...p, remotes: { ...p.remotes, [remote]: r } }));
    client.request<GitTagResult>({ type: "git.tag", cwd, ...ex, name }).then(
      (r) => {
        if (!live) return;
        if (!r.tag) return setS({ error: t("sidebar.git.notRepo"), remotes: {} });
        const tag = r.tag;
        setS({ tag, remotes: Object.fromEntries(tag.remotes.map((x) => [x, { state: "checking" } as RemoteState])) });
        for (const remote of tag.remotes)
          client.request<GitTagRemoteResult>({ type: "git.tagRemote", cwd, ...ex, name, remote }).then(
            (rr) => put(remote, rr.remoteTag?.hash ? { state: "has", hash: rr.remoteTag.hash } : { state: "absent" }),
            (e: RequestError) => put(remote, { state: "error", reason: (e.message || t("sidebar.git.failed")).split("\n")[0]! }),
          );
      },
      (e: RequestError) => live && setS({ error: e.message || t("sidebar.git.failed"), remotes: {} }),
    );
    return () => void (live = false);
  }, [client, cwd, exact, name]);
  return s;
}

/** Remove Tag: the local delete always, one opt-in box per remote that has the tag; mounted only while open. */
export function RemoveTagDialog({ client, cwd, exact = false, repoName, name, onRun, onClose }: { client: Client; cwd: string; exact?: boolean; repoName?: string; name: string; onRun: Run; onClose: () => void }) {
  const t = useT();
  const { tag, error, remotes } = useTagRemotes(client, cwd, exact, name);
  const [checked, setChecked] = useState<string[]>([]);
  const toggle = (r: string) => setChecked((c) => (c.includes(r) ? c.filter((x) => x !== r) : [...c, r]));
  const list = tag ? tag.remotes : [];
  const picked = list.filter((r) => checked.includes(r) && remotes[r]?.state === "has");
  const withRemote = picked.map((remote) => {
    const rs = remotes[remote] as { state: "has"; hash: string };
    return { remote, hash: rs.hash, argv: tagDeleteRemoteArgv(remote, name, rs.hash) };
  });
  const lines = [...withRemote.map((r) => command(r.argv)), command(tagDeleteArgv(name))];
  const go = () => {
    if (!tag) return;
    onClose();
    onRun(
      { type: "git.tagDelete", cwd, ...(exact && { exact: true as const }), name, hash: tag.hash, argv: tagDeleteArgv(name), ...(withRemote.length && { remotes: withRemote }) },
      ofRepo(withRemote.length ? t("sidebar.git.tagRemovedRemote", { name, remotes: picked.join(", ") }) : t("sidebar.git.tagRemoved", { name }), repoName),
      ofRepo(t("sidebar.git.tagRemoving", { name }), repoName),
    );
  };
  return (
    <ConfirmDialog open title={t("sidebar.git.tagRemoveTitle", { name })} description={error ?? (tag ? t("sidebar.git.tagRemoveText", { name, at: short7(tag.commit) }) : t("sidebar.git.loading"))} confirm={t("sidebar.git.tagRemove")} destructive confirmDisabled={!tag} onConfirm={go} onCancel={onClose} testId="git-remove-tag">
      {list.map((r) => {
        const s = remotes[r];
        if (!s || s.state === "absent") return s ? <div key={r} className="text-muted-foreground text-xs">{t("sidebar.git.tagRemoteAbsent", { remote: r })}</div> : null;
        if (s.state === "checking") return <div key={r} className="text-muted-foreground text-xs">{t("sidebar.git.tagRemoteCheck", { remote: r })}</div>;
        if (s.state === "error") return <div key={r} className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{t("sidebar.git.tagRemoteFailed", { remote: r, reason: s.reason })}</div>;
        return (
          <label key={r} className="flex items-center gap-2 text-sm max-md:min-h-11">
            <input type="checkbox" className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring" checked={checked.includes(r)} onChange={() => toggle(r)} data-testid={`git-remove-tag-remote-${r}`} />
            {t("sidebar.git.tagRemoteAlso", { remote: r })}
          </label>
        );
      })}
      <pre className={PRE} data-testid="git-command">
        {lines.join("\n")}
      </pre>
    </ConfirmDialog>
  );
}

/**
 * The menu section of one tag: header (icon and name), then Remove Tag… (red). `Sep` is the caller's separator, rendered after the section.
 */
export function TagItems({ name, busy, onRemove, Item, Sep }: { name: string; busy: boolean; onRemove: () => void; Item: MenuItem; Sep: ComponentType }): ReactNode {
  const t = useT();
  return (
    <>
      <div role="group" aria-label={name}>
        <div className="flex items-center gap-1 px-2 pt-1 font-medium text-muted-foreground text-xs" data-testid="tag-menu-head">
          <TagIcon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{name}</span>
        </div>
        <Item className={cn("text-destructive max-md:min-h-11")} disabled={busy} onClick={onRemove} data-testid="tag-remove">
          {t("sidebar.git.tagRemove")}
        </Item>
      </div>
      <Sep />
    </>
  );
}
