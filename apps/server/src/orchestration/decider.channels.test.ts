import {
  AgentId,
  ChannelId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCommand,
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
