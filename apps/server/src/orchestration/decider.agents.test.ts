import { AgentId, AgentName, type OrchestrationCommand } from "@iskra/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  applyCommands,
  createAgent,
  createProject,
  nextCommandId,
  projectId,
} from "./decider.testkit.ts";

const agentOne = AgentId.make("agent-1");
const agentTwo = AgentId.make("agent-2");

const archiveAgent = (type: "agent.archive" | "agent.unarchive"): OrchestrationCommand => ({
  type,
  commandId: nextCommandId(),
  agentId: agentOne,
});

it.layer(NodeServices.layer)("decider agents", (it) => {
  it.effect("creates an agent in an existing project", () =>
    Effect.gen(function* () {
      const readModel = yield* applyCommands([
        createProject(),
        createAgent(agentOne, { name: "backend", capabilities: ["read"] }),
      ]);

      expect(readModel.agents).toMatchObject([
        { id: "agent-1", projectId, name: "backend", capabilities: ["read"], archivedAt: null },
      ]);
    }),
  );

  it.effect("rejects an agent for a project that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(applyCommands([createAgent(agentOne)]));

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a second agent with the same name in a project", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        applyCommands([
          createProject(),
          createAgent(agentOne, { name: "backend" }),
          createAgent(agentTwo, { name: "backend" }),
        ]),
      );

      expect(error.message).toContain("'backend' is already taken");
    }),
  );

  it.effect("rejects renaming an agent onto a taken name", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        applyCommands([
          createProject(),
          createAgent(agentOne, { name: "backend" }),
          createAgent(agentTwo, { name: "frontend" }),
          { type: "agent.update", commandId: nextCommandId(), agentId: agentTwo, name: "backend" },
        ]),
      );

      expect(error.message).toContain("'backend' is already taken");
    }),
  );

  it.effect("archives and unarchives an agent, rejecting repeats", () =>
    Effect.gen(function* () {
      const base = [createProject(), createAgent(agentOne)];

      const archived = yield* applyCommands([...base, archiveAgent("agent.archive")]);
      expect(archived.agents?.[0]?.archivedAt).not.toBeNull();

      const restored = yield* applyCommands([
        ...base,
        archiveAgent("agent.archive"),
        archiveAgent("agent.unarchive"),
      ]);
      expect(restored.agents?.[0]?.archivedAt).toBeNull();

      yield* Effect.flip(
        applyCommands([...base, archiveAgent("agent.archive"), archiveAgent("agent.archive")]),
      );
      yield* Effect.flip(applyCommands([...base, archiveAgent("agent.unarchive")]));
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
