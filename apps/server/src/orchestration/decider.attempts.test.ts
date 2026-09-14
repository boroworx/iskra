import { AgentId, CardId, ThreadId, TurnId, type OrchestrationCommand } from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyCommands,
  applyTo,
  cardId,
  cardIn,
  createAgent,
  createCard,
  createProject,
  guardProject,
  createThread,
  nextCommandId,
  now,
  onCard,
  recordSession,
  startTurn,
} from "./decider.testkit.ts";

const agents = ["agent-one", "agent-two", "agent-three"].map((id) => AgentId.make(id));
const attemptIds = ["attempt-one", "attempt-two", "attempt-three"].map((id) => CardId.make(id));

const setup = (options: { readonly skipSpec: boolean }): ReadonlyArray<OrchestrationCommand> => [
  createProject(),
  guardProject(),
  ...agents.map((agentId) => createAgent(agentId)),
  createCard(cardId, { spec: "Limit each key.", tags: ["api"] }),
  onCard("card.approve"),
  ...(options.skipSpec ? [onCard("card.spec.skip")] : []),
];

const startAttempts = (count: number): OrchestrationCommand => ({
  type: "card.attempts.start",
  commandId: nextCommandId(),
  cardId,
  attempts: attemptIds
    .slice(0, count)
    .map((id, index) => ({ cardId: id, agentId: agents[index % agents.length]! })),
  createdAt: now,
});

const workspace = (id: CardId, index: number): OrchestrationCommand => ({
  type: "card.workspace.set",
  commandId: nextCommandId(),
  cardId: id,
  branch: `iskra/attempt-${index}`,
  worktreePath: `/tmp/worktrees/attempt-${index}`,
  portBase: 42000 + index * 10,
});

it.layer(NodeServices.layer)("decider attempts", (it) => {
  it.effect("starts two to four ready attempts on a ready card, each with its own agent", () =>
    Effect.gen(function* () {
      const started = yield* applyCommands([...setup({ skipSpec: true }), startAttempts(3)]);
      const attempts = attemptIds.map((id) => cardIn(started, id));
      expect(
        attempts.map((card) => [card?.status, card?.delegateAgentId, card?.parentCardId]),
      ).toEqual([
        ["ready", agents[0], cardId],
        ["ready", agents[1], cardId],
        ["ready", agents[2], cardId],
      ]);
      expect(new Set(attempts.map((card) => card?.attemptGroupId)).size).toBe(1);
      expect(attempts[0]).toMatchObject({
        spec: "Limit each key.",
        specState: "skipped",
        tags: ["api"],
      });

      const again = yield* Effect.flip(applyTo(started, [startAttempts(2)]));
      expect(again.message).toContain("already has attempts running");
      const tooFew = yield* Effect.flip(
        applyCommands([...setup({ skipSpec: true }), startAttempts(1)]),
      );
      expect(tooFew.message).toContain("Start between 2 and 4 attempts");
      const draft = yield* Effect.flip(
        applyCommands([...setup({ skipSpec: false }), startAttempts(2)]),
      );
      expect(draft.message).toContain("Approve or skip the card's spec");
    }),
  );

  it.effect("never lands an attempt on its own", () =>
    Effect.gen(function* () {
      const inReview = yield* applyCommands([
        ...setup({ skipSpec: true }),
        startAttempts(2),
        onCard("card.work.start", attemptIds[0]!),
        onCard("card.review.request", attemptIds[0]!),
      ]);
      const merge = yield* Effect.flip(
        applyTo(inReview, [onCard("card.merge.approve", attemptIds[0]!)]),
      );
      expect(merge.message).toContain("An attempt lands only by being promoted");
    }),
  );

  it.effect("promotes one attempt into its card and drops the rest", () =>
    Effect.gen(function* () {
      const working = yield* applyCommands([
        ...setup({ skipSpec: true }),
        startAttempts(3),
        ...attemptIds.map((id, index) => workspace(id, index)),
      ]);
      const early = yield* Effect.flip(
        applyCommands([
          ...setup({ skipSpec: true }),
          startAttempts(2),
          onCard("card.attempt.promote", attemptIds[0]!),
        ]),
      );
      expect(early.message).toContain("no work to promote yet");

      const promoted = yield* applyTo(working, [onCard("card.attempt.promote", attemptIds[1]!)]);
      expect(cardIn(promoted)).toMatchObject({
        branch: "iskra/attempt-1",
        worktreePath: "/tmp/worktrees/attempt-1",
        portBase: 42010,
        delegateAgentId: agents[1],
      });
      expect(attemptIds.map((id) => cardIn(promoted, id)?.status)).toEqual([
        "abandoned",
        "abandoned",
        "abandoned",
      ]);
      // The promoted attempt hands its worktree over rather than having it torn down.
      expect(cardIn(promoted, attemptIds[1]!)?.worktreePath).toBeNull();
      expect(cardIn(promoted, attemptIds[0]!)?.worktreePath).toBe("/tmp/worktrees/attempt-0");

      const twice = yield* Effect.flip(
        applyTo(promoted, [onCard("card.attempt.promote", attemptIds[2]!)]),
      );
      expect(twice.message).toContain("already promoted or dropped");
    }),
  );

  it.effect("stops an attempt's turns once its card's budget is spent", () =>
    Effect.gen(function* () {
      const threadId = "card-session-attempt";
      const running = yield* applyCommands([
        ...setup({ skipSpec: true }),
        startAttempts(2),
        workspace(attemptIds[0]!, 0),
        recordSession(threadId, agents[0]!, "owner", ["read", "write"], attemptIds[0]!),
        createThread(threadId),
        {
          type: "card.spend.record",
          commandId: nextCommandId(),
          cardId,
          threadId: ThreadId.make(threadId),
          agentId: agents[0]!,
          turnId: TurnId.make("turn-1"),
          costUsd: 10,
          costSource: "providerReported",
          recordedAt: now,
        },
      ]);
      const refused = yield* Effect.flip(applyTo(running, [startTurn(threadId)]));
      expect(refused.message).toContain("raise the cap");
    }),
  );
});
