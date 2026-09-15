import { isCardSnoozed, needsYouLabel, waitingLabel } from "@iskra/client-runtime/cards";
import type { CardDecisionInput } from "@iskra/client-runtime/operations";
import { DEFAULT_CARD_BUDGET_USD, type CardId, type EnvironmentId } from "@iskra/contracts";
import { useNavigation } from "@react-navigation/native";
import { Pressable, ScrollView, Text, View } from "react-native";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { ActionButton, Body, ButtonRow, Group, Muted, Row, SparkGlyph, TONE_COLOR } from "./components";
import { CardQuestion, CheckpointControls } from "./questions";
import {
  cardEnvironment,
  channelEnvironment,
  useMinuteClock,
  useNeedsYou,
  useRefusableCommand,
} from "./state";

const HOUR_MS = 60 * 60_000;

/** Needs you's way to the channels, boards and DMs. */
function ChannelsHeaderButton() {
  const navigation = useNavigation();
  return (
    <Pressable accessibilityRole="button" hitSlop={8} onPress={() => navigation.navigate("IskraChannels")}>
      <Text style={{ color: TONE_COLOR.blue, fontSize: 17 }}>Channels</Text>
    </Pressable>
  );
}

type DecisionType = CardDecisionInput["type"];

/**
 * Everything waiting on a person across environments, longest waiting first: questions answered
 * with their option buttons, checkpoints, and the one-tap decisions Needs you offers on web.
 */
// native-stack calls headerRight as a plain function, so it renders the button as an element
// rather than running the button's hooks inside SceneView once the options land.
const renderChannelsHeaderButton = () => <ChannelsHeaderButton />;

export function NeedsYouRouteScreen() {
  const navigation = useNavigation();
  const now = useMinuteClock();
  const environments = useNeedsYou(now);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const decide = useRefusableCommand(cardEnvironment.decide);
  const snooze = useRefusableCommand(cardEnvironment.snooze);
  const unsnooze = useRefusableCommand(cardEnvironment.unsnooze);
  const setBudget = useRefusableCommand(cardEnvironment.setBudget);
  const approveLesson = useRefusableCommand(channelEnvironment.approveLesson);
  const dismissLesson = useRefusableCommand(channelEnvironment.dismissLesson);
  const withItems = environments.filter((entry) => entry.items.length > 0);
  const snoozed = environments.flatMap((entry) =>
    entry.cards
      .filter((card) => isCardSnoozed(card, now))
      .map((card) => ({ environmentId: entry.environmentId, card })),
  );

  const decideOn = (environmentId: EnvironmentId, cardId: CardId, type: DecisionType, failure: string) =>
    void decide({ environmentId, input: { type, cardId } }, failure);
  const snoozeCard = (environmentId: EnvironmentId, cardId: CardId, snoozedUntil: string | null) =>
    void snooze({ environmentId, input: { cardId, snoozedUntil } }, "The card was not snoozed");

  return (
    <>
      <NativeStackScreenOptions options={{ title: "Needs you", headerRight: renderChannelsHeaderButton }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerClassName="gap-6 px-4 pt-3 pb-10"
      >
        {withItems.length === 0 ? (
          <View className="items-center gap-2 py-16">
            <SparkGlyph state="idle" size={28} />
            <Muted>Nothing is waiting on you.</Muted>
          </View>
        ) : null}
        {withItems.map((entry) => {
          const projectTitle = (projectId: string) =>
            entry.projects.find((project) => project.id === projectId)?.title ?? "";
          const cardById = new Map(entry.cards.map((card) => [card.id, card]));
          return (
            <Group
              key={entry.environmentId}
              title={
                environments.length > 1
                  ? (savedConnectionsById[entry.environmentId]?.environmentLabel ?? undefined)
                  : undefined
              }
            >
              {entry.items.map((item, index) => {
                const card = cardById.get(item.cardId);
                const question = card?.openElicitations.find(
                  (open) => open.activityId === item.activityId,
                );
                const attention = card?.attention.find((entry) => entry.activityId === item.activityId);
                const { environmentId } = entry;
                return (
                  <Row key={item.key} first={index === 0}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        navigation.navigate("IskraCard", { environmentId, cardId: item.cardId })
                      }
                      className="flex-row items-start gap-3 active:opacity-60"
                    >
                      <View className="pt-0.5">
                        <SparkGlyph state="needsYou" size={18} />
                      </View>
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Body strong lines={2}>
                          {item.title}
                        </Body>
                        <Muted lines={1}>
                          {needsYouLabel(item)} · {projectTitle(item.projectId)}
                        </Muted>
                      </View>
                      <Muted>{waitingLabel(item.since, now)}</Muted>
                    </Pressable>
                    {item.reason !== null && item.kind !== "checkpoint" && item.activityId === null ? (
                      <Muted lines={3}>{item.reason}</Muted>
                    ) : null}
                    {attention !== undefined ? <Body lines={4}>{attention.text}</Body> : null}
                    {question !== undefined && question.kind !== "refsChanged" ? (
                      <CardQuestion environmentId={environmentId} cardId={item.cardId} question={question} />
                    ) : null}
                    {(item.kind === "checkpoint" || item.kind === "sliceCheckpoint") && card !== undefined ? (
                      <CheckpointControls environmentId={environmentId} card={card} />
                    ) : null}
                    <ButtonRow>
                      {item.kind === "triage" ? (
                        <ActionButton
                          label="Drop"
                          kind="destructive"
                          onPress={() =>
                            decideOn(environmentId, item.cardId, "card.abandon", "The card was not dropped")
                          }
                        />
                      ) : item.kind === "spec" ? (
                        <>
                          <ActionButton
                            label="Approve spec"
                            onPress={() =>
                              decideOn(environmentId, item.cardId, "card.spec.approve", "The spec was not approved")
                            }
                          />
                          <ActionButton
                            label="Skip spec"
                            onPress={() =>
                              decideOn(environmentId, item.cardId, "card.spec.skip", "The spec was not skipped")
                            }
                          />
                        </>
                      ) : item.kind === "budgetReached" ? (
                        <ActionButton
                          label={`Raise the cap by $${DEFAULT_CARD_BUDGET_USD}`}
                          onPress={() =>
                            void setBudget(
                              {
                                environmentId,
                                input: {
                                  cardId: item.cardId,
                                  capUsd: (card?.budgetCapUsd ?? 0) + DEFAULT_CARD_BUDGET_USD,
                                },
                              },
                              "The cap was not raised",
                            )
                          }
                        />
                      ) : item.kind === "fixRoundsExhausted" ? (
                        <ActionButton
                          label="Give it more rounds"
                          onPress={() =>
                            decideOn(environmentId, item.cardId, "card.fix-rounds.reset", "The fix rounds were not reset")
                          }
                        />
                      ) : card?.paused != null && (item.kind === "paused" || item.kind === "sessionFailed") ? (
                        <ActionButton
                          label="Resume"
                          onPress={() =>
                            decideOn(environmentId, item.cardId, "card.resume", "The card was not resumed")
                          }
                        />
                      ) : item.kind === "unpricedModel" ? (
                        <ActionButton
                          label="Run uncapped"
                          onPress={() =>
                            decideOn(
                              environmentId,
                              item.cardId,
                              "card.unpriced.accept",
                              "The card was not allowed to run uncapped",
                            )
                          }
                        />
                      ) : item.kind === "lessonProposed" && item.lessonId !== null ? (
                        <>
                          <ActionButton
                            label="Approve lesson"
                            kind="primary"
                            onPress={() => {
                              if (item.lessonId === null) return;
                              void approveLesson(
                                { environmentId, input: { projectId: item.projectId, lessonId: item.lessonId } },
                                "The lesson was not approved",
                              );
                            }}
                          />
                          <ActionButton
                            label="Dismiss"
                            onPress={() => {
                              if (item.lessonId === null) return;
                              void dismissLesson(
                                { environmentId, input: { projectId: item.projectId, lessonId: item.lessonId } },
                                "The lesson was not dismissed",
                              );
                            }}
                          />
                        </>
                      ) : item.kind === "readyToMerge" ? (
                        <ActionButton
                          label="Approve merge"
                          kind="primary"
                          onPress={() =>
                            decideOn(environmentId, item.cardId, "card.merge.approve", "The merge was not approved")
                          }
                        />
                      ) : null}
                      {item.snoozable ? (
                        <>
                          <ActionButton
                            label="1 hour"
                            onPress={() =>
                              snoozeCard(environmentId, item.cardId, new Date(now + HOUR_MS).toISOString())
                            }
                          />
                          <ActionButton
                            label="Until it changes"
                            onPress={() => snoozeCard(environmentId, item.cardId, null)}
                          />
                        </>
                      ) : null}
                    </ButtonRow>
                  </Row>
                );
              })}
            </Group>
          );
        })}
        {snoozed.length > 0 ? (
          <Group title={`Snoozed ${snoozed.length}`}>
            {snoozed.map(({ environmentId, card }, index) => (
              <Row key={`${environmentId}:${card.id}`} first={index === 0}>
                <View className="flex-row items-center gap-3">
                  <View className="min-w-0 flex-1">
                    <Body lines={1}>{card.title}</Body>
                    <Muted>
                      {card.snoozedUntil === null
                        ? "Until it changes"
                        : `Until ${new Date(card.snoozedUntil).toLocaleString()}`}
                    </Muted>
                  </View>
                  <ActionButton
                    label="Wake"
                    onPress={() =>
                      void unsnooze({ environmentId, input: { cardId: card.id } }, "The card was not woken")
                    }
                  />
                </View>
              </Row>
            ))}
          </Group>
        ) : null}
      </ScrollView>
    </>
  );
}
