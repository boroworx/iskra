import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@iskra/client-runtime/state/runtime";
import {
  CARD_ATTEMPTS_MAX,
  CARD_ATTEMPTS_MIN,
  CardId,
  type AgentId,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
} from "@iskra/contracts";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { cardEnvironment } from "~/state/cards";
import { useEnvironmentAgents, useEnvironmentCards } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

/**
 * Best-of-N on one card: pick two to four agents to try it at once, then compare
 * their diffs side by side and promote the one that should become the card's work.
 */
export function AttemptsView(props: {
  readonly environmentId: EnvironmentId;
  readonly cardId: CardId;
}) {
  const cards = useEnvironmentCards(props.environmentId);
  const agents = useEnvironmentAgents(props.environmentId);
  const card = cards.find((entry) => entry.id === props.cardId) ?? null;
  const attempts = cards.filter(
    (entry) => entry.parentCardId === props.cardId && entry.attemptGroupId !== null,
  );
  const running = attempts.filter((entry) => entry.status !== "abandoned");

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border">
          <h1 className="truncate text-sm font-semibold">
            {card === null ? "Attempts" : `${card.title}: attempts`}
          </h1>
          {card !== null ? (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              ${card.spentUsd.toFixed(2)} of ${card.budgetCapUsd.toFixed(0)} spent
            </span>
          ) : null}
        </WorkspacePageHeader>
        {card === null ? null : running.length === 0 ? (
          <StartAttempts
            environmentId={props.environmentId}
            card={card}
            agents={agents.filter((agent) => agent.projectId === card.projectId)}
          />
        ) : (
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 py-4">
            {running.map((attempt) => (
              <AttemptColumn
                key={attempt.id}
                environmentId={props.environmentId}
                attempt={attempt}
                agent={agents.find((agent) => agent.id === attempt.delegateAgentId)}
              />
            ))}
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

function StartAttempts(props: {
  readonly environmentId: EnvironmentId;
  readonly card: OrchestrationCardShell;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
}) {
  const [chosen, setChosen] = useState<ReadonlyArray<AgentId>>([]);
  const [starting, setStarting] = useState(false);
  const start = useAtomCommand(cardEnvironment.startAttempts);
  const ready = props.card.status === "ready";
  const countOk = chosen.length >= CARD_ATTEMPTS_MIN && chosen.length <= CARD_ATTEMPTS_MAX;

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
      <p className="text-sm text-muted-foreground">
        {ready
          ? `Pick ${CARD_ATTEMPTS_MIN} to ${CARD_ATTEMPTS_MAX} agents to try this card at once, each on its own branch.`
          : "Attempts start on a ready card, before its work begins."}
      </p>
      <ul className="flex flex-col gap-1">
        {props.agents.map((agent) => (
          <li key={agent.id}>
            <label className="flex h-8 items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={!ready}
                checked={chosen.includes(agent.id)}
                onChange={(event) =>
                  setChosen((current) =>
                    event.target.checked
                      ? [...current, agent.id]
                      : current.filter((id) => id !== agent.id),
                  )
                }
              />
              @{agent.name}
            </label>
          </li>
        ))}
      </ul>
      <Button
        className="self-start"
        size="sm"
        disabled={!ready || !countOk || starting}
        onClick={async () => {
          setStarting(true);
          const result = await start({
            environmentId: props.environmentId,
            input: {
              cardId: props.card.id,
              attempts: chosen.map((agentId) => ({ cardId: CardId.make(randomUUID()), agentId })),
            },
          });
          setStarting(false);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: "The attempts did not start",
              description: error instanceof Error ? error.message : "The request was refused.",
            });
          }
        }}
      >
        Start {chosen.length > 0 ? chosen.length : ""} attempts
      </Button>
    </main>
  );
}

function AttemptColumn(props: {
  readonly environmentId: EnvironmentId;
  readonly attempt: OrchestrationCardShell;
  readonly agent: OrchestrationAgentShell | undefined;
}) {
  const diff = useEnvironmentQuery(
    cardEnvironment.diff({
      environmentId: props.environmentId,
      input: { cardId: props.attempt.id },
    }),
  );
  const promote = useAtomCommand(cardEnvironment.decide);
  const { attempt } = props;
  const canPromote = attempt.worktreePath !== null;

  return (
    <section
      aria-label={attempt.title}
      className="flex w-[32rem] max-w-full shrink-0 flex-col gap-2 rounded-lg border border-border p-3"
    >
      <header className="flex min-w-0 items-center gap-2 text-sm">
        <span className="truncate font-medium">
          {props.agent === undefined ? attempt.title : `@${props.agent.name}`}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {attempt.ownerSession?.state ?? "not started"}
        </span>
        {attempt.diffStat !== null ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            +{attempt.diffStat.additions} −{attempt.diffStat.deletions}
          </span>
        ) : null}
        <Button className="ml-auto" size="sm" variant="ghost-muted" onClick={() => diff.refresh()}>
          Refresh
        </Button>
        <Button
          size="sm"
          disabled={!canPromote}
          onClick={async () => {
            const result = await promote({
              environmentId: props.environmentId,
              input: { type: "card.attempt.promote", cardId: attempt.id },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add({
                type: "error",
                title: "The attempt was not promoted",
                description: error instanceof Error ? error.message : "The request was refused.",
              });
            }
          }}
        >
          Promote
        </Button>
      </header>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre rounded-md bg-muted/40 p-2 font-mono text-xs">
        {diff.error ??
          (diff.data === null
            ? "Loading the diff…"
            : diff.data.diff.length === 0
              ? `No changes against ${diff.data.baseBranch} yet.`
              : `${diff.data.diff}${diff.data.truncated ? "\n… the diff was cut short." : ""}`)}
      </pre>
    </section>
  );
}
