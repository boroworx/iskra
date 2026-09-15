import { cardPreview } from "@iskra/client-runtime/card-preview";
import { elicitationAnswer, openCardQuestions } from "@iskra/client-runtime/cards";
import {
  MessageId,
  type CardActivity,
  type CardCriterion,
  type CardEstimate,
  type Elicitation,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
  type OrchestrationChannelMessage,
} from "@iskra/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { cardEnvironment } from "~/state/cards";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastCommandFailure } from "../toastCommandFailure";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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
  return (
    <div className="flex flex-col gap-1.5">
      {criteria.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No criteria yet. Add the outcomes that show the work is done.
        </p>
      ) : null}
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
              size="icon-xs"
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
        onClick={() =>
          onChange([
            ...criteria,
            { id: `criterion-${randomUUID().slice(0, 8)}`, text: "", verification: "automated" },
          ])
        }
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
  readonly agent: Pick<OrchestrationAgentShell, "name" | "modelSelection"> | null;
}) {
  const preview = cardPreview(props);
  if (preview === null) {
    return (
      <p className="text-xs text-muted-foreground">
        No estimate for this card.{" "}
        {props.agent === null ? "" : `@${props.agent.name} on ${props.agent.modelSelection.model}.`}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2 text-xs">
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
  readonly elicitation: Elicitation;
  readonly disabled?: boolean;
  readonly onAnswer: (answer: { readonly optionId: string | null; readonly body: string }) => void;
}) {
  const { elicitation } = props;
  const [text, setText] = useState("");
  const written = elicitationAnswer(elicitation, { text });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {elicitation.options.map((option) => {
          const recommended = option.id === elicitation.recommendedOptionId;
          return (
            <Button
              key={option.id}
              size="sm"
              variant={recommended ? "default" : "outline"}
              disabled={props.disabled}
              onClick={() => {
                const answer = elicitationAnswer(elicitation, { optionId: option.id });
                if (answer !== null) props.onAnswer(answer);
              }}
            >
              {option.label}
              {recommended ? <span className="text-xs opacity-80">(recommended)</span> : null}
            </Button>
          );
        })}
      </div>
      {elicitation.allowText ? (
        <form
          className="flex gap-1.5"
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
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={props.disabled || written === null}
          >
            Send
          </Button>
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

/**
 * The card's open questions with one-click answers: the agent's own and proposed criteria changes.
 * A checkpoint's question is answered by the checkpoint controls instead.
 */
export function CardQuestions(props: {
  readonly card: Pick<OrchestrationCardShell, "id" | "openElicitations">;
  readonly activities: ReadonlyArray<CardActivity>;
  readonly environmentId: EnvironmentId;
}) {
  const answer = useAtomCommand(cardEnvironment.answerElicitation);
  const [sending, setSending] = useState(false);
  const questions = useMemo(
    () => openCardQuestions(props.card, props.activities, QUESTION_KINDS),
    [props.card, props.activities],
  );
  if (questions.length === 0) return null;
  return (
    <ol className="flex flex-col gap-3">
      {questions.map((question) => (
        <li key={question.activityId} className="flex flex-col gap-1.5">
          <p className="whitespace-pre-wrap break-words text-sm font-medium">
            {question.elicitation.question}
          </p>
          <ElicitationOptions
            elicitation={question.elicitation}
            disabled={sending}
            onAnswer={async (choice) => {
              setSending(true);
              const result = await answer({
                environmentId: props.environmentId,
                input: {
                  cardId: props.card.id,
                  activityId: question.activityId,
                  optionId: choice.optionId,
                  body: choice.body,
                },
              });
              setSending(false);
              toastCommandFailure(result, "The answer was not sent", "The request was refused.");
            }}
          />
        </li>
      ))}
    </ol>
  );
}

const QUESTION_KINDS = ["question", "criteriaChange"] as const;

const sameCriteria = (left: ReadonlyArray<CardCriterion>, right: ReadonlyArray<CardCriterion>) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * A card's acceptance criteria in the sheet: edited as a draft in triage (Approve & start confirms
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
      <p className="text-xs text-muted-foreground">
        {card.status === "triage"
          ? "A draft until you approve the card; Approve & start confirms them."
          : draft
            ? "Not confirmed: work starts only once you confirm them."
            : "Confirmed. Checks and review hold the work to these."}
      </p>
      <CriteriaEditor criteria={criteria} onChange={setDraft} disabled={!open} />
      {open ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
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
          </Button>
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
              <Button
                size="sm"
                variant="outline"
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
              </Button>
            </DisabledReason>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
