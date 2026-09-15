import {
  BOARD_COLUMNS,
  BOARD_COLUMN_LABEL,
  CARD_PRIORITIES,
  CARD_PRIORITY_LABEL,
  boardColumnOf,
  cardBadges,
  cardDropDecision,
  isCardSnoozed,
  type BoardColumn,
} from "@iskra/client-runtime/cards";
import { cardSparkState, cardStatusPill, criteriaMarks } from "@iskra/client-runtime/card-face";
import type {
  CardId,
  CardPriority,
  EnvironmentId,
  OrchestrationAgentShell,
  OrchestrationCardShell,
  ProjectId,
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
import { Link, useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { cardEnvironment } from "~/state/cards";
import { useEnvironmentAgents, useEnvironmentCards, useProjects } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { AgentAvatar } from "../iskra/AgentAvatar";
import { CriteriaMarks, SpendBar } from "../iskra/Marks";
import { StatusPill } from "../iskra/StatusPill";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { searchableSetting } from "../settings/settingsSearch";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { useUndoToast } from "./useUndoToast";
import { Tooltip, TooltipCreateHandle, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastCommandFailure } from "../toastCommandFailure";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { CardSheet } from "./CardSheet";
import { NewCardDialog } from "./NewCardDialog";

/** One tooltip for every badge on the board; each badge is only a trigger carrying its hint. */
const badgeHint = TooltipCreateHandle<string>();

/** Which cards wait on an unlanded blocker, and each card's sub-cards, in one pass over the board. */
function relatedCards(cards: ReadonlyArray<OrchestrationCardShell>) {
  const landed = new Set(cards.filter((card) => card.status === "landed").map((card) => card.id));
  const blocked = new Set<CardId>();
  const subCards = new Map<CardId, ReadonlyArray<OrchestrationCardShell>>();
  for (const card of cards) {
    if (
      card.relations.some(
        (relation) => relation.kind === "blockedBy" && !landed.has(relation.cardId),
      )
    ) {
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
  /** The card whose sheet is open, from the route's `card` search param. */
  readonly openCardId: CardId | null;
  /** Opens the New card dialog, from the route's `new` search param. */
  readonly openNewCard: boolean;
  /** The control the open card's sheet moves to, from the route's `focus` search param. */
  readonly focus?: "agent" | "criteria" | undefined;
}) {
  const navigate = useNavigate();
  const [newCardOpen, setNewCardOpen] = useState(false);
  const openCard = useCallback(
    (cardId: CardId | null) =>
      void navigate({
        to: "/board/$environmentId/$projectId",
        params: { environmentId: props.environmentId, projectId: props.projectId },
        search: cardId === null ? {} : { card: cardId },
      }),
    [navigate, props.environmentId, props.projectId],
  );
  const projects = useProjects();
  const project = projects.find(
    (entry) => entry.environmentId === props.environmentId && entry.id === props.projectId,
  );
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const allCards = useEnvironmentCards(props.environmentId);
  const agents = useEnvironmentAgents(props.environmentId);
  const decide = useAtomCommand(cardEnvironment.decide);
  const undoToast = useUndoToast();
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
  // The sheet's data is only the open card; faces never see it.
  const openCardShell = useMemo(
    () => cards.find((card) => card.id === props.openCardId) ?? null,
    [cards, props.openCardId],
  );
  const projectAgents = useMemo(
    () => agents.filter((agent) => agent.projectId === props.projectId),
    [agents, props.projectId],
  );
  const closeCard = useCallback(() => openCard(null), [openCard]);

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
    if (
      result._tag === "Success" &&
      (decision.type === "card.abandon" || decision.type === "card.unapprove")
    ) {
      undoToast(props.environmentId, { type: decision.type, cardId: card.id });
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border">
          <h1 className="truncate text-sm font-semibold">
            {project === undefined ? "Board" : `${project.title} board`}
          </h1>
          {project !== undefined ? (
            <Link
              to="/settings/integrations"
              search={{
                project: deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
              }}
              hash={searchableSetting("linear-team").id}
              className="ml-auto shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Linear sync
            </Link>
          ) : null}
          <Button
            className={project === undefined ? "ml-auto" : undefined}
            size="sm"
            variant="outline"
            onClick={() => setNewCardOpen(true)}
          >
            <PlusIcon />
            New card
          </Button>
        </WorkspacePageHeader>
        <NewCardDialog
          open={newCardOpen || props.openNewCard}
          onOpenChange={(open) => {
            setNewCardOpen(open);
            // Closing drops `new` from the URL; a created card then navigates to its sheet.
            if (!open && props.openNewCard) openCard(null);
          }}
          environmentId={props.environmentId}
          projectId={props.projectId}
          onCreated={openCard}
        />
        <CardSheet
          environmentId={props.environmentId}
          card={openCardShell}
          cards={cards}
          agents={projectAgents}
          now={now}
          focus={props.focus}
          onClose={closeCard}
        />
        <Tooltip handle={badgeHint}>
          {({ payload }) => <TooltipPopup className="max-w-64">{payload}</TooltipPopup>}
        </Tooltip>
        {cards.length === 0 ? (
          <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
            <div className="flex max-w-md flex-col gap-1 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">No cards yet</p>
              <p>
                A card is one piece of work on its own branch. It moves Triage → Ready → In progress
                → Review → Landing → Done.
              </p>
              <p>
                You approve it, assign an agent, and approve the merge; the rest moves on its own.
              </p>
            </div>
            <Button size="sm" onClick={() => setNewCardOpen(true)}>
              <PlusIcon />
              New card
            </Button>
          </main>
        ) : (
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
                  onOpen={openCard}
                />
              ))}
            </div>
          </DndContext>
        )}
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
  readonly onOpen: (cardId: CardId) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: props.column });
  return (
    <section
      ref={setNodeRef}
      aria-label={BOARD_COLUMN_LABEL[props.column]}
      className={cn("flex w-72 shrink-0 flex-col gap-2.5 rounded-xl p-1", isOver && "bg-muted")}
    >
      <h2 className="flex h-7 items-baseline gap-1.5 px-1 text-[13px] font-semibold">
        {BOARD_COLUMN_LABEL[props.column]}
        <span className="font-normal tabular-nums text-muted-foreground">{props.cards.length}</span>
      </h2>
      <ol className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
        {props.cards.map((card) => (
          <li key={card.id}>
            <CardFace
              card={card}
              blocked={props.related.blocked.has(card.id)}
              subCards={props.related.subCards.get(card.id)}
              delegateName={props.agents.find((agent) => agent.id === card.delegateAgentId)?.name}
              now={props.now}
              environmentId={props.environmentId}
              onOpen={props.onOpen}
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
  readonly onOpen: (cardId: CardId) => void;
}) {
  const { card } = props;
  const children = props.subCards ?? [];
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
  });
  const update = useAtomCommand(cardEnvironment.update);
  const decide = useAtomCommand(cardEnvironment.decide);
  const session = card.ownerSession;
  const badges = cardBadges(card, {
    blocked: props.blocked,
    snoozed: isCardSnoozed(card, props.now),
  });

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
        "flex cursor-grab touch-none flex-col gap-2.5 rounded-xl bg-card p-3 text-sm shadow-[0_0_0_0.5px_var(--border),0_1px_2px_rgb(0_0_0/8%)]",
        isDragging && "z-10 cursor-grabbing shadow-lg",
        card.status === "abandoned" && "opacity-60",
      )}
    >
      <div className="flex items-center justify-end gap-2">
        <StatusPill {...cardStatusPill(card)} />
      </div>
      <h3 className="line-clamp-2 font-medium leading-snug tracking-[-0.005em]">
        {/* dnd-kit swallows the click that ends a drag, so this opens the sheet only on a click. */}
        <button
          type="button"
          className="text-start hover:underline"
          onClick={() => props.onOpen(card.id)}
        >
          {card.title}
        </button>
      </h3>
      {card.status === "triage" && card.proposalReasoning !== null ? (
        <p className="line-clamp-3 text-xs text-muted-foreground">{card.proposalReasoning}</p>
      ) : null}
      {badges.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {badges.map((badge) => (
            <TooltipTrigger
              key={badge.label}
              handle={badgeHint}
              payload={badge.hint}
              render={
                <li
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] leading-none",
                    badge.alarming
                      ? "bg-destructive/15 text-destructive-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                />
              }
            >
              {badge.label}
            </TooltipTrigger>
          ))}
        </ul>
      ) : null}
      {card.paused !== null && card.status !== "landed" && card.status !== "abandoned" ? (
        <Button
          size="compact"
          variant="outline"
          className="self-start"
          onClick={() =>
            void decide({
              environmentId: props.environmentId,
              input: { type: "card.resume", cardId: card.id },
            }).then((result) =>
              toastCommandFailure(result, "The card was not resumed", "The request was refused."),
            )
          }
        >
          Resume
        </Button>
      ) : null}
      <div className="flex items-center gap-2">
        <CriteriaMarks marks={criteriaMarks(card)} />
        <span className="ms-auto flex items-center gap-2.5">
          {card.spentUsd > 0 ? (
            <SpendBar spentUsd={card.spentUsd} capUsd={card.budgetCapUsd} />
          ) : null}
          {props.delegateName !== undefined ? (
            <AgentAvatar name={props.delegateName} spark={cardSparkState(card)} />
          ) : null}
        </span>
      </div>
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
        {card.branch !== null ? <dd className="max-w-full truncate">{card.branch}</dd> : null}
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
        {children.length > 0 ? (
          <dd className="tabular-nums">
            {children.length} sub-card{children.length === 1 ? "" : "s"}
          </dd>
        ) : null}
      </dl>
    </article>
  );
});
