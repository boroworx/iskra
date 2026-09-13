import {
  AgentId,
  ChannelId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type RunCapability,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-channels");
const backend = AgentId.make("agent-backend");
const frontend = AgentId.make("agent-frontend");

const createAgent = (agentId: AgentId, name: string): OrchestrationCommand => ({
  type: "agent.create",
  commandId: CommandId.make(`cmd-create-${agentId}`),
  agentId,
  projectId,
  name,
  roleTags: [],
  rolePrompt: "",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
  capabilities: ["read"],
  createdAt: now,
});

const setup: ReadonlyArray<OrchestrationCommand> = [
  {
    type: "project.create",
    commandId: CommandId.make("cmd-project-channels"),
    projectId,
    title: "Channels",
    workspaceRoot: "/tmp/channels",
    createdAt: now,
  },
  createAgent(backend, "backend"),
  createAgent(frontend, "frontend"),
];

const createChannel = (
  id: string,
  kind: "channel" | "dm",
  memberAgentIds: ReadonlyArray<AgentId>,
): OrchestrationCommand => ({
  type: "channel.create",
  commandId: CommandId.make(`cmd-create-${id}`),
  channelId: ChannelId.make(id),
  projectId,
  kind,
  name: id,
  memberAgentIds,
  createdAt: now,
});

const channelCommand = (
  id: string,
  type: "channel.archive" | "channel.unarchive",
): OrchestrationCommand => ({
  type,
  commandId: CommandId.make(`cmd-${type}-${id}`),
  channelId: ChannelId.make(id),
});

const postMessage = (channelId: string, body: string): OrchestrationCommand => ({
  type: "channel.message.post",
  commandId: CommandId.make(`cmd-post-${channelId}-${body}`),
  channelId: ChannelId.make(channelId),
  messageId: MessageId.make(`message-${channelId}-${body}`),
  body,
  createdAt: now,
});

// Decides and projects each command in order, like the engine does for one batch.
const applyCommands = Effect.fn("applyCommands")(function* (
  commands: ReadonlyArray<OrchestrationCommand>,
) {
  let readModel = createEmptyReadModel(now);
  for (const command of commands) {
    const decided = yield* decideOrchestrationCommand({ command, readModel });
    for (const event of Array.isArray(decided) ? decided : [decided]) {
      readModel = yield* projectEvent(readModel, {
        ...event,
        sequence: readModel.snapshotSequence + 1,
      });
    }
  }
  return readModel;
});

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
          {
            type: "agent.archive",
            commandId: CommandId.make("cmd-archive-frontend"),
            agentId: frontend,
          },
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
        commandId: CommandId.make(`cmd-wake-${agentId}`),
        channelId: ChannelId.make("general"),
        agentId,
        triggerMessageId: MessageId.make("message-general-hello"),
        createdAt: now,
      });
      const base = [...setup, createChannel("general", "channel", [backend])];

      const readModel = yield* applyCommands(base);
      const woken = yield* decideOrchestrationCommand({ command: wake(backend), readModel });
      expect(woken).toMatchObject({
        type: "channel.agent-wake-requested",
        payload: { agentId: backend },
      });

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
      const trigger = {
        messageId: MessageId.make("message-general-hello"),
        authorKind: "human" as const,
        authorName: "user",
        body: "hello",
        createdAt: now,
      };
      const startRun = (capabilities: ReadonlyArray<RunCapability>): OrchestrationCommand => ({
        type: "channel.run.start",
        commandId: CommandId.make("cmd-run-start"),
        threadId: ThreadId.make("run-thread"),
        channelId: ChannelId.make("general"),
        agentId: backend,
        triggerMessageId: trigger.messageId,
        capabilities,
        context: {
          agent: { id: backend, name: "backend", rolePrompt: "" },
          channel: { id: ChannelId.make("general"), kind: "channel", name: "general", topic: "" },
          pinnedSpec: "",
          wakeDepth: 30,
          history: [],
          trigger,
        },
        rendered: { systemPrompt: "You are @backend.", firstMessage: "hello" },
        startedAt: now,
      });

      const started = yield* decideOrchestrationCommand({ command: startRun(["read"]), readModel });
      expect(started).toMatchObject({ type: "channel.run-started" });

      const refused = yield* Effect.flip(
        decideOrchestrationCommand({ command: startRun(["read", "write"]), readModel }),
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

      const posted = yield* decideOrchestrationCommand({
        command: {
          type: "channel.message.agent.post",
          commandId: CommandId.make("cmd-reply"),
          channelId: ChannelId.make("general"),
          messageId: MessageId.make("reply-1"),
          agentId: backend,
          runThreadId: ThreadId.make("run-thread"),
          body: "It is REST.",
          createdAt: now,
        },
        readModel,
      });

      expect(posted).toMatchObject({
        type: "channel.message-posted",
        payload: { authorKind: "agent", authorId: backend, runThreadId: "run-thread" },
      });
    }),
  );

  const reviewer = AgentId.make("agent-reviewer");
  const writer = AgentId.make("agent-writer");

  const startRun = (
    agentId: AgentId,
    channelId: string,
    threadId: string,
  ): OrchestrationCommand => ({
    type: "channel.run.start",
    commandId: CommandId.make(`cmd-run-${threadId}`),
    threadId: ThreadId.make(threadId),
    channelId: ChannelId.make(channelId),
    agentId,
    triggerMessageId: MessageId.make("message-trigger"),
    capabilities: ["read"],
    context: {
      agent: { id: agentId, name: "agent", rolePrompt: "" },
      channel: { id: ChannelId.make(channelId), kind: "channel", name: channelId, topic: "" },
      pinnedSpec: "",
      wakeDepth: 30,
      history: [],
      trigger: {
        messageId: MessageId.make("message-trigger"),
        authorKind: "human",
        authorName: "user",
        body: "hi",
        createdAt: now,
      },
    },
    rendered: { systemPrompt: "", firstMessage: "hi" },
    startedAt: now,
  });

  // Decides a human post after `commands`, always as a list of events.
  const decidePost = (
    commands: ReadonlyArray<OrchestrationCommand>,
    channelId: string,
    body: string,
  ) =>
    Effect.gen(function* () {
      const readModel = yield* applyCommands(commands);
      const decided = yield* decideOrchestrationCommand({
        command: postMessage(channelId, body),
        readModel,
      });
      return Array.isArray(decided) ? decided : [decided];
    });

  it.effect("wakes exactly the member agents a message mentions, and nobody otherwise", () =>
    Effect.gen(function* () {
      const base = [
        ...setup,
        createAgent(reviewer, "reviewer"),
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
      expect(silent.map((event) => event.type)).toEqual(["channel.message-posted"]);

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
        startRun(backend, "other", "run-other"),
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
        createAgent(reviewer, "reviewer"),
        createAgent(writer, "writer"),
        createChannel("general", "channel", [backend, frontend, reviewer, writer]),
        startRun(backend, "general", "run-1"),
        startRun(frontend, "general", "run-2"),
        startRun(reviewer, "general", "run-3"),
      ];

      const capped = yield* decidePost(base, "general", "@writer help");
      expect(capped[1]).toMatchObject({ payload: { authorKind: "system" } });

      const threadId = ThreadId.make("run-1");
      const freed = yield* decidePost(
        [
          ...base,
          {
            type: "thread.create",
            commandId: CommandId.make("cmd-thread-run-1"),
            threadId,
            projectId,
            title: "@backend in #general",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-haiku-4-5",
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          {
            type: "thread.session.set",
            commandId: CommandId.make("cmd-stop-run-1"),
            threadId,
            session: {
              threadId,
              status: "stopped",
              providerName: "claudeAgent",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            },
            createdAt: now,
          },
        ],
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
      const posted = yield* decideOrchestrationCommand({
        command: postMessage("general", "hello"),
        readModel,
      });
      expect(posted).toMatchObject({
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
});
