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
import { randomUUID } from "~/lib/utils";
import { cardEnvironment } from "~/state/cards";
import { channelEnvironment } from "~/state/channels";
import { useProjects } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastCommandFailure } from "../toastCommandFailure";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
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
 * What a person can do about one attention item: forward or dismiss it, retry the landing, restart
 * the card's services, or go where it gets resolved (project settings, the card's criteria).
 * `onCard` leaves out the link to the card when its sheet is already open.
 */
export function AttentionActions(props: {
  readonly card: Pick<OrchestrationCardShell, "id" | "projectId" | "title" | "acceptance">;
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
                    decide({
                      environmentId,
                      input: { type: "card.merge.approve", cardId: card.id },
                    }),
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
          case "restartServices":
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
                      input: { type: "card.services.restart", cardId: card.id },
                    }),
                    "The services were not restarted",
                  )
                }
              >
                Restart
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
          case "addHoldout":
            return project === undefined ? null : (
              <AddHoldoutButton
                key={action}
                card={card}
                item={item}
                environmentId={environmentId}
                projectId={project.id}
              />
            );
          case "assignAgent":
            return props.onCard ? null : (
              <Button
                key={action}
                size="sm"
                variant="outline"
                render={
                  <Link
                    to="/board/$environmentId/$projectId"
                    params={{ environmentId, projectId: card.projectId }}
                    search={{ card: card.id, focus: "agent" }}
                  />
                }
              >
                Assign an agent
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

/**
 * Add hidden scenario for a card that turned out flawed: a described scenario prefilled from the
 * card's criteria, saved to the project's hidden scenarios. Saving also sets the item aside.
 */
function AddHoldoutButton(props: {
  readonly card: Pick<OrchestrationCardShell, "id" | "title" | "acceptance">;
  readonly item: CardAttention;
  readonly environmentId: EnvironmentId;
  readonly projectId: OrchestrationCardShell["projectId"];
}) {
  const setHoldout = useAtomCommand(channelEnvironment.setProjectHoldout, { reportFailure: false });
  const dismiss = useAtomCommand(cardEnvironment.dismissAttention);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(`${props.card.title} stays fixed`);
  const [body, setBody] = useState(() =>
    props.card.acceptance.criteria.map((criterion) => `- ${criterion.text}`).join("\n"),
  );
  const [saving, setSaving] = useState(false);
  const ready = title.trim().length > 0 && body.trim().length > 0;

  const save = async () => {
    setSaving(true);
    const result = await setHoldout({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        scenario: {
          scenarioId: randomUUID(),
          title: title.trim(),
          kind: "text",
          body,
          command: null,
          timeoutMinutes: 5,
        },
      },
    });
    toastCommandFailure(result, "The hidden scenario was not saved", "The request was refused.");
    if (result._tag === "Success") {
      refused("It was not set aside")(
        await dismiss({
          environmentId: props.environmentId,
          input: { cardId: props.card.id, activityId: props.item.activityId },
        }),
      );
      setOpen(false);
    }
    setSaving(false);
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Add hidden scenario
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => !saving && setOpen(next)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Add a hidden scenario</AlertDialogTitle>
            <AlertDialogDescription>
              Only the verifier sees it, so future cards are checked for what this one got wrong. It
              starts from this card's criteria; say what went wrong.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 px-6 pb-2">
            <Input
              aria-label="Scenario title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Textarea
              aria-label="What to check"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogClose disabled={saving} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button disabled={saving || !ready} onClick={() => void save()}>
              Save scenario
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
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
            refused("The refs were not kept")(
              await keep({ environmentId: props.environmentId, input }),
            );
            setSending(false);
          }}
        >
          Keep
        </Button>
      </div>
      <AlertDialog open={confirming} onOpenChange={(open) => !sending && setConfirming(open)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Restore {everyRef ? "these refs" : `${chosen.size} refs`}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Each goes back to where it was before the agent's turn; a ref that changed again since
              is left alone and reported.
              {everyRef ? "" : " The unticked refs are kept as they are."}
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
                    : {
                        ...input,
                        refs: refs
                          .filter((change) => chosen.has(change.ref))
                          .map((change) => change.ref),
                      },
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
