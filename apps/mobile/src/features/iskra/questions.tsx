import { elicitationAnswer } from "@iskra/client-runtime/cards";
import {
  MessageId,
  type CardCheckpointDecision,
  type CardId,
  type CardOpenElicitation,
  type Elicitation,
  type EnvironmentId,
  type OrchestrationCardShell,
  type OrchestrationChannelMessage,
} from "@iskra/contracts";
import { openCheckpointActivityId } from "@iskra/client-runtime/cards";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import { ActionButton, Body, ButtonRow, Muted } from "./components";
import { cardEnvironment, channelEnvironment, useRefusableCommand } from "./state";

/** Multi-line text entry in the grouped-list style. */
export function Field(props: {
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly placeholder: string;
  readonly multiline?: boolean;
  readonly editable?: boolean;
}) {
  return (
    <TextInput
      accessibilityLabel={props.placeholder}
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColorClassName="accent-placeholder"
      editable={props.editable}
      multiline={props.multiline}
      className="min-h-10 rounded-[10px] bg-subtle px-3 py-2 text-[15px] text-foreground"
    />
  );
}

/**
 * A question's answers as buttons, the recommended one filled, with a written answer when the
 * question takes one. `onAnswer` gets the option's label or the trimmed words.
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
    <View className="gap-2">
      <ButtonRow>
        {elicitation.options.map((option) => (
          <ActionButton
            key={option.id}
            label={option.label}
            kind={option.id === elicitation.recommendedOptionId ? "primary" : "plain"}
            disabled={props.disabled}
            onPress={() => {
              const answer = elicitationAnswer(elicitation, { optionId: option.id });
              if (answer !== null) props.onAnswer(answer);
            }}
          />
        ))}
      </ButtonRow>
      {elicitation.allowText ? (
        <View className="flex-row items-end gap-2">
          <View className="flex-1">
            <Field value={text} onChangeText={setText} placeholder="Or write your own answer" multiline />
          </View>
          <ActionButton
            label="Send"
            disabled={props.disabled || written === null}
            onPress={() => {
              if (written === null) return;
              props.onAnswer(written);
              setText("");
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

/** One open question on a card, answered in place. */
export function CardQuestion(props: {
  readonly environmentId: EnvironmentId;
  readonly cardId: CardId;
  readonly question: CardOpenElicitation;
}) {
  const answer = useRefusableCommand(cardEnvironment.answerElicitation);
  const [sending, setSending] = useState(false);
  return (
    <View className="gap-2">
      {props.question.question.length > 0 ? <Body strong>{props.question.question}</Body> : null}
      {props.question.proposedCriteria === undefined ? null : (
        <View className="gap-1">
          {props.question.proposedCriteria.map((criterion, index) => (
            <Body key={criterion.id}>
              {index + 1}. {criterion.text}
              {criterion.verification === "manual" ? " (checked by a person)" : ""}
            </Body>
          ))}
        </View>
      )}
      <ElicitationOptions
        elicitation={props.question}
        disabled={sending}
        onAnswer={async (choice) => {
          setSending(true);
          await answer(
            {
              environmentId: props.environmentId,
              input: {
                cardId: props.cardId,
                activityId: props.question.activityId,
                optionId: choice.optionId,
                body: choice.body,
              },
            },
            "The answer was not sent",
          );
          setSending(false);
        }}
      />
    </View>
  );
}

/** A lead's question in a channel, answered with one tap; once answered it says so. */
export function ChannelQuestion(props: {
  readonly environmentId: EnvironmentId;
  readonly message: OrchestrationChannelMessage & { readonly elicitation: Elicitation };
}) {
  const { message } = props;
  const answer = useRefusableCommand(channelEnvironment.answerElicitation);
  const [sending, setSending] = useState(false);
  if (message.answeredAt !== undefined) return <Muted>Answered</Muted>;
  return (
    <View className="gap-2 pt-1">
      <Body strong>{message.elicitation.question}</Body>
      <ElicitationOptions
        elicitation={message.elicitation}
        disabled={sending}
        onAnswer={async (choice) => {
          setSending(true);
          await answer(
            {
              environmentId: props.environmentId,
              input: {
                channelId: message.channelId,
                questionMessageId: message.id,
                messageId: MessageId.make(uuidv4()),
                optionId: choice.optionId,
                body: choice.body,
              },
            },
            "The answer was not sent",
          );
          setSending(false);
        }}
      />
    </View>
  );
}

const CHECKPOINT_ANSWER: Record<CardCheckpointDecision, string> = {
  continue: "Continue",
  redirect: "Redirect",
  stop: "Stop",
};

/** The owner's checkpoint: continue, redirect with a note, or stop (which pauses the card). */
export function CheckpointControls(props: {
  readonly environmentId: EnvironmentId;
  readonly card: Pick<OrchestrationCardShell, "id" | "checkpoint" | "openElicitations">;
}) {
  const answer = useRefusableCommand(cardEnvironment.answerElicitation);
  const [note, setNote] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [sending, setSending] = useState(false);
  const checkpoint = props.card.checkpoint;
  const activityId = openCheckpointActivityId(props.card);
  if (checkpoint === null || activityId === null) return null;

  const send = async (decision: CardCheckpointDecision) => {
    const trimmed = note.trim();
    setSending(true);
    const sent = await answer(
      {
        environmentId: props.environmentId,
        input: {
          cardId: props.card.id,
          activityId,
          optionId: decision,
          body: trimmed.length > 0 ? trimmed : CHECKPOINT_ANSWER[decision],
        },
      },
      "The checkpoint was not answered",
    );
    setSending(false);
    if (sent) {
      setNote("");
      setRedirecting(false);
    }
  };

  return (
    <View className="gap-2">
      <Body>{checkpoint.whatToTry}</Body>
      {checkpoint.question !== null ? <Body strong>{checkpoint.question}</Body> : null}
      {redirecting ? (
        <Field value={note} onChangeText={setNote} placeholder="What the agent should do instead" multiline />
      ) : null}
      <ButtonRow>
        <ActionButton label="Continue" kind="primary" disabled={sending} onPress={() => void send("continue")} />
        {redirecting ? (
          <ActionButton
            label="Send redirect"
            disabled={sending || note.trim().length === 0}
            onPress={() => void send("redirect")}
          />
        ) : (
          <ActionButton label="Redirect…" disabled={sending} onPress={() => setRedirecting(true)} />
        )}
        <ActionButton label="Stop" kind="destructive" disabled={sending} onPress={() => void send("stop")} />
      </ButtonRow>
    </View>
  );
}
