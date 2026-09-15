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
import {
  cardShortId,
  cardSparkState,
  cardStatusPill,
  criteriaMarks,
} from "@iskra/client-runtime/card-face";
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
import { requestsChannelId } from "@iskra/contracts";
import { EllipsisIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
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
import { EmptyState } from "../iskra/Page";
import { CriteriaMarks, SpendBar } from "../iskra/Marks";
import { StatusPill } from "../iskra/StatusPill";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
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
        <WorkspacePageHeader>
          <h1 className="truncate text-[15px] font-semibold">Board</h1>
          {project !== undefined ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    aria-label="More board actions"
                    className="ml-auto"
                    size="icon-sm"
                    variant="ghost-muted"
                  />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem
                  render={
                    <Link
                      to="/settings/integrations"
                      search={{
                        project: deriveLogicalProjectKeyFromSettings(
                          project,
                          projectGroupingSettings,
                        ),
                      }}
                      hash={searchableSetting("linear-team").id}
                    />
                  }
                >
                  Linear sync
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
          <Button
            className={cn(project === undefined && "ml-auto")}
            size="sm"
            onClick={() => setNewCardOpen(true)}
          >
            <PlusIcon className="size-3" strokeWidth={2.6} />
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
          <main className="flex min-h-0 flex-1 flex-col">
            <EmptyState
              title="No cards yet"
              body="A card is one piece of work on its own branch."
              actions={
                <>
                  <Button variant="secondary" onClick={() => setNewCardOpen(true)}>
                    <PlusIcon strokeWidth={2.6} />
                    New card
                  </Button>
                  <Button
                    render={
                      <Link
                        to="/channels/$environmentId/$channelId"
                        params={{
                          environmentId: props.environmentId,
                          channelId: requestsChannelId(props.projectId),
                        }}
                      />
                    }
                  >
                    <MessageSquareIcon />
                    Ask for something
                  </Button>
                </>
              }
            />
          </main>
        ) : (
          <DndContext sensors={sensors} onDragEnd={(event) => void onDragEnd(event)}>
            <div
              key={props.projectId}
              className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4"
            >
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
      className={cn(
        "-m-1 flex shrink-0 flex-col gap-2.5 rounded-[14px] p-1",
        isOver && "bg-[rgb(120_120_128/10%)]",
      )}
    >
      <h2 className="flex h-7 shrink-0 items-baseline gap-1.5 px-1 pt-1 text-[13px] font-semibold">
        {BOARD_COLUMN_LABEL[props.column]}
        <span className="font-semibold tabular-nums text-tertiary-label">{props.cards.length}</span>
      </h2>
      {/* A group's cards run sideways, so every group stays in view down the page. */}
      <ol className="flex min-w-0 gap-2.5 overflow-x-auto p-px pb-2">
        {props.cards.map((card) => (
          <li key={card.id} className="w-[280px] shrink-0">
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
        {/* An empty group still takes a drop, so a card can move into it. */}
        {props.cards.length === 0 ? (
          <li className="h-10 flex-1 rounded-[12px] border border-dashed border-border/70" />
        ) : null}
      </ol>
    </section>
  );
}

/** Urgent and High show a flag: filled for Urgent, outlined for High. */
function PriorityFlag(props: { readonly priority: CardPriority }) {
  if (props.priority !== 1 && props.priority !== 2) return null;
  return (
    <svg aria-hidden width={10} height={10} viewBox="0 0 24 24" className="shrink-0 text-warning">
      <path
        d="M5 22V3h12l-2.5 5L17 13H5"
        fill={props.priority === 1 ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
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
  const finished = card.status === "landed" || card.status === "abandoned";
  const marks = criteriaMarks(card);
  // Secondary facts share one quiet caption line; the sheet has the rest.
  const facts = [
    card.diffStat !== null && card.diffStat.files > 0
      ? `+${card.diffStat.additions} −${card.diffStat.deletions}`
      : null,
    session?.planProgress != null
      ? `${session.planProgress.completedSteps}/${session.planProgress.totalSteps} steps`
      : null,
    children.length > 0 ? `${children.length} sub-card${children.length === 1 ? "" : "s"}` : null,
  ].filter((fact) => fact !== null);
  const showAttempts =
    card.status === "ready" || children.some((child) => child.attemptGroupId !== null);

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
        "flex cursor-grab touch-none flex-col gap-2.5 rounded-xl bg-card p-3 text-[13px] shadow-[0_0_0_0.5px_rgb(0_0_0/6%),0_1px_3px_rgb(0_0_0/7%)] dark:shadow-[0_0_0_0.5px_rgb(255_255_255/7%),0_1px_2px_rgb(0_0_0/32%)]",
        isDragging && "z-10 cursor-grabbing shadow-lg dark:shadow-lg",
        card.status === "abandoned" && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        {/* The caption is the priority control: its flag shows Urgent or High. */}
        <Select
          value={String(card.priority)}
          disabled={finished}
          onValueChange={(value) => {
            if (value === null) return;
            void update({
              environmentId: props.environmentId,
              input: { cardId: card.id, priority: Number(value) as CardPriority },
            });
          }}
        >
          <SelectTrigger
            aria-label={`Priority: ${CARD_PRIORITY_LABEL[card.priority]}`}
            className="-mx-1 h-5 min-h-0 w-auto min-w-0 gap-1 rounded-[5px] border-0 bg-transparent px-1 text-[11px] font-medium tabular-nums text-tertiary-label shadow-none hover:bg-[rgb(120_120_128/12%)] sm:min-h-0 sm:text-[11px] dark:bg-transparent dark:hover:bg-[rgb(120_120_128/20%)] [&_[data-slot=select-icon]]:hidden"
          >
            <PriorityFlag priority={card.priority} />
            <SelectValue>{() => cardShortId(card.id)}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {CARD_PRIORITIES.map((priority) => (
              <SelectItem key={priority} value={String(priority)}>
                {CARD_PRIORITY_LABEL[priority]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <StatusPill {...cardStatusPill(card)} />
      </div>
      <h3 className="line-clamp-3 text-[14px] leading-[1.35] font-medium tracking-[-0.005em] text-pretty">
        {/* dnd-kit swallows the click that ends a drag, so this opens the sheet only on a click. */}
        <button
          type="button"
          className="rounded-sm text-start outline-hidden ring-ring focus-visible:ring-2"
          onClick={() => props.onOpen(card.id)}
        >
          {card.title}
        </button>
      </h3>
      {card.status === "triage" && card.proposalReasoning !== null ? (
        <p className="line-clamp-2 text-xs text-muted-foreground">{card.proposalReasoning}</p>
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
                    "inline-flex h-[18px] items-center rounded-full px-1.5 text-[11px] font-semibold",
                    badge.alarming
                      ? "bg-destructive/14 text-destructive-foreground dark:bg-destructive/16"
                      : "bg-secondary text-muted-foreground",
                  )}
                />
              }
            >
              {badge.label}
            </TooltipTrigger>
          ))}
        </ul>
      ) : null}
      {card.paused !== null && !finished ? (
        <Button
          size="compact"
          variant="secondary"
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
      {facts.length > 0 || showAttempts ? (
        <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] font-medium tabular-nums text-tertiary-label">
          {facts.join(" · ")}
          {showAttempts ? (
            <>
              {facts.length > 0 ? <span aria-hidden>·</span> : null}
              <Link
                to="/attempts/$environmentId/$cardId"
                params={{ environmentId: props.environmentId, cardId: card.id }}
                className="text-info-foreground hover:underline"
              >
                Attempts
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      <div className="flex min-h-5 items-center justify-between gap-2">
        {marks.length > 0 ? <CriteriaMarks marks={marks} /> : <span />}
        <span className="flex items-center gap-2.5">
          {card.spentUsd > 0 ? (
            <SpendBar spentUsd={card.spentUsd} capUsd={card.budgetCapUsd} />
          ) : null}
          {props.delegateName !== undefined ? (
            <AgentAvatar name={props.delegateName} spark={cardSparkState(card)} />
          ) : null}
        </span>
      </div>
    </article>
  );
});
