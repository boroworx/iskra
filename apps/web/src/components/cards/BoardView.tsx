import {
  BOARD_COLUMNS,
  BOARD_COLUMN_LABEL,
  CARD_PRIORITIES,
  CARD_PRIORITY_LABEL,
  boardColumnOf,
  cardDropDecision,
  isCardSnoozed,
  type BoardColumn,
} from "@iskra/client-runtime/cards";
import {
  CARD_AUTOFIX_ATTEMPTS,
  type CardId,
  type CardPriority,
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { toastCommandFailure } from "../toastCommandFailure";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

type Badge = readonly [label: string, alarming: boolean];

const SESSION_BADGE: Partial<Record<RunSessionState, Badge>> = {
  pending: ["Starting", false],
  active: ["Working", false],
  awaitingInput: ["Needs you", true],
  complete: ["Waiting", false],
  error: ["Failed", true],
  stale: ["Stale", false],
};

/** Which cards wait on an unlanded blocker, and each card's sub-cards, in one pass over the board. */
function relatedCards(cards: ReadonlyArray<OrchestrationCardShell>) {
  const landed = new Set(cards.filter((card) => card.status === "landed").map((card) => card.id));
  const blocked = new Set<CardId>();
  const subCards = new Map<CardId, ReadonlyArray<OrchestrationCardShell>>();
  for (const card of cards) {
    if (card.relations.some((relation) => relation.kind === "blockedBy" && !landed.has(relation.cardId))) {
      blocked.add(card.id);
    }
    if (card.parentCardId !== null) {
      subCards.set(card.parentCardId, [...(subCards.get(card.parentCardId) ?? []), card]);
    }
  }
  return { blocked, subCards };
}

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
  // Faces get plain values from this, so a face whose own facts did not change skips rendering.
  const related = useMemo(() => relatedCards(cards), [cards]);

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
    toastCommandFailure(result, "The card stays where it was", "The decision was refused.");
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
                related={related}
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
  readonly related: ReturnType<typeof relatedCards>;
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
              blocked={props.related.blocked.has(card.id)}
              subCards={props.related.subCards.get(card.id)}
              delegateName={props.agents.find((agent) => agent.id === card.delegateAgentId)?.name}
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
  readonly blocked: boolean;
  readonly subCards: ReadonlyArray<OrchestrationCardShell> | undefined;
  readonly delegateName: string | undefined;
  readonly now: number;
  readonly environmentId: EnvironmentId;
}) {
  const { card } = props;
  const children = props.subCards ?? [];
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
  });
  const update = useAtomCommand(cardEnvironment.update);
  const session = card.ownerSession;
  const sessionBadge = session === null ? undefined : SESSION_BADGE[session.state];
  const badges: Badge[] = [];
  if (card.specState === "draft" && card.status !== "triage") badges.push(["Spec draft", false]);
  if (props.blocked) badges.push(["Blocked", true]);
  if (isCardSnoozed(card, props.now)) badges.push(["Snoozed", false]);
  if (sessionBadge !== undefined) badges.push(sessionBadge);
  if (card.checks !== null && card.status === "inReview") {
    badges.push(
      card.checks.state === "running"
        ? ["Checks running", false]
        : card.checks.state === "passed"
          ? ["Checks passed", false]
          : [`Checks failed ${card.checks.failedRuns}/${CARD_AUTOFIX_ATTEMPTS}`, true],
    );
  }
  if (card.spentUsd >= card.budgetCapUsd && card.status !== "landed") badges.push(["Budget reached", true]);
  if (card.unpricedTurns > 0 && !card.acceptsUnpriced) badges.push(["Unpriced model", true]);

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
          {badges.map(([label, alarming]) => (
            <li
              key={label}
              className={cn(
                "rounded px-1.5 py-0.5 text-[11px] leading-none",
                alarming ? "bg-destructive/15 text-destructive-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {label}
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <dd>
          <Select
            value={String(card.priority)}
            disabled={card.status === "landed" || card.status === "abandoned"}
            onValueChange={(value) => {
              if (value === null) return;
              void update({
                environmentId: props.environmentId,
                input: { cardId: card.id, priority: Number(value) as CardPriority },
              });
            }}
          >
            <SelectTrigger
              aria-label="Priority"
              className={cn(
                "h-auto min-h-0 w-auto gap-1 border-0 bg-transparent p-0 text-xs shadow-none",
                card.priority === 1 && "text-destructive-foreground",
              )}
            >
              <SelectValue>
                {(value: string | null) => CARD_PRIORITY_LABEL[Number(value ?? 0) as CardPriority]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {CARD_PRIORITIES.map((priority) => (
                <SelectItem key={priority} value={String(priority)}>
                  {CARD_PRIORITY_LABEL[priority]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </dd>
        {props.delegateName !== undefined ? <dd>@{props.delegateName}</dd> : null}
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
