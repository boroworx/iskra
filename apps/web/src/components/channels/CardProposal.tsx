import type { PillTone } from "@iskra/client-runtime/card-face";
import { metricsLine, templateMetrics } from "@iskra/client-runtime/metrics";
import { AgentId, type EnvironmentId, type OrchestrationCardShell } from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";

import { cardEnvironment } from "~/state/cards";
import { useEnvironmentAgents, useEnvironmentCards } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { CardPreviewPanel, CriteriaEditor, savedCriteria } from "../cards/CardContract";
import { DisabledReason } from "../cards/DisabledReason";
import { toastCommandFailure } from "../toastCommandFailure";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { StatusPill } from "../iskra/StatusPill";
import { cardProposalStatus, ownerCandidates, type AgentEntry } from "./channels.logic";

const NO_OWNER = "none";

type ProposalFace = Pick<
  OrchestrationCardShell,
  | "id"
  | "kind"
  | "projectId"
  | "title"
  | "spec"
  | "status"
  | "delegateAgentId"
  | "suggestedAgentId"
  | "acceptance"
  | "estimate"
  | "premise"
>;

/**
 * A lead's proposed card under its reply in the channel. Until it has an owner it offers
 * Approve & start, Edit on the board and Drop; after that it shows where the card stands.
 */
export function CardProposal(props: {
  readonly card: ProposalFace;
  readonly agents: ReadonlyArray<AgentEntry>;
  readonly environmentId: EnvironmentId;
}) {
  const { card, environmentId } = props;
  const decide = useAtomCommand(cardEnvironment.decide);
  const status = cardProposalStatus(card, props.agents);
  // The spec stays on the card: Edit (or Open card once started) shows it in the card sheet.
  const boardLink = {
    to: "/board/$environmentId/$projectId",
    params: { environmentId, projectId: card.projectId },
    search: { card: card.id },
  } as const;

  return (
    <section
      aria-label={`Proposed card: ${card.title}`}
      className="mt-2 flex min-w-0 max-w-[520px] flex-col gap-3.5 rounded-[14px] bg-card p-4 shadow-[0_0_0_0.5px_rgb(0_0_0/8%),0_4px_16px_rgb(0_0_0/8%)] dark:shadow-[0_0_0_0.5px_rgb(255_255_255/7%),0_4px_16px_rgb(0_0_0/24%)]"
    >
      <div className="flex min-w-0 items-center gap-2">
        {status === null ? <StatusPill label="Proposed" tone="orange" /> : null}
        {card.estimate !== null ? (
          <span
            role="img"
            aria-label={`Size ${card.estimate.size}`}
            className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-secondary px-1.5 text-[11px] font-semibold text-muted-foreground"
          >
            {card.estimate.size}
          </span>
        ) : null}
      </div>
      <h3 className="-mt-1 text-[17px] font-semibold leading-snug tracking-[-0.01em] break-words">
        {card.title}
      </h3>
      {card.acceptance.criteria.length > 0 ? (
        <ul aria-label="Acceptance criteria" className="flex flex-col gap-2.5">
          {card.acceptance.criteria.map((criterion) => (
            <li key={criterion.id} className="flex items-start gap-2.5 text-[13px] leading-[18px]">
              <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" className="shrink-0">
                <circle
                  cx="12"
                  cy="12"
                  r="9.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  className="text-muted-foreground/50"
                />
              </svg>
              <span className="min-w-0 break-words">{criterion.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {card.estimate?.split != null ? (
        <p className="text-xs text-muted-foreground">
          The lead suggests splitting it: {card.estimate.split.reason}
        </p>
      ) : null}
      {status === null ? (
        <div className="flex flex-wrap items-center justify-end gap-2 pt-0.5">
          <Button
            size="sm"
            variant="ghost-muted"
            className={PROPOSAL_BUTTON}
            onClick={() =>
              void decide({ environmentId, input: { type: "card.abandon", cardId: card.id } }).then(
                (result) =>
                  toastCommandFailure(
                    result,
                    "The card was not dropped",
                    "The request was refused.",
                  ),
              )
            }
          >
            Drop
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className={PROPOSAL_BUTTON}
            render={<Link {...boardLink} />}
          >
            Edit
          </Button>
          <ApproveAndStart
            card={card}
            agents={props.agents}
            environmentId={environmentId}
            className={PROPOSAL_BUTTON}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-3 pt-0.5">
          <StatusPill label={status} tone={PROPOSAL_STATUS_TONE[card.status]} />
          <Link
            {...boardLink}
            className="text-[13px] font-medium text-info-foreground hover:underline"
          >
            Open card
          </Link>
        </div>
      )}
    </section>
  );
}

const PROPOSAL_BUTTON = "h-[30px] rounded-lg px-3.5 text-[13px] font-medium sm:h-[30px]";

const PROPOSAL_STATUS_TONE: Record<ProposalFace["status"], PillTone> = {
  triage: "orange",
  ready: "blue",
  inProgress: "blue",
  inReview: "orange",
  landing: "blue",
  landed: "green",
  abandoned: "gray",
};

type StartableCard = Pick<
  OrchestrationCardShell,
  "id" | "kind" | "title" | "suggestedAgentId" | "acceptance" | "estimate" | "premise"
>;

/**
 * Approve & start: opens a confirmation of who owns the card, the acceptance criteria it is held
 * to, and what starting it likely costs. Confirming approves the card with those criteria and the
 * chosen owner, whose session then starts. The owner defaults to the lead's suggestion.
 */
export function ApproveAndStart(props: {
  readonly card: StartableCard;
  readonly agents: ReadonlyArray<AgentEntry>;
  readonly environmentId: EnvironmentId;
  readonly className?: string;
}) {
  const { className, ...dialogProps } = props;
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" className={className} onClick={() => setOpen(true)}>
        Approve &amp; Start
      </Button>
      {open ? <ApproveAndStartDialog {...dialogProps} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ApproveAndStartDialog(props: {
  readonly card: StartableCard;
  readonly agents: ReadonlyArray<AgentEntry>;
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const { card } = props;
  const approveAndStart = useAtomCommand(cardEnvironment.approveAndStart);
  const agentShells = useEnvironmentAgents(props.environmentId);
  const suggested = props.agents.find((agent) => agent.id === card.suggestedAgentId)?.id ?? null;
  const [ownerId, setOwnerId] = useState<AgentId | null>(suggested);
  const owners = useMemo(() => {
    const allowed = new Set(
      ownerCandidates(
        agentShells.filter((agent) => props.agents.some((entry) => entry.id === agent.id)),
        card.kind,
        ownerId,
      ).map((agent) => agent.id),
    );
    return props.agents.filter((agent) => allowed.has(agent.id));
  }, [agentShells, props.agents, card.kind, ownerId]);
  const [criteria, setCriteria] = useState(card.acceptance.criteria);
  const [starting, setStarting] = useState(false);
  const formId = useId();
  const confirmed = savedCriteria(criteria);
  const owner = agentShells.find((agent) => agent.id === ownerId) ?? null;
  const cards = useEnvironmentCards(props.environmentId);
  const [openedAt] = useState(() => Date.now());
  const ownerMetrics = useMemo(
    () =>
      owner === null
        ? undefined
        : templateMetrics(
            cards.filter((entry) => entry.projectId === owner.projectId),
            openedAt,
          ).get(owner.id),
    [cards, owner, openedAt],
  );
  const blocked =
    ownerId === null
      ? "Choose an owner first."
      : confirmed.length === 0
        ? "Add at least one acceptance criterion."
        : null;

  const start = async () => {
    if (ownerId === null || blocked !== null || starting) return;
    setStarting(true);
    const result = await approveAndStart({
      environmentId: props.environmentId,
      input: { cardId: card.id, delegateAgentId: ownerId, criteria: confirmed },
    });
    setStarting(false);
    toastCommandFailure(result, "The card was not started", "The request was refused.");
    if (result._tag === "Success") props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Approve &amp; Start</DialogTitle>
          <DialogDescription>
            {card.title}. Starting confirms these criteria; checks and review hold the work to them.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            {card.premise?.pushback != null ? (
              <p className="text-xs text-muted-foreground">
                The lead's pushback: {card.premise.pushback}
              </p>
            ) : null}
            <section className="flex flex-col gap-1.5" aria-label="Owner">
              <h3 className="text-xs font-medium text-muted-foreground">Owner</h3>
              <Select
                value={ownerId ?? NO_OWNER}
                onValueChange={(value) =>
                  setOwnerId(value === null || value === NO_OWNER ? null : AgentId.make(value))
                }
              >
                <SelectTrigger aria-label="Owner" className="w-48">
                  <SelectValue>
                    {(value: string | null) => {
                      const agent = props.agents.find((candidate) => candidate.id === value);
                      return agent === undefined ? "Choose an owner" : `@${agent.name}`;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {owners.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      @{agent.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </section>
            <section className="flex flex-col gap-1.5" aria-label="Acceptance criteria">
              <h3 className="text-xs font-medium text-muted-foreground">Acceptance criteria</h3>
              <CriteriaEditor criteria={criteria} onChange={setCriteria} />
            </section>
            <section className="flex flex-col gap-1.5" aria-label="Preview">
              <h3 className="text-xs font-medium text-muted-foreground">Before it starts</h3>
              <CardPreviewPanel
                estimate={card.estimate}
                agent={owner}
                hint={owner === null ? null : metricsLine(owner.name, ownerMetrics)}
              />
            </section>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <DisabledReason reason={blocked}>
            <Button type="submit" form={formId} disabled={blocked !== null || starting}>
              Confirm and start
            </Button>
          </DisabledReason>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
