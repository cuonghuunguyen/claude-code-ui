// "Add SSH host" of the Open project dialog: an `ssh user@host -p N [-i key] [-J jump]` command becomes a Host block in the ssh config (hub: ssh.add).
import { useState, type FormEvent } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "./i18n.ts";

const SAMPLE = "ssh user@host -p 22 -i ~/.ssh/key -J jump";
const FIELD = "h-9 w-full rounded-md bg-secondary/60 px-3 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring max-md:h-11 max-md:text-base";

/** `onAdd` rejects with the reason (bad command, alias exists); on success the form closes (the host is in the list by then). */
export function AddSshHost({ onAdd }: { onAdd: (command: string, alias?: string) => Promise<unknown> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState("");
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => (setOpen(false), setCommand(""), setAlias(""), setError(undefined));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !command.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await onAdd(command.trim(), alias.trim() || undefined);
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <div className="px-1.5 pb-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)} className="max-md:h-11" data-testid="add-ssh-host">
          <PlusIcon className="size-4" aria-hidden />
          {t("sidebar.op.addHost")}
        </Button>
      </div>
    );
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 px-3 pb-3" data-testid="add-ssh-host-form">
      <input autoFocus aria-label={t("sidebar.op.addHostCommandAria")} autoComplete="off" spellCheck={false} value={command} onChange={(e) => setCommand(e.target.value)} placeholder={SAMPLE} className={FIELD} data-testid="add-ssh-host-command" />
      <input aria-label={t("sidebar.op.addHostAliasAria")} autoComplete="off" spellCheck={false} value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={t("sidebar.op.addHostAlias")} className={FIELD} data-testid="add-ssh-host-alias" />
      <p className="text-muted-foreground text-xs">{t("sidebar.op.addHostHint")}</p>
      {error && (
        <p role="alert" className="text-destructive text-sm [overflow-wrap:anywhere]" data-testid="add-ssh-host-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !command.trim()} className="max-md:h-11" data-testid="add-ssh-host-submit">
          {busy ? t("sidebar.op.addHostAdding") : t("sidebar.op.addHostSubmit")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={close} className="max-md:h-11">
          {t("sidebar.op.addHostCancel")}
        </Button>
      </div>
    </form>
  );
}
