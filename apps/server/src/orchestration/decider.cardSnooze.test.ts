import {
  CardId,
  CommandId,
  MessageId,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const created = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-snooze");
const cardId = CardId.make("card-snooze");

let commandCount = 0;
const nextCommandId = () => CommandId.make(`cmd-snooze-${(commandCount += 1)}`);

const setup: ReadonlyArray<OrchestrationCommand> = [
  {
    type: "project.create",
    commandId: nextCommandId(),
    projectId,
    title: "Snooze",
    workspaceRoot: "/tmp/snooze",
    createdAt: created,
  },
  {
    type: "card.create",
    commandId: nextCommandId(),
    cardId,
    projectId,
    title: "Rate limiting",
    spec: "",
    tags: [],
    createdAt: created,
  },
];

const snooze = (snoozedUntil: string | null, createdAt = created): OrchestrationCommand => ({
  type: "card.snooze",
  commandId: nextCommandId(),
  cardId,
  snoozedUntil,
  createdAt,
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

const cardOf = (readModel: OrchestrationReadModel) => readModel.cards?.[0];

it.layer(NodeServices.layer)("decider card snooze", (it) => {
  it.effect("snoozes a card until a time or its next activity, and new activity passes the snooze", () =>
    Effect.gen(function* () {
      const fresh = yield* applyTo(createEmptyReadModel(created), setup);
      expect(cardOf(fresh)).toMatchObject({ snoozedAt: null, activityAt: created });

      const untilLater = yield* applyTo(fresh, [snooze("2100-01-01T00:00:00.000Z")]);
      expect(cardOf(untilLater)).toMatchObject({
        snoozedUntil: "2100-01-01T00:00:00.000Z",
        snoozedAt: created,
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
      const card = cardOf(active);
      expect(card?.activityAt).toBe("2026-01-02T00:00:00.000Z");
      expect(Date.parse(card?.activityAt ?? "") > Date.parse(card?.snoozedAt ?? "")).toBe(true);

      const untilActivity = yield* applyTo(fresh, [snooze(null)]);
      expect(cardOf(untilActivity)).toMatchObject({ snoozedUntil: null, snoozedAt: created });
    }),
  );

  it.effect("refuses a wake time in the past, and unsnoozes only a snoozed card", () =>
    Effect.gen(function* () {
      const fresh = yield* applyTo(createEmptyReadModel(created), setup);
      const past = yield* Effect.flip(applyTo(fresh, [snooze("2020-01-01T00:00:00.000Z")]));
      expect(past.message).toContain("Snooze until a time in the future.");

      const unsnooze: OrchestrationCommand = { type: "card.unsnooze", commandId: nextCommandId(), cardId };
      const notSnoozed = yield* Effect.flip(applyTo(fresh, [unsnooze]));
      expect(notSnoozed.message).toContain("The card is not snoozed.");

      const woken = yield* applyTo(fresh, [
        snooze(null),
        { type: "card.unsnooze", commandId: nextCommandId(), cardId },
      ]);
      expect(cardOf(woken)).toMatchObject({ snoozedUntil: null, snoozedAt: null });
    }),
  );
});
