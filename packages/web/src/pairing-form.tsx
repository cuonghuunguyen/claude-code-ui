// The not-paired card (docs/spec.md "Security"): a Home Screen app on iOS has its own storage, so it cannot take the token from Safari; paste the pairing link here.
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { parsePairing, storeToken } from "./pairing.ts";

export function PairingForm({ reload = () => location.reload() }: { reload?: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  // The card only renders for an unpaired browser, so taking the focus here is what the person came to do.
  useEffect(() => input.current?.focus(), []);

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const token = parsePairing(text);
    if (!token) return setError("That is not a pairing link or token.");
    setBusy(true);
    setError(undefined);
    try {
      const r = await fetch("/auth", { headers: { authorization: `Bearer ${token}` } });
      if (r.status === 204) {
        storeToken(token);
        setText("");
        return reload();
      }
      setError("This daemon does not accept that token. Copy the link the daemon printed last (the token changes when the config folder changes).");
    } catch {
      setError("Cannot reach the daemon.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-auto flex w-full max-w-sm flex-col gap-3 p-4 text-center" data-testid="pairing-needed">
      <p>The daemon rejected this browser: it is not paired.</p>
      <p className="text-sm text-muted-foreground">Paste the pairing link or token the daemon printed (…/#token=…).</p>
      <form onSubmit={submit} className="flex flex-col gap-2 text-left" data-testid="pairing-form">
        <label htmlFor={id} className="text-sm font-medium">
          Pairing link or token
        </label>
        <input
          ref={input}
          id={id}
          type="text"
          value={text}
          onChange={(e) => (setText(e.target.value), setError(undefined))}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          aria-invalid={error !== undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:h-9 sm:text-sm"
          data-testid="pairing-input"
        />
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive" data-testid="pairing-error">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="h-11 sm:h-8" data-testid="pairing-submit">
          Pair
        </Button>
      </form>
    </div>
  );
}
