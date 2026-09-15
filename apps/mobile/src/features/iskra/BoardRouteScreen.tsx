import { cardSparkState, cardStatusPill, criteriaMarks } from "@iskra/client-runtime/card-face";
import {
  BOARD_COLUMNS,
  BOARD_COLUMN_LABEL,
  boardColumnOf,
  cardBadges,
  isCardSnoozed,
  type BoardColumn,
} from "@iskra/client-runtime/cards";
import type { EnvironmentId, OrchestrationAgentShell, OrchestrationCardShell } from "@iskra/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { memo, useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects } from "../../state/entities";
import {
  AgentAvatar,
  Body,
  CriteriaMarks,
  Muted,
  Segmented,
  SparkGlyph,
  SpendBar,
  StatusPill,
  TONE_COLOR,
} from "./components";
import { useEnvironmentAgents, useEnvironmentCards, useMinuteClock } from "./state";

type BoardParams = StaticScreenProps<{ readonly environmentId: string; readonly projectId: string }>;

// The column a board opens on: where a person is most likely needed.
const OPENING_ORDER: ReadonlyArray<BoardColumn> = ["inReview", "triage", "inProgress", "ready", "landing", "done"];

/** A project's board as one column at a time, picked with a segmented control. */
export function BoardRouteScreen(props: BoardParams) {
  const environmentId = props.route.params.environmentId as EnvironmentId;
  const { projectId } = props.route.params;
  const now = useMinuteClock();
  const allCards = useEnvironmentCards(environmentId);
  const agents = useEnvironmentAgents(environmentId);
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === projectId,
  );
  const cards = useMemo(() => allCards.filter((card) => card.projectId === projectId), [allCards, projectId]);
  const counts = useMemo(() => {
    const byColumn = new Map<BoardColumn, number>();
    for (const card of cards) {
      const column = boardColumnOf(card.status);
      byColumn.set(column, (byColumn.get(column) ?? 0) + 1);
    }
    return byColumn;
  }, [cards]);
  const [picked, setPicked] = useState<BoardColumn | null>(null);
  const column = picked ?? OPENING_ORDER.find((entry) => (counts.get(entry) ?? 0) > 0) ?? "triage";
  const columnCards = useMemo(
    () => cards.filter((card) => boardColumnOf(card.status) === column),
    [cards, column],
  );
  const statusById = useMemo(() => new Map(cards.map((card) => [card.id, card.status])), [cards]);

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title: project?.title ?? "Board" }} />
      <FlatList
        data={columnCards}
        keyExtractor={(card) => card.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-2.5 px-4 pt-3 pb-10"
        ListHeaderComponent={
          <View className="pb-1">
            <Segmented
              segments={BOARD_COLUMNS.map((value) => ({
                value,
                label: BOARD_COLUMN_LABEL[value],
                count: counts.get(value) ?? 0,
              }))}
              value={column}
              onChange={setPicked}
            />
          </View>
        }
        ListEmptyComponent={
          <View className="items-center py-12">
            <Muted>No cards in {BOARD_COLUMN_LABEL[column]}.</Muted>
          </View>
        }
        renderItem={({ item }) => (
          <CardFace
            card={item}
            agents={agents}
            environmentId={environmentId}
            blocked={item.relations.some(
              (relation) => relation.kind === "blockedBy" && statusById.get(relation.cardId) !== "landed",
            )}
            snoozed={isCardSnoozed(item, now)}
          />
        )}
      />
    </View>
  );
}

/** A card on the board: status, its agent with the spark, criteria marks, spend and what's alarming. */
const CardFace = memo(function CardFace(props: {
  readonly card: OrchestrationCardShell;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly environmentId: EnvironmentId;
  readonly blocked: boolean;
  readonly snoozed: boolean;
}) {
  const navigation = useNavigation();
  const { card } = props;
  const agent = props.agents.find(
    (entry) => entry.id === (card.ownerSession?.agentId ?? card.delegateAgentId),
  );
  const spark = cardSparkState(card);
  const alarms = cardBadges(card, { blocked: props.blocked, snoozed: props.snoozed }).filter(
    (badge) => badge.alarming,
  );
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => navigation.navigate("IskraCard", { environmentId: props.environmentId, cardId: card.id })}
      className="gap-2 rounded-xl border-continuous bg-card px-4 py-3 active:opacity-70"
    >
      <View className="flex-row items-center gap-2">
        <StatusPill {...cardStatusPill(card)} />
        {card.kind !== "task" ? <Muted>{card.kind === "plan" ? "Plan" : "Migration"}</Muted> : null}
        <View className="flex-1" />
        {agent !== undefined ? (
          <AgentAvatar name={agent.name} spark={spark} size={22} />
        ) : (
          <SparkGlyph state={spark} />
        )}
      </View>
      <Body strong lines={3}>
        {card.title}
      </Body>
      <View className="flex-row items-center gap-3">
        <CriteriaMarks marks={criteriaMarks(card)} />
        <View className="flex-1" />
        <SpendBar spentUsd={card.spentUsd} capUsd={card.budgetCapUsd} />
        <Muted>${card.spentUsd.toFixed(2)}</Muted>
      </View>
      {alarms.length > 0 ? (
        <Text style={{ color: TONE_COLOR.orange, fontSize: 13 }} numberOfLines={2}>
          {alarms.map((badge) => badge.label).join(" · ")}
        </Text>
      ) : null}
    </Pressable>
  );
});
