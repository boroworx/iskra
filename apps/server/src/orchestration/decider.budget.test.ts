import {
  CardId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type UsageCostSource,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyCommands,
  applyTo,
  assign,
  backend,
  cardId,
  cardIn,
  createAgent,
  createCard,
  createProject,
  createThread,
  nextCommandId,
  now,
  onCard,
  recordSession,
  setWorkspace,
  startTurn,
} from "./decider.testkit.ts";

const ownerThreadId = "card-session-owner";

/** An approved card with a skipped spec, assigned to @backend in its own workspace. */
const readyCard = (id: CardId): ReadonlyArray<OrchestrationCommand> => [
  createCard(id),
  onCard("card.approve", id),
  onCard("card.spec.skip", id),
  assign(backend, id),
  setWorkspace(id),
];

const setup: ReadonlyArray<OrchestrationCommand> = [
  createProject(),
  createAgent(backend),
  ...readyCard(cardId),
  recordSession(ownerThreadId, backend),
  createThread(ownerThreadId),
];

const spend = (
  costUsd: number,
  costSource: UsageCostSource,
  id: CardId = cardId,
): OrchestrationCommand => {
  const commandId = nextCommandId();
  return {
    type: "card.spend.record",
    commandId,
    cardId: id,
    threadId: ThreadId.make(ownerThreadId),
    agentId: backend,
    turnId: TurnId.make(`turn-${commandId}`),
    costUsd,
    costSource,
    recordedAt: now,
  };
};

const setCap = (capUsd: number): OrchestrationCommand => ({
  type: "card.budget.set",
  commandId: nextCommandId(),
  cardId,
  capUsd,
});

it.layer(NodeServices.layer)("decider budgets", (it) => {
  it.effect("stops a card's turns at its cap and starts them again once a person raises it", () =>
    Effect.gen(function* () {
      const underCap = yield* applyCommands([...setup, spend(4, "providerReported")]);
      yield* applyTo(underCap, [startTurn(ownerThreadId)]);
      expect(cardIn(underCap)).toMatchObject({ spentUsd: 4, budgetCapUsd: 10 });

      const atCap = yield* applyTo(underCap, [spend(6, "modelPriced")]);
      const refused = yield* Effect.flip(applyTo(atCap, [startTurn(ownerThreadId)]));
      expect(refused.message).toContain("has spent $10.00 of its $10.00 budget");

      const raised = yield* applyTo(atCap, [setCap(20)]);
      yield* applyTo(raised, [startTurn(ownerThreadId)]);
      const notPositive = yield* Effect.flip(applyTo(atCap, [setCap(0)]));
      expect(notPositive.message).toContain("positive amount");
    }),
  );

  it.effect("holds an unpriced model until a person accepts running it uncapped, and back", () =>
    Effect.gen(function* () {
      const unpriced = yield* applyCommands([...setup, spend(0, "unpriced")]);
      expect(cardIn(unpriced)).toMatchObject({ spentUsd: 0, unpricedTurns: 1 });
      const held = yield* Effect.flip(applyTo(unpriced, [startTurn(ownerThreadId)]));
      expect(held.message).toContain("no known price");

      const accepted = yield* applyTo(unpriced, [onCard("card.unpriced.accept")]);
      yield* applyTo(accepted, [startTurn(ownerThreadId)]);
      const twice = yield* Effect.flip(applyTo(accepted, [onCard("card.unpriced.accept")]));
      expect(twice.message).toContain("already runs");

      const refusedAgain = yield* applyTo(accepted, [onCard("card.unpriced.refuse")]);
      const heldAgain = yield* Effect.flip(applyTo(refusedAgain, [startTurn(ownerThreadId)]));
      expect(heldAgain.message).toContain("no known price");
    }),
  );

  it.effect("starts no new session on a card past its budget", () =>
    Effect.gen(function* () {
      const other = CardId.make("card-other");
      const spent = yield* applyCommands([
        ...setup,
        ...readyCard(other),
        spend(10, "providerReported", other),
      ]);
      const refused = yield* Effect.flip(
        applyTo(spent, [
          recordSession("card-session-other", backend, "owner", ["read", "write"], other),
        ]),
      );
      expect(refused.message).toContain("raise the cap");
    }),
  );

  it.effect("counts each return to work", () =>
    Effect.gen(function* () {
      const returned = yield* applyCommands([
        ...setup,
        onCard("card.work.start"),
        onCard("card.review.request"),
        { type: "card.work.return", commandId: nextCommandId(), cardId, reason: "Checks failed." },
        onCard("card.review.request"),
        {
          type: "card.work.return",
          commandId: nextCommandId(),
          cardId,
          reason: "A review comment came in.",
        },
      ]);
      expect(cardIn(returned)?.reviewReturns).toBe(2);
    }),
  );
});
