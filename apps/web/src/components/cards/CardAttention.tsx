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
import { ActionButton } from "./cardChrome";

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
  const allow = useAtomCommand(cardEnvironment.allowAccess);
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
    <div className="flex flex-wrap items-center gap-2">
      {item.actions.map((action) => {
        switch (action) {
          case "forward":
            return (
              <ActionButton
                key={action}
                tone="primary"
                disabled={sending}
                onClick={() =>
                  void send(forward({ environmentId, input }), "The comment was not forwarded")
                }
              >
                Forward to the agent
              </ActionButton>
            );
          case "allowAccess":
            return (
              <ActionButton
                key={action}
                tone="primary"
                disabled={sending}
                onClick={() =>
                  void send(allow({ environmentId, input }), "Access was not allowed")
                }
              >
                Allow for this project
              </ActionButton>
            );
          case "dismiss":
            return (
              <ActionButton
                key={action}
                disabled={sending}
                onClick={() => void send(dismiss({ environmentId, input }), "It was not dismissed")}
              >
                Dismiss
              </ActionButton>
            );
          case "retryLanding":
            return (
              <ActionButton
                key={action}
                tone="primary"
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
              </ActionButton>
            );
          case "rerunVerifier":
            return (
              <ActionButton
                key={action}
                tone="primary"
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
              </ActionButton>
            );
          case "restartServices":
            return (
              <ActionButton
                key={action}
                tone="primary"
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
              </ActionButton>
            );
          case "openSettings":
            return project === undefined ? null : (
              <ActionButton
                key={action}
                render={
                  <Link
                    to="/settings/projects"
                    search={{ project: deriveLogicalProjectKeyFromSettings(project, grouping) }}
                    hash="project-orchestration"
                  />
                }
              >
                Project settings
              </ActionButton>
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
              <ActionButton
                key={action}
                tone="primary"
                render={
                  <Link
                    to="/board/$environmentId/$projectId"
                    params={{ environmentId, projectId: card.projectId }}
                    search={{ card: card.id, focus: "agent" }}
                  />
                }
              >
                Assign an agent
              </ActionButton>
            );
          case "addCriteria":
            return props.onCard ? null : (
              <ActionButton
                key={action}
                render={
                  <Link
                    to="/board/$environmentId/$projectId"
                    params={{ environmentId, projectId: card.projectId }}
                    search={{ card: card.id }}
                  />
                }
              >
                Add criteria
              </ActionButton>
            );
        }
      })}
    </div>
  );
}

/** An access request: who needs which domains, as chips, and the agent's reason. */
export function AccessRequestDetails(props: {
  readonly item: CardAttention;
  readonly agentName?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="flex flex-wrap items-center gap-1.5 text-[13px]">
        <span>
          {props.agentName === undefined ? "Its agent" : `@${props.agentName}`} needs access to
        </span>
        {(props.item.domains ?? []).map((domain) => (
          <code
            key={domain}
            className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-foreground"
          >
            {domain}
          </code>
        ))}
      </p>
      <p className="line-clamp-4 whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
        {props.item.text}
      </p>
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
      <ActionButton tone="primary" onClick={() => setOpen(true)}>
        Add hidden scenario
      </ActionButton>
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
    <div className="flex flex-col gap-2 text-xs">
      <p className="text-[13px] text-muted-foreground">
        These refs changed outside this card during an agent turn. If the agent did this, restore
        them; if you did, keep them. Then resume the card.
      </p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <ul className="grid w-max max-w-full grid-cols-[auto_auto_auto_12px_auto] items-center gap-x-2.5 gap-y-1.5 rounded-lg bg-muted px-3.5 py-2.5 tabular-nums">
          {refs.map((change) => (
            <li key={change.ref} className="contents">
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
              <span className="min-w-0 truncate font-semibold">
                {change.ref}
                <span className="ms-1.5 font-normal text-tertiary-label">{change.kind}</span>
              </span>
              <span className="font-mono text-tertiary-label">{shortId(change.before)}</span>
              <span aria-label="to" className="text-muted-foreground/75">
                →
              </span>
              <span className="font-mono">{shortId(change.after)}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <ActionButton
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
          </ActionButton>
          <ActionButton
            tone="primary"
            disabled={sending || chosen.size === 0}
            onClick={() => setConfirming(true)}
          >
            {everyRef ? "Restore…" : `Restore ${chosen.size} of ${refs.length}…`}
          </ActionButton>
        </div>
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
