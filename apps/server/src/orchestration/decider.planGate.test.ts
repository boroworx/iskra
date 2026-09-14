import {
  AgentId,
  CardId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type CardSessionRole,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type RunCapability,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-plan-gate");
const cardId = CardId.make("card-limits");
const backend = AgentId.make("agent-backend");
const reviewer = AgentId.make("agent-reviewer");

let commandCount = 0;
const nextCommandId = () => CommandId.make(`cmd-gate-${(commandCount += 1)}`);

const createAgent = (
  id: AgentId,
  capabilities: ReadonlyArray<RunCapability>,
): OrchestrationCommand => ({
  type: "agent.create",
  commandId: nextCommandId(),
  agentId: id,
  projectId,
  name: id.replace("agent-", ""),
  roleTags: [],
  rolePrompt: "",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
  capabilities,
  createdAt: now,
});

type SpecCommandType = "card.spec.approve" | "card.spec.skip" | "card.spec.reopen";
const onSpec = (type: SpecCommandType) =>
  ({ type, commandId: nextCommandId(), cardId }) as OrchestrationCommand;

const editCard = (edit: { readonly title?: string; readonly spec?: string }): OrchestrationCommand => ({
  type: "card.update",
  commandId: nextCommandId(),
  cardId,
  ...edit,
});

const record = (
  threadId: string,
  agentId: AgentId,
  role: CardSessionRole,
  capabilities: ReadonlyArray<RunCapability>,
): OrchestrationCommand => ({
  type: "card.session.record",
  commandId: nextCommandId(),
  threadId: ThreadId.make(threadId),
  cardId,
  agentId,
  role,
  capabilities,
  context: {
    agent: { id: agentId, name: "agent", rolePrompt: "" },
    role,
    card: { id: cardId, title: "Rate limiting", spec: "", branch: null, baseBranch: "main" },
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
    title: "Plan gate",
    workspaceRoot: "/tmp/plan-gate",
    createdAt: now,
  },
  createAgent(backend, ["read", "write"]),
  createAgent(reviewer, ["read"]),
  {
    type: "card.create",
    commandId: nextCommandId(),
    cardId,
    projectId,
    title: "Rate limiting",
    spec: "",
    tags: [],
    createdAt: now,
  },
  { type: "card.approve", commandId: nextCommandId(), cardId },
  { type: "card.assign", commandId: nextCommandId(), cardId, agentId: backend },
  {
    type: "card.workspace.set",
    commandId: nextCommandId(),
    cardId,
    branch: "iskra/rate-limiting-limits",
    worktreePath: "/tmp/worktrees/rate-limiting",
    portBase: 42000,
  },
];

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

const decide = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

const specState = (readModel: OrchestrationReadModel) => readModel.cards?.[0]?.specState;

it.layer(NodeServices.layer)("decider plan gate", (it) => {
  it.effect("keeps writing shut until a human approves or skips the spec", () =>
    Effect.gen(function* () {
      const draft = yield* applyCommands(setup);
      const recorded = yield* Effect.flip(
        applyTo(draft, [record("session-owner", backend, "owner", ["read", "write"])]),
      );
      expect(recorded.message).toContain("Approve or skip the card's spec");
      const started = yield* Effect.flip(
        applyTo(draft, [{ type: "card.session.start", commandId: nextCommandId(), cardId, createdAt: now }]),
      );
      expect(started.message).toContain("Approve or skip the card's spec");

      const approved = yield* applyTo(draft, [
        onSpec("card.spec.approve"),
        record("session-owner", backend, "owner", ["read", "write"]),
      ]);
      expect(approved.liveRuns).toHaveLength(1);
      const skipped = yield* applyTo(draft, [
        onSpec("card.spec.skip"),
        record("session-owner", backend, "owner", ["read", "write"]),
      ]);
      expect(specState(skipped)).toBe("skipped");
      expect(skipped.liveRuns).toHaveLength(1);
    }),
  );

  it.effect("records who skipped, and gives each spec decision its reverse", () =>
    Effect.gen(function* () {
      const draft = yield* applyCommands(setup);
      const skip = yield* decide(draft, onSpec("card.spec.skip"));
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

      const skipped = yield* applyTo(draft, [onSpec("card.spec.skip")]);
      const again = yield* Effect.flip(applyTo(skipped, [onSpec("card.spec.approve")]));
      expect(again.message).toContain("already skipped");
      const reopened = yield* applyTo(skipped, [onSpec("card.spec.reopen")]);
      expect(specState(reopened)).toBe("draft");
      const reopenDraft = yield* Effect.flip(applyTo(reopened, [onSpec("card.spec.reopen")]));
      expect(reopenDraft.message).toContain("already a draft");
    }),
  );

  it.effect("returns an approved spec to draft when its text changes, not its title", () =>
    Effect.gen(function* () {
      const approved = yield* applyCommands([...setup, onSpec("card.spec.approve")]);
      const retitled = yield* applyTo(approved, [editCard({ title: "Rate limits" })]);
      expect(specState(retitled)).toBe("approved");
      const unchanged = yield* applyTo(approved, [editCard({ spec: "" })]);
      expect(specState(unchanged)).toBe("approved");
      const edited = yield* applyTo(approved, [editCard({ spec: "Limit each key to 100 a minute." })]);
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

      const written = yield* applyTo(empty, [editCard({ spec: "Limit each key to 100 a minute." })]);
      expect(yield* decide(written, submit())).toEqual([
        expect.objectContaining({
          type: "card.spec-submitted",
          payload: expect.objectContaining({ cardId, agentId: backend }),
        }),
      ]);
      expect(yield* decide(written, submit(reviewer))).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ agentId: reviewer }) }),
      ]);

      const approved = yield* applyTo(written, [onSpec("card.spec.approve")]);
      const notDraft = yield* Effect.flip(decide(approved, submit()));
      expect(notDraft.message).toContain("Only a draft spec is reviewed");

      const writingCritic = yield* Effect.flip(
        applyTo(written, [record("session-critic", reviewer, "critic", ["read", "write"])]),
      );
      expect(writingCritic.message).toContain("read-only");
      const critic = yield* applyTo(written, [record("session-critic", reviewer, "critic", ["read"])]);
      expect(critic.liveRuns).toEqual([
        expect.objectContaining({ threadId: "session-critic", role: "critic" }),
      ]);
    }),
  );
});
