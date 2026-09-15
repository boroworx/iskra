import {
  cardWaitItems,
  cardOwnerSessions,
  isCardSnoozed,
  needsYouItems,
  needsYouLabel,
  waitingLabel,
} from "@iskra/client-runtime/cards";
import type { AtomCommandResult } from "@iskra/client-runtime/state/runtime";
import { DEFAULT_CARD_BUDGET_USD, type CardId, type EnvironmentId } from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { cardEnvironment } from "~/state/cards";
import { useEnvironmentAgents, useEnvironmentCards, useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { ApproveAndStart } from "../channels/CardProposal";
import { AttentionActions, RefsChangedControls } from "./CardAttention";
import { CardQuestion } from "./CardContract";
import { CheckpointControls } from "./CardReviewPanel";
import { agentListEntries, type AgentEntry } from "../channels/channels.logic";
import { SparkGlyph } from "../iskra/SparkGlyph";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { toastCommandFailure } from "../toastCommandFailure";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const HOUR_MS = 60 * 60_000;
const NO_AGENTS: ReadonlyArray<AgentEntry> = [];

const refused = (title: string) => (result: AtomCommandResult<unknown, unknown>) =>
  toastCommandFailure(result, title, "The request was refused.");

/**
 * Everything across projects waiting on a person, longest waiting first, with
 * how long each has waited. Snoozed cards come back at their time or on their
 * next activity, and can be woken early.
 */
export function NeedsYouView() {
  const environmentId = usePrimaryEnvironmentId();
  const cards = useEnvironmentCards(environmentId);
  const agents = useEnvironmentAgents(environmentId);
  const projects = useProjects();
  const snooze = useAtomCommand(cardEnvironment.snooze);
  const unsnooze = useAtomCommand(cardEnvironment.unsnooze);
  const decide = useAtomCommand(cardEnvironment.decide);
  const setBudget = useAtomCommand(cardEnvironment.setBudget);
  // Waiting times read in minutes, so a minute's tick keeps them honest without animating.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [projects, environmentId],
  );
  const items = useMemo(
    () =>
      needsYouItems({
        cards,
        sessions: cardOwnerSessions(cards),
        projects: environmentProjects,
        now,
      }),
    [cards, environmentProjects, now],
  );
  // Cards waiting on Iskra itself, such as machine capacity: shown, not counted as waiting on you.
  const waits = useMemo(() => cardWaitItems(cards), [cards]);
  const orchestrationSettingsSearch = (projectId: string) => {
    const project = environmentProjects.find((entry) => entry.id === projectId);
    return project === undefined
      ? null
      : { project: deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings) };
  };
  const snoozed = useMemo(() => cards.filter((card) => isCardSnoozed(card, now)), [cards, now]);
  const cardById = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  // Who can own a proposal, per project, for Approve & start.
  const agentsByProject = useMemo(() => {
    const byProject = new Map<string, ReadonlyArray<AgentEntry>>();
    for (const agent of agents) {
      if (!byProject.has(agent.projectId)) {
        byProject.set(agent.projectId, agentListEntries(agents, agent.projectId));
      }
    }
    return byProject;
  }, [agents]);
  const proposalReasoningOf = (cardId: CardId) => cardById.get(cardId)?.proposalReasoning ?? null;
  const projectTitle = (projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? "";

  const snoozeCard = (id: CardId, snoozedUntil: string | null) => {
    if (environmentId !== null) {
      void snooze({ environmentId, input: { cardId: id, snoozedUntil } }).then(
        refused("The card was not snoozed"),
      );
    }
  };
  const decideOn = (
    cardId: CardId,
    type: Parameters<typeof decide>[0]["input"]["type"],
    failure: string,
  ) => {
    if (environmentId !== null) {
      void decide({ environmentId, input: { type, cardId } }).then(refused(failure));
    }
  };
  const actionButton = (label: string, onClick: () => void) => (
    <Button size="sm" variant="ghost-muted" onClick={onClick}>
      {label}
    </Button>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border">
          <h1 className="truncate text-[15px] font-semibold">Needs you</h1>
          {items.length > 0 ? (
            <span className="inline-flex h-5 items-center rounded-full bg-warning px-2 text-xs font-bold tabular-nums text-black/85">
              {items.length}
            </span>
          ) : null}
        </WorkspacePageHeader>
        <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing is waiting on you.</p>
          ) : (
            <ol className="flex flex-col gap-2.5">
              {items.map((item) => {
                const itemCard = cardById.get(item.cardId);
                // The question or attention item this answers, from the card shell.
                const question = itemCard?.openElicitations.find(
                  (open) => open.activityId === item.activityId,
                );
                const attention = itemCard?.attention.find(
                  (entry) => entry.activityId === item.activityId,
                );
                return (
                  <li
                    key={item.key}
                    className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-card px-4 py-3 shadow-[0_0_0_0.5px_var(--border)]"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center self-start rounded-full bg-warning/16">
                      <SparkGlyph state="needsYou" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <CardLink
                        environmentId={environmentId}
                        projectId={item.projectId}
                        cardId={item.cardId}
                      >
                        {item.title}
                      </CardLink>
                      <span className="truncate text-xs text-muted-foreground">
                        {needsYouLabel(item)} · {projectTitle(item.projectId)}
                      </span>
                      {item.reason !== null && item.kind !== "checkpoint" && item.activityId === null ? (
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                          Why: {item.reason}
                        </p>
                      ) : null}
                      {attention !== undefined ? (
                        <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs">
                          {attention.text}
                        </p>
                      ) : null}
                      {question !== undefined &&
                      question.kind !== "refsChanged" &&
                      environmentId !== null ? (
                        <div className="mt-1.5">
                          <CardQuestion
                            cardId={item.cardId}
                            question={question}
                            environmentId={environmentId}
                          />
                        </div>
                      ) : null}
                      {item.kind === "triage" && proposalReasoningOf(item.cardId) !== null ? (
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                          {proposalReasoningOf(item.cardId)}
                        </p>
                      ) : null}
                      {item.kind === "checkpoint" &&
                      environmentId !== null &&
                      itemCard !== undefined ? (
                        <div className="mt-1.5">
                          <CheckpointControls card={itemCard} environmentId={environmentId} />
                        </div>
                      ) : null}
                      {question?.kind === "refsChanged" && environmentId !== null ? (
                        <div className="mt-1.5">
                          <RefsChangedControls
                            cardId={item.cardId}
                            report={question}
                            environmentId={environmentId}
                          />
                        </div>
                      ) : null}
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      waiting {waitingLabel(item.since, now)}
                    </span>
                    {attention !== undefined && itemCard !== undefined && environmentId !== null ? (
                      <AttentionActions
                        card={itemCard}
                        item={attention}
                        environmentId={environmentId}
                      />
                    ) : null}
                    {(item.kind === "awaitingInput" || item.kind === "criteriaChange") &&
                    question === undefined &&
                    environmentId !== null ? (
                      // A session waiting with no question on the card is answered in its sheet.
                      <Button
                        size="sm"
                        variant="ghost-muted"
                        render={
                          <Link
                            to="/board/$environmentId/$projectId"
                            params={{ environmentId, projectId: item.projectId }}
                            search={{ card: item.cardId }}
                          />
                        }
                      >
                        Answer
                      </Button>
                    ) : null}
                    {item.kind === "triage" ? (
                      <div className="flex shrink-0 flex-wrap items-center gap-1">
                        {environmentId === null || itemCard === undefined ? null : (
                          <ApproveAndStart
                            card={itemCard}
                            agents={agentsByProject.get(item.projectId) ?? NO_AGENTS}
                            environmentId={environmentId}
                          />
                        )}
                        {actionButton("Drop", () =>
                          decideOn(item.cardId, "card.abandon", "The card was not dropped"),
                        )}
                      </div>
                    ) : item.kind === "spec" ? (
                      <div className="flex shrink-0 gap-1">
                        {actionButton("Approve spec", () =>
                          decideOn(item.cardId, "card.spec.approve", "The spec was not approved"),
                        )}
                        {actionButton("Skip spec", () =>
                          decideOn(item.cardId, "card.spec.skip", "The spec was not skipped"),
                        )}
                      </div>
                    ) : item.kind === "budgetReached" ? (
                      actionButton(`Raise the cap by $${DEFAULT_CARD_BUDGET_USD}`, () => {
                        const capUsd =
                          (cardById.get(item.cardId)?.budgetCapUsd ?? 0) + DEFAULT_CARD_BUDGET_USD;
                        if (environmentId !== null) {
                          void setBudget({
                            environmentId,
                            input: { cardId: item.cardId, capUsd },
                          }).then(refused("The cap was not raised"));
                        }
                      })
                    ) : item.kind === "fixRoundsExhausted" ? (
                      actionButton("Give it more rounds", () =>
                        decideOn(
                          item.cardId,
                          "card.fix-rounds.reset",
                          "The fix rounds were not reset",
                        ),
                      )
                    ) : itemCard?.paused != null &&
                      (item.kind === "paused" || item.kind === "sessionFailed") ? (
                      actionButton("Resume", () =>
                        decideOn(item.cardId, "card.resume", "The card was not resumed"),
                      )
                    ) : (item.kind === "needsAgent" || item.kind === "criteria") &&
                      environmentId !== null ? (
                      <Button
                        size="sm"
                        variant="ghost-muted"
                        render={
                          <Link
                            to="/board/$environmentId/$projectId"
                            params={{ environmentId, projectId: item.projectId }}
                            search={{
                              card: item.cardId,
                              focus: item.kind === "needsAgent" ? "agent" : "criteria",
                            }}
                          />
                        }
                      >
                        {item.kind === "needsAgent" ? "Assign an agent" : "Open the criteria"}
                      </Button>
                    ) : item.kind === "delegateReadOnly" &&
                      environmentId !== null &&
                      itemCard?.delegateAgentId != null ? (
                      <Button
                        size="sm"
                        variant="ghost-muted"
                        render={
                          <Link
                            to="/agents/$environmentId/$agentId"
                            params={{ environmentId, agentId: itemCard.delegateAgentId }}
                          />
                        }
                      >
                        Open its agent
                      </Button>
                    ) : item.kind === "sideEffectGuard" ? (
                      <GuardLink search={orchestrationSettingsSearch(item.projectId)} />
                    ) : item.kind === "unpricedModel" ? (
                      // Refusing is the standing state here; the card sheet takes an acceptance back.
                      actionButton("Run uncapped", () =>
                        decideOn(
                          item.cardId,
                          "card.unpriced.accept",
                          "The card was not allowed to run uncapped",
                        ),
                      )
                    ) : null}
                    {item.snoozable ? (
                      <div className="flex shrink-0 gap-1">
                        {actionButton("1 hour", () =>
                          snoozeCard(item.cardId, new Date(now + HOUR_MS).toISOString()),
                        )}
                        {actionButton("Tomorrow", () =>
                          snoozeCard(item.cardId, new Date(now + 24 * HOUR_MS).toISOString()),
                        )}
                        {actionButton("Until it changes", () => snoozeCard(item.cardId, null))}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
          {waits.length > 0 ? (
            <section aria-label="Waiting on Iskra" className="mt-6">
              <h2 className="text-xs font-medium text-muted-foreground">
                Waiting on Iskra {waits.length}
              </h2>
              <ul className="mt-2 flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-card shadow-[0_0_0_0.5px_var(--border)]">
                {waits.map((wait) => (
                  <li
                    key={wait.cardId}
                    className="flex min-w-0 flex-wrap items-center gap-x-3 px-4 py-2.5"
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <CardLink
                        environmentId={environmentId}
                        projectId={wait.projectId}
                        cardId={wait.cardId}
                      >
                        {wait.title}
                      </CardLink>
                      <span className="truncate text-xs text-muted-foreground">
                        {wait.label === wait.reason ? wait.reason : `${wait.label}: ${wait.reason}`}
                      </span>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      waiting {waitingLabel(wait.since, now)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {snoozed.length > 0 ? (
            <section aria-label="Snoozed" className="mt-6">
              <h2 className="text-xs font-medium text-muted-foreground">
                Snoozed {snoozed.length}
              </h2>
              <ul className="mt-2 flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-card shadow-[0_0_0_0.5px_var(--border)]">
                {snoozed.map((card) => (
                  <li key={card.id} className="flex min-w-0 items-center gap-3 px-4 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                      {card.title}
                      {card.snoozedUntil === null
                        ? " · until it changes"
                        : ` · until ${new Date(card.snoozedUntil).toLocaleString()}`}
                    </span>
                    {actionButton("Wake", () => {
                      if (environmentId !== null) {
                        void unsnooze({ environmentId, input: { cardId: card.id } }).then(
                          refused("The card was not woken"),
                        );
                      }
                    })}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </main>
      </div>
    </SidebarInset>
  );
}

/** Where a project's side-effect guard is reviewed: its orchestration settings. */
function GuardLink(props: { readonly search: { readonly project: string } | null }) {
  if (props.search === null) return null;
  return (
    <Button
      size="sm"
      variant="ghost-muted"
      render={<Link to="/settings/projects" search={props.search} hash="project-orchestration" />}
    >
      Review the guard
    </Button>
  );
}

/** The card's title, opening its sheet on the board. */
function CardLink(props: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: string;
  readonly cardId: CardId;
  readonly children: string;
}) {
  if (props.environmentId === null) {
    return <span className="truncate text-sm font-medium">{props.children}</span>;
  }
  return (
    <Link
      to="/board/$environmentId/$projectId"
      params={{ environmentId: props.environmentId, projectId: props.projectId }}
      search={{ card: props.cardId }}
      className="truncate text-sm font-medium hover:underline"
    >
      {props.children}
    </Link>
  );
}
