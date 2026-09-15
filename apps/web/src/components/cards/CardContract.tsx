import { cardPreview } from "@iskra/client-runtime/card-preview";
import {
  CARD_QUESTION_KINDS,
  delegateReadOnlyWarning,
  elicitationAnswer,
} from "@iskra/client-runtime/cards";
import {
  MessageId,
  type CardCriterion,
  type CardEstimate,
  type CardOpenElicitation,
  type Elicitation,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
  type OrchestrationChannelMessage,
} from "@iskra/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn, randomUUID } from "~/lib/utils";
import { cardEnvironment } from "~/state/cards";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastCommandFailure } from "../toastCommandFailure";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AgentAvatar } from "../iskra/AgentAvatar";
import { ActionButton, Group, Row, RowLink, Trail } from "./cardChrome";
import { DisabledReason } from "./DisabledReason";

const VERIFICATION_LABEL: Record<CardCriterion["verification"], string> = {
  automated: "Checked by evidence",
  manual: "Needs your check",
};

/** Criteria being edited: blank rows are kept while typing and dropped when saved. */
export function savedCriteria(
  criteria: ReadonlyArray<CardCriterion>,
): ReadonlyArray<CardCriterion> {
  return criteria.flatMap((criterion) => {
    const text = criterion.text.trim();
    return text.length === 0 ? [] : [{ ...criterion, text }];
  });
}

/**
 * A card's acceptance criteria as editable rows: each an observable outcome, checked by evidence
 * or by a person at review (such as mobile UI).
 */
export function CriteriaEditor(props: {
  readonly criteria: ReadonlyArray<CardCriterion>;
  readonly onChange: (criteria: ReadonlyArray<CardCriterion>) => void;
  readonly disabled?: boolean;
}) {
  const { criteria, onChange } = props;
  const replace = (index: number, next: CardCriterion) =>
    onChange(criteria.map((criterion, at) => (at === index ? next : criterion)));
  const add = () =>
    onChange([
      ...criteria,
      { id: `criterion-${randomUUID().slice(0, 8)}`, text: "", verification: "automated" },
    ]);
  if (criteria.length === 0) {
    return (
      <Group>
        <Row>
          <span className="min-w-0 truncate text-muted-foreground">No criteria yet</span>
          <Trail>
            <RowLink disabled={props.disabled} onClick={add}>
              Add criterion
            </RowLink>
          </Trail>
        </Row>
      </Group>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <ol className="flex flex-col gap-1.5">
        {criteria.map((criterion, index) => (
          <li key={criterion.id} className="flex min-w-0 items-center gap-1.5">
            <Input
              aria-label={`Criterion ${index + 1}`}
              placeholder="An outcome someone can observe"
              className="min-w-0 flex-1"
              value={criterion.text}
              disabled={props.disabled}
              onChange={(event) => replace(index, { ...criterion, text: event.target.value })}
            />
            <Select
              value={criterion.verification}
              disabled={props.disabled}
              onValueChange={(value) => {
                if (value === "automated" || value === "manual") {
                  replace(index, { ...criterion, verification: value });
                }
              }}
            >
              <SelectTrigger aria-label="How it's checked" className="w-auto shrink-0">
                <SelectValue>
                  {(value: CardCriterion["verification"] | null) =>
                    VERIFICATION_LABEL[value ?? "automated"]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="automated">{VERIFICATION_LABEL.automated}</SelectItem>
                <SelectItem value="manual">{VERIFICATION_LABEL.manual}</SelectItem>
              </SelectPopup>
            </Select>
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Remove criterion"
              disabled={props.disabled}
              onClick={() => onChange(criteria.filter((_, at) => at !== index))}
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        variant="ghost-muted"
        className="self-start"
        disabled={props.disabled}
        onClick={add}
      >
        <PlusIcon />
        Add criterion
      </Button>
    </div>
  );
}

/**
 * What starting the card likely means, before it starts: the lead's estimate, who runs it on which
 * model, and a rough cost. A split suggestion shows as text; cards are split by hand for now.
 */
export function CardPreviewPanel(props: {
  readonly estimate: CardEstimate | null;
  readonly agent: Pick<OrchestrationAgentShell, "name" | "modelSelection" | "capabilities"> | null;
  /** The agent's track record on this project, as a routing hint. */
  readonly hint?: string | null;
  /** False where the read-only warning already shows, such as the card sheet's wait row. */
  readonly showReadOnly?: boolean;
}) {
  const preview = cardPreview(props);
  const hint =
    props.hint == null ? null : <p className="text-xs text-muted-foreground">{props.hint}</p>;
  // A warning, not a refusal: the card waits in the queue until the agent can write.
  const readOnly = props.showReadOnly === false ? null : delegateReadOnlyWarning(props.agent);
  const readOnlyWarning =
    readOnly === null ? null : <p className="text-xs text-warning-foreground">{readOnly}</p>;
  if (preview === null) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">
          No estimate for this card.{" "}
          {props.agent === null
            ? ""
            : `@${props.agent.name} on ${props.agent.modelSelection.model}.`}
        </p>
        {readOnlyWarning}
        {hint}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2 text-xs">
      {readOnlyWarning}
      {hint}
      <p className="text-muted-foreground">The lead's estimate</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Size</dt>
        <dd>{preview.size}</dd>
        <dt className="text-muted-foreground">Cost</dt>
        <dd className={preview.splitFirst ? "text-destructive-foreground" : "tabular-nums"}>
          {preview.costLabel}
        </dd>
        {preview.agentName !== null ? (
          <>
            <dt className="text-muted-foreground">Runs as</dt>
            <dd>
              @{preview.agentName} on {preview.model}
            </dd>
          </>
        ) : null}
        {preview.likelyAreas.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Areas</dt>
            <dd className="break-words font-mono">{preview.likelyAreas.join(", ")}</dd>
          </>
        ) : null}
        {preview.risks.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Risks</dt>
            <dd>{preview.risks.join("; ")}</dd>
          </>
        ) : null}
      </dl>
      {preview.split !== null ? (
        <div className="flex flex-col gap-0.5">
          <p>
            <span className="font-medium">Too big, split?</span> {preview.split.reason}
          </p>
          <ul className="list-inside list-disc text-muted-foreground">
            {preview.split.cards.map((card) => (
              <li key={card.title}>{card.title}</li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            Create these as their own cards, then drop this one.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A question's answers as one-click buttons, the recommended one first in weight, with a written
 * answer when the question takes one. `onAnswer` gets the option's label or the trimmed words.
 */
export function ElicitationOptions(props: {
  readonly elicitation: Pick<Elicitation, "options" | "recommendedOptionId" | "allowText">;
  readonly disabled?: boolean;
  readonly onAnswer: (answer: { readonly optionId: string | null; readonly body: string }) => void;
}) {
  const { elicitation } = props;
  const [text, setText] = useState("");
  const written = elicitationAnswer(elicitation, { text });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {elicitation.options.map((option) => {
          const recommended = option.id === elicitation.recommendedOptionId;
          return (
            <button
              key={option.id}
              type="button"
              disabled={props.disabled}
              className={cn(
                "inline-flex min-h-[30px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-left text-[13px] leading-snug font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                recommended
                  ? "bg-primary/18 text-info-foreground"
                  : "bg-secondary hover:bg-secondary/80",
              )}
              onClick={() => {
                const answer = elicitationAnswer(elicitation, { optionId: option.id });
                if (answer !== null) props.onAnswer(answer);
              }}
            >
              {option.label}
              {recommended ? <span className="text-xs opacity-80">(recommended)</span> : null}
            </button>
          );
        })}
      </div>
      {elicitation.allowText ? (
        <form
          className="flex max-w-md gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (written === null) return;
            props.onAnswer(written);
            setText("");
          }}
        >
          <Input
            aria-label="Your own answer"
            placeholder="Or write your own answer"
            className="min-w-0 flex-1"
            value={text}
            disabled={props.disabled}
            onChange={(event) => setText(event.target.value)}
          />
          <ActionButton type="submit" disabled={props.disabled || written === null}>
            Send
          </ActionButton>
        </form>
      ) : null}
    </div>
  );
}

/** A lead's question in a channel, answered in one click; once answered it says so. */
export function ChannelQuestion(props: {
  readonly message: OrchestrationChannelMessage & { readonly elicitation: Elicitation };
  readonly environmentId: EnvironmentId;
}) {
  const { message } = props;
  const answer = useAtomCommand(channelEnvironment.answerElicitation);
  const [sending, setSending] = useState(false);
  if (message.answeredAt !== undefined) {
    return <p className="mt-1 text-xs text-muted-foreground">Answered</p>;
  }
  return (
    <div className="mt-1.5 flex max-w-xl flex-col gap-1.5">
      <p className="text-sm font-medium">{message.elicitation.question}</p>
      <ElicitationOptions
        elicitation={message.elicitation}
        disabled={sending}
        onAnswer={async (choice) => {
          setSending(true);
          const result = await answer({
            environmentId: props.environmentId,
            input: {
              channelId: message.channelId,
              questionMessageId: message.id,
              messageId: MessageId.make(randomUUID()),
              optionId: choice.optionId,
              body: choice.body,
            },
          });
          setSending(false);
          toastCommandFailure(result, "The answer was not sent", "The request was refused.");
        }}
      />
    </div>
  );
}

/** The card's open questions answered in place, from its shell; a request for criteria shows as attention. */
export function cardQuestionsOf(
  card: Pick<OrchestrationCardShell, "openElicitations" | "attention">,
): ReadonlyArray<CardOpenElicitation> {
  return card.openElicitations.filter(
    (open) =>
      CARD_QUESTION_KINDS.includes(open.kind) &&
      !card.attention.some((item) => item.activityId === open.activityId),
  );
}

/** One open question with one-click answers, and the person's own words when it takes them. */
export function CardQuestion(props: {
  readonly cardId: OrchestrationCardShell["id"];
  readonly question: CardOpenElicitation;
  readonly environmentId: EnvironmentId;
  /** The agent asking, shown as its avatar beside the question. */
  readonly agentName?: string | undefined;
}) {
  const answer = useAtomCommand(cardEnvironment.answerElicitation);
  const [sending, setSending] = useState(false);
  return (
    <div className="flex flex-col gap-2.5">
      {props.question.question.length > 0 ? (
        <p className="flex min-w-0 items-start gap-2 text-[13px] text-muted-foreground">
          {props.agentName !== undefined ? (
            <AgentAvatar name={props.agentName} className="mt-px size-[18px] text-[9px]" />
          ) : null}
          <span className="min-w-0 whitespace-pre-wrap break-words">{props.question.question}</span>
        </p>
      ) : null}
      {props.question.proposedCriteria === undefined ? null : (
        <ol className="flex min-w-0 list-decimal flex-col gap-1 ps-5 text-[13px]">
          {props.question.proposedCriteria.map((criterion) => (
            <li key={criterion.id} className="min-w-0 break-words">
              {criterion.text}
              {criterion.verification === "manual" ? (
                <span className="text-muted-foreground"> (checked by a person)</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <ElicitationOptions
        elicitation={props.question}
        disabled={sending}
        onAnswer={async (choice) => {
          setSending(true);
          const result = await answer({
            environmentId: props.environmentId,
            input: {
              cardId: props.cardId,
              activityId: props.question.activityId,
              optionId: choice.optionId,
              body: choice.body,
            },
          });
          setSending(false);
          toastCommandFailure(result, "The answer was not sent", "The request was refused.");
        }}
      />
    </div>
  );
}

/**
 * The card's open questions with one-click answers: the agent's own and proposed criteria changes.
 * A checkpoint's question is answered by the checkpoint controls instead.
 */
export function CardQuestions(props: {
  readonly card: Pick<OrchestrationCardShell, "id" | "openElicitations" | "attention">;
  readonly environmentId: EnvironmentId;
  readonly agentName?: string | undefined;
}) {
  const questions = cardQuestionsOf(props.card);
  if (questions.length === 0) return null;
  return (
    <ol className="flex flex-col gap-4">
      {questions.map((question) => (
        <li key={question.activityId}>
          <CardQuestion
            cardId={props.card.id}
            question={question}
            environmentId={props.environmentId}
            agentName={props.agentName}
          />
        </li>
      ))}
    </ol>
  );
}

const sameCriteria = (left: ReadonlyArray<CardCriterion>, right: ReadonlyArray<CardCriterion>) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * A card's acceptance criteria in the sheet: edited as a draft in triage (Approve & Start confirms
 * them), and saved as confirmed once the card is approved, which tells a running agent.
 */
export function CardCriteria(props: {
  readonly card: Pick<OrchestrationCardShell, "id" | "status" | "acceptance">;
  readonly environmentId: EnvironmentId;
}) {
  const { card, environmentId } = props;
  const setCriteria = useAtomCommand(cardEnvironment.setCriteria);
  const decide = useAtomCommand(cardEnvironment.decide);
  const [criteria, setDraft] = useState(card.acceptance.criteria);
  const saved = savedCriteria(criteria);
  const edited = !sameCriteria(saved, card.acceptance.criteria);
  const open = card.status !== "landed" && card.status !== "abandoned";
  const draft = card.acceptance.state === "draft";

  return (
    <>
      {criteria.length === 0 ? null : (
        <p className="px-4 text-xs text-muted-foreground">
          {card.status === "triage"
            ? "A draft until you approve the card; Approve & Start confirms them."
            : draft
              ? "Not confirmed: work starts only once you confirm them."
              : "Confirmed. Checks and review hold the work to these."}
        </p>
      )}
      <CriteriaEditor criteria={criteria} onChange={setDraft} disabled={!open} />
      {open ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ActionButton
            tone="primary"
            disabled={!edited}
            onClick={() =>
              void setCriteria({ environmentId, input: { cardId: card.id, criteria: saved } }).then(
                (result) =>
                  toastCommandFailure(
                    result,
                    "The criteria were not saved",
                    "The request was refused.",
                  ),
              )
            }
          >
            Save criteria
          </ActionButton>
          {draft && card.status !== "triage" ? (
            <DisabledReason
              reason={
                edited
                  ? "Save your edits first."
                  : card.acceptance.criteria.length === 0
                    ? "Add at least one criterion."
                    : null
              }
            >
              <ActionButton
                disabled={edited || card.acceptance.criteria.length === 0}
                onClick={() =>
                  void decide({
                    environmentId,
                    input: { type: "card.criteria.confirm", cardId: card.id },
                  }).then((result) =>
                    toastCommandFailure(
                      result,
                      "The criteria were not confirmed",
                      "The request was refused.",
                    ),
                  )
                }
              >
                Confirm criteria
              </ActionButton>
            </DisabledReason>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
