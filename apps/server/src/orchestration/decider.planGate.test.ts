import {
  type AgentId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
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
  decide,
  nextCommandId,
  now,
  onCard,
  recordSession,
  reviewer,
  setWorkspace,
} from "./decider.testkit.ts";

const editCard = (edit: {
  readonly title?: string;
  readonly spec?: string;
}): OrchestrationCommand => ({
  type: "card.update",
  commandId: nextCommandId(),
  cardId,
  ...edit,
});

const setup: ReadonlyArray<OrchestrationCommand> = [
  createProject(),
  createAgent(backend),
  createAgent(reviewer, { capabilities: ["read"] }),
  createCard(),
  onCard("card.approve"),
  assign(backend),
  setWorkspace(),
];

const specState = (readModel: OrchestrationReadModel) => cardIn(readModel)?.specState;

it.layer(NodeServices.layer)("decider plan gate", (it) => {
  it.effect("keeps writing shut until a human approves or skips the spec", () =>
    Effect.gen(function* () {
      const draft = yield* applyCommands(setup);
      const recorded = yield* Effect.flip(
        applyTo(draft, [recordSession("session-owner", backend)]),
      );
      expect(recorded.message).toContain("Approve or skip the card's spec");
      const started = yield* Effect.flip(
        applyTo(draft, [
          { type: "card.session.start", commandId: nextCommandId(), cardId, createdAt: now },
        ]),
      );
      expect(started.message).toContain("Approve or skip the card's spec");

      const skipped = yield* applyTo(draft, [
        onCard("card.spec.skip"),
        recordSession("session-owner", backend),
      ]);
      expect(specState(skipped)).toBe("skipped");
      expect(skipped.liveRuns).toHaveLength(1);
    }),
  );

  it.effect("records who skipped, and gives each spec decision its reverse", () =>
    Effect.gen(function* () {
      const draft = yield* applyCommands(setup);
      const skip = yield* decide(draft, onCard("card.spec.skip"));
      expect(skip).toEqual([
        expect.objectContaining({
          type: "card.spec-state-changed",
          payload: expect.objectContaining({
            cardId,
            from: "draft",
            to: "skipped",
            by: { kind: "human", id: "human" },
          }),
        }),
      ]);

      const skipped = yield* applyTo(draft, [onCard("card.spec.skip")]);
      const again = yield* Effect.flip(applyTo(skipped, [onCard("card.spec.approve")]));
      expect(again.message).toContain("already skipped");
      const reopened = yield* applyTo(skipped, [onCard("card.spec.reopen")]);
      expect(specState(reopened)).toBe("draft");
      const reopenDraft = yield* Effect.flip(applyTo(reopened, [onCard("card.spec.reopen")]));
      expect(reopenDraft.message).toContain("already a draft");
    }),
  );

  it.effect("returns an approved spec to draft when its text changes, not its title", () =>
    Effect.gen(function* () {
      const approved = yield* applyCommands([...setup, onCard("card.spec.approve")]);
      const retitled = yield* applyTo(approved, [editCard({ title: "Rate limits" })]);
      expect(specState(retitled)).toBe("approved");
      const unchanged = yield* applyTo(approved, [editCard({ spec: "" })]);
      expect(specState(unchanged)).toBe("approved");
      const edited = yield* applyTo(approved, [
        editCard({ spec: "Limit each key to 100 a minute." }),
      ]);
      expect(specState(edited)).toBe("draft");
    }),
  );

  it.effect("sends a draft spec to a read-only critic", () =>
    Effect.gen(function* () {
      const submit = (agentId?: AgentId): OrchestrationCommand => ({
        type: "card.spec.submit",
        commandId: nextCommandId(),
        cardId,
        ...(agentId === undefined ? {} : { agentId }),
      });
      const empty = yield* applyCommands(setup);
      const noSpec = yield* Effect.flip(decide(empty, submit()));
      expect(noSpec.message).toContain("Write a spec before submitting it");

      const written = yield* applyTo(empty, [
        editCard({ spec: "Limit each key to 100 a minute." }),
      ]);
      expect(yield* decide(written, submit())).toEqual([
        expect.objectContaining({
          type: "card.spec-submitted",
          payload: expect.objectContaining({ cardId, agentId: backend }),
        }),
      ]);
      expect(yield* decide(written, submit(reviewer))).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ agentId: reviewer }) }),
      ]);

      const approved = yield* applyTo(written, [onCard("card.spec.approve")]);
      const notDraft = yield* Effect.flip(decide(approved, submit()));
      expect(notDraft.message).toContain("Only a draft spec is reviewed");

      const writingCritic = yield* Effect.flip(
        applyTo(written, [recordSession("session-critic", reviewer, "critic", ["read", "write"])]),
      );
      expect(writingCritic.message).toContain("read-only");
      const critic = yield* applyTo(written, [
        recordSession("session-critic", reviewer, "critic", ["read"]),
      ]);
      expect(critic.liveRuns).toEqual([
        expect.objectContaining({ threadId: "session-critic", role: "critic" }),
      ]);
    }),
  );
});
