import { AgentId, CardId, ChannelId, MessageId, type OrchestrationCommand } from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyCommands,
  assign,
  backend,
  cardId,
  cardIn,
  createAgent,
  createCard,
  createChannel,
  createProject,
  decide,
  nextCommandId,
  now,
  onCard,
  projectId,
  reviewer,
} from "./decider.testkit.ts";

const setup: ReadonlyArray<OrchestrationCommand> = [
  createProject(),
  createAgent(backend),
  createAgent(reviewer),
  createCard(),
  onCard("card.approve"),
  assign(backend),
];

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

      expect(cardIn(proposed, proposedId)).toMatchObject({
        status: "triage",
        specState: "draft",
        parentCardId: cardId,
        createdBy: { kind: "agent", id: backend },
        delegateAgentId: null,
      });
    }),
  );

  it.effect(
    "records a channel lead's proposal with its message, reasoning and likely duplicates",
    () =>
      Effect.gen(function* () {
        const channelId = ChannelId.make("channel-general");
        const sourceMessageId = MessageId.make("message-export");
        const readModel = yield* applyCommands([
          ...setup,
          createChannel(channelId, "channel", [backend], reviewer),
        ]);
        const propose = (agentId: AgentId, suggestedAgentName = "backend"): OrchestrationCommand => ({
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
            suggestedAgentName,
          },
          createdAt: now,
        });

        const events = yield* decide(readModel, propose(reviewer));
        expect(events.map((event) => event.type)).toEqual([
          "card.created",
          "card.activity-recorded",
          "card.relation-added",
        ]);
        expect(events[0]).toMatchObject({
          payload: {
            status: "triage",
            sourceMessageId,
            proposalReasoning: expect.stringContaining("webhooks"),
            suggestedAgentId: backend,
            createdBy: { kind: "lead", id: reviewer },
          },
        });
        expect(events[1]).toMatchObject({
          payload: {
            kind: "decision",
            author: { kind: "agent", id: reviewer },
            body: expect.stringContaining("webhooks"),
          },
        });
        expect(events[2]).toMatchObject({ payload: { kind: "duplicateOf", otherCardId: cardId } });

        const notLead = yield* Effect.flip(decide(readModel, propose(backend)));
        expect(notLead.message).toContain("doesn't lead this channel");

        // An unknown suggested owner is dropped; the proposal still goes through.
        const [unknown] = yield* decide(readModel, propose(reviewer, "ghost"));
        expect(unknown).toMatchObject({ payload: { suggestedAgentId: null } });
      }),
  );
});
