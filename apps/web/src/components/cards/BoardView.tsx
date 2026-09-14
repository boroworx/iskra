import {
  BOARD_COLUMNS,
  BOARD_COLUMN_LABEL,
  boardColumnOf,
  cardDropDecision,
  isCardSnoozed,
  type BoardColumn,
} from "@iskra/client-runtime/cards";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@iskra/client-runtime/state/runtime";
import {
  CARD_AUTOFIX_ATTEMPTS,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
  type ProjectId,
  type RunSessionState,
} from "@iskra/contracts";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { Link } from "@tanstack/react-router";
import { memo, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { cardEnvironment } from "~/state/cards";
import { useEnvironmentAgents, useEnvironmentCards, useProjects } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const SESSION_BADGE: Partial<Record<RunSessionState, string>> = {
  pending: "Starting",
  active: "Working",
  awaitingInput: "Needs you",
  complete: "Waiting",
  error: "Failed",
  stale: "Stale",
};

/**
 * A project's cards by status. Cards move on their own as work happens; a person
 * drags only to decide (approve, approve merge, abandon, or a reverse), and any
 * other drop snaps back with the reason.
 */
export function BoardView(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const projects = useProjects();
  const project = projects.find(
    (entry) => entry.environmentId === props.environmentId && entry.id === props.projectId,
  );
  const allCards = useEnvironmentCards(props.environmentId);
  const agents = useEnvironmentAgents(props.environmentId);
  const decide = useAtomCommand(cardEnvironment.decide);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  // Read once for the Snoozed badge; a card's own changes re-render its face.
  const [now] = useState(() => Date.now());

  const cards = useMemo(
    () => allCards.filter((card) => card.projectId === props.projectId),
    [allCards, props.projectId],
  );
  const columns = useMemo(() => {
    const byColumn = new Map<BoardColumn, OrchestrationCardShell[]>(
      BOARD_COLUMNS.map((column) => [column, []]),
    );
    for (const card of cards) {
      byColumn.get(boardColumnOf(card.status))?.push(card);
    }
    return byColumn;
  }, [cards]);

  const onDragEnd = async (event: DragEndEvent) => {
    const card = cards.find((candidate) => candidate.id === event.active.id);
    if (card === undefined || event.over === null) {
      return;
    }
    const decision = cardDropDecision(card.status, event.over.id as BoardColumn);
    if (decision.kind === "none") {
      return;
    }
    if (decision.kind === "refuse") {
      toastManager.add({
        type: "warning",
        title: "That move happens on its own",
        description: decision.reason,
      });
      return;
    }
    const result = await decide({
      environmentId: props.environmentId,
      input: { type: decision.type, cardId: card.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "The card stays where it was",
        description: error instanceof Error ? error.message : "The decision was refused.",
      });
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border">
          <h1 className="truncate text-sm font-semibold">
            {project === undefined ? "Board" : `${project.title} board`}
          </h1>
        </WorkspacePageHeader>
        <DndContext sensors={sensors} onDragEnd={(event) => void onDragEnd(event)}>
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 py-4">
            {BOARD_COLUMNS.map((column) => (
              <BoardColumnView
                key={column}
                column={column}
                cards={columns.get(column) ?? []}
                allCards={cards}
                agents={agents}
                now={now}
                environmentId={props.environmentId}
              />
            ))}
          </div>
        </DndContext>
      </div>
    </SidebarInset>
  );
}

function BoardColumnView(props: {
  readonly column: BoardColumn;
  readonly cards: ReadonlyArray<OrchestrationCardShell>;
  readonly allCards: ReadonlyArray<OrchestrationCardShell>;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly now: number;
  readonly environmentId: EnvironmentId;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: props.column });
  return (
    <section
      ref={setNodeRef}
      aria-label={BOARD_COLUMN_LABEL[props.column]}
      className={cn(
        "flex w-72 shrink-0 flex-col gap-2 rounded-lg bg-muted/30 p-2",
        isOver && "bg-muted/60",
      )}
    >
      <h2 className="flex h-6 items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
        {BOARD_COLUMN_LABEL[props.column]}
        <span className="tabular-nums">{props.cards.length}</span>
      </h2>
      <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {props.cards.map((card) => (
          <li key={card.id}>
            <CardFace
              card={card}
              allCards={props.allCards}
              agents={props.agents}
              now={props.now}
              environmentId={props.environmentId}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

const CardFace = memo(function CardFace(props: {
  readonly card: OrchestrationCardShell;
  readonly allCards: ReadonlyArray<OrchestrationCardShell>;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly now: number;
  readonly environmentId: EnvironmentId;
}) {
  const { card } = props;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
  });
  const delegate = props.agents.find((agent) => agent.id === card.delegateAgentId);
  const statusById = new Map(props.allCards.map((candidate) => [candidate.id, candidate.status]));
  const children = props.allCards.filter((candidate) => candidate.parentCardId === card.id);
  const blocked = card.relations.some(
    (relation) => relation.kind === "blockedBy" && statusById.get(relation.cardId) !== "landed",
  );
  const session = card.ownerSession;
  const sessionBadge = session === null ? undefined : SESSION_BADGE[session.state];
  const badges = [
    card.specState === "draft" && card.status !== "triage" ? "Spec draft" : null,
    blocked ? "Blocked" : null,
    isCardSnoozed(card, props.now) ? "Snoozed" : null,
    sessionBadge ?? null,
    card.checks === null || card.status !== "inReview"
      ? null
      : card.checks.state === "running"
        ? "Checks running"
        : card.checks.state === "passed"
          ? "Checks passed"
          : `Checks failed ${card.checks.failedRuns}/${CARD_AUTOFIX_ATTEMPTS}`,
    card.spentUsd >= card.budgetCapUsd && card.status !== "landed" ? "Budget reached" : null,
    card.unpricedTurns > 0 && !card.acceptsUnpriced ? "Unpriced model" : null,
  ].filter((badge): badge is string => badge !== null);

  return (
    <article
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={
        transform === null
          ? undefined
          : { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
      }
      className={cn(
        "flex cursor-grab touch-none flex-col gap-1.5 rounded-md border border-border bg-background p-2.5 text-sm shadow-xs",
        isDragging && "z-10 cursor-grabbing shadow-md",
        card.status === "abandoned" && "opacity-60",
      )}
    >
      <h3 className="line-clamp-2 font-medium">{card.title}</h3>
      {card.status === "triage" && card.proposalReasoning !== null ? (
        <p className="line-clamp-3 text-xs text-muted-foreground">{card.proposalReasoning}</p>
      ) : null}
      {badges.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {badges.map((badge) => (
            <li
              key={badge}
              className={cn(
                "rounded px-1.5 py-0.5 text-[11px] leading-none",
                badge === "Needs you" ||
                  badge === "Failed" ||
                  badge === "Blocked" ||
                  badge.startsWith("Checks failed") ||
                  badge === "Budget reached" ||
                  badge === "Unpriced model"
                  ? "bg-destructive/15 text-destructive-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {badge}
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {delegate !== undefined ? <dd>@{delegate.name}</dd> : null}
        {card.branch !== null ? (
          <dd className="max-w-full truncate font-mono">{card.branch}</dd>
        ) : null}
        {card.diffStat !== null && card.diffStat.files > 0 ? (
          <dd className="tabular-nums">
            +{card.diffStat.additions} −{card.diffStat.deletions}
          </dd>
        ) : null}
        {session?.planProgress != null ? (
          <dd className="tabular-nums">
            {session.planProgress.completedSteps}/{session.planProgress.totalSteps} steps
          </dd>
        ) : null}
        {card.status === "ready" || children.some((child) => child.attemptGroupId !== null) ? (
          <dd>
            <Link
              to="/attempts/$environmentId/$cardId"
              params={{ environmentId: props.environmentId, cardId: card.id }}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              Attempts
            </Link>
          </dd>
        ) : null}
        {card.spentUsd > 0 ? (
          <dd className="tabular-nums">
            ${card.spentUsd.toFixed(2)} of ${card.budgetCapUsd.toFixed(0)}
          </dd>
        ) : null}
        {children.length > 0 ? (
          <dd className="tabular-nums">
            {children.length} sub-card{children.length === 1 ? "" : "s"}
          </dd>
        ) : null}
      </dl>
    </article>
  );
});
