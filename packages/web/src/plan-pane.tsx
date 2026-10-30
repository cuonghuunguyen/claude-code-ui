// The Plan pane (GH-395, docs/spec.md "Pane layout"): the newest plan of a session as markdown, in a dock or as a main-area tab.
import { memo } from "react";
import { CircleAlertIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import type { SessionView } from "./store.ts";
import { latestPlan, planWaiting } from "./viewer.ts";
import { useT } from "./i18n.ts";

type Props = {
  view: SessionView | undefined;
  /** Main tab: "Plan · <title>"; dock: "Plan". */
  label: string;
  onGoToRequest: () => void;
  /** The session's subscribe failed: no view will come on its own. */
  failed?: boolean;
};

/** The approval itself stays in the session: this pane only points to it. */
export const PlanPane = memo(function PlanPane({ view, label, onGoToRequest, failed }: Props) {
  const t = useT();
  if (!view)
    return failed ? (
      <p className="m-auto text-muted-foreground text-sm" data-testid="plan-failed">
        {t("session.planPane.failed")}
      </p>
    ) : (
      <p className="m-auto text-muted-foreground text-sm">{t("session.planPane.loading")}</p>
    );
  const plan = latestPlan(view);
  if (!plan)
    return (
      <p className="m-auto text-muted-foreground text-sm" data-testid="plan-empty">
        {t("session.planPane.empty")}
      </p>
    );
  return (
    <section data-testid="plan-pane" aria-label={label} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
      {planWaiting(view) && (
        <div role="status" data-testid="plan-waiting" className="flex flex-wrap items-center gap-2 border-b bg-muted px-3 py-2 text-sm">
          <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{t("session.planPane.waiting")}</span>
          <Button type="button" size="sm" variant="outline" className="max-md:h-11 pointer-coarse:h-11" data-testid="plan-go-to-request" onClick={onGoToRequest}>
            {t("session.planPane.goTo")}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <MessageResponse>{plan}</MessageResponse>
      </div>
    </section>
  );
});
