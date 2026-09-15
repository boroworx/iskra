import { cardSparkState, cardStatusPill, outcomePill } from "@iskra/client-runtime/card-face";
import {
  CARD_QUESTION_KINDS,
  REASON_LABEL,
  cardMoveActions,
  cardVerificationRequired,
  filterCardActivities,
  reasonLine,
  verifierMergeRefusal,
  type CardActivityFilter,
} from "@iskra/client-runtime/cards";
import type { CardDecisionInput } from "@iskra/client-runtime/operations";
import { PLAN_CHILD_STATE_LABEL, planDraftLine, planSlices } from "@iskra/client-runtime/plan-view";
import { EMPTY_CARD_ACTIVITY, applyCardStreamItem } from "@iskra/client-runtime/state/card-activity";
import { UNDOABLE_LABEL, undoCommandOf, type UndoCommand } from "@iskra/client-runtime/undo";
import {
  CardId,
  MessageId,
  projectOrchestrationOf,
  type CardActivity,
  type CardActivityKind,
  type CardAttention,
  type CardCriterion,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationCardShell,
  type OrchestrationCardStreamItem,
} from "@iskra/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { memo, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { CardLanding, CardReview, currentEvidenceItems } from "./CardReview";
import {
  ActionButton,
  AgentAvatar,
  Body,
  ButtonRow,
  Group,
  Muted,
  RoundDots,
  Row,
  Segmented,
  SpendBar,
  StatusPill,
  TONE_COLOR,
} from "./components";
import { CardQuestion, CheckpointControls, ElicitationOptions, Field } from "./questions";
import {
  cardEnvironment,
  olderCardActivity,
  useEnvironmentAgents,
  useEnvironmentCards,
  useRefusableCommand,
} from "./state";

type CardParams = StaticScreenProps<{ readonly environmentId: string; readonly cardId: string }>;
type DecisionType = CardDecisionInput["type"];

const NO_ACTIVITIES: ReadonlyArray<CardActivity> = [];
const PAGE_SIZE = 30;
const UNDO_MS = 8_000;

/** Decisions an Undo bar can take back, as client-runtime's `undoCommandOf` reverses them. */
const isUndoable = (type: DecisionType): type is "card.pause" | "card.abandon" | "card.unapprove" =>
  type === "card.pause" || type === "card.abandon" || type === "card.unapprove";

/** One card and every decision on it that mobile carries, from the same rules as the web sheet. */
export function CardRouteScreen(props: CardParams) {
  const environmentId = props.route.params.environmentId as EnvironmentId;
  const cardId = props.route.params.cardId;
  const cards = useEnvironmentCards(environmentId);
  const agents = useEnvironmentAgents(environmentId);
  const card = cards.find((entry) => entry.id === cardId);
  if (card === undefined) {
    return (
      <View className="flex-1 items-center justify-center bg-screen px-8">
        <NativeStackScreenOptions options={{ title: "Card" }} />
        <Muted>This card isn't on this environment's board.</Muted>
      </View>
    );
  }
  return <CardScreenBody key={card.id} environmentId={environmentId} card={card} cards={cards} agents={agents} />;
}

function CardScreenBody(props: {
  readonly environmentId: EnvironmentId;
  readonly card: OrchestrationCardShell;
  readonly cards: ReadonlyArray<OrchestrationCardShell>;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
}) {
  const { card, environmentId } = props;
  const navigation = useNavigation();
  const decide = useRefusableCommand(cardEnvironment.decide);
  const postMessage = useRefusableCommand(cardEnvironment.postMessage);
  const reviewComment = useRefusableCommand(cardEnvironment.reviewComment);
  const approveAndStart = useRefusableCommand(cardEnvironment.approveAndStart);
  const dismiss = useRefusableCommand(cardEnvironment.dismissAttention);
  const forward = useRefusableCommand(cardEnvironment.forwardComment);
  const revert = useRefusableCommand(cardEnvironment.revert);
  const undoCommand = useRefusableCommand(cardEnvironment.undo);
  const [undo, setUndo] = useState<{ readonly label: string; readonly command: UndoCommand } | null>(null);
  const [message, setMessage] = useState("");

  const activity = useEnvironmentQuery(cardEnvironment.activity({ environmentId, input: { cardId: card.id } }));
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === card.projectId,
  );
  const policy = useMemo(() => projectOrchestrationOf(project ?? {}), [project]);
  const agentOf = (id: string | null) => props.agents.find((agent) => agent.id === id);
  const sessionAgent = agentOf(card.ownerSession?.agentId ?? card.delegateAgentId);
  const builder = agentOf(card.delegateAgentId);
  const outcome = outcomePill(card.outcome);
  const verificationRequired = cardVerificationRequired(card, policy, builder);
  const mergeRefusal = verifierMergeRefusal(card, verificationRequired);
  const items = currentEvidenceItems(card, activity.data?.evidence ?? null);
  const open = card.status !== "landed" && card.status !== "abandoned";
  const questions = card.openElicitations.filter(
    (question) =>
      CARD_QUESTION_KINDS.includes(question.kind) &&
      !card.attention.some((item) => item.activityId === question.activityId),
  );
  const suggested = agentOf(card.suggestedAgentId);

  useEffect(() => {
    if (undo === null) return;
    const timeout = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(timeout);
  }, [undo]);

  const decideOn = async (type: DecisionType, failure: string) => {
    const done = await decide({ environmentId, input: { type, cardId: card.id } }, failure);
    if (!done || !isUndoable(type)) {
      setUndo(null);
      return;
    }
    const command = undoCommandOf({ type, cardId: card.id });
    setUndo(command === null ? null : { label: UNDOABLE_LABEL[type], command });
  };

  const confirmRevert = () =>
    Alert.alert(
      "Revert this card?",
      "Iskra opens a new card that reverts its commit and sends it to review with evidence.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revert",
          style: "destructive",
          onPress: async () => {
            const revertCardId = CardId.make(uuidv4());
            const done = await revert(
              { environmentId, input: { cardId: card.id, revertCardId } },
              "The card was not reverted",
            );
            if (done) navigation.navigate("IskraCard", { environmentId, cardId: revertCardId });
          },
        },
      ],
    );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      className="flex-1 bg-screen"
      contentContainerClassName="gap-6 px-4 pt-3 pb-12"
    >
      <NativeStackScreenOptions options={{ title: "" }} />
      <View className="gap-2 px-1">
        <View className="flex-row flex-wrap items-center gap-2">
          <StatusPill {...cardStatusPill(card)} />
          {card.kind !== "task" ? (
            <StatusPill label={card.kind === "plan" ? "Plan" : "Migration"} tone="gray" />
          ) : null}
          {outcome !== null ? <StatusPill {...outcome} /> : null}
          {card.unattended ? <StatusPill label="Draft PR" tone="gray" /> : null}
        </View>
        <Text className="text-[22px] text-foreground" style={{ fontWeight: "700" }} selectable>
          {card.title}
        </Text>
        <View className="flex-row flex-wrap items-center gap-x-5 gap-y-2">
          {sessionAgent !== undefined ? (
            <View className="flex-row items-center gap-2">
              <AgentAvatar name={sessionAgent.name} spark={cardSparkState(card)} size={22} />
              <Muted>{sessionAgent.name}</Muted>
            </View>
          ) : null}
          <View className="flex-row items-center gap-2">
            <SpendBar spentUsd={card.spentUsd} capUsd={card.budgetCapUsd} />
            <Muted>${card.spentUsd.toFixed(2)}</Muted>
          </View>
          <View className="flex-row items-center gap-1.5">
            <RoundDots used={card.fixRounds.review} cap={policy.reviewFixRounds} label="Review fix rounds" />
            <Muted>Fix rounds</Muted>
          </View>
        </View>
      </View>

      {undo !== null ? (
        <View className="flex-row items-center gap-3 rounded-xl bg-card px-4 py-2.5">
          <View className="flex-1">
            <Body>{undo.label}</Body>
          </View>
          <ActionButton
            label="Undo"
            onPress={() => {
              const command = undo.command;
              setUndo(null);
              void undoCommand({ environmentId, input: command }, "It was not undone");
            }}
          />
        </View>
      ) : null}

      <Group title="Move">
        {open && card.status !== "triage" ? (
          <Row first>
            <ButtonRow>
              <ActionButton
                label={card.paused === null ? "Pause" : "Resume"}
                onPress={() =>
                  void (card.paused === null
                    ? decideOn("card.pause", "The card was not paused")
                    : decideOn("card.resume", "The card was not resumed"))
                }
              />
            </ButtonRow>
            {card.paused !== null ? (
              <Muted>Paused · {reasonLine(card.paused.reason)}</Muted>
            ) : card.waitReason !== null ? (
              <Muted>{reasonLine(card.waitReason)}</Muted>
            ) : null}
          </Row>
        ) : null}
        <Row first={!(open && card.status !== "triage")}>
          {card.status === "landed" ? (
            <ButtonRow>
              {card.landedSha !== null ? (
                <ActionButton label="Revert…" kind="destructive" onPress={confirmRevert} />
              ) : (
                <Muted>A landed card is finished.</Muted>
              )}
            </ButtonRow>
          ) : (
            <>
              <ButtonRow>
                {card.status === "triage" && suggested !== undefined && card.acceptance.criteria.length > 0 ? (
                  <ActionButton
                    label={`Approve & start with @${suggested.name}`}
                    kind="primary"
                    onPress={() =>
                      void approveAndStart(
                        {
                          environmentId,
                          input: {
                            cardId: card.id,
                            delegateAgentId: suggested.id,
                            criteria: card.acceptance.criteria,
                          },
                        },
                        "The card was not started",
                      )
                    }
                  />
                ) : null}
                {cardMoveActions(card.status, mergeRefusal).map((action) => (
                  <ActionButton
                    key={action.column}
                    label={action.label}
                    kind={action.type === "card.abandon" ? "destructive" : action.type === "card.merge.approve" ? "primary" : "plain"}
                    disabled={action.type === null}
                    onPress={() => {
                      if (action.type !== null) void decideOn(action.type, "The card stays where it was");
                    }}
                  />
                ))}
              </ButtonRow>
              {cardMoveActions(card.status, mergeRefusal)
                .filter((action) => action.type === null && action.column === "landing")
                .map((action) => (
                  <Muted key={action.column}>{action.reason}</Muted>
                ))}
            </>
          )}
        </Row>
      </Group>

      {card.plan !== null ? <PlanSection card={card} cards={props.cards} environmentId={environmentId} /> : null}

      {open && card.attention.length > 0 ? (
        <Group title="Waiting on you">
          {card.attention.map((item, index) => (
            <Row key={item.activityId} first={index === 0}>
              <Muted>{(REASON_LABEL[item.code]?.label ?? item.code)}</Muted>
              <Body>{item.text}</Body>
              <AttentionButtons
                item={item}
                onForward={() =>
                  void forward(
                    { environmentId, input: { cardId: card.id, activityId: item.activityId } },
                    "The comment was not forwarded",
                  )
                }
                onDismiss={() =>
                  void dismiss(
                    { environmentId, input: { cardId: card.id, activityId: item.activityId } },
                    "It was not dismissed",
                  )
                }
                onDecide={(type, failure) => void decideOn(type, failure)}
              />
            </Row>
          ))}
        </Group>
      ) : null}

      {open && questions.length > 0 ? (
        <Group title="Questions for you">
          {questions.map((question, index) => (
            <Row key={question.activityId} first={index === 0}>
              <CardQuestion environmentId={environmentId} cardId={card.id} question={question} />
            </Row>
          ))}
        </Group>
      ) : null}

      {open && card.checkpoint !== null ? (
        <Group title="Checkpoint">
          <Row first>
            <CheckpointControls environmentId={environmentId} card={card} />
          </Row>
        </Group>
      ) : null}

      {card.evidence !== null || card.status === "inReview" || card.status === "landing" ? (
        <CardReview
          card={card}
          items={items}
          verdict={activity.data?.verdict ?? null}
          verificationRequired={verificationRequired}
          agents={props.agents}
          environmentId={environmentId}
        />
      ) : null}

      {card.landing !== null || card.status === "inReview" || card.status === "landing" ? (
        <CardLanding card={card} items={items} policy={policy} environmentId={environmentId} />
      ) : null}

      <CriteriaSection card={card} environmentId={environmentId} />

      {open ? (
        <Group title={builder === undefined ? "Message" : `Message @${builder.name}`}>
          <Row first>
            <Field
              value={message}
              onChangeText={setMessage}
              placeholder={
                card.status === "inReview" ? "A message, or what to change before it lands" : "A message to the card's agent"
              }
              multiline
            />
            <ButtonRow>
              <ActionButton
                label="Send to agent"
                disabled={card.delegateAgentId === null || message.trim().length === 0}
                onPress={async () => {
                  const sent = await postMessage(
                    { environmentId, input: { cardId: card.id, messageId: MessageId.make(uuidv4()), body: message.trim() } },
                    "The message was not sent",
                  );
                  if (sent) setMessage("");
                }}
              />
              {card.status === "inReview" ? (
                <ActionButton
                  label="Request changes"
                  disabled={message.trim().length === 0}
                  onPress={async () => {
                    const sent = await reviewComment(
                      { environmentId, input: { cardId: card.id, messageId: MessageId.make(uuidv4()), body: message.trim() } },
                      "The review comment was not sent",
                    );
                    if (sent) setMessage("");
                  }}
                />
              ) : null}
            </ButtonRow>
            {card.delegateAgentId === null ? <Muted>Assign an agent on web first.</Muted> : null}
          </Row>
        </Group>
      ) : null}

      <ActivitySection
        cardId={card.id}
        environmentId={environmentId}
        live={activity.data?.activities ?? NO_ACTIVITIES}
        liveHasMore={activity.data?.hasMore ?? false}
        error={activity.error}
        agents={props.agents}
      />
    </ScrollView>
  );
}

function AttentionButtons(props: {
  readonly item: CardAttention;
  readonly onForward: () => void;
  readonly onDismiss: () => void;
  readonly onDecide: (type: DecisionType, failure: string) => void;
}) {
  return (
    <ButtonRow>
      {props.item.actions.map((action) => {
        switch (action) {
          case "forward":
            return <ActionButton key={action} label="Forward to the agent" onPress={props.onForward} />;
          case "dismiss":
            return <ActionButton key={action} label="Dismiss" onPress={props.onDismiss} />;
          case "retryLanding":
            return (
              <ActionButton
                key={action}
                label="Retry landing"
                onPress={() => props.onDecide("card.merge.approve", "The landing was not retried")}
              />
            );
          case "rerunVerifier":
            return (
              <ActionButton
                key={action}
                label="Rerun verifier"
                onPress={() => props.onDecide("card.verifier.rerun", "The verifier was not rerun")}
              />
            );
          case "restartServices":
            return (
              <ActionButton
                key={action}
                label="Restart"
                onPress={() => props.onDecide("card.services.restart", "The services were not restarted")}
              />
            );
          // Settings, criteria requests, holdouts and agent assignment are resolved on web.
          default:
            return null;
        }
      })}
    </ButtonRow>
  );
}

/** A plan card: the coordinator's proposal by slice, one-tap approval of its revision, and children. */
function PlanSection(props: {
  readonly card: OrchestrationCardShell;
  readonly cards: ReadonlyArray<OrchestrationCardShell>;
  readonly environmentId: EnvironmentId;
}) {
  const { card, environmentId } = props;
  const navigation = useNavigation();
  const approvePlan = useRefusableCommand(cardEnvironment.approvePlan);
  const answer = useRefusableCommand(cardEnvironment.answerElicitation);
  const [sending, setSending] = useState(false);
  const plan = card.plan!;
  const slices = useMemo(() => planSlices(card.id, plan, props.cards), [card.id, plan, props.cards]);
  const proposalActivityId = plan.proposalActivityId;

  return (
    <>
      <Group
        title={`Plan · revision ${plan.revision}`}
        footer={plan.integrationBranch === null ? undefined : `Children land into ${plan.integrationBranch}.`}
      >
        <Row first>
          <Body>
            {plan.state === "drafting"
              ? planDraftLine(card.status)
              : plan.state === "proposed"
                ? "Proposed: approve it to create its children, ready to start."
                : `Approved · slice ${plan.currentSlice}`}
          </Body>
          {plan.premise.length > 0 ? <Muted>{plan.premise}</Muted> : null}
        </Row>
        {plan.state === "proposed" && proposalActivityId !== null ? (
          <Row>
            <ElicitationOptions
              elicitation={{
                options: [
                  { id: "approve", label: "Approve plan" },
                  { id: "redirect", label: "Redirect" },
                ],
                recommendedOptionId: "approve",
                allowText: true,
              }}
              disabled={sending || plan.revision < 1}
              onAnswer={async (choice) => {
                setSending(true);
                if (choice.optionId === "approve") {
                  await approvePlan(
                    { environmentId, input: { cardId: card.id, revision: plan.revision } },
                    "The plan was not approved",
                  );
                } else {
                  // A redirect (or the person's own words) goes back to the coordinator as an answer.
                  await answer(
                    {
                      environmentId,
                      input: {
                        cardId: card.id,
                        activityId: proposalActivityId,
                        optionId: choice.optionId,
                        body: choice.body,
                      },
                    },
                    "The plan was not redirected",
                  );
                }
                setSending(false);
              }}
            />
          </Row>
        ) : null}
      </Group>
      {slices.map((slice) => (
        <Group key={slice.slice} title={`Slice ${slice.slice}${slice.finished ? " · landed" : ""}`}>
          {slice.children.map((view, index) => {
            const childCardId = view.cardId;
            return (
              <Row
                key={view.child.key}
                first={index === 0}
                onPress={
                  childCardId === null
                    ? undefined
                    : () => navigation.navigate("IskraCard", { environmentId, cardId: childCardId })
                }
              >
                <View className="flex-row items-start gap-3">
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Body strong lines={2}>
                      {view.child.title}
                    </Body>
                    <Muted>
                      {view.child.criteria.length}{" "}
                      {view.child.criteria.length === 1 ? "criterion" : "criteria"}
                      {view.child.suggestedAgent !== null ? ` · @${view.child.suggestedAgent}` : ""}
                      {view.dependsOnTitles.length > 0 ? ` · after ${view.dependsOnTitles.join(", ")}` : ""}
                    </Muted>
                  </View>
                  <Muted>{PLAN_CHILD_STATE_LABEL[view.state]}</Muted>
                </View>
              </Row>
            );
          })}
        </Group>
      ))}
    </>
  );
}

const sameCriteria = (left: ReadonlyArray<CardCriterion>, right: ReadonlyArray<CardCriterion>) =>
  JSON.stringify(left) === JSON.stringify(right);

/** The acceptance criteria as editable rows: a draft in triage, confirmed once the card is approved. */
function CriteriaSection(props: {
  readonly card: OrchestrationCardShell;
  readonly environmentId: EnvironmentId;
}) {
  const { card, environmentId } = props;
  const setCriteria = useRefusableCommand(cardEnvironment.setCriteria);
  const decide = useRefusableCommand(cardEnvironment.decide);
  const [criteria, setDraft] = useState(card.acceptance.criteria);
  const saved = criteria.flatMap((criterion) => {
    const text = criterion.text.trim();
    return text.length === 0 ? [] : [{ ...criterion, text }];
  });
  const edited = !sameCriteria(saved, card.acceptance.criteria);
  const open = card.status !== "landed" && card.status !== "abandoned";
  const draft = card.acceptance.state === "draft";
  const replace = (index: number, next: CardCriterion) =>
    setDraft(criteria.map((criterion, at) => (at === index ? next : criterion)));

  return (
    <Group
      title="Acceptance criteria"
      footer={
        card.status === "triage"
          ? "A draft until you approve the card."
          : draft
            ? "Not confirmed: work starts only once you confirm them."
            : "Confirmed. Checks and review hold the work to these."
      }
    >
      {criteria.length === 0 ? (
        <Row first>
          <Muted>No criteria yet. Add the outcomes that show the work is done.</Muted>
        </Row>
      ) : null}
      {criteria.map((criterion, index) => (
        <Row key={criterion.id} first={index === 0}>
          <Field
            value={criterion.text}
            onChangeText={(text) => replace(index, { ...criterion, text })}
            placeholder="An outcome someone can observe"
            multiline
            editable={open}
          />
          {open ? (
            <ButtonRow>
              <Segmented
                segments={[
                  { value: "automated", label: "Checked by evidence" },
                  { value: "manual", label: "Needs your check" },
                ]}
                value={criterion.verification}
                onChange={(verification) => replace(index, { ...criterion, verification })}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove criterion"
                hitSlop={8}
                onPress={() => setDraft(criteria.filter((_, at) => at !== index))}
              >
                <Text style={{ color: TONE_COLOR.red, fontSize: 15 }}>Remove</Text>
              </Pressable>
            </ButtonRow>
          ) : null}
        </Row>
      ))}
      {open ? (
        <Row>
          <ButtonRow>
            <ActionButton
              label="Add criterion"
              onPress={() =>
                setDraft([
                  ...criteria,
                  { id: `criterion-${uuidv4().slice(0, 8)}`, text: "", verification: "automated" },
                ])
              }
            />
            <ActionButton
              label="Save criteria"
              kind="primary"
              disabled={!edited}
              onPress={() =>
                void setCriteria(
                  { environmentId, input: { cardId: card.id, criteria: saved } },
                  "The criteria were not saved",
                )
              }
            />
            {draft && card.status !== "triage" ? (
              <ActionButton
                label="Confirm criteria"
                disabled={edited || card.acceptance.criteria.length === 0}
                onPress={() =>
                  void decide(
                    { environmentId, input: { type: "card.criteria.confirm", cardId: card.id } },
                    "The criteria were not confirmed",
                  )
                }
              />
            ) : null}
          </ButtonRow>
        </Row>
      ) : null}
    </Group>
  );
}

const KIND_LABEL: Record<CardActivityKind, string> = {
  message: "Message",
  decision: "Decision",
  plan: "Plan",
  elicitation: "Question",
  response: "Answer",
  status: "Status",
  evidence: "Evidence",
  landing: "Landing",
  error: "Error",
  critique: "Critique",
  help: "Help",
  verdict: "Verdict",
};

const FILTERS: ReadonlyArray<{ readonly value: CardActivityFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "people", label: "People" },
  { value: "agents", label: "Agents" },
];

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * The card's activity, newest first. It shows 30 at a time from what is held, then pages older
 * activities from the server past the subscription's newest 200.
 */
function ActivitySection(props: {
  readonly cardId: CardId;
  readonly environmentId: EnvironmentId;
  readonly live: ReadonlyArray<CardActivity>;
  readonly liveHasMore: boolean;
  readonly error: string | null;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
}) {
  const loadOlder = useAtomCommand(olderCardActivity);
  // Fetched older pages in fetch order, applied over the live activities like a card stream.
  const [pages, setPages] = useState<ReadonlyArray<OrchestrationCardStreamItem>>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<CardActivityFilter>("all");
  const [shown, setShown] = useState(PAGE_SIZE);
  const { activities: all, hasMore } = useMemo(
    () =>
      pages.reduce(applyCardStreamItem, {
        ...EMPTY_CARD_ACTIVITY,
        activities: props.live,
        hasMore: props.liveHasMore,
      }),
    [pages, props.live, props.liveHasMore],
  );
  const newestFirst = useMemo(() => [...filterCardActivities(all, filter)].reverse(), [all, filter]);
  const names = useMemo(() => new Map(props.agents.map((agent) => [agent.id as string, agent.name])), [props.agents]);
  const oldestId = all[0]?.activityId;

  const pageOlder = async () => {
    if (oldestId === undefined || loading) return;
    setLoading(true);
    const result = await loadOlder({
      environmentId: props.environmentId,
      input: { cardId: props.cardId, before: oldestId },
    });
    setLoading(false);
    if (result._tag !== "Success") {
      Alert.alert("Older activity didn't load", "Try again once the environment is connected.");
      return;
    }
    const page = result.value;
    setPages((current) => [...current, page]);
    setShown((current) => current + PAGE_SIZE);
  };

  return (
    <Group title="Activity">
      <Row first>
        <Segmented
          segments={FILTERS}
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setShown(PAGE_SIZE);
          }}
        />
        {props.error !== null ? <Muted>{props.error}</Muted> : null}
      </Row>
      {newestFirst.length === 0 ? (
        <Row>
          <Muted>Nothing here yet.</Muted>
        </Row>
      ) : null}
      {newestFirst.slice(0, shown).map((entry) => (
        <ActivityRow key={entry.activityId} activity={entry} names={names} />
      ))}
      {newestFirst.length > shown || hasMore ? (
        <Row>
          <ButtonRow>
            <ActionButton
              label={loading ? "Loading…" : newestFirst.length > shown ? `Show older (${newestFirst.length - shown})` : "Load older"}
              disabled={loading}
              onPress={() => (newestFirst.length > shown ? setShown(shown + PAGE_SIZE) : void pageOlder())}
            />
          </ButtonRow>
        </Row>
      ) : null}
    </Group>
  );
}

const ActivityRow = memo(function ActivityRow(props: {
  readonly activity: CardActivity;
  readonly names: ReadonlyMap<string, string>;
}) {
  const { activity } = props;
  const reason = activity.reason;
  const known = reason !== null && Object.hasOwn(REASON_LABEL, reason.code);
  const author =
    activity.author.kind === "agent"
      ? `@${props.names.get(activity.author.id) ?? "agent"}`
      : activity.author.kind === "human"
        ? "You"
        : activity.author.kind === "system"
          ? "Iskra"
          : activity.author.kind === "linear"
            ? "Linear"
            : "GitHub";
  return (
    <Row>
      <View className="flex-row items-baseline gap-2">
        <Text className="text-[13px] text-foreground" style={{ fontWeight: "600" }}>
          {author}
        </Text>
        <Muted>{known ? REASON_LABEL[reason.code]!.label : KIND_LABEL[activity.kind]}</Muted>
        <View className="flex-1" />
        <Muted>{timeFormat.format(new Date(activity.createdAt))}</Muted>
      </View>
      {activity.body.trim().length > 0 ? (
        <Text
          className="text-[15px] text-foreground"
          style={activity.kind === "error" ? { color: TONE_COLOR.red } : undefined}
          selectable
        >
          {activity.body}
        </Text>
      ) : null}
      {reason !== null && !activity.body.startsWith(reason.text) ? (
        <Muted>{known ? reason.text : `Why: ${reasonLine(reason)}`}</Muted>
      ) : null}
      {activity.deliverTo !== null && activity.delivery === "undelivered" ? (
        <Text style={{ color: TONE_COLOR.red, fontSize: 13 }}>Not delivered to its agent</Text>
      ) : null}
    </Row>
  );
});
