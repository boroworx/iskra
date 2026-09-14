import {
  AgentId,
  CardId,
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
const projectId = ProjectId.make("project-review");
const backend = AgentId.make("agent-backend");

let commandCount = 0;
const nextCommandId = () => CommandId.make(`cmd-review-${(commandCount += 1)}`);

type CardOnlyCommandType = "card.approve" | "card.work.start" | "card.review.request";
const onCard = (type: CardOnlyCommandType, id: string) =>
  ({ type, commandId: nextCommandId(), cardId: CardId.make(id) }) as OrchestrationCommand;

const cardInReview = (id: string): ReadonlyArray<OrchestrationCommand> => [
  {
    type: "card.create",
    commandId: nextCommandId(),
    cardId: CardId.make(id),
    projectId,
    title: `Card ${id}`,
    spec: "",
    tags: [],
    createdAt: now,
  },
  onCard("card.approve", id),
  { type: "card.assign", commandId: nextCommandId(), cardId: CardId.make(id), agentId: backend },
  onCard("card.work.start", id),
  onCard("card.review.request", id),
];

const setup: ReadonlyArray<OrchestrationCommand> = [
  {
    type: "project.create",
    commandId: nextCommandId(),
    projectId,
    title: "Review",
    workspaceRoot: "/tmp/review",
    createdAt: now,
  },
  {
    type: "agent.create",
    commandId: nextCommandId(),
    agentId: backend,
    projectId,
    name: "backend",
    roleTags: [],
    rolePrompt: "",
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
    capabilities: ["read", "write"],
    createdAt: now,
  },
];

const checks = (id: string, state: "running" | "passed" | "failed"): OrchestrationCommand => ({
  type: "card.checks.record",
  commandId: nextCommandId(),
  cardId: CardId.make(id),
  state,
  summary: state === "failed" ? "test: 1 failing" : "",
  updatedAt: now,
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

const cardIn = (readModel: OrchestrationReadModel, id: string) =>
  readModel.cards?.find((card) => card.id === id);

it.layer(NodeServices.layer)("decider review", (it) => {
  it.effect("counts failed check runs in a row, keeping the count while a run is in progress", () =>
    Effect.gen(function* () {
      const failedTwice = yield* applyCommands([
        ...setup,
        ...cardInReview("card"),
        checks("card", "running"),
        checks("card", "failed"),
        checks("card", "running"),
        checks("card", "failed"),
      ]);
      expect(cardIn(failedTwice, "card")?.checks).toMatchObject({
        state: "failed",
        failedRuns: 2,
        summary: "test: 1 failing",
      });

      const running = yield* applyTo(failedTwice, [checks("card", "running")]);
      expect(cardIn(running, "card")?.checks).toMatchObject({ state: "running", failedRuns: 2 });
      const passed = yield* applyTo(running, [checks("card", "passed")]);
      expect(cardIn(passed, "card")?.checks).toMatchObject({ state: "passed", failedRuns: 0 });
    }),
  );

  it.effect("sends a review comment to the agent and a card in review back to work", () =>
    Effect.gen(function* () {
      const inReview = yield* applyCommands([...setup, ...cardInReview("card")]);
      const comment = (body: string): OrchestrationCommand => ({
        type: "card.review.comment",
        commandId: nextCommandId(),
        cardId: CardId.make("card"),
        messageId: MessageId.make(`comment-${body.length}`),
        body,
        createdAt: now,
      });

      const decided = yield* decideOrchestrationCommand({
        command: comment("Handle a missing key."),
        readModel: inReview,
      });
      expect((Array.isArray(decided) ? decided : [decided]).map((event) => event.type)).toEqual([
        "card.message-posted",
        "card.status-changed",
      ]);
      const returned = yield* applyTo(inReview, [comment("Handle a missing key.")]);
      expect(cardIn(returned, "card")?.status).toBe("inProgress");

      // In progress already, a comment just waits for the agent's next turn.
      const again = yield* decideOrchestrationCommand({
        command: comment("And log it."),
        readModel: returned,
      });
      expect((Array.isArray(again) ? again : [again]).map((event) => event.type)).toEqual([
        "card.message-posted",
      ]);
    }),
  );

  it.effect("flags overlapping cards both ways, once, and only on the server", () =>
    Effect.gen(function* () {
      const twoCards = yield* applyCommands([...setup, ...cardInReview("landed"), ...cardInReview("other")]);
      const flag: OrchestrationCommand = {
        type: "card.overlap.flag",
        commandId: nextCommandId(),
        cardId: CardId.make("other"),
        otherCardId: CardId.make("landed"),
      };
      const flagged = yield* applyTo(twoCards, [flag]);
      expect(cardIn(flagged, "other")?.relations).toEqual([
        { kind: "overlaps", cardId: "landed" },
      ]);
      expect(cardIn(flagged, "landed")?.relations).toEqual([{ kind: "overlaps", cardId: "other" }]);

      const twice = yield* Effect.flip(applyTo(flagged, [{ ...flag, commandId: nextCommandId() }]));
      expect(twice.message).toContain("already flagged");
      const byClient = yield* Effect.flip(
        applyTo(twoCards, [
          {
            type: "card.relation.add",
            commandId: nextCommandId(),
            cardId: CardId.make("other"),
            kind: "overlaps",
            otherCardId: CardId.make("landed"),
          },
        ]),
      );
      expect(byClient.message).toContain("flagged by the server");
    }),
  );
});
