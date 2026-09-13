import {
  AgentId,
  AgentName,
  agentDmThreadId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-agents");

const createProject: OrchestrationCommand = {
  type: "project.create",
  commandId: CommandId.make("cmd-project-agents"),
  projectId,
  title: "Agents",
  workspaceRoot: "/tmp/agents",
  createdAt: now,
};

const createAgent = (id: string, name: string): OrchestrationCommand => ({
  type: "agent.create",
  commandId: CommandId.make(`cmd-create-${id}`),
  agentId: AgentId.make(id),
  projectId,
  name,
  roleTags: [],
  rolePrompt: "",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
  capabilities: ["read"],
  createdAt: now,
});

const archiveAgent = (
  id: string,
  type: "agent.archive" | "agent.unarchive",
): OrchestrationCommand => ({
  type,
  commandId: CommandId.make(`cmd-${type}-${id}`),
  agentId: AgentId.make(id),
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

it.layer(NodeServices.layer)("decider agents", (it) => {
  it.effect("creates an agent's DM thread only for that agent, in its own project", () =>
    Effect.gen(function* () {
      const otherProjectId = ProjectId.make("project-other");
      const dmThread = (inProject: ProjectId): OrchestrationCommand => ({
        type: "thread.create",
        commandId: CommandId.make(`cmd-dm-${inProject}`),
        threadId: agentDmThreadId(AgentId.make("agent-1")),
        projectId: inProject,
        title: "@backend",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-4-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      const createOtherProject: OrchestrationCommand = {
        type: "project.create",
        commandId: CommandId.make("cmd-project-other"),
        projectId: otherProjectId,
        title: "Other",
        workspaceRoot: "/tmp/other",
        createdAt: now,
      };

      const readModel = yield* applyCommands([
        createProject,
        createAgent("agent-1", "backend"),
        dmThread(projectId),
      ]);
      expect(readModel.threads.map((thread) => thread.id)).toContain("dm:agent-1");

      const inOtherProject = yield* Effect.flip(
        applyCommands([
          createProject,
          createOtherProject,
          createAgent("agent-1", "backend"),
          dmThread(otherProjectId),
        ]),
      );
      expect(inOtherProject.message).toContain("@backend");

      const withoutAgent = yield* Effect.flip(applyCommands([createProject, dmThread(projectId)]));
      expect(withoutAgent._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("creates an agent in an existing project", () =>
    Effect.gen(function* () {
      const readModel = yield* applyCommands([createProject, createAgent("agent-1", "backend")]);

      expect(readModel.agents).toMatchObject([
        { id: "agent-1", projectId, name: "backend", capabilities: ["read"], archivedAt: null },
      ]);
    }),
  );

  it.effect("rejects an agent for a project that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(applyCommands([createAgent("agent-1", "backend")]));

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a second agent with the same name in a project", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        applyCommands([
          createProject,
          createAgent("agent-1", "backend"),
          createAgent("agent-2", "backend"),
        ]),
      );

      expect(error.message).toContain("'backend' is already taken");
    }),
  );

  it.effect("rejects renaming an agent onto a taken name", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        applyCommands([
          createProject,
          createAgent("agent-1", "backend"),
          createAgent("agent-2", "frontend"),
          {
            type: "agent.update",
            commandId: CommandId.make("cmd-rename-agent-2"),
            agentId: AgentId.make("agent-2"),
            name: "backend",
          },
        ]),
      );

      expect(error.message).toContain("'backend' is already taken");
    }),
  );

  it.effect("archives and unarchives an agent, rejecting repeats", () =>
    Effect.gen(function* () {
      const base = [createProject, createAgent("agent-1", "backend")];

      const archived = yield* applyCommands([...base, archiveAgent("agent-1", "agent.archive")]);
      expect(archived.agents?.[0]?.archivedAt).not.toBeNull();

      const restored = yield* applyCommands([
        ...base,
        archiveAgent("agent-1", "agent.archive"),
        archiveAgent("agent-1", "agent.unarchive"),
      ]);
      expect(restored.agents?.[0]?.archivedAt).toBeNull();

      yield* Effect.flip(
        applyCommands([
          ...base,
          archiveAgent("agent-1", "agent.archive"),
          archiveAgent("agent-1", "agent.archive"),
        ]),
      );
      yield* Effect.flip(applyCommands([...base, archiveAgent("agent-1", "agent.unarchive")]));
    }),
  );

  it.effect("accepts only lowercase slug names, so every agent is @mentionable", () =>
    Effect.sync(() => {
      const isAgentName = Schema.is(AgentName);
      expect(isAgentName("backend-2")).toBe(true);
      expect(isAgentName("Backend")).toBe(false);
      expect(isAgentName("back end")).toBe(false);
      expect(isAgentName("@backend")).toBe(false);
    }),
  );
});
