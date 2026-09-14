import {
  AgentId,
  ChannelId,
  MessageId,
  ThreadId,
  type OrchestrationCommand,
} from "@iskra/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  applyCommands,
  backend,
  createAgent,
  createChannel,
  createProject,
  createThread,
  decide,
  frontend,
  nextCommandId,
  now,
  postMessage,
  reviewer,
  setSession,
  startChannelRun,
} from "./decider.testkit.ts";

const writer = AgentId.make("agent-writer");

const setup: ReadonlyArray<OrchestrationCommand> = [
  createProject(),
  createAgent(backend),
  createAgent(frontend),
];

const channelCommand = (
  id: string,
  type: "channel.archive" | "channel.unarchive",
): OrchestrationCommand => ({
  type,
  commandId: nextCommandId(),
  channelId: ChannelId.make(id),
});

// Decides a human post after `commands`.
const decidePost = (
  commands: ReadonlyArray<OrchestrationCommand>,
  channelId: string,
  body: string,
) =>
  applyCommands(commands).pipe(
    Effect.flatMap((readModel) => decide(readModel, postMessage(channelId, body))),
  );

it.layer(NodeServices.layer)("decider channels", (it) => {
  it.effect("creates a channel whose members are active agents of the project", () =>
    Effect.gen(function* () {
      const readModel = yield* applyCommands([
        ...setup,
        createChannel("general", "channel", [backend, frontend]),
      ]);

      expect(readModel.channels).toMatchObject([
        { id: "general", kind: "channel", wakeDepth: 30, memberAgentIds: [backend, frontend] },
      ]);
    }),
  );

  it.effect("rejects members that are unknown, archived, or listed twice", () =>
    Effect.gen(function* () {
      yield* Effect.flip(
        applyCommands([...setup, createChannel("general", "channel", [AgentId.make("ghost")])]),
      );
      yield* Effect.flip(
        applyCommands([
          ...setup,
          { type: "agent.archive", commandId: nextCommandId(), agentId: frontend },
          createChannel("general", "channel", [frontend]),
        ]),
      );
      const duplicate = yield* Effect.flip(
        applyCommands([...setup, createChannel("general", "channel", [backend, backend])]),
      );
      expect(duplicate.message).toContain("unique");
    }),
  );

  it.effect("gives a DM exactly one agent, and each agent one active DM", () =>
    Effect.gen(function* () {
      yield* Effect.flip(applyCommands([...setup, createChannel("dm-empty", "dm", [])]));
      yield* Effect.flip(
        applyCommands([...setup, createChannel("dm-pair", "dm", [backend, frontend])]),
      );

      const second = yield* Effect.flip(
        applyCommands([
          ...setup,
          createChannel("dm-backend", "dm", [backend]),
          createChannel("dm-backend-2", "dm", [backend]),
        ]),
      );
      expect(second.message).toContain("already has DM channel");

      // Archiving the first DM frees the agent, and unarchiving it is then refused.
      yield* Effect.flip(
        applyCommands([
          ...setup,
          createChannel("dm-backend", "dm", [backend]),
          channelCommand("dm-backend", "channel.archive"),
          createChannel("dm-backend-2", "dm", [backend]),
          channelCommand("dm-backend", "channel.unarchive"),
        ]),
      );
    }),
  );

  it.effect("wakes only an active member agent of an active channel", () =>
    Effect.gen(function* () {
      const wake = (agentId: AgentId): OrchestrationCommand => ({
        type: "channel.agent.wake",
        commandId: nextCommandId(),
        channelId: ChannelId.make("general"),
        agentId,
        triggerMessageId: MessageId.make("message-general-hello"),
        createdAt: now,
      });
      const base = [...setup, createChannel("general", "channel", [backend])];

      const readModel = yield* applyCommands(base);
      expect(yield* decide(readModel, wake(backend))).toMatchObject([
        { type: "channel.agent-wake-requested", payload: { agentId: backend } },
      ]);

      yield* Effect.flip(applyCommands([...base, wake(frontend)]));
      yield* Effect.flip(
        applyCommands([...base, channelCommand("general", "channel.archive"), wake(backend)]),
      );
    }),
  );

  it.effect("keeps channel conversation runs read-only", () =>
    Effect.gen(function* () {
      const readModel = yield* applyCommands([
        ...setup,
        createChannel("general", "channel", [backend]),
      ]);

      expect(
        yield* decide(readModel, startChannelRun(backend, "general", "run-thread")),
      ).toMatchObject([{ type: "channel.run-started" }]);

      const refused = yield* Effect.flip(
        decide(readModel, startChannelRun(backend, "general", "run-thread", ["read", "write"])),
      );
      expect(refused.message).toContain("read-only");
    }),
  );

  it.effect("posts an agent reply that names the run it came from", () =>
    Effect.gen(function* () {
      const readModel = yield* applyCommands([
        ...setup,
        createChannel("general", "channel", [backend]),
      ]);

      const posted = yield* decide(readModel, {
        type: "channel.message.agent.post",
        commandId: nextCommandId(),
        channelId: ChannelId.make("general"),
        messageId: MessageId.make("reply-1"),
        agentId: backend,
        runThreadId: ThreadId.make("run-thread"),
        body: "It is REST.",
        createdAt: now,
      });

      expect(posted).toMatchObject([
        {
          type: "channel.message-posted",
          payload: { authorKind: "agent", authorId: backend, runThreadId: "run-thread" },
        },
      ]);
    }),
  );

  it.effect("wakes exactly the member agents a message mentions, and says when it wakes nobody", () =>
    Effect.gen(function* () {
      const base = [
        ...setup,
        createAgent(reviewer),
        createChannel("general", "channel", [backend, frontend]),
      ];

      const mentioned = yield* decidePost(base, "general", "@frontend can you check this?");
      expect(mentioned.map((event) => event.type)).toEqual([
        "channel.message-posted",
        "channel.agent-wake-requested",
      ]);
      expect(mentioned[0]).toMatchObject({ payload: { mentions: [frontend] } });
      expect(mentioned[1]).toMatchObject({ payload: { agentId: frontend } });

      const silent = yield* decidePost(base, "general", "just thinking out loud");
      expect(silent.map((event) => event.type)).toEqual([
        "channel.message-posted",
        "channel.message-posted",
      ]);
      expect(silent[1]).toMatchObject({
        payload: {
          authorKind: "system",
          body: "Nobody was woken. @mention an agent, or choose a lead in channel settings.",
        },
      });

      const outsider = yield* decidePost(base, "general", "@reviewer any thoughts?");
      expect(outsider.map((event) => event.type)).toEqual([
        "channel.message-posted",
        "channel.message-posted",
      ]);
      expect(outsider[1]).toMatchObject({
        payload: { authorKind: "system", body: "@reviewer isn't an active member of #general." },
      });
    }),
  );

  it.effect("wakes a DM's agent on every human message, mention or not", () =>
    Effect.gen(function* () {
      const events = yield* decidePost(
        [...setup, createChannel("dm-backend", "dm", [backend])],
        "dm-backend",
        "hello",
      );

      expect(events.map((event) => event.type)).toEqual([
        "channel.message-posted",
        "channel.agent-wake-requested",
      ]);
      expect(events[1]).toMatchObject({ payload: { agentId: backend } });
    }),
  );

  it.effect("keeps one live run per agent: joins it from the same channel, refuses elsewhere", () =>
    Effect.gen(function* () {
      const base = [
        ...setup,
        createChannel("general", "channel", [backend]),
        createChannel("other", "channel", [backend]),
        startChannelRun(backend, "other", "run-other"),
      ];

      const elsewhere = yield* decidePost(base, "general", "@backend ping");
      expect(elsewhere.map((event) => event.type)).toEqual([
        "channel.message-posted",
        "channel.message-posted",
      ]);
      expect(elsewhere[1]).toMatchObject({
        payload: { authorKind: "system", body: "@backend is busy in another channel." },
      });

      const sameChannel = yield* decidePost(base, "other", "@backend one more thing");
      expect(sameChannel[1]).toMatchObject({
        type: "channel.agent-wake-requested",
        payload: { agentId: backend, liveRunThreadId: "run-other" },
      });
    }),
  );

  it.effect("refuses new runs past the project cap until a run's session ends", () =>
    Effect.gen(function* () {
      const base = [
        ...setup,
        createAgent(reviewer),
        createAgent(writer),
        createChannel("general", "channel", [backend, frontend, reviewer, writer]),
        startChannelRun(backend, "general", "run-1"),
        startChannelRun(frontend, "general", "run-2"),
        startChannelRun(reviewer, "general", "run-3"),
      ];

      const capped = yield* decidePost(base, "general", "@writer help");
      expect(capped[1]).toMatchObject({ payload: { authorKind: "system" } });

      const freed = yield* decidePost(
        [...base, createThread("run-1"), setSession("run-1", "stopped")],
        "general",
        "@writer help",
      );
      expect(freed[1]).toMatchObject({
        type: "channel.agent-wake-requested",
        payload: { agentId: writer },
      });
    }),
  );

  it.effect("accepts human messages only while the channel is not archived", () =>
    Effect.gen(function* () {
      const base = [...setup, createChannel("general", "channel", [backend])];

      const readModel = yield* applyCommands(base);
      expect((yield* decide(readModel, postMessage("general", "hello")))[0]).toMatchObject({
        type: "channel.message-posted",
        payload: { authorKind: "human", body: "hello" },
      });

      yield* Effect.flip(
        applyCommands([
          ...base,
          channelCommand("general", "channel.archive"),
          postMessage("general", "too-late"),
        ]),
      );
      yield* applyCommands([
        ...base,
        channelCommand("general", "channel.archive"),
        channelCommand("general", "channel.unarchive"),
        postMessage("general", "back-again"),
      ]);
    }),
  );
  it.effect(
    "wakes only the channel's lead on a message that mentions no one; a mention bypasses it",
    () =>
      Effect.gen(function* () {
        const lead = AgentId.make("agent-lead");
        const base = [
          ...setup,
          createAgent(lead),
          createChannel("triage", "channel", [backend], lead),
        ];

        const unmentioned = yield* decidePost(base, "triage", "the export button is broken");
        expect(unmentioned.map((event) => event.type)).toEqual([
          "channel.message-posted",
          "channel.agent-wake-requested",
        ]);
        expect(unmentioned[1]).toMatchObject({ payload: { agentId: lead } });

        const mentioned = yield* decidePost(base, "triage", "@backend the export button is broken");
        expect(mentioned.map((event) => event.type)).toEqual([
          "channel.message-posted",
          "channel.agent-wake-requested",
        ]);
        expect(mentioned[1]).toMatchObject({ payload: { agentId: backend } });

        // Any member may lead: an unaddressed message wakes it to triage.
        const memberLed = yield* decidePost(
          [...setup, createChannel("both", "channel", [backend], backend)],
          "both",
          "the export button is broken",
        );
        expect(memberLed[1]).toMatchObject({
          type: "channel.agent-wake-requested",
          payload: { agentId: backend },
        });
        const dm = yield* Effect.flip(
          applyCommands([
            ...setup,
            createAgent(lead),
            createChannel("dm-lead", "dm", [backend], lead),
          ]),
        );
        expect(dm.message).toContain("Only a channel can have a lead");
      }),
  );
});
