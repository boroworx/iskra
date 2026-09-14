import { AgentId, type EnvironmentId, type OrchestrationCardShell } from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { cardEnvironment } from "~/state/cards";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastCommandFailure } from "../toastCommandFailure";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { cardProposalStatus, type AgentEntry } from "./channels.logic";

const SPEC_PREVIEW_LINES = 4;
const NO_OWNER = "none";

type ProposalFace = Pick<
  OrchestrationCardShell,
  "id" | "projectId" | "title" | "spec" | "status" | "delegateAgentId" | "suggestedAgentId"
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
        <span className="text-xs text-muted-foreground">Proposed card</span>
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
                  toastCommandFailure(result, "The card was not dropped", "The request was refused."),
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

/**
 * Approve & start: approves the card with the chosen owner, whose session then starts. The owner
 * defaults to the lead's suggestion.
 */
export function ApproveAndStart(props: {
  readonly card: Pick<OrchestrationCardShell, "id" | "suggestedAgentId">;
  readonly agents: ReadonlyArray<AgentEntry>;
  readonly environmentId: EnvironmentId;
}) {
  const approveAndStart = useAtomCommand(cardEnvironment.approveAndStart);
  const suggested =
    props.agents.find((agent) => agent.id === props.card.suggestedAgentId)?.id ?? null;
  const [ownerId, setOwnerId] = useState<AgentId | null>(suggested);
  const [starting, setStarting] = useState(false);
  const ownerName = (value: string | null) => {
    const agent = props.agents.find((candidate) => candidate.id === value);
    return agent === undefined ? "Choose an owner" : `@${agent.name}`;
  };

  const start = async () => {
    if (ownerId === null) {
      return;
    }
    setStarting(true);
    const result = await approveAndStart({
      environmentId: props.environmentId,
      input: { cardId: props.card.id, delegateAgentId: ownerId },
    });
    setStarting(false);
    toastCommandFailure(result, "The card was not started", "The request was refused.");
  };

  return (
    <>
      <Select
        value={ownerId ?? NO_OWNER}
        onValueChange={(value) =>
          setOwnerId(value === null || value === NO_OWNER ? null : AgentId.make(value))
        }
      >
        <SelectTrigger aria-label="Owner" className="w-40">
          <SelectValue>{ownerName}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {props.agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              @{agent.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Button size="sm" disabled={ownerId === null || starting} onClick={() => void start()}>
        Approve &amp; start
      </Button>
    </>
  );
}
