import {
  AgentId,
  CardId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type UsageCostSource,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-budget");
const backend = AgentId.make("agent-backend");
const cardId = CardId.make("card-limits");
const ownerThreadId = ThreadId.make("card-session-owner");
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-4-5",
};

let commandCount = 0;
const nextCommandId = () => CommandId.make(`cmd-budget-${(commandCount += 1)}`);

const onCard = (
  type: "card.approve" | "card.spec.skip" | "card.unpriced.accept" | "card.unpriced.refuse" | "card.work.start" | "card.review.request",
  id: CardId = cardId,
) => ({ type, commandId: nextCommandId(), cardId: id }) as OrchestrationCommand;

const createCard = (id: CardId): ReadonlyArray<OrchestrationCommand> => [
  {
    type: "card.create",
    commandId: nextCommandId(),
    cardId: id,
    projectId,
    title: `Card ${id}`,
    spec: "",
    tags: [],
    createdAt: now,
  },
  onCard("card.approve", id),
  onCard("card.spec.skip", id),
  { type: "card.assign", commandId: nextCommandId(), cardId: id, agentId: backend },
  {
    type: "card.workspace.set",
    commandId: nextCommandId(),
    cardId: id,
    branch: `iskra/${id}`,
    worktreePath: `/tmp/worktrees/${id}`,
    portBase: 42000,
  },
];

const recordSession = (threadId: ThreadId, id: CardId): OrchestrationCommand => ({
  type: "card.session.record",
  commandId: nextCommandId(),
  threadId,
  cardId: id,
  agentId: backend,
  role: "owner",
  capabilities: ["read", "write"],
  context: {
    agent: { id: backend, name: "backend", rolePrompt: "" },
    role: "owner",
    card: { id, title: "Rate limiting", spec: "", branch: null, baseBranch: "main" },
    decisions: [],
    diff: "",
    diffTruncated: false,
    question: null,
  },
  rendered: { systemPrompt: "system", firstMessage: "brief" },
  startedAt: now,
});

const setup: ReadonlyArray<OrchestrationCommand> = [
  {
    type: "project.create",
    commandId: nextCommandId(),
    projectId,
    title: "Budget",
    workspaceRoot: "/tmp/budget",
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
    modelSelection,
    capabilities: ["read", "write"],
    createdAt: now,
  },
  ...createCard(cardId),
  recordSession(ownerThreadId, cardId),
  {
    type: "thread.create",
    commandId: nextCommandId(),
    threadId: ownerThreadId,
    projectId,
    title: "@backend on Rate limiting",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
  },
];

const spend = (costUsd: number, costSource: UsageCostSource, id: CardId = cardId): OrchestrationCommand => ({
  type: "card.spend.record",
  commandId: nextCommandId(),
  cardId: id,
  threadId: ownerThreadId,
  agentId: backend,
  turnId: TurnId.make(`turn-${commandCount}`),
  costUsd,
  costSource,
  recordedAt: now,
});

const turnStart = (): OrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: nextCommandId(),
  threadId: ownerThreadId,
  message: {
    messageId: MessageId.make(`message-${commandCount}`),
    role: "user",
    text: "Keep going.",
    attachments: [],
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: now,
});

const setCap = (capUsd: number): OrchestrationCommand => ({
  type: "card.budget.set",
  commandId: nextCommandId(),
  cardId,
  capUsd,
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

const cardIn = (readModel: OrchestrationReadModel, id: CardId = cardId) =>
  readModel.cards?.find((card) => card.id === id);

it.layer(NodeServices.layer)("decider budgets", (it) => {
  it.effect("stops a card's turns at its cap and starts them again once a person raises it", () =>
    Effect.gen(function* () {
      const underCap = yield* applyCommands([...setup, spend(4, "providerReported")]);
      yield* applyTo(underCap, [turnStart()]);
      expect(cardIn(underCap)).toMatchObject({ spentUsd: 4, budgetCapUsd: 10 });

      const atCap = yield* applyTo(underCap, [spend(6, "modelPriced")]);
      const refused = yield* Effect.flip(applyTo(atCap, [turnStart()]));
      expect(refused.message).toContain("has spent $10.00 of its $10.00 budget");

      const raised = yield* applyTo(atCap, [setCap(20)]);
      yield* applyTo(raised, [turnStart()]);
      const notPositive = yield* Effect.flip(applyTo(atCap, [setCap(0)]));
      expect(notPositive.message).toContain("positive amount");
    }),
  );

  it.effect("holds an unpriced model until a person accepts running it uncapped, and back", () =>
    Effect.gen(function* () {
      const unpriced = yield* applyCommands([...setup, spend(0, "unpriced")]);
      expect(cardIn(unpriced)).toMatchObject({ spentUsd: 0, unpricedTurns: 1 });
      const held = yield* Effect.flip(applyTo(unpriced, [turnStart()]));
      expect(held.message).toContain("no known price");

      const accepted = yield* applyTo(unpriced, [onCard("card.unpriced.accept")]);
      yield* applyTo(accepted, [turnStart()]);
      const twice = yield* Effect.flip(applyTo(accepted, [onCard("card.unpriced.accept")]));
      expect(twice.message).toContain("already runs");

      const refusedAgain = yield* applyTo(accepted, [onCard("card.unpriced.refuse")]);
      const heldAgain = yield* Effect.flip(applyTo(refusedAgain, [turnStart()]));
      expect(heldAgain.message).toContain("no known price");
    }),
  );

  it.effect("starts no new session on a card past its budget", () =>
    Effect.gen(function* () {
      const other = CardId.make("card-other");
      const spent = yield* applyCommands([...setup, ...createCard(other), spend(10, "providerReported", other)]);
      const refused = yield* Effect.flip(
        applyTo(spent, [recordSession(ThreadId.make("card-session-other"), other)]),
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
        { type: "card.work.return", commandId: nextCommandId(), cardId, reason: "A review comment came in." },
      ]);
      expect(cardIn(returned)?.reviewReturns).toBe(2);
    }),
  );
});
