import { TriangleAlertIcon } from "lucide-react";
import { createContext, use } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "./i18n.ts";

/** Opens the Claude login terminal; set by the App, so the warning row can offer it. */
export const ClaudeLoginContext = createContext<(() => void) | undefined>(undefined);

/** The SDK messages the timeline has no card for: an error string as a warning row, anything else as its type. */
export function RawPart({ message }: { message: unknown }) {
  const tr = useT();
  const openLogin = use(ClaudeLoginContext);
  const { type, subtype, error } = (message ?? {}) as { type?: unknown; subtype?: unknown; error?: unknown };
  if (typeof error === "string")
    return (
      <div className="flex flex-wrap items-start gap-1.5 text-warning text-xs" data-testid="raw-part">
        <TriangleAlertIcon role="img" aria-label={tr("app.timeline.warning")} className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{error}</span>
        {openLogin && (error === "authentication_failed" || type === "auth_status") && (
          <Button type="button" size="sm" variant="outline" data-testid="claude-login" className="max-md:min-h-11 pointer-coarse:min-h-11" onClick={openLogin}>
            {tr("app.login.action")}
          </Button>
        )}
      </div>
    );
  return (
    <div className="text-muted-foreground text-xs [overflow-wrap:anywhere]" data-testid="raw-part">
      {[type, subtype].filter((v) => typeof v === "string").join("/") || tr("app.timeline.sdkMessage")}
    </div>
  );
}
