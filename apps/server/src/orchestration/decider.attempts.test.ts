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
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-attempts");
const parentId = CardId.make("card-limits");
const agents = ["agent-one", "agent-two", "agent-three"].map((id) => AgentId.make(id));
const attemptIds = ["attempt-one", "attempt-two", "attempt-three"].map((id) => CardId.make(id));

let commandCount = 0;
const nextCommandId = () => CommandId.make(`cmd-attempts-${(commandCount += 1)}`);

type CardOnlyCommand =
  | "card.approve"
  | "card.spec.skip"
  | "card.attempt.promote"
  | "card.work.start"
  | "card.review.request"
  | "card.merge.approve";
const onCard = (type: CardOnlyCommand, cardId: CardId) =>
  ({ type, commandId: nextCommandId(), cardId }) as OrchestrationCommand;

const setup = (options: { readonly skipSpec: boolean }): ReadonlyArray<OrchestrationCommand> => [
  {
    type: "project.create",
    commandId: nextCommandId(),
    projectId,
    title: "Attempts",
    workspaceRoot: "/tmp/attempts",
    createdAt: now,
  },
  ...agents.map(
    (agentId): OrchestrationCommand => ({
      type: "agent.create",
      commandId: nextCommandId(),
      agentId,
      projectId,
      name: agentId.replace("agent-", ""),
      roleTags: [],
      rolePrompt: "",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
      capabilities: ["read", "write"],
      createdAt: now,
    }),
  ),
  {
    type: "card.create",
    commandId: nextCommandId(),
    cardId: parentId,
    projectId,
    title: "Rate limiting",
    spec: "Limit each key.",
    tags: ["api"],
    createdAt: now,
  },
  onCard("card.approve", parentId),
  ...(options.skipSpec ? [onCard("card.spec.skip", parentId)] : []),
];

const startAttempts = (count: number): OrchestrationCommand => ({
  type: "card.attempts.start",
  commandId: nextCommandId(),
  cardId: parentId,
  attempts: attemptIds.slice(0, count).map((cardId, index) => ({ cardId, agentId: agents[index % agents.length]! })),
  createdAt: now,
});

const workspace = (cardId: CardId, index: number): OrchestrationCommand => ({
  type: "card.workspace.set",
  commandId: nextCommandId(),
  cardId,
  branch: `iskra/attempt-${index}`,
  worktreePath: `/tmp/worktrees/attempt-${index}`,
  portBase: 42000 + index * 10,
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

const cardIn = (readModel: OrchestrationReadModel, cardId: CardId) =>
  readModel.cards?.find((card) => card.id === cardId);

it.layer(NodeServices.layer)("decider attempts", (it) => {
  it.effect("starts two to four ready attempts on a ready card, each with its own agent", () =>
    Effect.gen(function* () {
      const started = yield* applyCommands([...setup({ skipSpec: true }), startAttempts(3)]);
      const attempts = attemptIds.map((cardId) => cardIn(started, cardId));
      expect(attempts.map((card) => [card?.status, card?.delegateAgentId, card?.parentCardId])).toEqual([
        ["ready", agents[0], parentId],
        ["ready", agents[1], parentId],
        ["ready", agents[2], parentId],
      ]);
      expect(new Set(attempts.map((card) => card?.attemptGroupId)).size).toBe(1);
      expect(attempts[0]).toMatchObject({ spec: "Limit each key.", specState: "skipped", tags: ["api"] });

      const again = yield* Effect.flip(applyTo(started, [startAttempts(2)]));
      expect(again.message).toContain("already has attempts running");
      const tooFew = yield* Effect.flip(applyCommands([...setup({ skipSpec: true }), startAttempts(1)]));
      expect(tooFew.message).toContain("Start between 2 and 4 attempts");
      const draft = yield* Effect.flip(applyCommands([...setup({ skipSpec: false }), startAttempts(2)]));
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
      const merge = yield* Effect.flip(applyTo(inReview, [onCard("card.merge.approve", attemptIds[0]!)]));
      expect(merge.message).toContain("An attempt lands only by being promoted");
    }),
  );

  it.effect("promotes one attempt into its card and drops the rest", () =>
    Effect.gen(function* () {
      const working = yield* applyCommands([
        ...setup({ skipSpec: true }),
        startAttempts(3),
        ...attemptIds.map((cardId, index) => workspace(cardId, index)),
      ]);
      const early = yield* Effect.flip(
        applyCommands([...setup({ skipSpec: true }), startAttempts(2), onCard("card.attempt.promote", attemptIds[0]!)]),
      );
      expect(early.message).toContain("no work to promote yet");

      const promoted = yield* applyTo(working, [onCard("card.attempt.promote", attemptIds[1]!)]);
      expect(cardIn(promoted, parentId)).toMatchObject({
        branch: "iskra/attempt-1",
        worktreePath: "/tmp/worktrees/attempt-1",
        portBase: 42010,
        delegateAgentId: agents[1],
      });
      expect(attemptIds.map((cardId) => cardIn(promoted, cardId)?.status)).toEqual([
        "abandoned",
        "abandoned",
        "abandoned",
      ]);
      // The promoted attempt hands its worktree over rather than having it torn down.
      expect(cardIn(promoted, attemptIds[1]!)?.worktreePath).toBeNull();
      expect(cardIn(promoted, attemptIds[0]!)?.worktreePath).toBe("/tmp/worktrees/attempt-0");

      const twice = yield* Effect.flip(applyTo(promoted, [onCard("card.attempt.promote", attemptIds[2]!)]));
      expect(twice.message).toContain("already promoted or dropped");
    }),
  );

  it.effect("stops an attempt's turns once its card's budget is spent", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("card-session-attempt");
      const running = yield* applyCommands([
        ...setup({ skipSpec: true }),
        startAttempts(2),
        workspace(attemptIds[0]!, 0),
        {
          type: "card.session.record",
          commandId: nextCommandId(),
          threadId,
          cardId: attemptIds[0]!,
          agentId: agents[0]!,
          role: "owner",
          capabilities: ["read", "write"],
          context: {
            agent: { id: agents[0]!, name: "one", rolePrompt: "" },
            role: "owner",
            card: { id: attemptIds[0]!, title: "Attempt", spec: "", branch: null, baseBranch: "main" },
            decisions: [],
            diff: "",
            diffTruncated: false,
            question: null,
          },
          rendered: { systemPrompt: "system", firstMessage: "brief" },
          startedAt: now,
        },
        {
          type: "thread.create",
          commandId: nextCommandId(),
          threadId,
          projectId,
          title: "Attempt",
          modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        {
          type: "card.spend.record",
          commandId: nextCommandId(),
          cardId: parentId,
          threadId,
          agentId: agents[0]!,
          turnId: TurnId.make("turn-1"),
          costUsd: 10,
          costSource: "providerReported",
          recordedAt: now,
        },
      ]);
      const refused = yield* Effect.flip(
        applyTo(running, [
          {
            type: "thread.turn.start",
            commandId: nextCommandId(),
            threadId,
            message: {
              messageId: MessageId.make("message-attempt"),
              role: "user",
              text: "Go on.",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: now,
          },
        ]),
      );
      expect(refused.message).toContain("raise the cap");
    }),
  );
});
