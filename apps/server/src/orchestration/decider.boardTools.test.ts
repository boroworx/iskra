import {
  AgentId,
  CardId,
  ChannelId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-tools");
const backend = AgentId.make("agent-backend");
const reviewer = AgentId.make("agent-reviewer");
const cardId = CardId.make("card-limits");

let commandCount = 0;
const nextCommandId = () => CommandId.make(`cmd-tools-${(commandCount += 1)}`);

const setup: ReadonlyArray<OrchestrationCommand> = [
  {
    type: "project.create",
    commandId: nextCommandId(),
    projectId,
    title: "Tools",
    workspaceRoot: "/tmp/tools",
    createdAt: now,
  },
  ...[backend, reviewer].map(
    (agentId): OrchestrationCommand => ({
      type: "agent.create",
      commandId: nextCommandId(),
      agentId,
      projectId,
      name: agentId.replace("agent-", ""),
      roleTags: [],
      rolePrompt: "",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
      capabilities: ["read", "write"],
      createdAt: now,
    }),
  ),
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
  { type: "card.assign", commandId: nextCommandId(), cardId, agentId: backend },
];

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

it.layer(NodeServices.layer)("decider board tools", (it) => {
  it.effect("puts a card an agent proposes into triage, authored by that agent", () =>
    Effect.gen(function* () {
      const proposedId = CardId.make("card-proposed");
      const proposed = yield* applyCommands([
        ...setup,
        {
          type: "card.propose",
          commandId: nextCommandId(),
          cardId: proposedId,
          agentId: backend,
          projectId,
          parentCardId: cardId,
          title: "Rate limit the webhooks too",
          spec: "Webhooks share the API's limits.",
          tags: ["api"],
          createdAt: now,
        },
      ]);

      expect(proposed.cards?.find((card) => card.id === proposedId)).toMatchObject({
        status: "triage",
        specState: "draft",
        parentCardId: cardId,
        createdBy: { kind: "agent", id: backend },
        delegateAgentId: null,
      });
    }),
  );

  it.effect("records a decision under the agent working on the card, and no other", () =>
    Effect.gen(function* () {
      const readModel = yield* applyCommands(setup);
      const record = (agentId: AgentId): OrchestrationCommand => ({
        type: "card.decision.agent.record",
        commandId: nextCommandId(),
        cardId,
        agentId,
        decisionId: `decision-${agentId}`,
        text: "Use a token bucket.",
        createdAt: now,
      });

      expect(yield* decide(readModel, record(backend))).toEqual([
        expect.objectContaining({
          type: "card.decision-recorded",
          payload: expect.objectContaining({
            author: { kind: "agent", id: backend },
            text: "Use a token bucket.",
          }),
        }),
      ]);
      const outsider = yield* Effect.flip(decide(readModel, record(reviewer)));
      expect(outsider.message).toContain("isn't working on this card");
    }),
  );
  it.effect("records a channel lead's proposal with its message, reasoning and likely duplicates", () =>
    Effect.gen(function* () {
      const channelId = ChannelId.make("channel-general");
      const sourceMessageId = MessageId.make("message-export");
      const readModel = yield* applyCommands([
        ...setup,
        {
          type: "channel.create",
          commandId: nextCommandId(),
          channelId,
          projectId,
          kind: "channel",
          name: "general",
          memberAgentIds: [backend],
          leadAgentId: reviewer,
          createdAt: now,
        },
      ]);
      const propose = (agentId: AgentId): OrchestrationCommand => ({
        type: "card.propose",
        commandId: nextCommandId(),
        cardId: CardId.make("card-limits-webhooks"),
        agentId,
        projectId,
        channelId,
        title: "Limit webhook calls",
        spec: "Webhooks need their own limit.",
        tags: [],
        lead: {
          sourceMessageId,
          reasoning: "The message asks for limits on webhooks, which the open card leaves out.",
          likelyDuplicateCardIds: [cardId],
        },
        createdAt: now,
      });

      const events = yield* decide(readModel, propose(reviewer));
      expect(events.map((event) => event.type)).toEqual([
        "card.created",
        "card.decision-recorded",
        "card.relation-added",
      ]);
      expect(events[0]).toMatchObject({
        payload: {
          status: "triage",
          sourceMessageId,
          proposalReasoning: expect.stringContaining("webhooks"),
          createdBy: { kind: "lead", id: reviewer },
        },
      });
      expect(events[1]).toMatchObject({
        payload: { author: { kind: "lead", id: reviewer }, text: expect.stringContaining("webhooks") },
      });
      expect(events[2]).toMatchObject({ payload: { kind: "duplicateOf", otherCardId: cardId } });

      const notLead = yield* Effect.flip(decide(readModel, propose(backend)));
      expect(notLead.message).toContain("doesn't lead this channel");
    }),
  );
});
