import {
  AgentId,
  CardId,
  ClientOrchestrationCommand,
  ProjectId,
  type OrchestrationCommand,
} from "@iskra/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { projectEvent } from "./projector.ts";
import {
  enterReview,
  applyCommands,
  assign,
  backend,
  cardIn,
  cardInReview,
  createAgent,
  createCard,
  createProject,
  guardProject,
  decide,
  nextCommandId,
  now,
  onCard,
  projectId,
} from "./decider.testkit.ts";

const otherProjectId = ProjectId.make("project-other");

const relate = (
  type: "card.relation.add" | "card.relation.remove",
  cardId: string,
  kind: "blocks" | "blockedBy" | "related" | "overlaps" | "duplicateOf",
  otherCardId: string,
) =>
  ({
    type,
    commandId: nextCommandId(),
    cardId: CardId.make(cardId),
    kind,
    otherCardId: CardId.make(otherCardId),
  }) as OrchestrationCommand;

const setup = [createProject(), guardProject(), createAgent(backend)];

it.layer(NodeServices.layer)("decider cards", (it) => {
  it.effect("creates every card as a triage proposal owned by the local human", () =>
    Effect.gen(function* () {
      const readModel = yield* applyCommands([...setup, createCard("rate-limiting")]);

      expect(cardIn(readModel, "rate-limiting")).toMatchObject({
        projectId,
        status: "triage",
        specState: "draft",
        ownerHumanId: "human",
        createdBy: { kind: "human", id: "human" },
        delegateAgentId: null,
        baseBranch: null,
        relations: [],
      });
    }),
  );

  it.effect("walks a card from approval to landed, reversing each human decision on the way", () =>
    Effect.gen(function* () {
      const readModel = yield* applyCommands([
        ...setup,
        createCard("card"),
        onCard("card.approve", "card"),
        onCard("card.unapprove", "card"),
        onCard("card.approve", "card"),
        assign(backend, "card"),
        onCard("card.work.start", "card"),
        ...enterReview("card"),
        onCard("card.merge.approve", "card"),
        onCard("card.merge.cancel", "card"),
        onCard("card.merge.approve", "card"),
        onCard("card.land", "card"),
      ]);

      expect(cardIn(readModel, "card")).toMatchObject({
        status: "landed",
        delegateAgentId: "agent-backend",
      });

      const reopened = yield* applyCommands([
        ...setup,
        createCard("dropped"),
        onCard("card.abandon", "dropped"),
        onCard("card.reopen", "dropped"),
      ]);
      expect(cardIn(reopened, "dropped")?.status).toBe("triage");
    }),
  );

  it.effect("rejects a move the status rules forbid, with the rule's reason", () =>
    Effect.gen(function* () {
      const early = yield* Effect.flip(
        applyCommands([...setup, createCard("card"), onCard("card.merge.approve", "card")]),
      );
      expect(early.message).toContain("Only a card in review can be approved to merge.");

      const unassigned = yield* Effect.flip(
        applyCommands([
          ...setup,
          createCard("card"),
          onCard("card.approve", "card"),
          onCard("card.work.start", "card"),
        ]),
      );
      expect(unassigned.message).toContain("Assign an agent before work starts.");
    }),
  );

  it.effect(
    "holds a merge while a sub-card is open, and allows it once the sub-card is abandoned",
    () =>
      Effect.gen(function* () {
        const withChild = [
          ...setup,
          ...cardInReview("parent"),
          createCard("child", { parentCardId: "parent" }),
        ];

        const held = yield* Effect.flip(
          applyCommands([...withChild, onCard("card.merge.approve", "parent")]),
        );
        expect(held.message).toContain("Land or abandon its sub-cards first.");

        const readModel = yield* applyCommands([
          ...withChild,
          onCard("card.abandon", "child"),
          onCard("card.merge.approve", "parent"),
        ]);
        expect(cardIn(readModel, "parent")?.status).toBe("landing");
      }),
  );

  it.effect("holds a merge while a blocker has not landed", () =>
    Effect.gen(function* () {
      const held = yield* Effect.flip(
        applyCommands([
          ...setup,
          createCard("blocker"),
          ...cardInReview("card"),
          relate("card.relation.add", "card", "blockedBy", "blocker"),
          onCard("card.merge.approve", "card"),
        ]),
      );
      expect(held.message).toContain("It is blocked by a card that has not landed.");
    }),
  );

  it.effect("assigns only an active agent of the card's project, and not before approval", () =>
    Effect.gen(function* () {
      const inTriage = yield* Effect.flip(
        applyCommands([...setup, createCard("card"), assign(backend, "card")]),
      );
      expect(inTriage.message).toContain("Approve the card before assigning an agent.");

      const elsewhere = AgentId.make("agent-elsewhere");
      const foreign = yield* Effect.flip(
        applyCommands([
          ...setup,
          createProject(otherProjectId),
          createAgent(elsewhere, { projectId: otherProjectId }),
          createCard("card"),
          onCard("card.approve", "card"),
          assign(elsewhere, "card"),
        ]),
      );
      expect(foreign.message).toContain("is not an active agent of this card's project");

      const unassigned = yield* applyCommands([
        ...setup,
        createCard("card"),
        onCard("card.approve", "card"),
        assign(backend, "card"),
        onCard("card.unassign", "card"),
      ]);
      expect(cardIn(unassigned, "card")?.delegateAgentId).toBeNull();
    }),
  );

  it.effect(
    "keeps relations symmetric, within one project, and leaves overlaps to the server",
    () =>
      Effect.gen(function* () {
        const cards = [...setup, createCard("api"), createCard("auth")];

        const related = yield* applyCommands([
          ...cards,
          relate("card.relation.add", "api", "blockedBy", "auth"),
        ]);
        expect(cardIn(related, "api")?.relations).toEqual([{ kind: "blockedBy", cardId: "auth" }]);
        expect(cardIn(related, "auth")?.relations).toEqual([{ kind: "blocks", cardId: "api" }]);

        const removed = yield* applyCommands([
          ...cards,
          relate("card.relation.add", "api", "blockedBy", "auth"),
          relate("card.relation.remove", "api", "blockedBy", "auth"),
        ]);
        expect(cardIn(removed, "api")?.relations).toEqual([]);
        expect(cardIn(removed, "auth")?.relations).toEqual([]);

        const overlaps = yield* Effect.flip(
          applyCommands([...cards, relate("card.relation.add", "api", "overlaps", "auth")]),
        );
        expect(overlaps.message).toContain("Overlaps are flagged by the server");

        const self = yield* Effect.flip(
          applyCommands([...cards, relate("card.relation.add", "api", "related", "api")]),
        );
        expect(self.message).toContain("A card cannot relate to itself.");

        const crossProject = yield* Effect.flip(
          applyCommands([
            ...cards,
            createProject(otherProjectId),
            createCard("elsewhere", { projectId: otherProjectId }),
            relate("card.relation.add", "api", "related", "elsewhere"),
          ]),
        );
        expect(crossProject.message).toContain("Related cards must be in the same project.");
      }),
  );

  it.effect("approves and starts a card in one step: approval, its draft spec, and its owner", () =>
    Effect.gen(function* () {
      const start = (id: string, delegateAgentId: AgentId = backend): OrchestrationCommand => ({
        type: "card.approve",
        commandId: nextCommandId(),
        cardId: CardId.make(id),
        delegateAgentId,
      });
      const proposed = [...setup, createCard("card", { spec: "Build it." })];
      const base = yield* applyCommands(proposed);

      expect((yield* decide(base, start("card"))).map((event) => event.type)).toEqual([
        "card.acceptance-set",
        "card.status-changed",
        "card.spec-state-changed",
        "card.delegate-changed",
      ]);
      expect(cardIn(yield* applyCommands([...proposed, start("card")]), "card")).toMatchObject({
        status: "ready",
        specState: "approved",
        delegateAgentId: backend,
      });

      // A card approved earlier without an owner starts the same way, keeping its approved spec.
      const approvedAlone = yield* applyCommands([
        ...setup,
        createCard("late"),
        onCard("card.approve", "late"),
        onCard("card.spec.approve", "late"),
      ]);
      expect((yield* decide(approvedAlone, start("late"))).map((event) => event.type)).toEqual([
        "card.delegate-changed",
      ]);

      // Nothing is half done: an owner that can't be assigned refuses the whole step.
      const outsider = yield* Effect.flip(
        decide(base, start("card", AgentId.make("agent-nobody"))),
      );
      expect(outsider.message).toContain("agent-nobody");
    }),
  );

  it.effect("records decisions as events without adding them to the read model", () =>
    Effect.gen(function* () {
      const readModel = yield* applyCommands([...setup, createCard("card")]);

      const [event] = yield* decide(readModel, {
        type: "card.decision.record",
        commandId: nextCommandId(),
        cardId: CardId.make("card"),
        decisionId: "decision-store",
        text: "Use Redis for the counters.",
        createdAt: now,
      });
      expect(event).toMatchObject({
        type: "card.activity-recorded",
        payload: {
          kind: "decision",
          author: { kind: "human", id: "human" },
          body: "Use Redis for the counters.",
        },
      });

      const projected = yield* projectEvent(readModel, {
        ...event!,
        sequence: readModel.snapshotSequence + 1,
      });
      expect(projected.cards).toEqual(readModel.cards);
    }),
  );

  it.effect("refuses edits once a card is finished", () =>
    Effect.gen(function* () {
      const edited = yield* Effect.flip(
        applyCommands([
          ...setup,
          createCard("card"),
          onCard("card.abandon", "card"),
          {
            type: "card.update",
            commandId: nextCommandId(),
            cardId: CardId.make("card"),
            title: "Too late",
          },
        ]),
      );
      expect(edited.message).toContain("cannot be edited");
    }),
  );

  it("does not accept server-only card commands from clients", () => {
    const decode = Schema.decodeUnknownExit(ClientOrchestrationCommand);
    for (const type of ["card.work.start", "card.review.enter", "card.land"]) {
      expect(Exit.isFailure(decode({ type, commandId: "cmd", cardId: "card" }))).toBe(true);
    }
    expect(
      Exit.isFailure(
        decode({
          type: "card.work.return",
          commandId: "cmd",
          cardId: "card",
          reason: "checks failed",
        }),
      ),
    ).toBe(true);
    expect(Exit.isSuccess(decode({ type: "card.approve", commandId: "cmd", cardId: "card" }))).toBe(
      true,
    );
  });
});
