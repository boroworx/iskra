import type { AtomCommandResult } from "@iskra/client-runtime/state/runtime";
import type {
  CardAttention,
  CardOpenElicitation,
  EnvironmentId,
  OrchestrationCardShell,
} from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { cardEnvironment } from "~/state/cards";
import { useProjects } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastCommandFailure } from "../toastCommandFailure";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

const refused = (title: string) => (result: AtomCommandResult<unknown, unknown>) =>
  toastCommandFailure(result, title, "The request was refused.");

/**
 * What a person can do about one attention item: forward or dismiss it, retry the landing, or go
 * where it gets resolved (project settings, the card's criteria). `onCard` leaves out the link to
 * the card when its sheet is already open.
 */
export function AttentionActions(props: {
  readonly card: Pick<OrchestrationCardShell, "id" | "projectId">;
  readonly item: CardAttention;
  readonly environmentId: EnvironmentId;
  readonly onCard?: boolean;
}) {
  const { card, item, environmentId } = props;
  const forward = useAtomCommand(cardEnvironment.forwardComment);
  const dismiss = useAtomCommand(cardEnvironment.dismissAttention);
  const decide = useAtomCommand(cardEnvironment.decide);
  const projects = useProjects();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const [sending, setSending] = useState(false);
  const project = projects.find(
    (entry) => entry.environmentId === environmentId && entry.id === card.projectId,
  );
  const input = { cardId: card.id, activityId: item.activityId };
  const send = async (
    request: Promise<AtomCommandResult<unknown, unknown>>,
    failure: string,
  ): Promise<void> => {
    setSending(true);
    refused(failure)(await request);
    setSending(false);
  };

  return (
    <div className="flex flex-wrap gap-1">
      {item.actions.map((action) => {
        switch (action) {
          case "forward":
            return (
              <Button
                key={action}
                size="sm"
                variant="outline"
                disabled={sending}
                onClick={() =>
                  void send(forward({ environmentId, input }), "The comment was not forwarded")
                }
              >
                Forward to the agent
              </Button>
            );
          case "dismiss":
            return (
              <Button
                key={action}
                size="sm"
                variant="ghost-muted"
                disabled={sending}
                onClick={() => void send(dismiss({ environmentId, input }), "It was not dismissed")}
              >
                Dismiss
              </Button>
            );
          case "retryLanding":
            return (
              <Button
                key={action}
                size="sm"
                variant="outline"
                disabled={sending}
                onClick={() =>
                  void send(
                    decide({ environmentId, input: { type: "card.merge.approve", cardId: card.id } }),
                    "The landing was not retried",
                  )
                }
              >
                Retry landing
              </Button>
            );
          case "rerunVerifier":
            return (
              <Button
                key={action}
                size="sm"
                variant="outline"
                disabled={sending}
                onClick={() =>
                  void send(
                    decide({
                      environmentId,
                      input: { type: "card.verifier.rerun", cardId: card.id },
                    }),
                    "The verifier was not rerun",
                  )
                }
              >
                Rerun verifier
              </Button>
            );
          case "openSettings":
            return project === undefined ? null : (
              <Button
                key={action}
                size="sm"
                variant="ghost-muted"
                render={
                  <Link
                    to="/settings/projects"
                    search={{ project: deriveLogicalProjectKeyFromSettings(project, grouping) }}
                    hash="project-orchestration"
                  />
                }
              >
                Project settings
              </Button>
            );
          case "addCriteria":
            return props.onCard ? null : (
              <Button
                key={action}
                size="sm"
                variant="ghost-muted"
                render={
                  <Link
                    to="/board/$environmentId/$projectId"
                    params={{ environmentId, projectId: card.projectId }}
                    search={{ card: card.id }}
                  />
                }
              >
                Add criteria
              </Button>
            );
        }
      })}
    </div>
  );
}

const shortId = (sha: string | null) => (sha === null ? "none" : sha.slice(0, 12));

/**
 * Refs outside the card that changed during an agent turn. Iskra can't tell who changed them, so a
 * person restores the ones the agent moved (every ref unless they untick some, which are kept) or
 * keeps them all. The card stays paused until they resume it.
 */
export function RefsChangedControls(props: {
  readonly cardId: OrchestrationCardShell["id"];
  readonly report: CardOpenElicitation;
  readonly environmentId: EnvironmentId;
}) {
  const restore = useAtomCommand(cardEnvironment.restoreRefs);
  const keep = useAtomCommand(cardEnvironment.keepRefs);
  const refs = props.report.refChanges ?? [];
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(refs.map((change) => change.ref)),
  );
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const input = { cardId: props.cardId, activityId: props.report.activityId };
  const everyRef = chosen.size === refs.length;

  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <p className="text-sm">
        These refs changed outside this card during an agent turn. If the agent did this, restore
        them; if you did, keep them. Then resume the card.
      </p>
      <ul className="flex flex-col gap-1">
        {refs.map((change) => (
          <li key={change.ref} className="flex min-w-0 flex-wrap items-center gap-x-2">
            <Checkbox
              aria-label={`Restore ${change.ref}`}
              checked={chosen.has(change.ref)}
              disabled={sending}
              onCheckedChange={(checked) =>
                setChosen((current) => {
                  const next = new Set(current);
                  if (checked) next.add(change.ref);
                  else next.delete(change.ref);
                  return next;
                })
              }
            />
            <span className="min-w-0 truncate font-mono">{change.ref}</span>
            <span className="text-muted-foreground">{change.kind}</span>
            <span className="font-mono text-muted-foreground">
              {shortId(change.before)} → {shortId(change.after)}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="outline"
          disabled={sending || chosen.size === 0}
          onClick={() => setConfirming(true)}
        >
          {everyRef ? "Restore…" : `Restore ${chosen.size} of ${refs.length}…`}
        </Button>
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={sending}
          onClick={async () => {
            setSending(true);
            refused("The refs were not kept")(await keep({ environmentId: props.environmentId, input }));
            setSending(false);
          }}
        >
          Keep
        </Button>
      </div>
      <AlertDialog open={confirming} onOpenChange={(open) => !sending && setConfirming(open)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore {everyRef ? "these refs" : `${chosen.size} refs`}?</AlertDialogTitle>
            <AlertDialogDescription>
              Each goes back to where it was before the agent's turn; a ref that changed again since
              is left alone and reported.{everyRef ? "" : " The unticked refs are kept as they are."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={sending} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={sending}
              onClick={async () => {
                setSending(true);
                const result = await restore({
                  environmentId: props.environmentId,
                  input: everyRef
                    ? input
                    : { ...input, refs: refs.filter((change) => chosen.has(change.ref)).map((change) => change.ref) },
                });
                setSending(false);
                setConfirming(false);
                refused("The refs were not restored")(result);
              }}
            >
              Restore
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
