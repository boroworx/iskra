import {
  ChannelId,
  DEFAULT_PROJECT_ORCHESTRATION,
  MessageId,
  ThreadId,
  type OrchestrationCommand,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyCommands,
  applyTo,
  assign,
  backend,
  cardId,
  createAgent,
  createCard,
  createChannel,
  createProject,
  guardProject,
  createThread,
  decide,
  frontend,
  nextCommandId,
  now,
  onCard,
  postMessage,
  projectId,
  recordSession,
  setSession,
  setWorkspace,
  startChannelRun,
} from "./decider.testkit.ts";

const channelId = ChannelId.make("channel-backend");

const setup: ReadonlyArray<OrchestrationCommand> = [
  createProject(),
  guardProject(),
  createAgent(backend),
  createAgent(frontend),
  createCard(),
  onCard("card.approve"),
  onCard("card.spec.approve"),
];

const owned = [...setup, assign(backend), setWorkspace(), recordSession("session-owner", backend)];

it.layer(NodeServices.layer)("decider card sessions", (it) => {
  it.effect("keeps one live writing session per card", () =>
    Effect.gen(function* () {
      const readModel = yield* applyCommands(owned);
      expect(readModel.liveRuns).toEqual([
        expect.objectContaining({
          threadId: "session-owner",
          cardId,
          role: "owner",
          channelId: null,
        }),
      ]);

      const second = yield* Effect.flip(
        applyTo(readModel, [recordSession("session-second", backend)]),
      );
      expect(second.message).toContain("one session writes at a time");
      const fresh = yield* Effect.flip(
        applyTo(readModel, [
          { type: "card.session.start", commandId: nextCommandId(), cardId, createdAt: now },
        ]),
      );
      expect(fresh.message).toContain("one session writes at a time");
    }),
  );

  it.effect("keeps helpers read-only and owners within their agent's capabilities", () =>
    Effect.gen(function* () {
      const helper = yield* Effect.flip(
        applyCommands([
          ...setup,
          recordSession("session-helper", frontend, "helper", ["read", "write"]),
        ]),
      );
      expect(helper.message).toContain("A helper session is read-only.");

      const beyond = yield* Effect.flip(
        applyCommands([
          ...setup,
          assign(backend),
          setWorkspace(),
          recordSession("session-shell", backend, "owner", ["read", "write", "shell"]),
        ]),
      );
      expect(beyond.message).toContain("is not allowed shell");

      const notTheAgent = yield* Effect.flip(
        applyCommands([
          ...setup,
          assign(backend),
          setWorkspace(),
          recordSession("session-other", frontend, "owner", ["read"]),
        ]),
      );
      expect(notTheAgent.message).toContain("Only the card's assigned agent writes to it");

      const noWorktree = yield* Effect.flip(
        applyCommands([
          ...setup,
          assign(backend),
          recordSession("session-early", backend, "owner", ["read"]),
        ]),
      );
      expect(noWorktree.message).toContain("worktree");
    }),
  );

  it.effect("changes the agent between the owner's turns, never during one", () =>
    Effect.gen(function* () {
      const working = yield* applyCommands([
        ...owned,
        createThread("session-owner"),
        setSession("session-owner", "running", "turn-1"),
      ]);
      const midTurn = yield* Effect.flip(applyTo(working, [assign(frontend)]));
      expect(midTurn.message).toContain("Wait for the agent's current turn to end");

      const idle = yield* applyTo(working, [
        setSession("session-owner", "ready"),
        assign(frontend),
      ]);
      expect(idle.cards?.[0]?.delegateAgentId).toBe(frontend);
    }),
  );

  it.effect(
    "counts card sessions toward the project's cap without making the agent busy in channels",
    () =>
      Effect.gen(function* () {
        const withChannel = yield* applyCommands([
          ...owned,
          {
            type: "project.orchestration.set",
            commandId: nextCommandId(),
            projectId,
            orchestration: {
              ...DEFAULT_PROJECT_ORCHESTRATION,
              sessionCap: 3,
              sideEffectGuard: { acknowledgedAt: now, killSwitchEnv: null },
            },
          } satisfies OrchestrationCommand,
          createChannel(channelId, "channel", [backend, frontend]),
        ]);

        // Writing a card does not stop the agent answering in a channel.
        const woken = yield* decide(
          withChannel,
          postMessage(channelId, "@backend how do limits work?"),
        );
        expect(woken.map((event) => event.type)).toEqual([
          "channel.message-posted",
          "channel.agent-wake-requested",
        ]);

        const atCap = yield* applyTo(withChannel, [
          recordSession("session-helper-1", frontend, "helper", ["read"]),
          recordSession("session-helper-2", frontend, "helper", ["read"]),
        ]);
        const refused = yield* decide(atCap, postMessage(channelId, "@backend one more?"));
        expect(refused.map((event) => event.type)).toEqual([
          "channel.message-posted",
          "channel.message-posted",
        ]);
        expect(refused[1]?.payload).toMatchObject({ authorKind: "system" });
      }),
  );

  it.effect("sends a DM message into the chosen live session and never starts one", () =>
    Effect.gen(function* () {
      const dm = (threadId: string): OrchestrationCommand => ({
        type: "agent.session.message",
        commandId: nextCommandId(),
        threadId: ThreadId.make(threadId),
        messageId: MessageId.make(`dm-${threadId}`),
        body: "Also cover burst traffic.",
        createdAt: now,
      });
      const readModel = yield* applyCommands([
        ...owned,
        recordSession("session-helper", frontend, "helper", ["read"]),
        createChannel(channelId, "channel", [backend, frontend]),
        startChannelRun(frontend, channelId, "run-conversation"),
      ]);

      const toOwner = yield* decide(readModel, dm("session-owner"));
      expect(toOwner).toEqual([
        expect.objectContaining({
          type: "card.activity-recorded",
          payload: expect.objectContaining({
            cardId,
            deliverTo: "builder",
            author: { kind: "human", id: "human" },
          }),
        }),
      ]);

      const toConversation = yield* decide(readModel, dm("run-conversation"));
      expect(toConversation.map((event) => event.type)).toEqual([
        "channel.message-posted",
        "channel.agent-wake-requested",
      ]);
      expect(toConversation[0]?.payload).toMatchObject({
        body: "@frontend Also cover burst traffic.",
      });
      expect(toConversation[1]?.payload).toMatchObject({ liveRunThreadId: "run-conversation" });

      const toHelper = yield* Effect.flip(decide(readModel, dm("session-helper")));
      expect(toHelper.message).toContain("A helper takes no messages");
      const ended = yield* Effect.flip(decide(readModel, dm("session-gone")));
      expect(ended.message).toContain("a DM message never starts a session");
    }),
  );
});
