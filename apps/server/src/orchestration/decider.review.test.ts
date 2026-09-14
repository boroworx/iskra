import { CardId, MessageId, type OrchestrationCommand } from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyCommands,
  applyTo,
  backend,
  cardIn,
  cardInReview,
  createAgent,
  createProject,
  guardProject,
  decide,
  nextCommandId,
  now,
} from "./decider.testkit.ts";

const setup: ReadonlyArray<OrchestrationCommand> = [
  createProject(),
  guardProject(),
  createAgent(backend),
];

const checks = (id: string, state: "running" | "passed" | "failed"): OrchestrationCommand => ({
  type: "card.checks.record",
  commandId: nextCommandId(),
  cardId: CardId.make(id),
  state,
  summary: state === "failed" ? "test: 1 failing" : "",
  updatedAt: now,
});

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

      const decided = yield* decide(inReview, comment("Handle a missing key."));
      expect(decided.map((event) => event.type)).toEqual([
        "card.activity-recorded",
        "card.status-changed",
      ]);
      const returned = yield* applyTo(inReview, [comment("Handle a missing key.")]);
      expect(cardIn(returned, "card")?.status).toBe("inProgress");

      // In progress already, a comment just waits for the agent's next turn.
      const again = yield* decide(returned, comment("And log it."));
      expect(again.map((event) => event.type)).toEqual(["card.activity-recorded"]);
    }),
  );

  it.effect("flags overlapping cards both ways, once, and only on the server", () =>
    Effect.gen(function* () {
      const twoCards = yield* applyCommands([
        ...setup,
        ...cardInReview("landed"),
        ...cardInReview("other"),
      ]);
      const flag: OrchestrationCommand = {
        type: "card.overlap.flag",
        commandId: nextCommandId(),
        cardId: CardId.make("other"),
        otherCardId: CardId.make("landed"),
      };
      const flagged = yield* applyTo(twoCards, [flag]);
      expect(cardIn(flagged, "other")?.relations).toEqual([{ kind: "overlaps", cardId: "landed" }]);
      expect(cardIn(flagged, "landed")?.relations).toEqual([{ kind: "overlaps", cardId: "other" }]);

      const twice = yield* Effect.flip(applyTo(flagged, [{ ...flag, commandId: nextCommandId() }]));
      expect(twice.message).toContain("already flagged");
    }),
  );
});
