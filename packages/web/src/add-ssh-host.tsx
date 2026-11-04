// "Add SSH host…" of the Open project host list: its own dialog. An `ssh user@host -p N [-i key] [-J jump]` command becomes a Host block in the ssh config (hub: ssh.add).
import { useRef, useState, type FormEvent } from "react";
import { PlusIcon } from "lucide-react";
import { parseSshCommand, type SshTarget } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import { Banner, ConfigDialog } from "./config-dialog.tsx";
import { useT } from "./i18n.ts";

const FIELD = "h-9 w-full rounded-md bg-secondary/60 px-3 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring max-md:h-11 max-md:text-base";
const SAMPLE = "ssh user@host -p 22 -i ~/.ssh/key -J jump";

/** The parsed command, or the parser's reason; nothing typed yet is neither. */
function preview(command: string): { target: SshTarget } | { reason: string } | undefined {
  if (!command.trim()) return undefined;
  try {
    return { target: parseSshCommand(command) };
  } catch (e) {
    return { reason: (e as Error).message };
  }
}

/** `onAdd` resolves with the new host's Side id, or rejects with the daemon's reason (shown in the dialog). `onAdded`: called after the dialog closed. */
export function AddSshHost({ onAdd, onAdded }: { onAdd: (command: string) => Promise<string>; onAdded?: (side: string) => void }) {
  const t = useT();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => (setOpen(false), setCommand(""), setError(undefined));
  const p = preview(command);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !p || !("target" in p)) return;
    setBusy(true);
    setError(undefined);
    try {
      const side = await onAdd(command.trim());
      close();
      onAdded?.(side);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rows = p && "target" in p ? ([["alias", p.target.host], ["host", p.target.host], ["user", p.target.user], ["port", p.target.port && String(p.target.port)], ["key", p.target.identity], ["jump", p.target.jump]] as const).filter((r) => r[1]) : [];
  return (
    <div className="px-1.5 pb-2">
      <Button ref={button} type="button" variant="ghost" size="sm" onClick={() => setOpen(true)} className="max-md:h-11" data-testid="add-ssh-host">
        <PlusIcon className="size-4" aria-hidden />
        {t("sidebar.op.addHost")}
      </Button>
      <ConfigDialog
        title={t("sidebar.op.addHostTitle")}
        open={open}
        onClose={close}
        busy={busy}
        testId="add-ssh-host-dialog"
        finalFocus={() => button.current}
        footer={
          <>
            <Button type="submit" form="add-ssh-host-form" size="sm" disabled={busy || !p || !("target" in p)} className="max-md:h-11" data-testid="add-ssh-host-submit">
              {busy ? t("sidebar.op.addHostAdding") : t("sidebar.op.addHostSubmit")}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={close} className="max-md:h-11" data-testid="add-ssh-host-cancel">
              {t("sidebar.op.addHostCancel")}
            </Button>
          </>
        }
      >
        <form id="add-ssh-host-form" onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" data-testid="add-ssh-host-form">
          <input autoFocus aria-label={t("sidebar.op.addHostCommandAria")} autoComplete="off" spellCheck={false} value={command} onChange={(e) => (setCommand(e.target.value), setError(undefined))} placeholder={SAMPLE} className={FIELD} data-testid="add-ssh-host-command" />
          <p className="text-muted-foreground text-xs">{t("sidebar.op.addHostHint")}</p>
          {p && "reason" in p && (
            <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]" data-testid="add-ssh-host-invalid">
              {p.reason}
            </p>
          )}
          {rows.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="add-ssh-host-preview">
              {rows.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{t(`sidebar.op.addHostPreview.${k}`)}</dt>
                  <dd className="min-w-0 [overflow-wrap:anywhere]" data-testid={`add-ssh-host-preview-${k}`}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {error && <Banner kind="error">{error}</Banner>}
        </form>
      </ConfigDialog>
    </div>
  );
}
