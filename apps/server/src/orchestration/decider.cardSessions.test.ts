import {
  AgentId,
  CardId,
  ChannelId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CardSessionRole,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type RunCapability,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-sessions");
const cardId = CardId.make("card-limits");
const channelId = ChannelId.make("channel-backend");
const backend = AgentId.make("agent-backend");
const frontend = AgentId.make("agent-frontend");

let commandCount = 0;
const nextCommandId = () => CommandId.make(`cmd-session-${(commandCount += 1)}`);

const createAgent = (id: AgentId, capabilities: ReadonlyArray<RunCapability>): OrchestrationCommand => ({
  type: "agent.create",
  commandId: nextCommandId(),
  agentId: id,
  projectId,
  name: id.replace("agent-", ""),
  roleTags: [],
  rolePrompt: "",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
  capabilities,
  createdAt: now,
});

const setup: ReadonlyArray<OrchestrationCommand> = [
  {
    type: "project.create",
    commandId: nextCommandId(),
    projectId,
    title: "Sessions",
    workspaceRoot: "/tmp/sessions",
    createdAt: now,
  },
  createAgent(backend, ["read", "write"]),
  createAgent(frontend, ["read", "write"]),
  {
    type: "card.create",
    commandId: nextCommandId(),
    cardId,
    projectId,
    title: "Rate limiting",
    spec: "",
    tags: [],
    createdAt: now,
  },
  { type: "card.approve", commandId: nextCommandId(), cardId },
  { type: "card.spec.approve", commandId: nextCommandId(), cardId },
];

const assign = (agentId: AgentId): OrchestrationCommand => ({
  type: "card.assign",
  commandId: nextCommandId(),
  cardId,
  agentId,
});

const workspace: OrchestrationCommand = {
  type: "card.workspace.set",
  commandId: nextCommandId(),
  cardId,
  branch: "iskra/rate-limiting-limits",
  worktreePath: "/tmp/worktrees/rate-limiting",
  portBase: 42000,
};

const record = (
  threadId: string,
  agentId: AgentId,
  role: CardSessionRole,
  capabilities: ReadonlyArray<RunCapability>,
): OrchestrationCommand => ({
  type: "card.session.record",
  commandId: nextCommandId(),
  threadId: ThreadId.make(threadId),
  cardId,
  agentId,
  role,
  capabilities,
  context: {
    agent: { id: agentId, name: "agent", rolePrompt: "" },
    role,
    card: { id: cardId, title: "Rate limiting", spec: "", branch: null, baseBranch: "main" },
    decisions: [],
    diff: "",
    diffTruncated: false,
    question: null,
  },
  rendered: { systemPrompt: "system", firstMessage: "brief" },
  startedAt: now,
});

const sessionThread = (threadId: string): ReadonlyArray<OrchestrationCommand> => [
  {
    type: "thread.create",
    commandId: nextCommandId(),
    threadId: ThreadId.make(threadId),
    projectId,
    title: "@backend on Rate limiting",
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
  },
];

const setSession = (threadId: string, turnId: string | null): OrchestrationCommand => ({
  type: "thread.session.set",
  commandId: nextCommandId(),
  threadId: ThreadId.make(threadId),
  session: {
    threadId: ThreadId.make(threadId),
    status: turnId === null ? "ready" : "running",
    providerName: "claudeAgent",
    runtimeMode: "approval-required",
    activeTurnId: turnId === null ? null : TurnId.make(turnId),
    lastError: null,
    updatedAt: now,
  },
  createdAt: now,
});

const applyTo = Effect.fn("applyTo")(function* (
  initial: OrchestrationReadModel,
  commands: ReadonlyArray<OrchestrationCommand>,
) {
  let readModel = initial;
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
const applyCommands = (commands: ReadonlyArray<OrchestrationCommand>) =>
  applyTo(createEmptyReadModel(now), commands);

const decide = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

const owned = [...setup, assign(backend), workspace, record("session-owner", backend, "owner", ["read", "write"])];

it.layer(NodeServices.layer)("decider card sessions", (it) => {
  it.effect("keeps one live writing session per card", () =>
    Effect.gen(function* () {
      const readModel = yield* applyCommands(owned);
      expect(readModel.liveRuns).toEqual([
        expect.objectContaining({ threadId: "session-owner", cardId, role: "owner", channelId: null }),
      ]);

      const second = yield* Effect.flip(
        applyTo(readModel, [record("session-second", backend, "owner", ["read", "write"])]),
      );
      expect(second.message).toContain("one session writes at a time");
      const fresh = yield* Effect.flip(
        applyTo(readModel, [{ type: "card.session.start", commandId: nextCommandId(), cardId, createdAt: now }]),
      );
      expect(fresh.message).toContain("one session writes at a time");
    }),
  );

  it.effect("keeps helpers read-only and owners within their agent's capabilities", () =>
    Effect.gen(function* () {
      const helper = yield* Effect.flip(
        applyCommands([...setup, record("session-helper", frontend, "helper", ["read", "write"])]),
      );
      expect(helper.message).toContain("A helper session is read-only.");

      const beyond = yield* Effect.flip(
        applyCommands([...setup, assign(backend), workspace, record("session-shell", backend, "owner", ["read", "write", "shell"])]),
      );
      expect(beyond.message).toContain("is not allowed shell");

      const notTheAgent = yield* Effect.flip(
        applyCommands([...setup, assign(backend), workspace, record("session-other", frontend, "owner", ["read"])]),
      );
      expect(notTheAgent.message).toContain("Only the card's assigned agent writes to it");

      const noWorktree = yield* Effect.flip(
        applyCommands([...setup, assign(backend), record("session-early", backend, "owner", ["read"])]),
      );
      expect(noWorktree.message).toContain("worktree");
    }),
  );

  it.effect("changes the agent between the owner's turns, never during one", () =>
    Effect.gen(function* () {
      const working = yield* applyCommands([
        ...owned,
        ...sessionThread("session-owner"),
        setSession("session-owner", "turn-1"),
      ]);
      const midTurn = yield* Effect.flip(applyTo(working, [assign(frontend)]));
      expect(midTurn.message).toContain("Wait for the agent's current turn to end");

      const idle = yield* applyTo(working, [setSession("session-owner", null), assign(frontend)]);
      expect(idle.cards?.[0]?.delegateAgentId).toBe(frontend);
    }),
  );

  it.effect("counts card sessions toward the project's cap without making the agent busy in channels", () =>
    Effect.gen(function* () {
      const withChannel = yield* applyCommands([
        ...owned,
        {
          type: "channel.create",
          commandId: nextCommandId(),
          channelId,
          projectId,
          kind: "channel",
          name: "backend",
          memberAgentIds: [backend, frontend],
          createdAt: now,
        },
      ]);
      const post = (messageId: string, body: string): OrchestrationCommand => ({
        type: "channel.message.post",
        commandId: nextCommandId(),
        channelId,
        messageId: MessageId.make(messageId),
        body,
        createdAt: now,
      });

      // Writing a card does not stop the agent answering in a channel.
      const woken = yield* decide(withChannel, post("message-question", "@backend how do limits work?"));
      expect(woken.map((event) => event.type)).toEqual([
        "channel.message-posted",
        "channel.agent-wake-requested",
      ]);

      const atCap = yield* applyTo(withChannel, [
        record("session-helper-1", frontend, "helper", ["read"]),
        record("session-helper-2", frontend, "helper", ["read"]),
      ]);
      const refused = yield* decide(atCap, post("message-later", "@backend one more?"));
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
        record("session-helper", frontend, "helper", ["read"]),
        {
          type: "channel.create",
          commandId: nextCommandId(),
          channelId,
          projectId,
          kind: "channel",
          name: "backend",
          memberAgentIds: [backend, frontend],
          createdAt: now,
        },
        {
          type: "channel.run.start",
          commandId: nextCommandId(),
          threadId: ThreadId.make("run-conversation"),
          channelId,
          agentId: frontend,
          triggerMessageId: MessageId.make("message-trigger"),
          capabilities: ["read"],
          context: {
            agent: { id: frontend, name: "frontend", rolePrompt: "" },
            channel: { id: channelId, kind: "channel", name: "backend", topic: "" },
            pinnedSpec: "",
            wakeDepth: 0,
            history: [],
            trigger: {
              messageId: MessageId.make("message-trigger"),
              authorKind: "human",
              authorName: "user",
              body: "@frontend hi",
              createdAt: now,
            },
          },
          rendered: { systemPrompt: "system", firstMessage: "first" },
          startedAt: now,
        },
      ]);

      const toOwner = yield* decide(readModel, dm("session-owner"));
      expect(toOwner).toEqual([
        expect.objectContaining({
          type: "card.message-posted",
          payload: expect.objectContaining({ cardId, forOwner: true, authorKind: "human" }),
        }),
      ]);

      const toConversation = yield* decide(readModel, dm("run-conversation"));
      expect(toConversation.map((event) => event.type)).toEqual([
        "channel.message-posted",
        "channel.agent-wake-requested",
      ]);
      expect(toConversation[0]?.payload).toMatchObject({ body: "@frontend Also cover burst traffic." });
      expect(toConversation[1]?.payload).toMatchObject({ liveRunThreadId: "run-conversation" });

      const toHelper = yield* Effect.flip(decide(readModel, dm("session-helper")));
      expect(toHelper.message).toContain("A helper takes no messages");
      const ended = yield* Effect.flip(decide(readModel, dm("session-gone")));
      expect(ended.message).toContain("a DM message never starts a session");
    }),
  );
});
