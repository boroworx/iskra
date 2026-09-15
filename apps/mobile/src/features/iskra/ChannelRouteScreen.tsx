import { derivePendingRequests } from "@iskra/client-runtime/pending-requests";
import { EMPTY_CHANNEL_STATE, liveRunPreview } from "@iskra/client-runtime/state/channels";
import {
  MessageId,
  REQUESTS_CHANNEL_NAME,
  type AgentId,
  type ChannelId,
  type EnvironmentId,
  type OrchestrationAgentShell,
  type OrchestrationChannelMessage,
  type OrchestrationChannelRun,
} from "@iskra/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Option from "effect/Option";
import { memo, useCallback, useLayoutEffect, useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadDetail } from "../../state/use-thread-detail";
import { uuidv4 } from "../../lib/uuid";
import {
  ActionButton,
  AgentAvatar,
  Body,
  EventLine,
  Muted,
  SparkGlyph,
  TONE_COLOR,
} from "./components";
import { ChannelQuestion, Field } from "./questions";
import {
  channelEnvironment,
  useEnvironmentAgents,
  useEnvironmentChannels,
  useRefusableCommand,
} from "./state";

const GROUP_WINDOW_MS = 5 * 60_000;
const NO_SHOWING_RUNS: ReadonlyMap<string, string> = new Map();
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

type ChannelParams = StaticScreenProps<{
  readonly environmentId: string;
  readonly channelId: string;
}>;
type AgentDmParams = StaticScreenProps<{
  readonly environmentId: string;
  readonly agentId: string;
}>;

export function ChannelRouteScreen(props: ChannelParams) {
  const environmentId = props.route.params.environmentId as EnvironmentId;
  const channels = useEnvironmentChannels(environmentId);
  const channel = channels.find((entry) => entry.id === props.route.params.channelId) ?? null;
  // Requests exists once someone picks its lead on a computer; until then it can't be posted to.
  if (props.route.params.channelId.startsWith("requests:")) {
    const ready = channel !== null && channel.leadAgentId !== null;
    return (
      <Conversation
        environmentId={environmentId}
        channelId={channel?.id ?? null}
        agentId={null}
        title={REQUESTS_CHANNEL_NAME}
        emptyText="No requests yet."
        placeholder="Ask for something, or @mention an agent"
        notice={
          ready
            ? undefined
            : "Choose who turns requests into cards in Iskra on your computer to start using Requests."
        }
      />
    );
  }
  return (
    <Conversation
      environmentId={environmentId}
      channelId={channel?.id ?? null}
      agentId={null}
      title={channel === null ? "Channel" : `#${channel.name}`}
      emptyText={
        channel === null ? "This channel is archived or no longer exists." : "No messages yet."
      }
    />
  );
}

/** An agent's DM: its channel once the first message opened one, posting through `agent.dm.post`. */
export function AgentDmRouteScreen(props: AgentDmParams) {
  const environmentId = props.route.params.environmentId as EnvironmentId;
  const agentId = props.route.params.agentId as AgentId;
  const channels = useEnvironmentChannels(environmentId);
  const agents = useEnvironmentAgents(environmentId);
  const agent = agents.find((entry) => entry.id === agentId);
  const dm = channels.find(
    (channel) => channel.kind === "dm" && channel.memberAgentIds.includes(agentId),
  );
  return (
    <Conversation
      environmentId={environmentId}
      channelId={dm?.id ?? null}
      agentId={agentId}
      title={agent === undefined ? "Direct message" : `@${agent.name}`}
      emptyText="Send the first message to start the conversation."
    />
  );
}

function Conversation(props: {
  readonly environmentId: EnvironmentId;
  readonly channelId: ChannelId | null;
  /** Set for a DM: messages post to the agent, opening its DM channel on the first one. */
  readonly agentId: AgentId | null;
  readonly title: string;
  readonly emptyText: string;
  readonly placeholder?: string;
  /** Why the conversation can't be posted to yet; shown above a disabled composer. */
  readonly notice?: string;
}) {
  const { environmentId, channelId, agentId } = props;
  const insets = useSafeAreaInsets();
  const agents = useEnvironmentAgents(environmentId);
  const messages = useEnvironmentQuery(
    channelId === null
      ? null
      : channelEnvironment.messages({ environmentId, input: { channelId } }),
  );
  const post = useRefusableCommand(channelEnvironment.postMessage);
  const dmPost = useRefusableCommand(channelEnvironment.dmPost);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const channelState = messages.data ?? EMPTY_CHANNEL_STATE;
  // Live rows by thread id, with their agent: that agent's "Waiting for" note would say it twice.
  const [showingRuns, setShowingRuns] = useState(NO_SHOWING_RUNS);
  const reportRun = useCallback((threadId: string, runAgentId: string | null) => {
    setShowingRuns((current) => {
      if ((current.get(threadId) ?? null) === runAgentId) return current;
      const next = new Map(current);
      if (runAgentId === null) next.delete(threadId);
      else next.set(threadId, runAgentId);
      return next;
    });
  }, []);
  // Newest first for an inverted list, which keeps the newest message in view as messages arrive.
  const rows = useMemo(
    () => [...messageRows(channelState.messages, agents, new Set(showingRuns.values()))].reverse(),
    [channelState.messages, agents, showingRuns],
  );
  const trimmed = body.trim();
  const canPost = (channelId !== null || agentId !== null) && props.notice === undefined;

  const send = async () => {
    if (trimmed.length === 0 || sending || !canPost) return;
    setSending(true);
    const messageId = MessageId.make(uuidv4());
    const sent =
      agentId !== null
        ? await dmPost(
            { environmentId, input: { agentId, messageId, body: trimmed } },
            "The message was not sent",
          )
        : channelId !== null
          ? await post(
              { environmentId, input: { channelId, messageId, body: trimmed } },
              "The message was not sent",
            )
          : false;
    setSending(false);
    if (sent) setBody("");
  };

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title: props.title }} />
      <FlatList
        inverted
        data={rows}
        keyExtractor={(row) => row.message.id}
        renderItem={({ item }) => <MessageRow row={item} environmentId={environmentId} />}
        contentContainerClassName="px-4 pt-3 pb-3"
        // The inverted list's header sits under the newest message.
        ListHeaderComponent={
          channelState.runs.length === 0 ? null : (
            <View>
              {channelState.runs.map((run) => (
                <LiveRunRow
                  key={run.threadId}
                  run={run}
                  agents={agents}
                  channelMessages={channelState.messages}
                  environmentId={environmentId}
                  onShow={reportRun}
                />
              ))}
            </View>
          )
        }
        ListEmptyComponent={
          <View className="items-center py-16" style={{ transform: [{ scaleY: -1 }] }}>
            <Muted>{messages.error ?? props.emptyText}</Muted>
          </View>
        }
      />
      {canPost || props.notice !== undefined ? (
        <KeyboardStickyView offset={{ opened: insets.bottom }}>
          <View
            className="gap-2 border-t border-border bg-screen px-4 pt-2"
            style={{ paddingBottom: Math.max(insets.bottom, 8) }}
          >
            {props.notice !== undefined ? <Muted>{props.notice}</Muted> : null}
            <View className="flex-row items-end gap-2">
              <View className="flex-1">
                <Field
                  value={body}
                  onChangeText={setBody}
                  placeholder={
                    props.placeholder ??
                    (agentId !== null
                      ? `Message ${props.title}`
                      : `Message ${props.title} — @mention to wake an agent`)
                  }
                  editable={canPost}
                  multiline
                />
              </View>
              <ActionButton
                label="Send"
                kind="primary"
                disabled={!canPost || trimmed.length === 0 || sending}
                onPress={() => void send()}
              />
            </View>
          </View>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
}

interface MessageRowModel {
  readonly message: OrchestrationChannelMessage;
  readonly authorName: string;
  readonly showHeader: boolean;
  readonly notes: ReadonlyArray<{
    readonly agentId: string;
    readonly text: string;
    readonly undelivered: boolean;
  }>;
}

/**
 * Named authors, one header per author's run of messages, and what each human message's deliveries
 * say, leaving out the waits of agents in `working`, whose live row shows instead.
 */
function messageRows(
  messages: ReadonlyArray<OrchestrationChannelMessage>,
  agents: ReadonlyArray<OrchestrationAgentShell>,
  working: ReadonlySet<string>,
): ReadonlyArray<MessageRowModel> {
  const names = new Map<string, string>(agents.map((agent) => [agent.id, agent.name]));
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const continuesRun =
      previous !== undefined &&
      previous.authorKind === message.authorKind &&
      previous.authorId === message.authorId &&
      Date.parse(message.createdAt) - Date.parse(previous.createdAt) < GROUP_WINDOW_MS;
    return {
      message,
      authorName:
        message.authorKind === "human"
          ? "You"
          : message.authorKind === "system"
            ? "Iskra"
            : (names.get(message.authorId) ?? message.authorId),
      showHeader: !continuesRun,
      notes:
        message.authorKind !== "human"
          ? []
          : (message.deliveries ?? []).flatMap((delivery): MessageRowModel["notes"] => {
              const name = `@${names.get(delivery.agentId) ?? delivery.agentId}`;
              return delivery.status === "delivered"
                ? []
                : delivery.status === "undelivered"
                  ? [
                      {
                        agentId: delivery.agentId,
                        text: `${name} never read this`,
                        undelivered: true,
                      },
                    ]
                  : working.has(delivery.agentId)
                    ? []
                    : [
                        {
                          agentId: delivery.agentId,
                          text: `Waiting for ${name}`,
                          undelivered: false,
                        },
                      ];
            }),
    };
  });
}

/**
 * A run still working on its reply: what it has said so far this turn as it streams in, or that it
 * is working or waiting on you. It hides the moment the turn's reply is posted.
 */
const LiveRunRow = memo(function LiveRunRow(props: {
  readonly run: OrchestrationChannelRun;
  readonly agents: ReadonlyArray<OrchestrationAgentShell>;
  readonly channelMessages: ReadonlyArray<OrchestrationChannelMessage>;
  readonly environmentId: EnvironmentId;
  readonly onShow: (threadId: string, agentId: string | null) => void;
}) {
  const { run, onShow } = props;
  // ponytail: an ended run keeps its thread subscription until the channel resubscribes.
  const thread = Option.getOrNull(
    useThreadDetail({ environmentId: props.environmentId, threadId: run.threadId }).data,
  );
  const awaitingInput = useMemo(() => {
    if (thread === null) return false;
    const pending = derivePendingRequests(thread.activities);
    return pending.approvals.length + pending.userInputs.length > 0;
  }, [thread]);
  const preview = liveRunPreview({
    run,
    thread,
    awaitingInput,
    channelMessages: props.channelMessages,
    // oxlint-disable-next-line react/purity -- the start and settle graces compare against render time
    now: Date.now(),
  });
  const visible = preview !== null;
  useLayoutEffect(() => {
    onShow(run.threadId, visible ? run.agentId : null);
    return () => onShow(run.threadId, null);
  }, [onShow, run.threadId, run.agentId, visible]);
  if (preview === null) return null;
  const name = props.agents.find((agent) => agent.id === run.agentId)?.name ?? run.agentId;
  return (
    <View className="gap-1 pt-4">
      <View className="flex-row items-center gap-2">
        <AgentAvatar name={name} size={22} spark={preview.waiting ? "needsYou" : "working"} />
        <Body strong>{name}</Body>
        <Muted>{timeFormat.format(new Date(run.startedAt))}</Muted>
      </View>
      {preview.message !== null ? <Body>{preview.message.text}</Body> : null}
      {preview.waiting || preview.message === null ? (
        <View className="flex-row items-center gap-1.5">
          <SparkGlyph state={preview.waiting ? "needsYou" : "working"} size={12} />
          <Muted>{preview.waiting ? "Waiting on you" : "Working…"}</Muted>
        </View>
      ) : null}
    </View>
  );
});

/** The card an Iskra note reports on, read from the note's id, and whether it is its owner's question. */
function cardNoteOf(message: OrchestrationChannelMessage) {
  const match =
    message.authorKind === "system" ? /:card-(progress|question):([^:]+)$/.exec(message.id) : null;
  return match?.[2] === undefined ? null : { cardId: match[2], question: match[1] === "question" };
}

const MessageRow = memo(function MessageRow(props: {
  readonly row: MessageRowModel;
  readonly environmentId: EnvironmentId;
}) {
  const navigation = useNavigation();
  const { message, authorName, showHeader, notes } = props.row;
  if (message.authorKind === "system") {
    const note = cardNoteOf(message);
    return (
      <View className="py-2">
        <EventLine spark={note?.question === true ? "needsYou" : "idle"}>
          <Text className="text-center text-[13px] text-foreground-muted">
            {message.body} · {timeFormat.format(new Date(message.createdAt))}
          </Text>
          {note !== null ? (
            <Pressable
              accessibilityRole="link"
              onPress={() =>
                navigation.navigate("IskraCard", {
                  environmentId: props.environmentId,
                  cardId: note.cardId,
                })
              }
            >
              <Text style={{ color: TONE_COLOR.blue, fontSize: 13, fontWeight: "600" }}>
                {note.question ? "Answer on the card" : "Open card"}
              </Text>
            </Pressable>
          ) : null}
        </EventLine>
      </View>
    );
  }
  return (
    <View className={showHeader ? "gap-1 pt-4" : "gap-1 pt-1"}>
      {showHeader ? (
        <View className="flex-row items-center gap-2">
          {message.authorKind === "agent" ? <AgentAvatar name={authorName} size={22} /> : null}
          <Body strong>{authorName}</Body>
          <Muted>{timeFormat.format(new Date(message.createdAt))}</Muted>
        </View>
      ) : null}
      <Body>{message.body}</Body>
      {message.authorKind === "agent" && message.elicitation !== undefined ? (
        <ChannelQuestion
          environmentId={props.environmentId}
          message={{ ...message, elicitation: message.elicitation }}
        />
      ) : null}
      {notes.map((note) => (
        <Text
          key={note.agentId}
          className="text-[13px]"
          style={{ color: note.undelivered ? TONE_COLOR.red : TONE_COLOR.gray }}
        >
          {note.text}
        </Text>
      ))}
    </View>
  );
});
