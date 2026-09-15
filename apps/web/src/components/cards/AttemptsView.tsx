import { CARD_SESSION_LABEL } from "@iskra/client-runtime/cards";
import {
  CARD_ATTEMPTS_MAX,
  CARD_ATTEMPTS_MIN,
  CardId,
  type AgentId,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
} from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { cardEnvironment } from "~/state/cards";
import { useEnvironmentAgents, useEnvironmentCards } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { AgentAvatar } from "../iskra/AgentAvatar";
import { SpendBar } from "../iskra/Marks";
import { StatusPill } from "../iskra/StatusPill";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { SidebarInset } from "../ui/sidebar";
import { toastCommandFailure } from "../toastCommandFailure";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { EmptyState } from "../iskra/Page";
import { cardShortId } from "../iskra/cardLabel";
import { ActionButton, Group, ROW_CLASS, RowLink, Section } from "./cardChrome";
import { DisabledReason } from "./DisabledReason";

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
  const projectAgents =
    card === null ? [] : agents.filter((agent) => agent.projectId === card.projectId);
  // The picker's choice lives here so its one primary, Start, can sit in the toolbar.
  const [chosen, setChosen] = useState<ReadonlyArray<AgentId>>([]);
  const [starting, setStarting] = useState(false);
  const start = useAtomCommand(cardEnvironment.startAttempts);
  const ready = card?.status === "ready";
  const countOk = chosen.length >= CARD_ATTEMPTS_MIN && chosen.length <= CARD_ATTEMPTS_MAX;
  const picking = card !== null && running.length === 0;
  const cardLink =
    card === null ? undefined : (
      <Link
        to="/board/$environmentId/$projectId"
        params={{ environmentId: props.environmentId, projectId: card.projectId }}
        search={{ card: card.id }}
      />
    );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader>
          {cardLink !== undefined ? (
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Back to the card"
              render={cardLink}
            >
              <ChevronLeftIcon />
            </Button>
          ) : null}
          <h1 className="truncate text-[15px] font-semibold">Attempts</h1>
          {card !== null ? (
            <span className="shrink-0 text-xs font-medium tabular-nums text-tertiary-label">
              {cardShortId(card)}
            </span>
          ) : null}
          {picking && ready && projectAgents.length > 0 ? (
            <DisabledReason
              className="ms-auto"
              reason={countOk ? null : `Pick ${CARD_ATTEMPTS_MIN} to ${CARD_ATTEMPTS_MAX} agents.`}
            >
              <ActionButton
                tone="primary"
                className="ms-auto"
                disabled={!countOk || starting}
                onClick={async () => {
                  setStarting(true);
                  const result = await start({
                    environmentId: props.environmentId,
                    input: {
                      cardId: card.id,
                      attempts: chosen.map((agentId) => ({
                        cardId: CardId.make(randomUUID()),
                        agentId,
                      })),
                    },
                  });
                  setStarting(false);
                  toastCommandFailure(
                    result,
                    "The attempts did not start",
                    "The request was refused.",
                  );
                }}
              >
                Start {chosen.length > 0 ? chosen.length : ""} attempts
              </ActionButton>
            </DisabledReason>
          ) : null}
        </WorkspacePageHeader>
        {card !== null ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-[22px] gap-y-1 px-5 pt-5 text-[13px] text-muted-foreground">
            <Link
              to="/board/$environmentId/$projectId"
              params={{ environmentId: props.environmentId, projectId: card.projectId }}
              search={{ card: card.id }}
              className="min-w-0 truncate hover:text-foreground hover:underline"
            >
              {card.title}
            </Link>
            <span className="inline-flex items-center gap-2">
              <SpendBar spentUsd={card.spentUsd} capUsd={card.budgetCapUsd} className="w-22" />
              <span className="tabular-nums">
                ${card.spentUsd.toFixed(2)} of ${card.budgetCapUsd.toFixed(0)} spent
              </span>
            </span>
          </div>
        ) : null}
        {card === null ? null : !picking ? (
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 pt-5 pb-6">
            {running.map((attempt) => (
              <AttemptColumn
                key={attempt.id}
                environmentId={props.environmentId}
                attempt={attempt}
                agent={agents.find((agent) => agent.id === attempt.delegateAgentId)}
              />
            ))}
          </div>
        ) : !ready ? (
          <EmptyState
            title="No attempts yet"
            body="Attempts start on a ready card, before its work begins. Approve it on the board first."
            actions={<ActionButton render={cardLink}>Back to the card</ActionButton>}
          />
        ) : projectAgents.length === 0 ? (
          <EmptyState
            title="No agents to try it"
            body="Add agents to this project, then pick two to four of them here."
            actions={<ActionButton render={cardLink}>Back to the card</ActionButton>}
          />
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto px-5 pt-7 pb-10">
            <div className="flex max-w-[720px] flex-col">
              <Section label="Agents">
                <p className="px-4 text-xs text-muted-foreground">
                  Pick {CARD_ATTEMPTS_MIN} to {CARD_ATTEMPTS_MAX} to try this card at once, each on
                  its own branch.
                </p>
                <Group>
                  {projectAgents.map((agent) => (
                    <label key={agent.id} className={`${ROW_CLASS} cursor-pointer`}>
                      <Checkbox
                        checked={chosen.includes(agent.id)}
                        onCheckedChange={(checked) =>
                          setChosen((current) =>
                            checked
                              ? [...current, agent.id]
                              : current.filter((id) => id !== agent.id),
                          )
                        }
                      />
                      <AgentAvatar name={agent.name} />@{agent.name}
                    </label>
                  ))}
                </Group>
              </Section>
            </div>
          </main>
        )}
      </div>
    </SidebarInset>
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
  const session = attempt.ownerSession?.state;

  return (
    <section
      aria-label={attempt.title}
      className="flex w-[32rem] max-w-full shrink-0 flex-col overflow-hidden rounded-[14px] bg-card shadow-[0_0_0_0.5px_var(--border)]"
    >
      <header className="flex min-w-0 items-center gap-2.5 px-4 py-3 text-[13px] shadow-[inset_0_-0.5px_var(--border)]">
        {props.agent !== undefined ? <AgentAvatar name={props.agent.name} size="md" /> : null}
        <span className="truncate text-[15px] font-semibold">
          {props.agent === undefined ? attempt.title : `@${props.agent.name}`}
        </span>
        <StatusPill
          label={session === undefined ? "Not started" : CARD_SESSION_LABEL[session]}
          tone={
            session === "active" || session === "pending"
              ? "blue"
              : session === "error"
                ? "red"
                : session === "awaitingInput"
                  ? "orange"
                  : "gray"
          }
        />
        {attempt.diffStat !== null ? (
          <span className="shrink-0 text-xs tabular-nums text-tertiary-label">
            +{attempt.diffStat.additions} −{attempt.diffStat.deletions}
          </span>
        ) : null}
        <RowLink className="ms-auto text-xs" onClick={() => diff.refresh()}>
          Refresh
        </RowLink>
        <DisabledReason
          reason={
            canPromote ? null : "Its session has not made its branch yet; promote it once it has."
          }
        >
          <ActionButton
            tone="primary"
            disabled={!canPromote}
            onClick={async () => {
              const result = await promote({
                environmentId: props.environmentId,
                input: { type: "card.attempt.promote", cardId: attempt.id },
              });
              toastCommandFailure(
                result,
                "The attempt was not promoted",
                "The request was refused.",
              );
            }}
          >
            Promote
          </ActionButton>
        </DisabledReason>
      </header>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-xs">
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
