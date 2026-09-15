import type { PillTone } from "@iskra/client-runtime/card-face";
import { openCheckpointActivityId } from "@iskra/client-runtime/cards";
import { MIGRATION_PHASE_LABEL, migrationCounts } from "@iskra/client-runtime/plan-view";
import type {
  CardMigrationItemState,
  EnvironmentId,
  OrchestrationCardShell,
} from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { cardEnvironment } from "~/state/cards";
import { useAtomCommand } from "~/state/use-atom-command";
import { StatusPill } from "../iskra/StatusPill";
import { toastCommandFailure } from "../toastCommandFailure";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const ITEMS_SHOWN = 100;

const ITEM_PILL: Record<
  CardMigrationItemState,
  { readonly label: string; readonly tone: PillTone }
> = {
  pending: { label: "Pending", tone: "gray" },
  running: { label: "Running", tone: "blue" },
  landed: { label: "Landed", tone: "green" },
  blocked: { label: "Blocked", tone: "red" },
};

/**
 * A migration card: its phase, each item and its child card, and, after the sample, the tune
 * checkpoint where a person edits the instructions before the rest are swept.
 */
export function MigrationPanel(props: {
  readonly card: OrchestrationCardShell;
  readonly environmentId: EnvironmentId;
}) {
  const { card, environmentId } = props;
  const migration = card.migration;
  const answer = useAtomCommand(cardEnvironment.answerElicitation);
  const [instructions, setInstructions] = useState(migration?.instructions ?? "");
  const [showAll, setShowAll] = useState(false);
  const [sending, setSending] = useState(false);
  if (migration === null) return null;
  const counts = migrationCounts(migration);
  const checkpointActivityId = openCheckpointActivityId(card);
  const tuning = migration.phase === "tuning" && checkpointActivityId !== null;
  const edited = instructions.trim() !== migration.instructions.trim();
  const items = showAll ? migration.items : migration.items.slice(0, ITEMS_SHOWN);

  const decide = async (optionId: "continue" | "redirect" | "stop", body: string) => {
    if (checkpointActivityId === null) return;
    setSending(true);
    const result = await answer({
      environmentId,
      input: { cardId: card.id, activityId: checkpointActivityId, optionId, body },
    });
    setSending(false);
    toastCommandFailure(
      result,
      "The migration checkpoint was not answered",
      "The request was refused.",
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {MIGRATION_PHASE_LABEL[migration.phase]} · {migration.items.length} items · {counts.landed}{" "}
        landed · {counts.running} running · {counts.blocked} blocked
      </p>
      <p className="break-words text-xs text-muted-foreground">
        Listed by: {migration.enumerateCommand}
      </p>
      {tuning ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm">
            The sample of {migration.sampleSize} is done. Check its cards, adjust the instructions
            if they need it, then sweep the rest.
          </p>
          <Textarea
            aria-label="Migration instructions"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              disabled={sending || edited}
              onClick={() => void decide("continue", "Sweep the rest")}
            >
              Sweep the rest
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={sending || !edited || instructions.trim().length === 0}
              onClick={() => void decide("redirect", instructions.trim())}
            >
              Save instructions
            </Button>
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={sending}
              onClick={() => void decide("stop", "Stop the migration")}
            >
              Stop
            </Button>
          </div>
        </div>
      ) : migration.instructions.trim().length > 0 ? (
        <p className="whitespace-pre-wrap break-words text-sm">{migration.instructions}</p>
      ) : null}
      {migration.items.length > 0 ? (
        <ul className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto rounded-xl bg-card shadow-[0_0_0_0.5px_var(--border)]">
          {items.map((item) => (
            <li key={item.key} className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm">
              {item.childCardId === null ? (
                <span className="min-w-0 flex-1 truncate">{item.key}</span>
              ) : (
                <Link
                  to="/board/$environmentId/$projectId"
                  params={{ environmentId, projectId: card.projectId }}
                  search={{ card: item.childCardId }}
                  className="min-w-0 flex-1 truncate hover:underline"
                >
                  {item.key}
                </Link>
              )}
              <StatusPill {...ITEM_PILL[item.state]} />
            </li>
          ))}
        </ul>
      ) : null}
      {!showAll && migration.items.length > ITEMS_SHOWN ? (
        <Button
          size="sm"
          variant="ghost-muted"
          className="self-start"
          onClick={() => setShowAll(true)}
        >
          Show all {migration.items.length}
        </Button>
      ) : null}
    </div>
  );
}
