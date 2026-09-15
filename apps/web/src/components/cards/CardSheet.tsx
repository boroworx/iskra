import {
  BOARD_COLUMN_LABEL,
  CARD_RELATION_LABEL,
  CARD_SESSION_LABEL,
  boardColumnOf,
  cardMoveActions,
  isCardSnoozed,
  reasonLabel,
  reasonLine,
} from "@iskra/client-runtime/cards";
import type { AtomCommandResult } from "@iskra/client-runtime/state/runtime";
import {
  CardRelationKind,
  MessageId,
  projectOrchestrationOf,
  type CardEvidenceItem,
  type AgentId,
  type CardActivity,
  type CardId,
  type CardStatus,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
} from "@iskra/contracts";
import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { randomUUID } from "~/lib/utils";
import { cardEnvironment } from "~/state/cards";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { ApproveAndStart } from "../channels/CardProposal";
import { CardActivityTimeline } from "./CardActivityTimeline";
import { AttentionActions, RefsChangedControls } from "./CardAttention";
import { CardCriteria, CardPreviewPanel, CardQuestions, cardQuestionsOf } from "./CardContract";
import { CardLandingPanel, CardReview, CheckpointControls } from "./CardReviewPanel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../ui/sheet";
import { Textarea } from "../ui/textarea";
import { toastCommandFailure } from "../toastCommandFailure";
import { DisabledReason } from "./DisabledReason";

const HOUR_MS = 60 * 60_000;

const refused = (title: string) => (result: AtomCommandResult<unknown, unknown>) =>
  toastCommandFailure(result, title, "The request was refused.");

function statusLabel(status: CardStatus): string {
  return status === "landed"
    ? "Landed"
    : status === "abandoned"
      ? "Abandoned"
      : BOARD_COLUMN_LABEL[boardColumnOf(status)];
}

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
  return (
    <Sheet
      open={props.card !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <SheetPopup className="max-w-lg">
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
  const decideOn = (type: Parameters<typeof decide>[0]["input"]["type"], failure: string) =>
    void decide({ environmentId, input: { type, cardId: card.id } }).then(refused(failure));
  const sessionAgentId = card.ownerSession?.agentId ?? card.delegateAgentId;
  const sessionAgent = props.agents.find((agent) => agent.id === sessionAgentId);
  const edited = title.trim() !== card.title || spec !== card.spec;
  const snoozed = isCardSnoozed(card, props.now);
  const trimmedMessage = message.trim();
  const cap = Number(capUsd);

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

  return (
    <>
      <SheetHeader>
        <SheetTitle className="pe-8">{card.title}</SheetTitle>
        <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>
            {statusLabel(card.status)}
            {card.status === "landed" && card.landing?.mergedOnHostUrl !== undefined ? (
              <>
                {" · "}
                <a
                  href={card.landing.mergedOnHostUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                >
                  merged on the host
                </a>
              </>
            ) : null}
          </span>
          {card.ownerSession !== null ? (
            <span>· {CARD_SESSION_LABEL[card.ownerSession.state]}</span>
          ) : null}
          {sessionAgent !== undefined ? (
            <Link
              to="/agents/$environmentId/$agentId"
              params={{ environmentId, agentId: sessionAgent.id }}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              · Open @{sessionAgent.name}
            </Link>
          ) : null}
          {card.status === "ready" || card.attemptGroupId !== null ? (
            <Link
              to="/attempts/$environmentId/$cardId"
              params={{ environmentId, cardId: card.id }}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              · Attempts
            </Link>
          ) : null}
        </p>
      </SheetHeader>
      <SheetPanel className="flex flex-col gap-5">
        <Section label="Move">
          {open && card.status !== "triage" ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  card.paused === null
                    ? decideOn("card.pause", "The card was not paused")
                    : decideOn("card.resume", "The card was not resumed")
                }
              >
                {card.paused === null ? "Pause" : "Resume"}
              </Button>
              {card.paused !== null ? (
                <DisabledReason reason={reasonLabel(card.paused.reason).hint}>
                  <span className="text-xs text-muted-foreground">
                    Paused · {reasonLine(card.paused.reason)}
                  </span>
                </DisabledReason>
              ) : card.waitReason !== null ? (
                <DisabledReason reason={reasonLabel(card.waitReason).hint}>
                  <span className="text-xs text-muted-foreground">
                    {reasonLine(card.waitReason)}
                  </span>
                </DisabledReason>
              ) : null}
            </div>
          ) : null}
          {card.status === "landed" ? (
            <p className="text-xs text-muted-foreground">A landed card is finished.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {cardMoveActions(card.status).map((action) => (
                <DisabledReason key={action.column} reason={action.reason}>
                  <Button
                    size="sm"
                    variant={action.type === "card.abandon" ? "destructive-outline" : "outline"}
                    disabled={action.type === null}
                    onClick={() => {
                      if (action.type !== null)
                        decideOn(action.type, "The card stays where it was");
                    }}
                  >
                    {action.label}
                  </Button>
                </DisabledReason>
              ))}
            </div>
          )}
          {card.status === "triage" ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <ApproveAndStart card={card} agents={props.agents} environmentId={environmentId} />
            </div>
          ) : null}
          {card.status === "triage" && card.proposalReasoning !== null ? (
            <p className="text-xs text-muted-foreground">{card.proposalReasoning}</p>
          ) : null}
        </Section>

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
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
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
              </Button>
              {card.specState === "draft" ? (
                <>
                  <DisabledReason
                    reason={
                      card.spec.trim().length === 0
                        ? "Write and save a spec first, or skip it."
                        : null
                    }
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={card.spec.trim().length === 0 || edited}
                      onClick={() => decideOn("card.spec.approve", "The spec was not approved")}
                    >
                      Approve spec
                    </Button>
                  </DisabledReason>
                  <Button
                    size="sm"
                    variant="ghost-muted"
                    onClick={() => decideOn("card.spec.skip", "The spec was not skipped")}
                  >
                    Skip spec
                  </Button>
                </>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground">
                    Spec {card.specState === "approved" ? "approved" : "skipped"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost-muted"
                    onClick={() => decideOn("card.spec.reopen", "The spec was not reopened")}
                  >
                    Reopen spec
                  </Button>
                </>
              )}
            </div>
          ) : null}
        </Section>

        {open && card.attention.length > 0 ? (
          <Section label="Waiting on you">
            <ol className="flex flex-col gap-3">
              {card.attention.map((item) => (
                <li key={item.activityId} className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">
                    {reasonLabel({ code: item.code, text: item.text }).label}
                  </span>
                  <p className="whitespace-pre-wrap break-words text-sm">{item.text}</p>
                  <AttentionActions card={card} item={item} environmentId={environmentId} onCard />
                </li>
              ))}
            </ol>
          </Section>
        ) : null}

        {open ? <CardQuestionsSection card={card} environmentId={environmentId} /> : null}

        {open && card.checkpoint !== null ? (
          <Section label="Checkpoint">
            <CheckpointControls card={card} environmentId={environmentId} />
          </Section>
        ) : null}

        {open
          ? card.openElicitations
              .filter((question) => question.kind === "refsChanged")
              .map((report) => (
                <Section key={report.activityId} label="Refs changed outside this card">
                  <RefsChangedControls
                    cardId={card.id}
                    report={report}
                    environmentId={environmentId}
                  />
                </Section>
              ))
          : null}

        {card.evidence !== null || card.status === "inReview" || card.status === "landing" ? (
          <Section label="Review">
            {card.status === "inReview" ? (
              // Cards that reached review before evidence existed get theirs here; any card may recapture.
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() => decideOn("card.evidence.capture", "Evidence was not requested")}
              >
                Capture evidence
              </Button>
            ) : null}
            <CardReview
              card={card}
              evidence={evidence}
              activities={activities}
              environmentId={environmentId}
            />
          </Section>
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

        <div ref={criteriaSection} className="contents">
          <Section label="Acceptance criteria">
            <CardCriteria card={card} environmentId={environmentId} />
          </Section>
        </div>

        {card.status === "triage" || card.status === "ready" ? (
          <Section label="Before it starts">
            <CardPreviewPanel
              estimate={card.estimate}
              agent={
                props.agents.find(
                  (agent) => agent.id === (card.delegateAgentId ?? card.suggestedAgentId),
                ) ?? null
              }
            />
          </Section>
        ) : null}

        {open ? (
          <div ref={agentSection} className="contents">
          <Section label="Agent">
            <div className="flex flex-wrap items-center gap-1.5">
              <Select
                value={card.delegateAgentId}
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
                  {props.agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      @{agent.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {card.delegateAgentId !== null ? (
                <Button
                  size="sm"
                  variant="ghost-muted"
                  onClick={() => decideOn("card.unassign", "The agent was not unassigned")}
                >
                  Unassign
                </Button>
              ) : null}
            </div>
            <Textarea
              aria-label="Message to the card's agent"
              placeholder={
                card.status === "inReview"
                  ? "A message, or what to change before it lands"
                  : "A message to the card's agent"
              }
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
            <div className="flex flex-wrap gap-1.5">
              <DisabledReason
                reason={card.delegateAgentId === null ? "Assign an agent first." : null}
              >
                <Button
                  size="sm"
                  variant="outline"
                  disabled={card.delegateAgentId === null || trimmedMessage.length === 0}
                  onClick={() => send("message")}
                >
                  Send to agent
                </Button>
              </DisabledReason>
              {card.status === "inReview" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={trimmedMessage.length === 0}
                  onClick={() => send("review")}
                >
                  Request changes
                </Button>
              ) : null}
            </div>
          </Section>
          </div>
        ) : null}

        <Section label="Relations">
          {card.relations.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {card.relations.map((relation) => (
                <li
                  key={`${relation.kind}:${relation.cardId}`}
                  className="flex min-w-0 items-center gap-2 text-sm"
                >
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {CARD_RELATION_LABEL[relation.kind]}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {cardById.get(relation.cardId)?.title ?? "A card on another board"}
                  </span>
                  <Button
                    size="icon-xs"
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
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              value={relationKind}
              onValueChange={(value) => setRelationKind(value ?? "blockedBy")}
            >
              <SelectTrigger aria-label="Relation" className="w-auto min-w-28">
                <SelectValue>
                  {(value: CardRelationKind | null) => CARD_RELATION_LABEL[value ?? "blockedBy"]}
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
                    value === null ? "Choose a card" : (cardById.get(value as CardId)?.title ?? "")
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
            <Button
              size="sm"
              variant="outline"
              disabled={relationCardId === null}
              onClick={() => {
                if (relationCardId === null) return;
                void addRelation({
                  environmentId,
                  input: { cardId: card.id, kind: relationKind, otherCardId: relationCardId },
                }).then(refused("The relation was not added"));
                setRelationCardId(null);
              }}
            >
              Add
            </Button>
          </div>
        </Section>

        <Section label="Budget">
          <p className="text-xs tabular-nums text-muted-foreground">
            ${card.spentUsd.toFixed(2)} spent of a ${card.budgetCapUsd.toFixed(2)} cap
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              aria-label="Budget cap in dollars"
              type="number"
              min={0}
              step={1}
              className="w-28"
              value={capUsd}
              onChange={(event) => setCapUsd(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!Number.isFinite(cap) || cap <= 0 || cap === card.budgetCapUsd}
              onClick={() =>
                void setBudget({ environmentId, input: { cardId: card.id, capUsd: cap } }).then(
                  refused("The budget was not set"),
                )
              }
            >
              Set cap
            </Button>
            {card.unpricedTurns > 0 ? (
              card.acceptsUnpriced ? (
                <Button
                  size="sm"
                  variant="ghost-muted"
                  onClick={() => decideOn("card.unpriced.refuse", "The card still runs uncapped")}
                >
                  Stop running uncapped
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    decideOn("card.unpriced.accept", "The card was not allowed to run uncapped")
                  }
                >
                  Run uncapped
                </Button>
              )
            ) : null}
          </div>
        </Section>

        {open ? (
          <Section label="Needs you">
            <div className="flex flex-wrap items-center gap-1.5">
              {snoozed ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    Snoozed{" "}
                    {card.snoozedUntil === null
                      ? "until it changes"
                      : `until ${new Date(card.snoozedUntil).toLocaleString()}`}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost-muted"
                    onClick={() =>
                      void unsnooze({ environmentId, input: { cardId: card.id } }).then(
                        refused("The card was not woken"),
                      )
                    }
                  >
                    Wake
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="ghost-muted"
                    onClick={() =>
                      void snooze({
                        environmentId,
                        input: {
                          cardId: card.id,
                          snoozedUntil: new Date(Date.now() + HOUR_MS).toISOString(),
                        },
                      }).then(refused("The card was not snoozed"))
                    }
                  >
                    Snooze 1 hour
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost-muted"
                    onClick={() =>
                      void snooze({
                        environmentId,
                        input: { cardId: card.id, snoozedUntil: null },
                      }).then(refused("The card was not snoozed"))
                    }
                  >
                    Snooze until it changes
                  </Button>
                </>
              )}
            </div>
          </Section>
        ) : null}

        <Section label="Activity">
          <CardActivityTimeline
            activities={activities}
            agents={props.agents}
            error={activity.error}
          />
        </Section>
      </SheetPanel>
    </>
  );
}

const NO_ACTIVITIES: ReadonlyArray<CardActivity> = [];
const NO_EVIDENCE_ITEMS: ReadonlyArray<CardEvidenceItem> = [];

/** The card's open questions, titled only when there are some it answers in place. */
function CardQuestionsSection(props: Parameters<typeof CardQuestions>[0]) {
  return cardQuestionsOf(props.card).length > 0 ? (
    <Section label="Questions for you">
      <CardQuestions {...props} />
    </Section>
  ) : null;
}

function Section(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section aria-label={props.label} className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{props.label}</h3>
      {props.children}
    </section>
  );
}
