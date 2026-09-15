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
import { cardProposalStatus, ownerCandidates, type AgentEntry } from "./channels.logic";

const SPEC_PREVIEW_LINES = 4;
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
  const [expanded, setExpanded] = useState(false);
  const status = cardProposalStatus(card, props.agents);
  const spec = card.spec.trim();
  const specLines = spec.split("\n");
  const long = specLines.length > SPEC_PREVIEW_LINES;
  const boardLink = {
    to: "/board/$environmentId/$projectId",
    params: { environmentId, projectId: card.projectId },
    search: { card: card.id },
  } as const;

  return (
    <section
      aria-label={`Proposed card: ${card.title}`}
      className="mt-2 flex min-w-0 max-w-xl flex-col gap-2 rounded-lg border border-border px-3 py-2.5"
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-xs text-muted-foreground">
          Proposed card{card.estimate !== null ? ` · size ${card.estimate.size}` : ""}
        </span>
        <span className="truncate text-sm font-medium">{card.title}</span>
      </div>
      {spec.length > 0 ? (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {expanded || !long ? spec : specLines.slice(0, SPEC_PREVIEW_LINES).join("\n")}
        </p>
      ) : null}
      {long ? (
        <Button
          className="-ml-2 self-start"
          size="sm"
          variant="ghost-muted"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : `Show all ${specLines.length} lines`}
        </Button>
      ) : null}
      {card.acceptance.criteria.length > 0 ? (
        <ul className="list-inside list-disc text-sm">
          {card.acceptance.criteria.map((criterion) => (
            <li key={criterion.id}>{criterion.text}</li>
          ))}
        </ul>
      ) : null}
      {card.estimate?.split != null ? (
        <p className="text-xs text-muted-foreground">
          The lead suggests splitting it: {card.estimate.split.reason}
        </p>
      ) : null}
      {status === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <ApproveAndStart card={card} agents={props.agents} environmentId={environmentId} />
          <Button size="sm" variant="outline" render={<Link {...boardLink} />}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost-muted"
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
        </div>
      ) : (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{status}</span>
          <Link {...boardLink} className="hover:underline">
            Open card
          </Link>
        </p>
      )}
    </section>
  );
}

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
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Approve &amp; start
      </Button>
      {open ? <ApproveAndStartDialog {...props} onClose={() => setOpen(false)} /> : null}
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
          <DialogTitle>Approve &amp; start</DialogTitle>
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
