import { criteriaMarks } from "@iskra/client-runtime/card-face";
import {
  cardWaitItems,
  cardOwnerSessions,
  isCardSnoozed,
  needsYouItems,
  needsYouLabel,
  waitingLabel,
  type NeedsYouKind,
} from "@iskra/client-runtime/cards";
import type { AtomCommandResult } from "@iskra/client-runtime/state/runtime";
import {
  DEFAULT_CARD_BUDGET_USD,
  type CardId,
  type EnvironmentId,
  type ProjectId,
} from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import {
  BellOffIcon,
  CircleAlertIcon,
  CircleDollarSignIcon,
  ClockIcon,
  EllipsisIcon,
  FlagIcon,
  GitBranchIcon,
  LightbulbIcon,
  ListChecksIcon,
  LockIcon,
  PauseIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  SquarePlusIcon,
  UserPlusIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { cn } from "~/lib/utils";
import { cardEnvironment } from "~/state/cards";
import { channelEnvironment } from "~/state/channels";
import { useUndoToast } from "./useUndoToast";
import { useEnvironmentAgents, useEnvironmentCards, useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { ApproveAndStart } from "../channels/CardProposal";
import { AttentionActions, RefsChangedControls } from "./CardAttention";
import { CardQuestion } from "./CardContract";
import { CheckpointControls } from "./CardReviewPanel";
import { agentListEntries, type AgentEntry } from "../channels/channels.logic";
import { AgentAvatar } from "../iskra/AgentAvatar";
import { CriteriaMarks } from "../iskra/Marks";
import { SparkGlyph } from "../iskra/SparkGlyph";
import { StatusPill } from "../iskra/StatusPill";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { toastCommandFailure } from "../toastCommandFailure";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { EmptyState, PageColumn, PageLargeTitle } from "../iskra/Page";
import { cardShortId } from "../iskra/cardLabel";
import { ActionButton } from "./cardChrome";
import { DisabledReason } from "./DisabledReason";

const HOUR_MS = 60 * 60_000;
const NO_AGENTS: ReadonlyArray<AgentEntry> = [];

const refused = (title: string) => (result: AtomCommandResult<unknown, unknown>) =>
  toastCommandFailure(result, title, "The request was refused.");

/** Each kind's mark in its tinted circle; questions, checkpoints and attention keep the spark. */
const KIND_ICON: Partial<Record<NeedsYouKind, LucideIcon>> = {
  triage: SquarePlusIcon,
  spec: ListChecksIcon,
  criteria: ListChecksIcon,
  criteriaChange: ListChecksIcon,
  readyToMerge: ListChecksIcon,
  scopeFlags: ListChecksIcon,
  evidenceMissing: ListChecksIcon,
  planApproval: ListChecksIcon,
  needsAgent: UserPlusIcon,
  delegateReadOnly: LockIcon,
  refsChanged: GitBranchIcon,
  revertConflict: GitBranchIcon,
  sessionFailed: CircleAlertIcon,
  paused: PauseIcon,
  fixRoundsExhausted: RotateCcwIcon,
  sideEffectGuard: ShieldAlertIcon,
  budgetReached: CircleDollarSignIcon,
  budgetCap: CircleDollarSignIcon,
  unpricedModel: CircleDollarSignIcon,
  lessonProposed: LightbulbIcon,
  outcomeFlawed: FlagIcon,
};

/** Kinds whose buttons already say what is asked, so the label line would only repeat them. */
const SELF_EVIDENT: ReadonlySet<NeedsYouKind> = new Set(["triage", "readyToMerge", "refsChanged"]);

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
  const approveLesson = useAtomCommand(channelEnvironment.approveLesson);
  const dismissLesson = useAtomCommand(channelEnvironment.dismissLesson);
  const undoToast = useUndoToast();
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
  // One section per project, in the order of each project's most pressing item.
  const itemGroups = useMemo(() => {
    const groups = new Map<string, Array<(typeof items)[number]>>();
    for (const item of items) {
      const group = groups.get(item.projectId);
      if (group) group.push(item);
      else groups.set(item.projectId, [item]);
    }
    return [...groups];
  }, [items]);
  const orchestrationSettingsSearch = (projectId: string) => {
    const project = environmentProjects.find((entry) => entry.id === projectId);
    return project === undefined
      ? null
      : { project: deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings) };
  };
  const snoozed = useMemo(() => cards.filter((card) => isCardSnoozed(card, now)), [cards, now]);
  const cardById = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const agentNameById = useMemo(
    () => new Map(agents.map((agent) => [agent.id as string, agent.name])),
    [agents],
  );
  // Who can own a proposal, per project, for Approve & Start.
  const agentsByProject = useMemo(() => {
    const byProject = new Map<string, ReadonlyArray<AgentEntry>>();
    for (const agent of agents) {
      if (!byProject.has(agent.projectId)) {
        byProject.set(agent.projectId, agentListEntries(agents, agent.projectId));
      }
    }
    return byProject;
  }, [agents]);
  const projectTitle = (projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? "";

  const snoozeCard = (id: CardId, snoozedUntil: string | null) => {
    if (environmentId !== null) {
      void snooze({ environmentId, input: { cardId: id, snoozedUntil } }).then((result) => {
        refused("The card was not snoozed")(result);
        if (result._tag === "Success")
          undoToast(environmentId, { type: "card.snooze", cardId: id });
      });
    }
  };
  const decideLesson = (
    command: typeof approveLesson,
    projectId: ProjectId,
    lessonId: string,
    failure: string,
  ) => {
    if (environmentId !== null) {
      void command({ environmentId, input: { projectId, lessonId } }).then(refused(failure));
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
  const boardLink = (projectId: string, cardId: CardId, focus?: "agent" | "criteria") =>
    environmentId === null ? undefined : (
      <Link
        to="/board/$environmentId/$projectId"
        params={{ environmentId, projectId }}
        search={focus === undefined ? { card: cardId } : { card: cardId, focus }}
      />
    );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader />
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-10">
          <PageColumn width="wide">
            <PageLargeTitle
              accessory={
                items.length > 0 ? (
                  <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-warning px-[9px] text-[13px] font-bold tabular-nums text-[#1c1c1e]">
                    {items.length}
                  </span>
                ) : null
              }
            >
              Needs You
            </PageLargeTitle>
          </PageColumn>
          {items.length === 0 ? (
            <EmptyState
              title="Nothing needs you"
              body="Questions, reviews and stuck cards show up here."
              {...(waits.length + snoozed.length > 0 ? { className: "flex-none py-12" } : {})}
            />
          ) : null}
          <PageColumn width="wide" className="flex flex-col">
            {itemGroups.map(([projectId, groupItems]) => (
              <section
                key={projectId}
                aria-label={projectTitle(projectId) || "Other project"}
                className="mt-7 flex flex-col gap-2 first:mt-0"
              >
                <h2 className="px-4 text-[13px] font-semibold text-muted-foreground">
                  {projectTitle(projectId) || "Other project"}
                </h2>
                <ol className="flex flex-col gap-2.5">
                  {groupItems.map((item) => {
                    const itemCard = cardById.get(item.cardId);
                    // The question or attention item this answers, from the card shell.
                    const question = itemCard?.openElicitations.find(
                      (open) => open.activityId === item.activityId,
                    );
                    const attention = itemCard?.attention.find(
                      (entry) => entry.activityId === item.activityId,
                    );
                    const answersInPlace =
                      question !== undefined && question.kind !== "refsChanged";
                    const Icon = KIND_ICON[item.kind];
                    const why =
                      item.reason !== null &&
                      item.kind !== "lessonProposed" &&
                      item.kind !== "checkpoint" &&
                      item.kind !== "sliceCheckpoint" &&
                      item.activityId === null
                        ? item.reason
                        : item.kind === "triage"
                          ? (itemCard?.proposalReasoning ?? null)
                          : null;
                    const suggested =
                      item.kind === "triage" && itemCard !== undefined
                        ? agentNameById.get(
                            itemCard.suggestedAgentId ?? itemCard.delegateAgentId ?? "",
                          )
                        : undefined;
                    const marks =
                      itemCard !== undefined &&
                      (item.kind === "readyToMerge" ||
                        item.kind === "triage" ||
                        item.kind === "scopeFlags" ||
                        item.kind === "evidenceMissing")
                        ? criteriaMarks(itemCard)
                        : [];
                    const primary: ReactNode =
                      attention !== undefined &&
                      itemCard !== undefined &&
                      environmentId !== null ? (
                        <AttentionActions
                          card={itemCard}
                          item={attention}
                          environmentId={environmentId}
                        />
                      ) : (item.kind === "awaitingInput" || item.kind === "criteriaChange") &&
                        question === undefined ? (
                        // A session waiting with no question on the card is answered in its sheet.
                        <ActionButton
                          tone="primary"
                          render={boardLink(item.projectId, item.cardId)}
                        >
                          Answer
                        </ActionButton>
                      ) : item.kind === "triage" ? (
                        <>
                          <ActionButton
                            onClick={() =>
                              decideOn(item.cardId, "card.abandon", "The card was not dropped")
                            }
                          >
                            Drop
                          </ActionButton>
                          {environmentId === null || itemCard === undefined ? null : (
                            <ApproveAndStart
                              card={itemCard}
                              agents={agentsByProject.get(item.projectId) ?? NO_AGENTS}
                              environmentId={environmentId}
                              className="h-7 rounded-[7px] px-3.5 text-[13px] sm:h-7"
                            />
                          )}
                        </>
                      ) : item.kind === "spec" ? (
                        <>
                          <ActionButton
                            onClick={() =>
                              decideOn(item.cardId, "card.spec.skip", "The spec was not skipped")
                            }
                          >
                            Skip spec
                          </ActionButton>
                          <ActionButton
                            tone="primary"
                            onClick={() =>
                              decideOn(
                                item.cardId,
                                "card.spec.approve",
                                "The spec was not approved",
                              )
                            }
                          >
                            Approve spec
                          </ActionButton>
                        </>
                      ) : item.kind === "budgetReached" ? (
                        <ActionButton
                          tone="primary"
                          onClick={() => {
                            const capUsd = (itemCard?.budgetCapUsd ?? 0) + DEFAULT_CARD_BUDGET_USD;
                            if (environmentId !== null) {
                              void setBudget({
                                environmentId,
                                input: { cardId: item.cardId, capUsd },
                              }).then(refused("The cap was not raised"));
                            }
                          }}
                        >
                          Raise the cap by ${DEFAULT_CARD_BUDGET_USD}
                        </ActionButton>
                      ) : item.kind === "fixRoundsExhausted" ? (
                        <ActionButton
                          tone="primary"
                          onClick={() =>
                            decideOn(
                              item.cardId,
                              "card.fix-rounds.reset",
                              "The fix rounds were not reset",
                            )
                          }
                        >
                          Give it more rounds
                        </ActionButton>
                      ) : itemCard?.paused != null &&
                        (item.kind === "paused" || item.kind === "sessionFailed") ? (
                        <ActionButton
                          tone="primary"
                          onClick={() =>
                            decideOn(item.cardId, "card.resume", "The card was not resumed")
                          }
                        >
                          Resume
                        </ActionButton>
                      ) : (item.kind === "needsAgent" || item.kind === "criteria") &&
                        environmentId !== null ? (
                        <ActionButton
                          tone="primary"
                          render={boardLink(
                            item.projectId,
                            item.cardId,
                            item.kind === "needsAgent" ? "agent" : "criteria",
                          )}
                        >
                          {item.kind === "needsAgent" ? "Assign an agent" : "Open the criteria"}
                        </ActionButton>
                      ) : item.kind === "delegateReadOnly" &&
                        environmentId !== null &&
                        itemCard?.delegateAgentId != null ? (
                        <ActionButton
                          tone="primary"
                          render={
                            <Link
                              to="/agents/$environmentId/$agentId"
                              params={{ environmentId, agentId: itemCard.delegateAgentId }}
                            />
                          }
                        >
                          Open its agent
                        </ActionButton>
                      ) : item.kind === "sideEffectGuard" ? (
                        <GuardLink search={orchestrationSettingsSearch(item.projectId)} />
                      ) : item.kind === "lessonProposed" && item.lessonId !== null ? (
                        <>
                          <ActionButton
                            onClick={() =>
                              decideLesson(
                                dismissLesson,
                                item.projectId,
                                item.lessonId!,
                                "The lesson was not dismissed",
                              )
                            }
                          >
                            Dismiss
                          </ActionButton>
                          <ActionButton
                            tone="primary"
                            onClick={() =>
                              decideLesson(
                                approveLesson,
                                item.projectId,
                                item.lessonId!,
                                "The lesson was not approved",
                              )
                            }
                          >
                            Approve lesson
                          </ActionButton>
                        </>
                      ) : item.kind === "planApproval" && environmentId !== null ? (
                        <ActionButton
                          tone="primary"
                          render={boardLink(item.projectId, item.cardId)}
                        >
                          Review the plan
                        </ActionButton>
                      ) : (item.kind === "readyToMerge" ||
                          item.kind === "scopeFlags" ||
                          item.kind === "evidenceMissing") &&
                        environmentId !== null ? (
                        <ActionButton
                          tone="primary"
                          render={boardLink(item.projectId, item.cardId)}
                        >
                          Review
                        </ActionButton>
                      ) : item.kind === "budgetCap" ? (
                        item.code === "environmentBudgetCap" ? (
                          <ActionButton
                            tone="primary"
                            render={<Link to="/settings/connections" hash="card-runtime" />}
                          >
                            Raise the machine budget
                          </ActionButton>
                        ) : orchestrationSettingsSearch(item.projectId) === null ? null : (
                          <ActionButton
                            tone="primary"
                            render={
                              <Link
                                to="/settings/projects"
                                search={orchestrationSettingsSearch(item.projectId)!}
                                hash="project-budgets"
                              />
                            }
                          >
                            Raise the budget
                          </ActionButton>
                        )
                      ) : item.kind === "unpricedModel" ? (
                        // Refusing is the standing state here; the card sheet takes an acceptance back.
                        <ActionButton
                          tone="primary"
                          onClick={() =>
                            decideOn(
                              item.cardId,
                              "card.unpriced.accept",
                              "The card was not allowed to run uncapped",
                            )
                          }
                        >
                          Run uncapped
                        </ActionButton>
                      ) : null;

                    return (
                      <li
                        key={item.key}
                        className="grid min-w-0 grid-cols-[32px_minmax(0,1fr)] items-start gap-3.5 rounded-[14px] bg-card px-4 py-3.5 shadow-[0_0_0_0.5px_var(--border)] md:grid-cols-[32px_minmax(0,1fr)_auto]"
                      >
                        <span
                          className={cn(
                            "flex size-8 items-center justify-center rounded-full",
                            item.kind === "sessionFailed"
                              ? "bg-destructive/16 text-destructive-foreground"
                              : "bg-warning/16 text-warning",
                          )}
                        >
                          {Icon === undefined ? (
                            <SparkGlyph state="needsYou" />
                          ) : (
                            <Icon aria-hidden className="size-4" strokeWidth={2} />
                          )}
                        </span>
                        <div className="flex min-w-0 flex-col gap-2">
                          <div className="flex min-h-8 min-w-0 items-center gap-x-2">
                            <CardLink
                              environmentId={environmentId}
                              projectId={item.projectId}
                              cardId={item.cardId}
                              className="text-[15px] font-semibold tracking-[-0.005em]"
                            >
                              {item.title}
                            </CardLink>
                            <span className="shrink-0 text-[11px] font-medium tabular-nums text-tertiary-label">
                              {cardShortId(itemCard ?? { id: item.cardId, linearIssue: null })}
                            </span>
                            {item.kind === "refsChanged" ? (
                              <StatusPill label="Refs Moved" tone="orange" />
                            ) : null}
                            {marks.length > 0 ? (
                              <CriteriaMarks marks={marks} className="ms-1" />
                            ) : null}
                            {suggested !== undefined ? (
                              <AgentAvatar
                                name={suggested}
                                className="ms-1 size-[18px] text-[9px]"
                              />
                            ) : null}
                          </div>
                          {SELF_EVIDENT.has(item.kind) ||
                          answersInPlace ||
                          attention !== undefined ? null : (
                            <DisabledReason reason={why} className="self-start">
                              <span className="self-start text-[13px] text-muted-foreground">
                                {needsYouLabel(item)}
                              </span>
                            </DisabledReason>
                          )}
                          {item.kind === "lessonProposed" && item.reason !== null ? (
                            <p className="line-clamp-4 whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
                              {item.reason}
                            </p>
                          ) : null}
                          {attention !== undefined ? (
                            <p className="line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
                              {attention.text}
                            </p>
                          ) : null}
                          {answersInPlace && environmentId !== null ? (
                            <CardQuestion
                              cardId={item.cardId}
                              question={question}
                              environmentId={environmentId}
                              agentName={
                                itemCard?.delegateAgentId == null
                                  ? undefined
                                  : agentNameById.get(itemCard.delegateAgentId)
                              }
                            />
                          ) : null}
                          {(item.kind === "checkpoint" || item.kind === "sliceCheckpoint") &&
                          environmentId !== null &&
                          itemCard !== undefined ? (
                            <CheckpointControls card={itemCard} environmentId={environmentId} />
                          ) : null}
                          {question?.kind === "refsChanged" && environmentId !== null ? (
                            <RefsChangedControls
                              cardId={item.cardId}
                              report={question}
                              environmentId={environmentId}
                            />
                          ) : null}
                        </div>
                        <div className="col-start-2 flex min-h-8 flex-wrap items-center justify-end gap-2 md:col-start-3">
                          {primary}
                          <span className="w-8 text-right text-xs tabular-nums text-tertiary-label">
                            <span className="sr-only">Waiting </span>
                            {waitingLabel(item.since, now)}
                          </span>
                          {item.snoozable ? (
                            <Menu>
                              <MenuTrigger
                                render={
                                  <Button
                                    size="icon-sm"
                                    variant="ghost-muted"
                                    aria-label={`Snooze ${item.title}`}
                                  />
                                }
                              >
                                <EllipsisIcon />
                              </MenuTrigger>
                              <MenuPopup align="end">
                                <MenuGroup>
                                  <MenuGroupLabel>Snooze</MenuGroupLabel>
                                  <MenuItem
                                    onClick={() =>
                                      snoozeCard(item.cardId, new Date(now + HOUR_MS).toISOString())
                                    }
                                  >
                                    1 hour
                                  </MenuItem>
                                  <MenuItem
                                    onClick={() =>
                                      snoozeCard(
                                        item.cardId,
                                        new Date(now + 24 * HOUR_MS).toISOString(),
                                      )
                                    }
                                  >
                                    Tomorrow
                                  </MenuItem>
                                  <MenuItem onClick={() => snoozeCard(item.cardId, null)}>
                                    Until it changes
                                  </MenuItem>
                                </MenuGroup>
                              </MenuPopup>
                            </Menu>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
            {waits.length > 0 ? (
              <ListSection label="Waiting on Iskra">
                {waits.map((wait) => (
                  <li key={wait.cardId} className={LIST_ROW}>
                    <ClockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/75" />
                    <CardLink
                      environmentId={environmentId}
                      projectId={wait.projectId}
                      cardId={wait.cardId}
                      className="text-[13px] text-muted-foreground"
                    >
                      {wait.title}
                    </CardLink>
                    <DisabledReason reason={wait.label === wait.reason ? null : wait.reason}>
                      <span className="ms-auto min-w-0 truncate text-xs text-tertiary-label">
                        {wait.label}
                      </span>
                    </DisabledReason>
                    <span className="w-8 shrink-0 text-right text-xs tabular-nums text-tertiary-label">
                      <span className="sr-only">Waiting </span>
                      {waitingLabel(wait.since, now)}
                    </span>
                  </li>
                ))}
              </ListSection>
            ) : null}
            {snoozed.length > 0 ? (
              <ListSection label="Snoozed">
                {snoozed.map((card) => (
                  <li key={card.id} className={LIST_ROW}>
                    <BellOffIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/75" />
                    <span className="min-w-0 truncate text-[13px] text-muted-foreground">
                      {card.title}
                    </span>
                    <span className="ms-auto shrink-0 text-xs text-tertiary-label">
                      {card.snoozedUntil === null
                        ? "Until it changes"
                        : `Until ${new Date(card.snoozedUntil).toLocaleString()}`}
                    </span>
                    <ActionButton
                      onClick={() => {
                        if (environmentId !== null) {
                          void unsnooze({ environmentId, input: { cardId: card.id } }).then(
                            refused("The card was not woken"),
                          );
                        }
                      }}
                    >
                      Wake
                    </ActionButton>
                  </li>
                ))}
              </ListSection>
            ) : null}
          </PageColumn>
        </main>
      </div>
    </SidebarInset>
  );
}

const LIST_ROW =
  "relative flex h-12 min-w-0 items-center gap-3 px-4 before:absolute before:top-0 before:right-0 before:left-4 before:border-t-[0.5px] before:border-border before:content-[''] first:before:hidden";

function ListSection(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section aria-label={props.label} className="mt-7 flex flex-col gap-2">
      <h2 className="px-4 text-[13px] font-semibold text-muted-foreground">{props.label}</h2>
      <ul className="overflow-hidden rounded-[14px] bg-card shadow-[0_0_0_0.5px_var(--border)]">
        {props.children}
      </ul>
    </section>
  );
}

/** Where a project's side-effect guard is reviewed: its orchestration settings. */
function GuardLink(props: { readonly search: { readonly project: string } | null }) {
  if (props.search === null) return null;
  return (
    <ActionButton
      tone="primary"
      render={<Link to="/settings/projects" search={props.search} hash="project-orchestration" />}
    >
      Review the guard
    </ActionButton>
  );
}

/** The card's title, opening its sheet on the board. */
function CardLink(props: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: string;
  readonly cardId: CardId;
  readonly className?: string;
  readonly children: string;
}) {
  if (props.environmentId === null) {
    return <span className={cn("min-w-0 truncate", props.className)}>{props.children}</span>;
  }
  return (
    <Link
      to="/board/$environmentId/$projectId"
      params={{ environmentId: props.environmentId, projectId: props.projectId }}
      search={{ card: props.cardId }}
      className={cn("min-w-0 truncate hover:underline", props.className)}
    >
      {props.children}
    </Link>
  );
}
