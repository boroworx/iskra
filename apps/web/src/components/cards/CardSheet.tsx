import {
  CARD_RELATION_LABEL,
  CARD_SESSION_LABEL,
  cardMoveActions,
  cardVerificationRequired,
  isCardSnoozed,
  reasonLabel,
  reasonLine,
  restoreRefusal,
  revertRefusal,
  verifierMergeRefusal,
} from "@iskra/client-runtime/cards";
import {
  isAtomCommandInterrupted,
  atomCommandFailureMessage,
  type AtomCommandResult,
} from "@iskra/client-runtime/state/runtime";
import {
  CardRelationKind,
  MessageId,
  projectOrchestrationOf,
  type CardEvidenceItem,
  type AgentId,
  type CardActivity,
  CardId,
  type CardOutcome,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
  type RunSessionState,
} from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, ClockIcon, EllipsisIcon, PauseIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn, randomUUID } from "~/lib/utils";
import { cardEnvironment } from "~/state/cards";
import { useProjects, useThread } from "~/state/entities";
import { scopeThreadRef } from "@iskra/client-runtime/environment";
import { metricsLine, templateMetrics } from "@iskra/client-runtime/metrics";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  cardSparkState,
  cardStatusPill,
  outcomePill,
  type PillTone,
} from "@iskra/client-runtime/card-face";
import { ApproveAndStart } from "../channels/CardProposal";
import { ownerCandidates } from "../channels/channels.logic";
import { MigrationPanel } from "./MigrationPanel";
import { PlanReview } from "./PlanReview";
import { useUndoToast } from "./useUndoToast";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { AgentAvatar } from "../iskra/AgentAvatar";
import { RoundDots, SpendBar } from "../iskra/Marks";
import { StatusPill } from "../iskra/StatusPill";
import { CardActivityTimeline } from "./CardActivityTimeline";
import { AttentionActions, RefsChangedControls } from "./CardAttention";
import { CardCriteria, CardPreviewPanel, CardQuestions, cardQuestionsOf } from "./CardContract";
import { CardLandingPanel, CardReview, CheckpointControls } from "./CardReviewPanel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  Sheet,
  SheetClose,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../ui/sheet";
import { Textarea } from "../ui/textarea";
import { toastCommandFailure } from "../toastCommandFailure";
import {
  ActionButton,
  BranchGlyph,
  Group,
  Row,
  RowLink,
  Section,
  Trail,
} from "./cardChrome";
import { cardShortId } from "../iskra/cardLabel";
import { DisabledReason } from "./DisabledReason";

const HOUR_MS = 60 * 60_000;

/** The server's own sentence for assigning before approval; the picker says it before trying. */
const APPROVE_BEFORE_ASSIGN_TEXT = "Approve the card before assigning an agent.";

const SESSION_TONE: Record<RunSessionState, PillTone> = {
  pending: "blue",
  active: "blue",
  awaitingInput: "orange",
  complete: "gray",
  error: "red",
  stale: "gray",
  ended: "gray",
};

/** The footer's larger buttons, as the review canvas draws them. */
const FOOTER_BUTTON = "h-[30px] rounded-lg px-4 sm:h-[30px]";

/** Toasts a refused command and hands its reason to `onRefused`, so the sheet says it in place. */
const refusedWith =
  (onRefused: (text: string) => void) =>
  (title: string) =>
  (result: AtomCommandResult<unknown, unknown>) => {
    toastCommandFailure(result, title, "The request was refused.");
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      onRefused(`${title}. ${atomCommandFailureMessage(result, "The request was refused.")}`);
    }
  };

/**
 * One card's detail and every decision on it, as buttons that follow the same
 * rules as dragging. The board passes the selected card; nothing here is derived
 * for cards that are not open.
 */
export function CardSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly card: OrchestrationCardShell | null;
  /** The project's cards, for relations. */
  readonly cards: ReadonlyArray<OrchestrationCardShell>;
  /** The project's active agents. */
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  /** When the board was opened, for the snoozed state. */
  readonly now: number;
  /** The section to scroll to and focus when the sheet opens. */
  readonly focus?: "agent" | "criteria" | undefined;
  readonly onClose: () => void;
}) {
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Sheet
      open={props.card !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <SheetPopup
        ref={popup}
        tabIndex={-1}
        showCloseButton={false}
        initialFocus={popup}
        className="max-w-[640px] bg-background outline-none"
      >
        {props.card === null ? null : (
          <CardSheetBody
            key={props.card.id}
            environmentId={props.environmentId}
            card={props.card}
            cards={props.cards}
            agents={props.agents}
            now={props.now}
            focus={props.focus}
          />
        )}
      </SheetPopup>
    </Sheet>
  );
}

function CardSheetBody(props: {
  readonly environmentId: EnvironmentId;
  readonly card: OrchestrationCardShell;
  readonly cards: ReadonlyArray<OrchestrationCardShell>;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly now: number;
  readonly focus?: "agent" | "criteria" | undefined;
}) {
  const { card, environmentId } = props;
  // Needs you opens the sheet at what it asks for: once, when the body mounts for this card.
  const agentSection = useRef<HTMLDivElement>(null);
  const criteriaSection = useRef<HTMLDivElement>(null);
  const initialFocus = useRef(props.focus);
  useEffect(() => {
    const section = (initialFocus.current === "agent" ? agentSection : criteriaSection).current;
    if (initialFocus.current === undefined || section === null) return;
    const frame = requestAnimationFrame(() => {
      section.scrollIntoView({ block: "center" });
      section.querySelector<HTMLElement>("button, textarea, input")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const update = useAtomCommand(cardEnvironment.update);
  const decide = useAtomCommand(cardEnvironment.decide);
  const assign = useAtomCommand(cardEnvironment.assign);
  const postMessage = useAtomCommand(cardEnvironment.postMessage);
  const reviewComment = useAtomCommand(cardEnvironment.reviewComment);
  const addRelation = useAtomCommand(cardEnvironment.addRelation);
  const removeRelation = useAtomCommand(cardEnvironment.removeRelation);
  const setBudget = useAtomCommand(cardEnvironment.setBudget);
  const snooze = useAtomCommand(cardEnvironment.snooze);
  const unsnooze = useAtomCommand(cardEnvironment.unsnooze);
  // A refusal also shows at the top of the sheet, where a toast can pass unseen behind it.
  const [refusal, setRefusal] = useState<string | null>(null);
  const refused = refusedWith(setRefusal);

  // The body only exists while the sheet is open, so the card's stream lives exactly that long.
  const activity = useEnvironmentQuery(
    cardEnvironment.activity({ environmentId, input: { cardId: card.id } }),
  );
  const activities = activity.data?.activities ?? NO_ACTIVITIES;
  const evidence = activity.data?.evidence ?? null;
  const projects = useProjects();
  const policy = useMemo(
    () =>
      projectOrchestrationOf(
        projects.find(
          (project) => project.environmentId === environmentId && project.id === card.projectId,
        ) ?? {},
      ),
    [projects, environmentId, card.projectId],
  );

  // A proposal is mostly edited before it's approved, so it opens in its edit layout.
  const [editing, setEditing] = useState(card.status === "triage");
  const [requesting, setRequesting] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [spec, setSpec] = useState(card.spec);
  const [message, setMessage] = useState("");
  const [capUsd, setCapUsd] = useState(String(card.budgetCapUsd));
  const [relationKind, setRelationKind] = useState<CardRelationKind>("blockedBy");
  const [relationCardId, setRelationCardId] = useState<CardId | null>(null);

  const cardById = useMemo(
    () => new Map(props.cards.map((entry) => [entry.id, entry])),
    [props.cards],
  );
  const open = card.status !== "landed" && card.status !== "abandoned";
  const undoToast = useUndoToast();
  const decideOn = (type: Parameters<typeof decide>[0]["input"]["type"], failure: string) =>
    void decide({ environmentId, input: { type, cardId: card.id } }).then((result) => {
      refused(failure)(result);
      if (
        result._tag === "Success" &&
        (type === "card.pause" || type === "card.abandon" || type === "card.unapprove")
      ) {
        undoToast(environmentId, { type, cardId: card.id });
      }
    });
  const afterSnooze = (result: AtomCommandResult<unknown, unknown>) => {
    refused("The card was not snoozed")(result);
    if (result._tag === "Success")
      undoToast(environmentId, { type: "card.snooze", cardId: card.id });
  };
  const sessionAgentId = card.ownerSession?.agentId ?? card.delegateAgentId;
  const sessionAgent = props.agents.find((agent) => agent.id === sessionAgentId);
  const edited = title.trim() !== card.title || spec !== card.spec;
  const snoozed = isCardSnoozed(card, props.now);
  const trimmedMessage = message.trim();
  const cap = Number(capUsd);
  const builder = props.agents.find((agent) => agent.id === card.delegateAgentId);
  const verificationRequired = cardVerificationRequired(card, policy, builder);
  const mergeRefusal = verifierMergeRefusal(card, verificationRequired);
  const moves = cardMoveActions(card.status, mergeRefusal);
  const merge = card.status === "inReview" ? moves.find((move) => move.column === "landing") : undefined;
  const outcome = outcomePill(card.outcome);
  const previewAgent =
    props.agents.find((agent) => agent.id === (card.delegateAgentId ?? card.suggestedAgentId)) ??
    null;
  const showsAttempts = card.status === "ready" || card.attemptGroupId !== null;
  const branch = card.branch ?? card.baseBranch;

  const send = (kind: "message" | "review") => {
    const input = {
      cardId: card.id,
      messageId: MessageId.make(randomUUID()),
      body: trimmedMessage,
    };
    const sent =
      kind === "message"
        ? postMessage({ environmentId, input }).then(refused("The message was not sent"))
        : reviewComment({ environmentId, input }).then(refused("The review comment was not sent"));
    void sent;
    setMessage("");
  };

  // One criteria editor, placed in the edit layout or the body, where Needs you's focus finds it.
  const criteriaEditor = (
    <div ref={criteriaSection} className="contents">
      <Section label="Acceptance criteria">
        <CardCriteria card={card} environmentId={environmentId} />
      </Section>
    </div>
  );
  const criteriaInBody =
    card.evidence === null || card.acceptance.state === "draft" || props.focus === "criteria";

  return (
    <>
      <SheetHeader className="gap-2.5 px-7 pt-7 pb-4">
        <div className="flex min-h-7 items-center gap-2">
          <span className="text-xs font-medium tabular-nums text-tertiary-label">
            {cardShortId(card)}
          </span>
          <div className="ms-auto flex flex-wrap items-center justify-end gap-1.5">
            {card.ownerSession !== null && open ? (
              <StatusPill
                label={CARD_SESSION_LABEL[card.ownerSession.state]}
                tone={SESSION_TONE[card.ownerSession.state]}
              />
            ) : null}
            {snoozed ? <StatusPill label="Snoozed" tone="gray" /> : null}
            {card.unattended ? <StatusPill label="Draft PR" tone="gray" /> : null}
            {outcome !== null ? <StatusPill {...outcome} /> : null}
            <StatusPill {...cardStatusPill(card)} />
            <RowLink className="ms-1" aria-pressed={editing} onClick={() => setEditing((current) => !current)}>
              {editing ? "Done" : "Edit"}
            </RowLink>
            <Menu>
              <MenuTrigger
                render={<Button size="icon-sm" variant="ghost-muted" aria-label="Card actions" />}
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end" className="w-64">
                <MenuItem onClick={() => setEditing((current) => !current)}>
                  {editing ? "Done editing" : "Edit card"}
                </MenuItem>
                {open && card.status !== "triage" ? (
                  <MenuItem
                    onClick={() =>
                      card.paused === null
                        ? decideOn("card.pause", "The card was not paused")
                        : decideOn("card.resume", "The card was not resumed")
                    }
                  >
                    {card.paused === null ? "Pause" : "Resume"}
                  </MenuItem>
                ) : null}
                {moves.length > 0 ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Move</MenuGroupLabel>
                      {moves.map((action) => (
                        <MenuItem
                          key={action.column}
                          disabled={action.type === null}
                          variant={action.type === "card.abandon" ? "destructive" : "default"}
                          onClick={() => {
                            if (action.type !== null)
                              decideOn(action.type, "The card stays where it was");
                          }}
                        >
                          <span className="flex min-w-0 flex-col">
                            {action.label}
                            {action.reason !== null ? (
                              <span className="text-xs text-muted-foreground">{action.reason}</span>
                            ) : null}
                          </span>
                        </MenuItem>
                      ))}
                    </MenuGroup>
                  </>
                ) : null}
                {open ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Needs you</MenuGroupLabel>
                      {snoozed ? (
                        <MenuItem
                          onClick={() =>
                            void unsnooze({ environmentId, input: { cardId: card.id } }).then(
                              refused("The card was not woken"),
                            )
                          }
                        >
                          Wake
                        </MenuItem>
                      ) : (
                        <>
                          <MenuItem
                            onClick={() =>
                              void snooze({
                                environmentId,
                                input: {
                                  cardId: card.id,
                                  snoozedUntil: new Date(Date.now() + HOUR_MS).toISOString(),
                                },
                              }).then(afterSnooze)
                            }
                          >
                            Snooze 1 hour
                          </MenuItem>
                          <MenuItem
                            onClick={() =>
                              void snooze({
                                environmentId,
                                input: { cardId: card.id, snoozedUntil: null },
                              }).then(afterSnooze)
                            }
                          >
                            Snooze until it changes
                          </MenuItem>
                        </>
                      )}
                    </MenuGroup>
                  </>
                ) : null}
                {sessionAgent !== undefined || showsAttempts ? <MenuSeparator /> : null}
                {sessionAgent !== undefined ? (
                  <MenuItem
                    render={
                      <Link
                        to="/agents/$environmentId/$agentId"
                        params={{ environmentId, agentId: sessionAgent.id }}
                      />
                    }
                  >
                    Open @{sessionAgent.name}
                  </MenuItem>
                ) : null}
                {showsAttempts ? (
                  <MenuItem
                    render={
                      <Link
                        to="/attempts/$environmentId/$cardId"
                        params={{ environmentId, cardId: card.id }}
                      />
                    }
                  >
                    Attempts
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
            <SheetClose
              render={
                <Button size="icon-sm" variant="ghost-muted" aria-label="Close" />
              }
            >
              <XIcon />
            </SheetClose>
          </div>
        </div>
        <SheetTitle className="text-[22px] font-bold leading-tight tracking-[-0.015em]">
          {card.title}
        </SheetTitle>
        <div className="mt-1 flex flex-wrap items-center gap-x-[22px] gap-y-1.5 text-[13px] text-muted-foreground">
          {sessionAgent !== undefined ? (
            <Link
              to="/agents/$environmentId/$agentId"
              params={{ environmentId, agentId: sessionAgent.id }}
              className="inline-flex items-center gap-2 rounded-sm hover:text-foreground"
            >
              <AgentAvatar name={sessionAgent.name} spark={cardSparkState(card)} />
              {sessionAgent.name}
            </Link>
          ) : null}
          <span className="inline-flex items-center gap-2">
            <SpendBar spentUsd={card.spentUsd} capUsd={card.budgetCapUsd} className="w-22" />
            <span className="tabular-nums">${card.spentUsd.toFixed(2)}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <RoundDots
              used={card.fixRounds.review}
              cap={policy.reviewFixRounds}
              label="Review fix rounds"
            />
            Fix rounds
          </span>
          {card.revertsCardId !== null ? (
            <span className="min-w-0 truncate text-tertiary-label">
              Reverts {cardById.get(card.revertsCardId)?.title ?? "a landed card"}
            </span>
          ) : null}
          {showsAttempts ? (
            <Link
              to="/attempts/$environmentId/$cardId"
              params={{ environmentId, cardId: card.id }}
              className="text-info-foreground hover:underline"
            >
              Attempts
            </Link>
          ) : null}
        </div>
      </SheetHeader>
      <SheetPanel className="flex flex-col gap-6 px-7 pb-7">
        {refusal !== null ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl bg-destructive/12 px-3.5 py-2.5 text-xs text-destructive-foreground"
          >
            <p className="min-w-0 flex-1 break-words">{refusal}</p>
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Dismiss"
              onClick={() => setRefusal(null)}
            >
              <XIcon />
            </Button>
          </div>
        ) : null}

        {card.status === "triage" && card.proposalReasoning !== null ? (
          <p className="px-4 text-[13px] text-muted-foreground">{card.proposalReasoning}</p>
        ) : null}

        {editing ? (
          <>
            <Section label="Card">
              <Input
                aria-label="Title"
                value={title}
                disabled={!open}
                onChange={(event) => setTitle(event.target.value)}
              />
              <Textarea
                aria-label="Spec"
                placeholder="What should be built, and how you will know it is done"
                value={spec}
                disabled={!open}
                onChange={(event) => setSpec(event.target.value)}
              />
              {open ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <ActionButton
                    tone="primary"
                    disabled={!edited || title.trim().length === 0}
                    onClick={() =>
                      void update({
                        environmentId,
                        input: {
                          cardId: card.id,
                          ...(title.trim() !== card.title ? { title: title.trim() } : {}),
                          ...(spec !== card.spec ? { spec } : {}),
                        },
                      }).then(refused("The card was not saved"))
                    }
                  >
                    Save
                  </ActionButton>
                  {card.specState === "draft" ? (
                    <>
                      <DisabledReason
                        reason={
                          card.spec.trim().length === 0
                            ? "Write and save a spec first, or skip it."
                            : null
                        }
                      >
                        <ActionButton
                          disabled={card.spec.trim().length === 0 || edited}
                          onClick={() => decideOn("card.spec.approve", "The spec was not approved")}
                        >
                          Approve spec
                        </ActionButton>
                      </DisabledReason>
                      <ActionButton
                        onClick={() => decideOn("card.spec.skip", "The spec was not skipped")}
                      >
                        Skip spec
                      </ActionButton>
                    </>
                  ) : (
                    <>
                      <StatusPill
                        label={card.specState === "approved" ? "Spec approved" : "Spec skipped"}
                        tone={card.specState === "approved" ? "green" : "gray"}
                      />
                      <RowLink
                        onClick={() => decideOn("card.spec.reopen", "The spec was not reopened")}
                      >
                        Reopen spec
                      </RowLink>
                    </>
                  )}
                </div>
              ) : null}
            </Section>
            {criteriaEditor}
          </>
        ) : null}

        {open && (card.paused !== null || card.waitReason !== null) ? (
          <Group>
            {card.paused !== null ? (
              <Row className="py-2">
                <PauseIcon aria-hidden className="size-[18px] shrink-0 text-muted-foreground" />
                <DisabledReason reason={reasonLabel(card.paused.reason).hint}>
                  <span className="min-w-0 text-muted-foreground">
                    Paused · {reasonLine(card.paused.reason)}
                  </span>
                </DisabledReason>
                {card.status === "inReview" ? (
                  <Trail>
                    <ActionButton
                      tone="primary"
                      onClick={() => decideOn("card.resume", "The card was not resumed")}
                    >
                      Resume
                    </ActionButton>
                  </Trail>
                ) : null}
              </Row>
            ) : (
              <Row className="py-2">
                <ClockIcon aria-hidden className="size-[18px] shrink-0 text-muted-foreground" />
                <DisabledReason reason={card.waitReason === null ? null : reasonLabel(card.waitReason).hint}>
                  <span className="min-w-0 text-muted-foreground">
                    {card.waitReason === null ? "" : reasonLine(card.waitReason)}
                  </span>
                </DisabledReason>
              </Row>
            )}
            {card.paused !== null && card.ownerSession !== null ? (
              <RestoreControl card={card} environmentId={environmentId} />
            ) : null}
          </Group>
        ) : null}

        {open && card.attention.length > 0 ? (
          <Section label="Waiting on you">
            <Group>
              {card.attention.map((item) => (
                <Row key={item.activityId} className="flex-col items-stretch gap-1.5 py-3">
                  <span className="text-xs text-tertiary-label">
                    {reasonLabel({ code: item.code, text: item.text }).label}
                  </span>
                  <p className="whitespace-pre-wrap break-words">{item.text}</p>
                  <div className="flex justify-end">
                    <AttentionActions card={card} item={item} environmentId={environmentId} onCard />
                  </div>
                </Row>
              ))}
            </Group>
          </Section>
        ) : null}

        {open && cardQuestionsOf(card).length > 0 ? (
          <Section label="Questions for you">
            <Group className="p-4">
              <CardQuestions card={card} environmentId={environmentId} agentName={sessionAgent?.name} />
            </Group>
          </Section>
        ) : null}

        {/* A migration's tune checkpoint is answered in its panel, with the instructions editor. */}
        {open && card.checkpoint !== null && card.migration?.phase !== "tuning" ? (
          <Section label="Checkpoint">
            <Group className="p-4">
              <CheckpointControls card={card} environmentId={environmentId} />
            </Group>
          </Section>
        ) : null}

        {open
          ? card.openElicitations
              .filter((question) => question.kind === "refsChanged")
              .map((report) => (
                <Section key={report.activityId} label="Refs changed outside this card">
                  <Group className="p-4">
                    <RefsChangedControls
                      cardId={card.id}
                      report={report}
                      environmentId={environmentId}
                    />
                  </Group>
                </Section>
              ))
          : null}

        {card.kind === "plan" && card.plan !== null ? (
          <PlanReview card={card} cards={props.cards} environmentId={environmentId} />
        ) : null}

        {card.kind === "migration" && card.migration !== null ? (
          <Section label="Migration">
            <MigrationPanel card={card} environmentId={environmentId} />
          </Section>
        ) : null}

        {card.evidence !== null || card.status === "inReview" || card.status === "landing" ? (
          <CardReview
            card={card}
            evidence={evidence}
            activities={activities}
            verdict={activity.data?.verdict ?? null}
            verificationRequired={verificationRequired}
            agents={props.agents}
            environmentId={environmentId}
            // Cards that reached review before evidence existed get theirs here; any card may recapture.
            onCapture={
              card.status === "inReview"
                ? () => decideOn("card.evidence.capture", "Evidence was not requested")
                : undefined
            }
          />
        ) : null}

        {card.landing !== null || card.status === "inReview" || card.status === "landing" ? (
          <Section label="Landing">
            <CardLandingPanel
              card={card}
              items={evidence?.items ?? NO_EVIDENCE_ITEMS}
              policy={policy}
              environmentId={environmentId}
            />
          </Section>
        ) : null}

        {!open ? (
          <Section label="Outcome">
            <OutcomeControls card={card} cards={props.cards} environmentId={environmentId} />
          </Section>
        ) : null}

        {!editing && criteriaInBody ? criteriaEditor : null}

        {card.status === "triage" || card.status === "ready" ? (
          <Section label="Before it starts">
            <Group className="p-4">
              <CardPreviewPanel
                showReadOnly={card.waitReason?.code !== "delegateReadOnly"}
                estimate={card.estimate}
                agent={previewAgent}
                hint={
                  previewAgent === null
                    ? null
                    : metricsLine(
                        previewAgent.name,
                        templateMetrics(props.cards, props.now).get(previewAgent.id),
                      )
                }
              />
            </Group>
          </Section>
        ) : null}

        {open ? (
          <div ref={agentSection} className="contents">
            <Section label="Agent">
              <Group>
                <Row className="flex-wrap py-2">
                  <Select
                    value={card.delegateAgentId}
                    disabled={card.status === "triage"}
                    onValueChange={(value) => {
                      if (value !== null && value !== card.delegateAgentId) {
                        void assign({
                          environmentId,
                          input: { cardId: card.id, agentId: value as AgentId },
                        }).then(refused("The agent was not assigned"));
                      }
                    }}
                  >
                    <SelectTrigger aria-label="Agent" className="w-auto min-w-40">
                      <SelectValue>
                        {(value: string | null) =>
                          value === null
                            ? "No agent"
                            : `@${props.agents.find((agent) => agent.id === value)?.name ?? "archived agent"}`
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {ownerCandidates(props.agents, card.kind, card.delegateAgentId).map(
                        (agent) => (
                          <SelectItem key={agent.id} value={agent.id}>
                            @{agent.name}
                          </SelectItem>
                        ),
                      )}
                    </SelectPopup>
                  </Select>
                  {card.status === "triage" ? (
                    <span className="text-xs text-tertiary-label">
                      {APPROVE_BEFORE_ASSIGN_TEXT}
                    </span>
                  ) : null}
                  {card.delegateAgentId !== null ? (
                    <Trail>
                      <RowLink
                        onClick={() => decideOn("card.unassign", "The agent was not unassigned")}
                      >
                        Unassign
                      </RowLink>
                    </Trail>
                  ) : null}
                </Row>
                <Row className="flex-col items-stretch gap-2 py-3">
                  <Textarea
                    aria-label="Message to the card's agent"
                    placeholder="A message to the card's agent"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                  />
                  <DisabledReason
                    className="self-end"
                    reason={card.delegateAgentId === null ? "Assign an agent first." : null}
                  >
                    <ActionButton
                      className="self-end"
                      disabled={card.delegateAgentId === null || trimmedMessage.length === 0}
                      onClick={() => send("message")}
                    >
                      Send to agent
                    </ActionButton>
                  </DisabledReason>
                </Row>
              </Group>
            </Section>
          </div>
        ) : null}

        {editing || card.relations.length > 0 ? (
          <Section label="Relations">
            {card.relations.length > 0 ? (
              <Group>
                {card.relations.map((relation) => (
                  <Row key={`${relation.kind}:${relation.cardId}`}>
                    <span className="shrink-0 text-xs text-tertiary-label">
                      {CARD_RELATION_LABEL[relation.kind]}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {cardById.get(relation.cardId)?.title ?? "A card on another board"}
                    </span>
                    {editing ? (
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label="Remove relation"
                        onClick={() =>
                          void removeRelation({
                            environmentId,
                            input: {
                              cardId: card.id,
                              kind: relation.kind,
                              otherCardId: relation.cardId,
                            },
                          }).then(refused("The relation was not removed"))
                        }
                      >
                        <XIcon />
                      </Button>
                    ) : null}
                  </Row>
                ))}
              </Group>
            ) : null}
            {editing ? (
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={relationKind}
                  onValueChange={(value) => setRelationKind(value ?? "blockedBy")}
                >
                  <SelectTrigger aria-label="Relation" className="w-auto min-w-28">
                    <SelectValue>
                      {(value: CardRelationKind | null) =>
                        CARD_RELATION_LABEL[value ?? "blockedBy"]
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {CardRelationKind.literals.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {CARD_RELATION_LABEL[kind]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Select
                  value={relationCardId}
                  onValueChange={(value) => setRelationCardId(value as CardId | null)}
                >
                  <SelectTrigger aria-label="Other card" className="w-auto min-w-40 max-w-56">
                    <SelectValue>
                      {(value: string | null) =>
                        value === null
                          ? "Choose a card"
                          : (cardById.get(value as CardId)?.title ?? "")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {props.cards
                      .filter((entry) => entry.id !== card.id)
                      .map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.title}
                        </SelectItem>
                      ))}
                  </SelectPopup>
                </Select>
                <ActionButton
                  disabled={relationCardId === null}
                  onClick={() => {
                    if (relationCardId === null) return;
                    const input = {
                      cardId: card.id,
                      kind: relationKind,
                      otherCardId: relationCardId,
                    };
                    void addRelation({ environmentId, input }).then((result) => {
                      refused("The relation was not added")(result);
                      if (result._tag === "Success") {
                        undoToast(environmentId, { type: "card.relation.add", ...input });
                      }
                    });
                    setRelationCardId(null);
                  }}
                >
                  Add
                </ActionButton>
              </div>
            ) : null}
          </Section>
        ) : null}

        {editing ? (
          <Section
            label="Budget"
            trailing={
              <span className="tabular-nums">
                ${card.spentUsd.toFixed(2)} spent of a ${card.budgetCapUsd.toFixed(2)} cap
              </span>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Budget cap in dollars"
                type="number"
                min={0}
                step={1}
                className="w-28"
                value={capUsd}
                onChange={(event) => setCapUsd(event.target.value)}
              />
              <ActionButton
                disabled={!Number.isFinite(cap) || cap <= 0 || cap === card.budgetCapUsd}
                onClick={() =>
                  void setBudget({ environmentId, input: { cardId: card.id, capUsd: cap } }).then(
                    refused("The budget was not set"),
                  )
                }
              >
                Set cap
              </ActionButton>
              {card.unpricedTurns > 0 ? (
                card.acceptsUnpriced ? (
                  <RowLink
                    onClick={() =>
                      decideOn("card.unpriced.refuse", "The card still runs uncapped")
                    }
                  >
                    Stop running uncapped
                  </RowLink>
                ) : (
                  <ActionButton
                    onClick={() =>
                      decideOn("card.unpriced.accept", "The card was not allowed to run uncapped")
                    }
                  >
                    Run uncapped
                  </ActionButton>
                )
              ) : null}
            </div>
          </Section>
        ) : null}

        <Section label="Activity">
          <Group>
            <button
              type="button"
              aria-expanded={activityOpen}
              className="flex min-h-[46px] cursor-pointer items-center gap-3 px-4 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() => setActivityOpen((current) => !current)}
            >
              <span className="tabular-nums text-muted-foreground">
                {activities.length} {activities.length === 1 ? "event" : "events"}
              </span>
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "ms-auto size-3 text-tertiary-label transition-transform duration-150 motion-reduce:transition-none",
                  activityOpen && "rotate-90",
                )}
              />
            </button>
          </Group>
          {activityOpen ? (
            <CardActivityTimeline
              activities={activities}
              agents={props.agents}
              error={activity.error}
            />
          ) : null}
        </Section>
      </SheetPanel>

      {card.status === "inReview" ||
      card.status === "triage" ||
      card.status === "landed" ||
      (open && card.paused !== null) ? (
        <div className="flex flex-col gap-2.5 bg-sidebar px-7 py-4 shadow-[inset_0_0.5px_var(--border)]">
          {requesting ? (
            <Textarea
              aria-label="What to change before it lands"
              placeholder="What to change before it lands"
              value={message}
              autoFocus
              onChange={(event) => setMessage(event.target.value)}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2.5">
            {branch !== null ? (
              <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-tertiary-label">
                <BranchGlyph className="shrink-0" />
                <span className="truncate">{branch}</span>
              </span>
            ) : null}
            <div className="ms-auto flex flex-wrap items-center gap-2.5">
              {card.status === "landed" ? (
                <RevertControl card={card} cards={props.cards} environmentId={environmentId} />
              ) : card.status !== "inReview" && card.status !== "triage" ? (
                <ActionButton
                  tone="primary"
                  className={FOOTER_BUTTON}
                  onClick={() => decideOn("card.resume", "The card was not resumed")}
                >
                  Resume
                </ActionButton>
              ) : card.status === "triage" ? (
                <>
                  <ActionButton
                    className={FOOTER_BUTTON}
                    onClick={() => decideOn("card.abandon", "The card was not dropped")}
                  >
                    Drop
                  </ActionButton>
                  <ApproveAndStart
                    card={card}
                    agents={props.agents}
                    environmentId={environmentId}
                    className={cn(FOOTER_BUTTON, "text-[13px]")}
                  />
                </>
              ) : requesting ? (
                <>
                  <ActionButton
                    className={FOOTER_BUTTON}
                    onClick={() => {
                      setRequesting(false);
                      setMessage("");
                    }}
                  >
                    Cancel
                  </ActionButton>
                  <ActionButton
                    tone="primary"
                    className={FOOTER_BUTTON}
                    disabled={trimmedMessage.length === 0}
                    onClick={() => {
                      send("review");
                      setRequesting(false);
                    }}
                  >
                    Request Changes
                  </ActionButton>
                </>
              ) : (
                <>
                  <ActionButton className={FOOTER_BUTTON} onClick={() => setRequesting(true)}>
                    Request Changes
                  </ActionButton>
                  {merge !== undefined ? (
                    <DisabledReason reason={merge.reason}>
                      <ActionButton
                        tone="primary"
                        className={FOOTER_BUTTON}
                        disabled={merge.type === null}
                        onClick={() => {
                          if (merge.type !== null)
                            decideOn(merge.type, "The card stays where it was");
                        }}
                      >
                        {merge.label}
                      </ActionButton>
                    </DisabledReason>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * "Restore to before turn n" on a paused card: puts its worktree back to an owner checkpoint. The
 * owner thread's checkpoints load only while this shows, which is only for a paused card's sheet.
 */
function RestoreControl(props: {
  readonly card: OrchestrationCardShell;
  readonly environmentId: EnvironmentId;
}) {
  const { card, environmentId } = props;
  const threadId = card.ownerSession?.threadId ?? null;
  const thread = useThread(threadId === null ? null : scopeThreadRef(environmentId, threadId));
  const restore = useAtomCommand(cardEnvironment.restoreCheckpoint);
  const [turn, setTurn] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const turns = (thread?.checkpoints ?? [])
    .map((checkpoint) => checkpoint.checkpointTurnCount)
    .filter((count) => count > 0);
  if (turns.length === 0) return null;
  const refusal = restoreRefusal(card);
  const chosen = turn ?? String(turns.at(-1));

  return (
    <Row className="flex-wrap py-2">
      <span className="text-muted-foreground">Restore the worktree</span>
      <Trail>
        <Select value={chosen} onValueChange={(value) => setTurn(value)}>
          <SelectTrigger aria-label="Turn to restore before" className="w-auto min-w-36">
            <SelectValue>{(value: string | null) => `Before turn ${value ?? chosen}`}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {turns.map((count) => (
              <SelectItem key={count} value={String(count)}>
                Before turn {count}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <DisabledReason reason={refusal}>
          <ActionButton
            disabled={refusal !== null || sending}
            onClick={async () => {
              setSending(true);
              const result = await restore({
                environmentId,
                input: { cardId: card.id, turnCount: Number(chosen) - 1 },
              });
              setSending(false);
              toastCommandFailure(
                result,
                "The worktree was not restored",
                "The request was refused.",
              );
            }}
          >
            Restore
          </ActionButton>
        </DisabledReason>
      </Trail>
    </Row>
  );
}

const OUTCOME_LABEL: Record<CardOutcome["state"], string> = {
  success: "Success",
  flawed: "Flawed",
  blocked: "Blocked",
  manual: "Manual",
};

/**
 * How a finished card turned out: Iskra decides it a week after landing (a blocked card at once),
 * and a person can set it with a note. A landed card can also be reverted, which makes a new card.
 */
function OutcomeControls(props: {
  readonly card: OrchestrationCardShell;
  readonly cards: ReadonlyArray<OrchestrationCardShell>;
  readonly environmentId: EnvironmentId;
}) {
  const { card, environmentId } = props;
  const setOutcome = useAtomCommand(cardEnvironment.setOutcome);
  const [state, setState] = useState<CardOutcome["state"] | null>(card.outcome?.state ?? null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const heuristic = card.outcome?.signals.find((signal) => signal.code !== "outcomeSetByPerson");

  let summary: ReactNode;
  if (card.outcome === null) {
    summary =
      card.status === "landed"
        ? "Iskra decides how it turned out a week after it landed."
        : "No outcome yet.";
  } else {
    summary = `${OUTCOME_LABEL[card.outcome.state]}${heuristic !== undefined ? ` · ${heuristic.text} (a heuristic)` : ""}`;
  }

  return (
    <Group>
      <Row className="py-2.5">
        <span className="text-muted-foreground">{summary}</span>
      </Row>
      <Row className="flex-wrap gap-2 py-2">
        <Select
          value={state}
          onValueChange={(value) => {
            if (value !== null) setState(value);
          }}
        >
          <SelectTrigger aria-label="Outcome" className="w-auto min-w-28">
            <SelectValue>
              {(value: CardOutcome["state"] | null) =>
                value === null ? "Choose" : OUTCOME_LABEL[value]
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(Object.keys(OUTCOME_LABEL) as CardOutcome["state"][]).map((entry) => (
              <SelectItem key={entry} value={entry}>
                {OUTCOME_LABEL[entry]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Input
          aria-label="Why"
          placeholder="Why"
          className="min-w-0 flex-1"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <DisabledReason
          className="ms-auto"
          reason={
            state === null
              ? "Choose how it turned out."
              : note.trim().length === 0
                ? "Say why you're setting it."
                : null
          }
        >
          <ActionButton
            disabled={sending || state === null || note.trim().length === 0}
            onClick={async () => {
              if (state === null) return;
              setSending(true);
              const result = await setOutcome({
                environmentId,
                input: { cardId: card.id, outcome: state, note: note.trim() },
              });
              setSending(false);
              toastCommandFailure(result, "The outcome was not set", "The request was refused.");
              if (result._tag === "Success") setNote("");
            }}
          >
            Set outcome
          </ActionButton>
        </DisabledReason>
      </Row>
    </Group>
  );
}

/** "Revert…" in a landed card's footer: confirms, then makes a new card that reverts its commit. */
function RevertControl(props: {
  readonly card: OrchestrationCardShell;
  readonly cards: ReadonlyArray<OrchestrationCardShell>;
  readonly environmentId: EnvironmentId;
}) {
  const { card, environmentId } = props;
  const revert = useAtomCommand(cardEnvironment.revert);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const refusal = revertRefusal(card, props.cards);
  return (
    <>
      <DisabledReason reason={refusal}>
        <ActionButton
          tone="destructive"
          className={FOOTER_BUTTON}
          disabled={refusal !== null || sending}
          onClick={() => setConfirming(true)}
        >
          Revert…
        </ActionButton>
      </DisabledReason>
      <AlertDialog open={confirming} onOpenChange={(next) => !sending && setConfirming(next)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert {card.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              Iskra makes a new card that reverts this card's commit on the base branch, runs the
              checks, and sends it to review. Nothing lands until you approve its merge.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={sending} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={sending}
              onClick={async () => {
                setSending(true);
                const result = await revert({
                  environmentId,
                  input: { cardId: card.id, revertCardId: CardId.make(randomUUID()) },
                });
                setSending(false);
                setConfirming(false);
                toastCommandFailure(
                  result,
                  "The card was not reverted",
                  "The request was refused.",
                );
              }}
            >
              Revert
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

const NO_ACTIVITIES: ReadonlyArray<CardActivity> = [];
const NO_EVIDENCE_ITEMS: ReadonlyArray<CardEvidenceItem> = [];
