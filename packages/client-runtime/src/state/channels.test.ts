import {
  AgentId,
  ChannelId,
  MessageId,
  ThreadId,
  TurnId,
  type ChannelMessageDelivery,
  type OrchestrationChannelMessage,
  type OrchestrationChannelRun,
  type OrchestrationMessage,
  type OrchestrationSession,
} from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyChannelStreamItem,
  EMPTY_CHANNEL_STATE,
  liveRunPreview,
  RUN_SETTLE_GRACE_MS,
  type ChannelState,
} from "./channels.ts";

const START = Date.parse("2026-01-01T00:00:00.000Z");
// Whole seconds after START, as the ISO time the contracts carry.
const at = (seconds: number) => `2026-01-01T00:00:0${seconds}.000Z`;

type PreviewThread = NonNullable<Parameters<typeof liveRunPreview>[0]["thread"]>;

const said = (turnId: string, text: string, streaming = false): OrchestrationMessage => ({
  id: MessageId.make(`assistant-${turnId}-${text.length}`),
  role: "assistant",
  text,
  turnId: TurnId.make(turnId),
  streaming,
  createdAt: at(1),
  updatedAt: at(1),
});

const thread = (input: {
  readonly status: OrchestrationSession["status"];
  readonly activeTurnId?: string | null;
  readonly turnId?: string;
  readonly completedAt?: string | null;
  readonly messages?: ReadonlyArray<OrchestrationMessage>;
}): PreviewThread => ({
  session: {
    threadId: ThreadId.make("run-a"),
    status: input.status,
    providerName: null,
    runtimeMode: "approval-required",
    activeTurnId:
      input.activeTurnId === undefined || input.activeTurnId === null
        ? null
        : TurnId.make(input.activeTurnId),
    lastError: null,
    updatedAt: at(0),
  },
  latestTurn:
    input.turnId === undefined
      ? null
      : {
          turnId: TurnId.make(input.turnId),
          state: input.completedAt ? "completed" : "running",
          requestedAt: at(0),
          startedAt: at(0),
          completedAt: input.completedAt ?? null,
          assistantMessageId: null,
        },
  messages: input.messages ?? [],
});

describe("liveRunPreview", () => {
  const preview = (
    previewThread: PreviewThread | null,
    now: number,
    channelMessages: ReadonlyArray<{ readonly id: string }> = [],
  ) =>
    liveRunPreview({
      run: run("run-a"),
      thread: previewThread,
      awaitingInput: false,
      channelMessages: channelMessages.map((entry) => ({ id: MessageId.make(entry.id) })),
      now,
    });

  it("shows a run with no session yet as working, briefly", () => {
    expect(preview(null, START + 5_000)).toEqual({ turnId: null, message: null, waiting: false });
    expect(preview(null, START + RUN_SETTLE_GRACE_MS + 1)).toBeNull();
  });

  it("streams the turn's newest non-empty assistant text, the one its reply will post", () => {
    const running = thread({
      status: "running",
      activeTurnId: "turn-1",
      turnId: "turn-1",
      messages: [
        said("turn-1", "First paragraph."),
        said("turn-1", "  "),
        said("turn-1", "Second, still going", true),
      ],
    });

    expect(preview(running, START + 2_000)?.message?.text).toBe("Second, still going");
    expect(preview(running, START + 2_000)?.message?.streaming).toBe(true);
  });

  it("hides once the channel holds this turn's reply, and shows again for a follow-up turn", () => {
    const settled = thread({
      status: "ready",
      turnId: "turn-1",
      completedAt: at(3),
      messages: [said("turn-1", "Done.")],
    });
    // Between the turn ending and its reply posting, the text stays in place.
    expect(preview(settled, START + 4_000)?.message?.text).toBe("Done.");
    expect(preview(settled, START + 4_000, [{ id: "run-reply:run-a:turn-1" }])).toBeNull();

    const followUp = thread({
      status: "running",
      activeTurnId: "turn-2",
      turnId: "turn-2",
      messages: [said("turn-1", "Done.")],
    });
    expect(preview(followUp, START + 5_000, [{ id: "run-reply:run-a:turn-1" }])).toEqual({
      turnId: "turn-2",
      message: null,
      waiting: false,
    });
  });

  it("hides a stopped run, and a settled turn that never posted after the grace", () => {
    expect(preview(thread({ status: "stopped", turnId: "turn-1" }), START + 1_000)).toBeNull();
    const settled = thread({
      status: "ready",
      turnId: "turn-1",
      completedAt: at(0),
      messages: [said("turn-1", "Done.")],
    });
    expect(preview(settled, START + RUN_SETTLE_GRACE_MS + 1)).toBeNull();
  });
});

const message = (id: string, body = id): OrchestrationChannelMessage => ({
  id: MessageId.make(id),
  channelId: ChannelId.make("general"),
  authorKind: "human",
  authorId: "human",
  body,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const run = (threadId: string): OrchestrationChannelRun => ({
  threadId: ThreadId.make(threadId),
  agentId: AgentId.make("lead"),
  startedAt: "2026-01-01T00:00:00.000Z",
});

describe("applyChannelStreamItem", () => {
  it("keeps one copy of a message that arrives in the snapshot and live", () => {
    const afterSnapshot = applyChannelStreamItem(EMPTY_CHANNEL_STATE, {
      kind: "snapshot",
      messages: [message("a"), message("b")],
      runs: [],
    });
    const afterLive = [message("b"), message("c")].reduce(
      (state, live) => applyChannelStreamItem(state, { kind: "message", message: live }),
      afterSnapshot,
    );

    expect(afterLive.messages.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps one copy of a run that arrives in the snapshot and live", () => {
    const afterSnapshot = applyChannelStreamItem(EMPTY_CHANNEL_STATE, {
      kind: "snapshot",
      messages: [],
      runs: [run("run-a")],
    });
    const afterLive = [run("run-a"), run("run-b")].reduce(
      (state, live) => applyChannelStreamItem(state, { kind: "run", run: live }),
      afterSnapshot,
    );

    expect(afterLive.runs.map((entry) => entry.threadId)).toEqual(["run-a", "run-b"]);
  });

  it("keeps each agent's latest delivery standing on a message", () => {
    const backend = AgentId.make("backend");
    const writer = AgentId.make("writer");
    const deliveries: ReadonlyArray<ChannelMessageDelivery> = [
      { agentId: backend, status: "pending" },
      { agentId: writer, status: "pending" },
      { agentId: backend, status: "delivered" },
    ];
    let next: ChannelState = { messages: [message("a"), message("b")], runs: [] };
    for (const delivery of deliveries) {
      next = applyChannelStreamItem(next, {
        kind: "delivery",
        messageId: MessageId.make("b"),
        delivery,
      });
    }

    expect(next.messages[0]?.deliveries).toBeUndefined();
    expect(next.messages[1]?.deliveries).toEqual([
      { agentId: "writer", status: "pending" },
      { agentId: "backend", status: "delivered" },
    ]);
  });

  it("replaces held messages and runs with a resubscription's snapshot", () => {
    const held: ChannelState = { messages: [message("a"), message("b")], runs: [run("run-a")] };
    const next = applyChannelStreamItem(held, {
      kind: "snapshot",
      messages: [message("b")],
      runs: [],
    });

    expect(next.messages.map((entry) => entry.id)).toEqual(["b"]);
    expect(next.runs).toEqual([]);
  });
});
