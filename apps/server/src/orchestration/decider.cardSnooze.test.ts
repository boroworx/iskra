import { MessageId, type OrchestrationCommand } from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyCommands,
  applyTo,
  cardId,
  cardIn,
  createCard,
  createProject,
  nextCommandId,
  now,
  onCard,
} from "./decider.testkit.ts";

const setup: ReadonlyArray<OrchestrationCommand> = [createProject(), createCard()];

const snooze = (snoozedUntil: string | null): OrchestrationCommand => ({
  type: "card.snooze",
  commandId: nextCommandId(),
  cardId,
  snoozedUntil,
  createdAt: now,
});

it.layer(NodeServices.layer)("decider card snooze", (it) => {
  it.effect(
    "snoozes a card until a time or its next activity, and new activity passes the snooze",
    () =>
      Effect.gen(function* () {
        const fresh = yield* applyCommands(setup);
        expect(cardIn(fresh)).toMatchObject({ snoozedAt: null, activityAt: now });

        const untilLater = yield* applyTo(fresh, [snooze("2100-01-01T00:00:00.000Z")]);
        expect(cardIn(untilLater)).toMatchObject({
          snoozedUntil: "2100-01-01T00:00:00.000Z",
          snoozedAt: now,
        });

        // A message on the card is activity after the snooze.
        const active = yield* applyTo(untilLater, [
          {
            type: "card.message.post",
            commandId: nextCommandId(),
            cardId,
            messageId: MessageId.make("message-later"),
            body: "Any update?",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ]);
        expect(cardIn(active)?.activityAt).toBe("2026-01-02T00:00:00.000Z");

        const untilActivity = yield* applyTo(fresh, [snooze(null)]);
        expect(cardIn(untilActivity)).toMatchObject({ snoozedUntil: null, snoozedAt: now });
      }),
  );

  it.effect("refuses a wake time in the past, and unsnoozes only a snoozed card", () =>
    Effect.gen(function* () {
      const fresh = yield* applyCommands(setup);
      const past = yield* Effect.flip(applyTo(fresh, [snooze("2020-01-01T00:00:00.000Z")]));
      expect(past.message).toContain("Snooze until a time in the future.");

      const notSnoozed = yield* Effect.flip(applyTo(fresh, [onCard("card.unsnooze")]));
      expect(notSnoozed.message).toContain("The card is not snoozed.");

      const woken = yield* applyTo(fresh, [snooze(null), onCard("card.unsnooze")]);
      expect(cardIn(woken)).toMatchObject({ snoozedUntil: null, snoozedAt: null });
    }),
  );
});
