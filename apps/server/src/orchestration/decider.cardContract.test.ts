import {
  CardId,
  ChannelId,
  DEFAULT_AGENT_BLUEPRINT,
  ProviderInstanceId,
  type AgentId,
  ClientOrchestrationCommand,
  DEFAULT_PROJECT_ORCHESTRATION,
  MessageId,
  ThreadId,
  type CardEvidenceItem,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ProjectOrchestration,
} from "@iskra/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  ALREADY_ANSWERED_REASON,
  ANSWER_OPTION_REASON,
  AUTO_MERGE_OFF_REASON,
  NO_VERIFIER_RUNNING_REASON,
  OPEN_ASSIST_RUNS_REASON,
  RESTART_SERVICES_REASON,
  OVERRIDE_REASON_REQUIRED,
  OVERRIDE_STATE_REASON,
  VERDICT_INCOMPLETE_REASON,
  VERDICT_STALE_REASON,
  VERIFIER_NOT_PASSED_REASON,
  VERIFIER_RUNNING_REASON,
  VERIFY_LATEST_COMMIT_REASON,
  NO_CHECKS_REASON,
  NO_ATTENTION_REASON,
  NO_CRITERIA_REASON,
  NO_OPEN_QUESTION_REASON,
  NOT_DISMISSABLE_REASON,
  NOT_FORWARDABLE_REASON,
  PULL_REQUEST_REOPENED_CODE,
  NO_OPEN_REF_REPORT_REASON,
  NOT_REF_REPORT_REASON,
  OPEN_CHECKPOINT_REASON,
  PAUSED_REASON,
  PLAN_CHILD_LANDING_REASON,
  PREMISE_REASON,
  REVIEW_EVIDENCE_REASON,
  SIDE_EFFECT_GUARD_REASON,
  SYSTEM_REF_REPORT_REASON,
  UNACKNOWLEDGED_FLAGS_REASON,
  WORK_CRITERIA_REASON,
} from "./cardRules.ts";
import { projectEvent } from "./projector.ts";
import {
  applyCommands,
  applyTo,
  assign,
  backend,
  cardId,
  cardIn,
  createAgent,
  createCard,
  createChannel,
  createProject,
  decide,
  enterReview as reviewWithEvidence,
  frontend,
  nextCommandId,
  now,
  onCard,
  projectId,
  recordSession,
  reviewer,
  setWorkspace,
} from "./decider.testkit.ts";

const isClientCommand = Schema.is(ClientOrchestrationCommand);

const criteria = [{ id: "c1", text: "Bursts over 100 get a 429.", verification: "automated" }] as const;
const guardAcknowledged = { sideEffectGuard: { acknowledgedAt: now, killSwitchEnv: null } };

const setPolicy = (patch: Partial<ProjectOrchestration> = {}): OrchestrationCommand => ({
  type: "project.orchestration.set",
  commandId: nextCommandId(),
  projectId,
  orchestration: { ...DEFAULT_PROJECT_ORCHESTRATION, ...guardAcknowledged, ...patch },
});

const approveAndStart = (
  id: string = cardId,
  withCriteria?: ReadonlyArray<(typeof criteria)[number]>,
): OrchestrationCommand => ({
  type: "card.approve",
  commandId: nextCommandId(),
  cardId: CardId.make(id),
  delegateAgentId: backend,
  ...(withCriteria === undefined ? {} : { criteria: withCriteria }),
});

const check = (name: string, exitCode: number): CardEvidenceItem => ({
  itemId: name,
  kind: "check",
  source: "local",
  name,
  criterionId: null,
  exitCode,
  timedOut: false,
  durationMs: 10,
  logTail: "",
  artifactPath: null,
  unavailable: null,
});

const recordEvidence = (
  headSha: string,
  items: ReadonlyArray<CardEvidenceItem>,
  options: { readonly id?: string; readonly hardFlag?: boolean } = {},
): OrchestrationCommand => ({
  type: "card.evidence.record",
  commandId: nextCommandId(),
  cardId: CardId.make(options.id ?? cardId),
  evidenceId: `evidence-${nextCommandId()}`,
  headSha,
  purpose: "review",
  items,
  flags:
    options.hardFlag === true
      ? [{ kind: "deletedTest", path: "limits.test.ts", detail: "Deleted.", hard: true }]
      : [],
  risks: null,
  recordedAt: now,
});

const enterReview = (headSha: string, id: string = cardId): OrchestrationCommand => ({
  type: "card.review.enter",
  commandId: nextCommandId(),
  cardId: CardId.make(id),
  headSha,
});

const returnToWork = (round: "ci" | "review"): OrchestrationCommand => ({
  type: "card.work.return",
  commandId: nextCommandId(),
  cardId,
  reason: "CI failed.",
  round,
});

const refusal = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.flip(decide(readModel, command)).pipe(
    Effect.map((error) => ("detail" in error ? error.detail : String(error))),
  );

const setup = [createProject(), setPolicy(), createAgent(backend), createAgent(frontend)];

/** An activity for no one with a reason code, as the reactors record what waits on a person. */
const raise = (
  activityId: string,
  code: string,
  body = "Waits on you.",
  kind: "error" | "message" | "elicitation" = "error",
): OrchestrationCommand => ({
  type: "card.activity.record",
  commandId: nextCommandId(),
  activityId,
  cardId,
  kind,
  author:
    code === "untrustedComment"
      ? { kind: "github", id: "stranger", trusted: false }
      : { kind: "system", id: "system" },
  body,
  runThreadId: null,
  deliverTo: null,
  elicitation: null,
  answers: null,
  status: null,
  evidenceId: null,
  reason: { code, text: code },
  createdAt: now,
});

const onAttention = (
  type: "card.comment.forward" | "card.attention.dismiss",
  activityId: string,
): OrchestrationCommand => ({ type, commandId: nextCommandId(), cardId, activityId });

/** A card proposed with no acceptance criteria written yet. */
const bareCard = (id: string = cardId): OrchestrationCommand => {
  const { criteria: _none, ...card } = createCard(id) as Extract<
    OrchestrationCommand,
    { type: "card.create" }
  >;
  return card;
};

/** A card with confirmed criteria, its agent assigned and its work started. */
const cardInProgress = (id: string = cardId): ReadonlyArray<OrchestrationCommand> => [
  createCard(id),
  approveAndStart(id, criteria),
  onCard("card.work.start", id),
];

it.layer(NodeServices.layer)("decider card contract", (it) => {
  it.effect("Approve & start needs acceptance criteria and confirms the ones it is given", () =>
    Effect.gen(function* () {
      const triage = yield* applyCommands([...setup, bareCard()]);
      expect(yield* refusal(triage, approveAndStart())).toBe(NO_CRITERIA_REASON);
      expect(yield* refusal(triage, approveAndStart(cardId, [...criteria, ...criteria]))).toBe(
        "Each acceptance criterion needs its own id.",
      );

      const started = yield* applyTo(triage, [approveAndStart(cardId, criteria)]);
      expect(cardIn(started)).toMatchObject({
        status: "ready",
        delegateAgentId: backend,
        specState: "approved",
        acceptance: { criteria, state: "confirmed" },
      });
    }),
  );

  it.effect("work starts only once a person confirmed the card's criteria", () =>
    Effect.gen(function* () {
      // A plain approval of a card with no criteria leaves them to write.
      const ready = yield* applyCommands([
        ...setup,
        bareCard(),
        onCard("card.approve"),
        assign(backend),
      ]);
      expect(cardIn(ready)?.acceptance).toEqual({ criteria: [], state: "draft" });
      expect(yield* refusal(ready, onCard("card.work.start"))).toBe(WORK_CRITERIA_REASON);
      expect(yield* refusal(ready, onCard("card.criteria.confirm"))).toBe(NO_CRITERIA_REASON);

      // A person's edit on an approved card is its confirmation.
      const confirmed = yield* applyTo(ready, [
        { type: "card.criteria.set", commandId: nextCommandId(), cardId, criteria },
        onCard("card.work.start"),
      ]);
      expect(cardIn(confirmed)).toMatchObject({
        status: "inProgress",
        acceptance: { state: "confirmed" },
      });
      expect(yield* refusal(confirmed, onCard("card.criteria.confirm"))).toBe(
        "The acceptance criteria are already confirmed.",
      );
    }),
  );

  it.effect("criteria written in triage stay a draft until the card is approved", () =>
    Effect.gen(function* () {
      const drafted = yield* applyCommands([
        ...setup,
        createCard(),
        { type: "card.criteria.set", commandId: nextCommandId(), cardId, criteria },
      ]);
      expect(cardIn(drafted)?.acceptance).toEqual({ criteria, state: "draft" });
      const approved = yield* applyTo(drafted, [onCard("card.approve")]);
      expect(cardIn(approved)?.acceptance).toEqual({ criteria, state: "confirmed" });
    }),
  );

  it.effect("a card enters review only with passing evidence for its latest commit", () =>
    Effect.gen(function* () {
      const working = yield* applyCommands([...setup, ...cardInProgress()]);
      expect(yield* refusal(working, enterReview("abc123"))).toBe(REVIEW_EVIDENCE_REASON);

      const failing = yield* applyTo(working, [
        recordEvidence("abc123", [check("typecheck", 0), check("test", 1)]),
      ]);
      expect(cardIn(failing)?.evidence).toMatchObject({ passed: false, failedChecks: ["test"] });
      // Failing evidence sends the owner a fix while the card stays in progress: a CI round.
      expect(cardIn(failing)?.fixRounds).toEqual({ ci: 1, review: 0 });
      expect(yield* refusal(failing, enterReview("abc123"))).toBe(REVIEW_EVIDENCE_REASON);

      const passing = yield* applyTo(failing, [recordEvidence("def456", [check("test", 0)])]);
      expect(yield* refusal(passing, enterReview("abc123"))).toBe(REVIEW_EVIDENCE_REASON);
      const inReview = yield* applyTo(passing, [enterReview("def456")]);
      expect(cardIn(inReview)?.status).toBe("inReview");
    }),
  );

  it.effect("a project without checks can't send cards to review until a person waives them", () =>
    Effect.gen(function* () {
      const unchecked = yield* applyCommands([
        ...setup,
        ...cardInProgress(),
        recordEvidence("abc123", []),
      ]);
      expect(cardIn(unchecked)?.evidence?.passed).toBe(true);
      expect(yield* refusal(unchecked, enterReview("abc123"))).toBe(NO_CHECKS_REASON);

      const waived = yield* applyTo(unchecked, [setPolicy({ checksWaived: true })]);
      const inReview = yield* applyTo(waived, [enterReview("abc123")]);
      expect(cardIn(inReview)?.status).toBe("inReview");
    }),
  );

  it.effect("automatic returns to work stop at the project's fix rounds until a person resets them", () =>
    Effect.gen(function* () {
      const reviewAgain = (headSha: string) => [
        recordEvidence(headSha, [check("test", 0)]),
        enterReview(headSha),
      ];
      const spent = yield* applyCommands([
        ...setup,
        ...cardInProgress(),
        ...reviewAgain("sha-1"),
        returnToWork("review"),
        ...reviewAgain("sha-2"),
        returnToWork("review"),
        ...reviewAgain("sha-3"),
      ]);
      expect(cardIn(spent)?.fixRounds).toEqual({ ci: 0, review: 2 });
      expect(yield* refusal(spent, returnToWork("review"))).toBe(
        "The card used its 2 review fix rounds; a person can give it more.",
      );
      // CI rounds are counted apart, and a person's comment is never capped.
      const ciReturn = yield* applyTo(spent, [returnToWork("ci")]);
      expect(cardIn(ciReturn)).toMatchObject({ status: "inProgress", fixRounds: { ci: 1 } });

      const reset = yield* applyTo(spent, [onCard("card.fix-rounds.reset")]);
      expect(cardIn(reset)?.fixRounds).toEqual({ ci: 0, review: 0 });
      expect(yield* refusal(reset, onCard("card.fix-rounds.reset"))).toBe(
        "The card hasn't used any fix rounds.",
      );
      const returned = yield* applyTo(reset, [returnToWork("review")]);
      expect(cardIn(returned)?.status).toBe("inProgress");
    }),
  );

  it.effect("a merge waits for a person to acknowledge hard scope flags", () =>
    Effect.gen(function* () {
      const flagged = yield* applyCommands([
        ...setup,
        ...cardInProgress(),
        recordEvidence("abc123", [check("test", 0)], { hardFlag: true }),
        enterReview("abc123"),
      ]);
      expect(yield* refusal(flagged, onCard("card.merge.approve"))).toBe(
        UNACKNOWLEDGED_FLAGS_REASON,
      );
      const acknowledge = (evidenceId: string): OrchestrationCommand => ({
        type: "card.flags.acknowledge",
        commandId: nextCommandId(),
        cardId,
        evidenceId,
      });
      expect(yield* refusal(flagged, acknowledge("evidence-other"))).toBe(
        "There are no flagged changes to acknowledge.",
      );
      const evidenceId = cardIn(flagged)?.evidence?.evidenceId ?? "";
      const merging = yield* applyTo(flagged, [
        acknowledge(evidenceId),
        onCard("card.merge.approve"),
      ]);
      expect(cardIn(merging)?.status).toBe("landing");
    }),
  );

  it.effect("a card lands without a person only as a plan child into its plan's branch, or with auto-merge on", () =>
    Effect.gen(function* () {
      const landingBegin = (
        id: string,
        reason: "planChild" | "autoMergePolicy",
      ): OrchestrationCommand => ({
        type: "card.landing.begin",
        commandId: nextCommandId(),
        cardId: CardId.make(id),
        reason,
      });
      const reviewed = yield* applyCommands([
        ...setup,
        ...cardInProgress(),
        recordEvidence("abc123", [check("test", 0)]),
        enterReview("abc123"),
      ]);
      expect(yield* refusal(reviewed, landingBegin(cardId, "planChild"))).toBe(
        PLAN_CHILD_LANDING_REASON,
      );
      expect(yield* refusal(reviewed, landingBegin(cardId, "autoMergePolicy"))).toBe(
        AUTO_MERGE_OFF_REASON,
      );
      const autoMerged = yield* applyTo(reviewed, [
        setPolicy({ autoMerge: { enabled: true, minSatisfaction: 0.9 } }),
        landingBegin(cardId, "autoMergePolicy"),
      ]);
      expect(cardIn(autoMerged)?.status).toBe("landing");

      // No command creates plan cards yet, so the plan arrives as its events.
      let withPlan = reviewed;
      const planEvents: ReadonlyArray<Pick<OrchestrationEvent, "type" | "payload">> = [
        {
          type: "card.created",
          payload: {
            cardId: CardId.make("card-plan"),
            kind: "plan",
            projectId,
            channelId: null,
            parentCardId: null,
            title: "Plan",
            spec: "",
            specState: "approved",
            tags: [],
            status: "inProgress",
            ownerHumanId: "human",
            baseBranch: null,
            createdBy: { kind: "human", id: "human" },
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          type: "card.workspace-set",
          payload: {
            cardId: CardId.make("card-plan"),
            branch: "iskra/plan-limits",
            worktreePath: "/tmp/worktrees/plan",
            portBase: 42000,
            updatedAt: now,
          },
        },
      ];
      for (const event of planEvents) {
        withPlan = yield* projectEvent(withPlan, {
          ...event,
          sequence: withPlan.snapshotSequence + 1,
          eventId: `event-${nextCommandId()}`,
          aggregateKind: "card",
          aggregateId: CardId.make("card-plan"),
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        } as OrchestrationEvent);
      }
      const child = (id: string, baseBranch: string): ReadonlyArray<OrchestrationCommand> => [
        {
          type: "card.create",
          commandId: nextCommandId(),
          cardId: CardId.make(id),
          projectId,
          parentCardId: CardId.make("card-plan"),
          title: "Child",
          spec: "",
          tags: [],
          baseBranch,
          createdAt: now,
        },
        approveAndStart(id, criteria),
        onCard("card.work.start", id),
        recordEvidence("child-sha", [check("test", 0)], { id }),
        enterReview("child-sha", id),
      ];
      const children = yield* applyTo(withPlan, [
        ...child("card-child", "iskra/plan-limits"),
        ...child("card-stray", "main"),
      ]);
      expect(yield* refusal(children, landingBegin("card-stray", "planChild"))).toBe(
        PLAN_CHILD_LANDING_REASON,
      );
      // With the verifier on, a plan child waits for it like any other card.
      const verified = yield* applyTo(children, [setPolicy({ verifier: { mode: "on" } })]);
      expect(yield* refusal(verified, landingBegin("card-child", "planChild"))).toBe(
        VERIFIER_NOT_PASSED_REASON,
      );
      const childLanding = yield* applyTo(children, [landingBegin("card-child", "planChild")]);
      expect(cardIn(childLanding, "card-child")?.status).toBe("landing");
    }),
  );

  it.effect("helpers, critics and verifiers need their role, and a card has two helper or critic runs at most", () =>
    Effect.gen(function* () {
      const started = yield* applyCommands([
        ...setup,
        createAgent(reviewer, { roles: ["verifier"] }),
        ...cardInProgress(),
      ]);
      const help = (agentId: AgentId | null): OrchestrationCommand => ({
        type: "card.help.request",
        commandId: nextCommandId(),
        cardId,
        agentId,
        messageId: MessageId.make(`help-${nextCommandId()}`),
        question: "Which store keeps the counters?",
        createdAt: now,
      });
      const critique = (agentId: AgentId | null): OrchestrationCommand => ({
        type: "card.critique.request",
        commandId: nextCommandId(),
        cardId,
        agentId,
        messageId: MessageId.make(`critique-${nextCommandId()}`),
        focus: "diff",
        createdAt: now,
      });
      const personAsks = (agentId: AgentId): OrchestrationCommand => ({
        type: "card.helper.request",
        commandId: nextCommandId(),
        cardId,
        agentId,
        messageId: MessageId.make(`ask-${nextCommandId()}`),
        question: "Which store?",
        createdAt: now,
      });
      expect(yield* refusal(started, help(reviewer))).toBe(
        "@reviewer can't act as a helper; choose an agent whose roles include it.",
      );
      expect(yield* refusal(started, critique(reviewer))).toBe(
        "@reviewer can't act as a critic; choose an agent whose roles include it.",
      );
      expect(yield* refusal(started, personAsks(reviewer))).toBe(
        "@reviewer can't act as a helper; choose an agent whose roles include it.",
      );

      // No agent named asks the builder's own template; the answer comes back to the builder.
      const asked = yield* decide(started, help(null));
      expect(asked.map((event) => event.type)).toEqual([
        "card.activity-recorded",
        "card.helper-requested",
      ]);
      expect(asked[1]?.payload).toMatchObject({ agentId: backend, requestedBy: "builder" });
      const critiqued = yield* decide(started, critique(frontend));
      expect(critiqued[1]).toMatchObject({
        type: "card.critique-requested",
        payload: { agentId: frontend, focus: "diff" },
      });

      const busy = yield* applyTo(started, [
        recordSession("thread-helper", frontend, "helper", ["read"]),
        recordSession("thread-critic", frontend, "critic", ["read"]),
      ]);
      expect(yield* refusal(busy, help(frontend))).toBe(OPEN_ASSIST_RUNS_REASON);
      expect(yield* refusal(busy, critique(frontend))).toBe(OPEN_ASSIST_RUNS_REASON);
      expect(yield* refusal(busy, personAsks(frontend))).toBe(OPEN_ASSIST_RUNS_REASON);

      // A template's verifier must be able to verify.
      const verifyWith = (name: string): OrchestrationCommand => ({
        type: "agent.update",
        commandId: nextCommandId(),
        agentId: backend,
        verifyWith: name,
      });
      expect(yield* refusal(started, verifyWith("frontend"))).toBe(
        "@frontend can't act as a verifier; choose an agent whose roles include it.",
      );
      const paired = yield* applyTo(started, [verifyWith("reviewer")]);
      expect(paired.agents?.find((agent) => agent.id === backend)?.verifyWith).toBe("reviewer");
    }),
  );

  it.effect("a person restarts the services of a card still being worked on, with a worktree", () =>
    Effect.gen(function* () {
      const restart: OrchestrationCommand = {
        type: "card.services.restart",
        commandId: nextCommandId(),
        cardId,
      };
      expect(isClientCommand(restart)).toBe(true);
      const bare = yield* applyCommands([...setup, bareCard()]);
      expect(yield* refusal(bare, restart)).toBe(RESTART_SERVICES_REASON);

      const withWorktree = yield* applyTo(bare, [setWorkspace()]);
      expect((yield* decide(withWorktree, restart)).map((event) => event.type)).toEqual([
        "card.services-restart-requested",
      ]);

      const abandoned = yield* applyTo(withWorktree, [onCard("card.abandon")]);
      expect(yield* refusal(abandoned, restart)).toBe(RESTART_SERVICES_REASON);
    }),
  );

  it.effect("a merge waits for the verifier to pass the latest commit, or a person to override it", () =>
    Effect.gen(function* () {
      const verifier = {
        agentId: reviewer,
        instanceId: ProviderInstanceId.make("opencode"),
        model: "openai/gpt-5",
        reason: { code: "differentProvider", text: "OpenCode checks work Claude built." },
      };
      const select = (headSha: string, agentId: AgentId = reviewer): OrchestrationCommand => ({
        type: "card.verifier.select",
        commandId: nextCommandId(),
        cardId,
        headSha,
        verifier: { ...verifier, agentId },
      });
      const verdict = (
        headSha: string,
        pass: boolean,
        criterionIds: ReadonlyArray<string> = ["c1"],
      ): OrchestrationCommand => ({
        type: "card.verdict.record",
        commandId: nextCommandId(),
        verdictId: `verdict-${nextCommandId()}`,
        cardId,
        headSha,
        criteria: criterionIds.map((criterionId) => ({
          criterionId,
          pass,
          evidence: "limits.test.ts",
          note: pass ? "" : "No 429 on the 101st request.",
        })),
        diffJudge: { matchesCriteria: true, concerns: [] },
        scenarios: [{ scenarioId: "holdout-1", satisfied: pass }],
        recordedAt: now,
      });
      const override = (reason: string): OrchestrationCommand => ({
        type: "card.verifier.override",
        commandId: nextCommandId(),
        cardId,
        reason,
      });
      const rerun: OrchestrationCommand = {
        type: "card.verifier.rerun",
        commandId: nextCommandId(),
        cardId,
      };
      const reviewed = yield* applyCommands([
        ...setup,
        setPolicy({ verifier: { mode: "on" } }),
        createAgent(reviewer, { roles: ["verifier"] }),
        ...cardInProgress(),
        recordEvidence("abc123", [check("test", 0)]),
        enterReview("abc123"),
      ]);

      // Nobody verified yet: the merge waits, and there is no verdict to record.
      expect(yield* refusal(reviewed, onCard("card.merge.approve"))).toBe(VERIFIER_NOT_PASSED_REASON);
      expect(yield* refusal(reviewed, verdict("abc123", true))).toBe(NO_VERIFIER_RUNNING_REASON);
      expect(yield* refusal(reviewed, select("old123"))).toBe(VERIFY_LATEST_COMMIT_REASON);
      expect(yield* refusal(reviewed, select("abc123", frontend))).toBe(
        "@frontend can't act as a verifier; choose an agent whose roles include it.",
      );

      const running = yield* applyTo(reviewed, [select("abc123")]);
      expect(cardIn(running)?.verification).toMatchObject({ state: "running", headSha: "abc123" });
      expect(yield* refusal(running, rerun)).toBe(VERIFIER_RUNNING_REASON);
      expect(yield* refusal(running, override("Checked by hand."))).toBe(OVERRIDE_STATE_REASON);
      expect(yield* refusal(running, verdict("old123", true))).toBe(VERDICT_STALE_REASON);
      expect(yield* refusal(running, verdict("abc123", true, []))).toBe(VERDICT_INCOMPLETE_REASON);

      const failed = yield* applyTo(running, [verdict("abc123", false)]);
      expect(cardIn(failed)?.verification).toMatchObject({
        state: "failed",
        satisfaction: { satisfied: 0, total: 1 },
      });
      expect(yield* refusal(failed, onCard("card.merge.approve"))).toBe(VERIFIER_NOT_PASSED_REASON);
      expect(yield* refusal(failed, override("   "))).toBe(OVERRIDE_REASON_REQUIRED);
      const overridden = yield* applyTo(failed, [
        override("Checked the 429 by hand."),
        onCard("card.merge.approve"),
      ]);
      expect(cardIn(overridden)?.status).toBe("landing");
      expect(cardIn(yield* applyTo(failed, [rerun]))?.verification).toMatchObject({
        state: "pending",
        headSha: "abc123",
      });

      // A passing verdict lets the merge through, until evidence for another commit.
      const passed = yield* applyTo(running, [verdict("abc123", true)]);
      expect(cardIn(passed)?.verification.state).toBe("passed");
      expect(cardIn(yield* applyTo(passed, [onCard("card.merge.approve")]))?.status).toBe("landing");
      const newCommit = yield* applyTo(passed, [recordEvidence("def456", [check("test", 0)])]);
      expect(cardIn(newCommit)?.verification).toMatchObject({ state: "pending", headSha: null });
      expect(yield* refusal(newCommit, onCard("card.merge.approve"))).toBe(
        VERIFIER_NOT_PASSED_REASON,
      );
    }),
  );

  it.effect("auto-merge and a template that always verifies wait for the verifier too", () =>
    Effect.gen(function* () {
      const reviewed = yield* applyCommands([
        createProject(),
        setPolicy({ autoMerge: { enabled: true, minSatisfaction: 0.9 } }),
        createAgent(backend, { blueprint: { ...DEFAULT_AGENT_BLUEPRINT, verify: "always" } }),
        createAgent(frontend),
        ...cardInProgress(),
        recordEvidence("abc123", [check("test", 0)]),
        enterReview("abc123"),
      ]);
      const autoMerge: OrchestrationCommand = {
        type: "card.landing.begin",
        commandId: nextCommandId(),
        cardId,
        reason: "autoMergePolicy",
      };
      expect(yield* refusal(reviewed, autoMerge)).toBe(VERIFIER_NOT_PASSED_REASON);
      expect(yield* refusal(reviewed, onCard("card.merge.approve"))).toBe(VERIFIER_NOT_PASSED_REASON);
    }),
  );

  it.effect("owner sessions wait for the project's side-effect guard and for a paused card to resume", () =>
    Effect.gen(function* () {
      const unguarded = yield* applyCommands([
        createProject(),
        createAgent(backend),
        createAgent(frontend),
        ...cardInProgress(),
        setWorkspace(),
      ]);
      expect(yield* refusal(unguarded, recordSession("thread-owner", backend))).toBe(
        SIDE_EFFECT_GUARD_REASON,
      );
      const start: OrchestrationCommand = {
        type: "card.session.start",
        commandId: nextCommandId(),
        cardId,
        createdAt: now,
      };
      expect(yield* refusal(unguarded, start)).toBe(SIDE_EFFECT_GUARD_REASON);
      // A read-only helper answers questions without writing, so the guard doesn't hold it.
      yield* applyTo(unguarded, [recordSession("thread-helper", frontend, "helper", ["read"])]);

      const guarded = yield* applyTo(unguarded, [setPolicy()]);
      const paused = yield* applyTo(guarded, [onCard("card.pause")]);
      expect(cardIn(paused)?.paused).toMatchObject({ by: "human" });
      expect(yield* refusal(paused, onCard("card.pause"))).toBe("The card is already paused.");
      expect(yield* refusal(paused, recordSession("thread-owner", backend))).toBe(PAUSED_REASON);
      expect(yield* refusal(paused, start)).toBe(PAUSED_REASON);

      const resumed = yield* applyTo(paused, [onCard("card.resume")]);
      expect(yield* refusal(resumed, onCard("card.resume"))).toBe("The card isn't paused.");
      const owning = yield* applyTo(resumed, [recordSession("thread-owner", backend)]);
      expect(owning.liveRuns).toHaveLength(1);
    }),
  );

  it.effect("the project's session cap refuses sessions past it", () =>
    Effect.gen(function* () {
      const capped = yield* applyCommands([
        ...setup,
        setPolicy({ sessionCap: 1 }),
        ...cardInProgress(),
        setWorkspace(),
        recordSession("thread-owner", backend),
      ]);
      expect(
        yield* refusal(capped, recordSession("thread-helper", frontend, "helper", ["read"])),
      ).toBe("All 1 session slots in this project are busy; the card starts when one frees.");
    }),
  );

  it.effect("a builder's sub-cards skip triage, run as its own and stop at the project's cap", () =>
    Effect.gen(function* () {
      const working = yield* applyCommands([
        ...setup,
        setPolicy({ builderSubCardsMax: 1 }),
        ...cardInProgress(),
      ]);
      const propose = (
        id: string,
        agentId = backend,
      ): Extract<OrchestrationCommand, { type: "card.propose" }> => ({
        type: "card.propose",
        commandId: nextCommandId(),
        cardId: CardId.make(id),
        agentId,
        projectId,
        parentCardId: cardId,
        title: "Split out the limiter",
        spec: "",
        tags: [],
        criteria,
        subCard: true,
        createdAt: now,
      });
      expect(yield* refusal(working, propose("card-sub", frontend))).toBe(
        "Only the agent working on an approved card adds sub-cards to it.",
      );
      expect(yield* refusal(working, { ...propose("card-sub"), criteria: [] })).toBe(
        NO_CRITERIA_REASON,
      );
      const withSubCard = yield* applyTo(working, [propose("card-sub")]);
      expect(cardIn(withSubCard, "card-sub")).toMatchObject({
        status: "ready",
        delegateAgentId: backend,
        specState: "approved",
        acceptance: { state: "confirmed" },
        createdBy: { kind: "agent", id: backend },
      });
      expect(yield* refusal(withSubCard, propose("card-sub-2"))).toBe(
        "This card already has 1 open sub-cards; land or drop one first.",
      );
    }),
  );

  it.effect("a proposal that doesn't get to the requester's goal is refused", () =>
    Effect.gen(function* () {
      const readModel = yield* applyCommands(setup);
      expect(
        yield* refusal(readModel, {
          type: "card.propose",
          commandId: nextCommandId(),
          cardId: CardId.make("card-proposed"),
          agentId: backend,
          projectId,
          title: "Cache everything",
          spec: "",
          tags: [],
          premise: { goal: "Faster pages", getsThere: false, pushback: "Caching hides the slow query." },
          createdAt: now,
        }),
      ).toBe(PREMISE_REASON);
    }),
  );

  it.effect("a checkpoint opens on work in progress and a stop pauses the card", () =>
    Effect.gen(function* () {
      const request = (id: string = cardId): OrchestrationCommand => ({
        type: "card.checkpoint.request",
        commandId: nextCommandId(),
        cardId: CardId.make(id),
        checkpoint: {
          checkpointId: `checkpoint-${nextCommandId()}`,
          whatToTry: "Open the limits page.",
          question: null,
          evidenceId: null,
          requestedAt: now,
        },
      });
      const resolve = (decision: "continue" | "redirect" | "stop"): OrchestrationCommand => ({
        type: "card.checkpoint.resolve",
        commandId: nextCommandId(),
        cardId,
        decision,
      });
      const triage = yield* applyCommands([...setup, createCard()]);
      expect(yield* refusal(triage, request())).toBe(
        "Only a card in progress can ask for a checkpoint.",
      );
      expect(yield* refusal(triage, resolve("continue"))).toBe(OPEN_CHECKPOINT_REASON);

      const asking = yield* applyTo(triage, [
        approveAndStart(cardId, criteria),
        onCard("card.work.start"),
        request(),
      ]);
      expect(yield* refusal(asking, request())).toBe("The card already has an open checkpoint.");
      const stopped = yield* applyTo(asking, [resolve("stop")]);
      expect(cardIn(stopped)).toMatchObject({
        checkpoint: null,
        paused: { reason: { code: "checkpointStopped" }, by: "human" },
      });
    }),
  );

  it.effect("a person answers a card's open question once; a checkpoint's answer resolves it", () =>
    Effect.gen(function* () {
      const ask: OrchestrationCommand = {
        type: "card.activity.record",
        commandId: nextCommandId(),
        activityId: "question-1",
        cardId,
        kind: "elicitation",
        author: { kind: "agent", id: backend },
        body: "Which store?",
        runThreadId: null,
        deliverTo: null,
        elicitation: {
          question: "Which store?",
          options: [
            { id: "redis", label: "Redis" },
            { id: "memory", label: "Memory" },
          ],
          recommendedOptionId: "redis",
          allowText: true,
          kind: "question",
        },
        answers: null,
        status: null,
        evidenceId: null,
        reason: null,
        createdAt: now,
      };
      const answer = (activityId: string, optionId: string | null): OrchestrationCommand => ({
        type: "card.elicitation.answer",
        commandId: nextCommandId(),
        cardId,
        activityId,
        optionId,
        body: "Redis",
        createdAt: now,
      });
      expect(isClientCommand(answer("question-1", "redis"))).toBe(true);
      const asked = yield* applyCommands([
        ...setup,
        createCard(),
        approveAndStart(cardId, criteria),
        onCard("card.work.start"),
        ask,
      ]);
      expect(cardIn(asked)?.openElicitations).toEqual([
        {
          activityId: "question-1",
          kind: "question",
          optionIds: ["redis", "memory"],
          askedAt: now,
          question: "Which store?",
          options: [
            { id: "redis", label: "Redis" },
            { id: "memory", label: "Memory" },
          ],
          recommendedOptionId: "redis",
          allowText: true,
        },
      ]);
      expect(yield* refusal(asked, answer("question-2", null))).toBe(NO_OPEN_QUESTION_REASON);
      expect(yield* refusal(asked, answer("question-1", "postgres"))).toBe(ANSWER_OPTION_REASON);
      expect(yield* decide(asked, answer("question-1", "redis"))).toMatchObject([
        {
          type: "card.activity-recorded",
          payload: {
            activityId: "question-1:answer",
            kind: "response",
            author: { kind: "human" },
            deliverTo: "builder",
            delivery: "pending",
            answers: { questionId: "question-1", optionId: "redis" },
          },
        },
      ]);
      const answered = yield* applyTo(asked, [answer("question-1", null)]);
      expect(cardIn(answered)?.openElicitations).toEqual([]);
      expect(yield* refusal(answered, answer("question-1", "redis"))).toBe(NO_OPEN_QUESTION_REASON);

      const checkpointed = yield* applyTo(answered, [
        {
          type: "card.checkpoint.request",
          commandId: nextCommandId(),
          cardId,
          checkpoint: {
            checkpointId: "checkpoint-1",
            whatToTry: "Open the limits page.",
            question: null,
            evidenceId: null,
            requestedAt: now,
          },
        },
      ]);
      expect(cardIn(checkpointed)?.openElicitations).toEqual([
        {
          activityId: "checkpoint-1",
          kind: "checkpoint",
          optionIds: ["continue", "redirect", "stop"],
          askedAt: now,
          question: "Is this going the right way?",
          options: [
            { id: "continue", label: "Continue" },
            { id: "redirect", label: "Redirect" },
            { id: "stop", label: "Stop" },
          ],
          recommendedOptionId: "continue",
          allowText: true,
        },
      ]);
      const stopped = yield* applyTo(checkpointed, [answer("checkpoint-1", "stop")]);
      expect(cardIn(stopped)).toMatchObject({
        checkpoint: null,
        openElicitations: [],
        paused: { reason: { code: "checkpointStopped" } },
      });
    }),
  );

  it.effect("a person forwards or dismisses what waits on them; review and landing again clear the rest", () =>
    Effect.gen(function* () {
      expect(isClientCommand(onAttention("card.comment.forward", "comment-1"))).toBe(true);
      expect(isClientCommand(onAttention("card.attention.dismiss", "comment-1"))).toBe(true);
      const started = yield* applyCommands([
        ...setup,
        createCard(),
        approveAndStart(cardId, criteria),
        onCard("card.work.start"),
      ]);
      const raised = yield* applyTo(started, [
        raise("comment-1", "untrustedComment", "stranger on the pull request: Use tabs.", "message"),
        raise("comment-2", "untrustedComment", "stranger on the pull request: Rename it.", "message"),
        raise("checks-1", "checksMissing"),
        raise("checks-2", "checksMissing"),
        // Not an attention code: nothing waits.
        raise("stalled-1", "stalled"),
      ]);
      expect(
        cardIn(raised)?.attention.map((item) => [item.activityId, item.code, item.actions]),
      ).toEqual([
        ["comment-1", "untrustedComment", ["forward", "dismiss"]],
        ["comment-2", "untrustedComment", ["forward", "dismiss"]],
        // The same code again replaces the older item; each comment is its own.
        ["checks-2", "checksMissing", ["openSettings", "dismiss"]],
      ]);
      expect(yield* refusal(raised, onAttention("card.comment.forward", "comment-9"))).toBe(
        NO_ATTENTION_REASON,
      );
      expect(yield* refusal(raised, onAttention("card.comment.forward", "checks-2"))).toBe(
        NOT_FORWARDABLE_REASON,
      );
      expect(yield* decide(raised, onAttention("card.comment.forward", "comment-1"))).toMatchObject([
        {
          type: "card.activity-recorded",
          payload: {
            activityId: "comment-1:forwarded",
            kind: "response",
            author: { kind: "human" },
            deliverTo: "builder",
            delivery: "pending",
            answers: { questionId: "comment-1", optionId: "forward" },
            body: expect.stringContaining("> stranger on the pull request: Use tabs."),
          },
        },
      ]);
      const handled = yield* applyTo(raised, [
        onAttention("card.comment.forward", "comment-1"),
        onAttention("card.attention.dismiss", "comment-2"),
      ]);
      expect(cardIn(handled)?.attention.map((item) => item.activityId)).toEqual(["checks-2"]);
      expect(yield* refusal(handled, onAttention("card.attention.dismiss", "comment-1"))).toBe(
        NO_ATTENTION_REASON,
      );

      // Checks were added (or waived) and the card entered review.
      const reviewing = yield* applyTo(handled, reviewWithEvidence());
      expect(cardIn(reviewing)?.attention).toEqual([]);
      // The host refused the merge, so landing was cancelled; approving it again is the retry.
      const blocked = yield* applyTo(reviewing, [
        onCard("card.merge.approve"),
        raise("blocked-1", "landingBlocked"),
        onCard("card.merge.cancel"),
      ]);
      expect(cardIn(blocked)?.attention.map((item) => item.code)).toEqual(["landingBlocked"]);
      const retried = yield* applyTo(blocked, [onCard("card.merge.approve")]);
      expect(cardIn(retried)?.attention).toEqual([]);
    }),
  );

  it.effect("a linked or reopened pull request, written criteria and landing clear what they resolve", () =>
    Effect.gen(function* () {
      const url = "https://github.com/acme/api/pull/7";
      const link: OrchestrationCommand = {
        type: "card.landing.link",
        commandId: nextCommandId(),
        cardId,
        landing: { mode: "pullRequest", url, number: 7, headSha: "abc1234", draft: false, linkedAt: now },
      };
      const started = yield* applyCommands([
        ...setup,
        createCard(),
        approveAndStart(cardId, criteria),
        onCard("card.work.start"),
      ]);
      const unopened = yield* applyTo(started, [
        raise("open-failed", "pullRequestOpenFailed"),
        raise("ci-only", "ciChecksNeedPullRequest"),
        raise("criteria-ask", "criteriaMissing", "Which acceptance criteria?", "elicitation"),
      ]);
      expect(cardIn(unopened)?.attention.map((item) => item.code)).toEqual([
        "pullRequestOpenFailed",
        "ciChecksNeedPullRequest",
        "criteriaMissing",
      ]);
      // Asking for criteria is also a question, answered in words from the shell.
      expect(cardIn(unopened)?.openElicitations).toMatchObject([
        { activityId: "criteria-ask", question: "Which acceptance criteria?", options: [], allowText: true },
      ]);
      expect(yield* refusal(unopened, onAttention("card.attention.dismiss", "criteria-ask"))).toBe(
        NOT_DISMISSABLE_REASON,
      );

      const written = yield* applyTo(unopened, [
        { type: "card.criteria.set", commandId: nextCommandId(), cardId, criteria },
        link,
      ]);
      expect(cardIn(written)).toMatchObject({ attention: [], openElicitations: [] });

      const closed = yield* applyTo(written, [raise("closed-1", "pullRequestClosed")]);
      expect(cardIn(closed)?.attention.map((item) => item.code)).toEqual(["pullRequestClosed"]);
      const reopened = yield* applyTo(closed, [
        raise("pr-reopened:closed-1", PULL_REQUEST_REOPENED_CODE, `Reopened: ${url}`, "message"),
      ]);
      expect(cardIn(reopened)?.attention).toEqual([]);

      const merged = yield* applyTo(reopened, [
        ...reviewWithEvidence(),
        raise("closed-2", "pullRequestClosed"),
        { type: "card.land", commandId: nextCommandId(), cardId, mergedOnHostUrl: url },
      ]);
      expect(cardIn(merged)).toMatchObject({
        status: "landed",
        landing: { url, mergedOnHostUrl: url },
        attention: [],
      });
    }),
  );

  it.effect("a person restores or keeps the refs Iskra reported, once; only Iskra reports them", () =>
    Effect.gen(function* () {
      const changes = [
        { ref: "refs/heads/main", kind: "moved", before: "a".repeat(40), after: "b".repeat(40) },
        { ref: "refs/tags/x", kind: "created", before: null, after: "b".repeat(40) },
      ] as const;
      const report = (author: "system" | "agent"): OrchestrationCommand => ({
        type: "card.activity.record",
        commandId: nextCommandId(),
        activityId: "refs-1",
        cardId,
        kind: "error",
        author: author === "system" ? { kind: "system", id: "system" } : { kind: "agent", id: backend },
        body: "Refs outside this card changed.",
        runThreadId: null,
        deliverTo: null,
        elicitation: {
          question: "Restore or keep?",
          options: [
            { id: "restore", label: "Restore" },
            { id: "keep", label: "Keep" },
          ],
          recommendedOptionId: null,
          allowText: false,
          kind: "refsChanged",
        },
        answers: null,
        status: null,
        evidenceId: null,
        reason: { code: "refMovedOutsideCard", text: "Refs changed." },
        refChanges: changes,
        createdAt: now,
      });
      const restore = (activityId: string, refs?: ReadonlyArray<string>): OrchestrationCommand => ({
        type: "card.refs.restore",
        commandId: nextCommandId(),
        cardId,
        activityId,
        ...(refs === undefined ? {} : { refs }),
      });
      const keep = (activityId: string): OrchestrationCommand => ({
        type: "card.refs.keep",
        commandId: nextCommandId(),
        cardId,
        activityId,
      });
      expect(isClientCommand(restore("refs-1", ["refs/tags/x"]))).toBe(true);
      expect(isClientCommand(keep("refs-1"))).toBe(true);
      expect(isClientCommand(report("system"))).toBe(false);

      const started = yield* applyCommands([
        ...setup,
        createCard(),
        approveAndStart(cardId, criteria),
        onCard("card.work.start"),
      ]);
      expect(yield* refusal(started, report("agent"))).toBe(SYSTEM_REF_REPORT_REASON);
      const reported = yield* applyTo(started, [report("system")]);
      expect(cardIn(reported)?.openElicitations).toEqual([
        {
          activityId: "refs-1",
          kind: "refsChanged",
          optionIds: ["restore", "keep"],
          askedAt: now,
          question: "Restore or keep?",
          options: [
            { id: "restore", label: "Restore" },
            { id: "keep", label: "Keep" },
          ],
          recommendedOptionId: null,
          allowText: false,
          refChanges: changes,
        },
      ]);
      expect(yield* refusal(reported, restore("refs-2"))).toBe(NO_OPEN_REF_REPORT_REASON);
      expect(yield* refusal(reported, restore("refs-1", []))).toBe("Choose at least one ref to restore.");
      expect(yield* refusal(reported, restore("refs-1", ["refs/heads/other"]))).toBe(
        "Not in this report: refs/heads/other.",
      );
      expect(yield* decide(reported, restore("refs-1", ["refs/tags/x"]))).toMatchObject([
        {
          type: "card.activity-recorded",
          payload: {
            activityId: "refs-1:restore",
            kind: "response",
            author: { kind: "human" },
            deliverTo: null,
            answers: { questionId: "refs-1", optionId: "restore" },
            refChanges: [changes[1]],
          },
        },
      ]);
      // Answering it as a question restores every ref.
      expect(
        yield* decide(reported, {
          type: "card.elicitation.answer",
          commandId: nextCommandId(),
          cardId,
          activityId: "refs-1",
          optionId: "restore",
          body: "Restore",
          createdAt: now,
        }),
      ).toMatchObject([{ payload: { activityId: "refs-1:restore", refChanges: changes } }]);

      const kept = yield* applyTo(reported, [keep("refs-1")]);
      expect(cardIn(kept)?.openElicitations).toEqual([]);
      expect(yield* refusal(kept, restore("refs-1"))).toBe(NO_OPEN_REF_REPORT_REASON);
      expect(yield* refusal(kept, keep("refs-1"))).toBe(NO_OPEN_REF_REPORT_REASON);

      const asked = yield* applyTo(kept, [
        {
          ...report("system"),
          activityId: "question-9",
          kind: "elicitation",
          elicitation: {
            question: "Which store?",
            options: [
              { id: "redis", label: "Redis" },
              { id: "memory", label: "Memory" },
            ],
            recommendedOptionId: null,
            allowText: true,
            kind: "question",
          },
          refChanges: null,
        } as OrchestrationCommand,
      ]);
      expect(yield* refusal(asked, keep("question-9"))).toBe(NOT_REF_REPORT_REASON);
    }),
  );

  it.effect("only a person's command sets the orchestration policy, and it must be coherent", () =>
    Effect.gen(function* () {
      const command = setPolicy({ egress: { mode: "allowlist", allow: ["a.dev"], deny: ["a.dev"] } });
      expect(isClientCommand(command)).toBe(true);
      const readModel = yield* applyCommands([createProject()]);
      expect(yield* refusal(readModel, command)).toBe(
        "A domain can't be both allowed and denied: a.dev.",
      );
      const set = yield* applyTo(readModel, [setPolicy({ sessionCap: 2 })]);
      expect(set.projects[0]?.orchestration).toMatchObject({ sessionCap: 2 });
    }),
  );

  it.effect("a lead's question is answered once, with an offered option or a person's words", () =>
    Effect.gen(function* () {
      const general = ChannelId.make("channel-general");
      const ask = (options: ReadonlyArray<{ id: string; label: string }>): OrchestrationCommand => ({
        type: "channel.message.agent.post",
        commandId: nextCommandId(),
        channelId: general,
        messageId: MessageId.make("message-question"),
        agentId: backend,
        runThreadId: ThreadId.make("thread-lead"),
        body: "Which store?",
        elicitation: {
          question: "Which store?",
          options,
          recommendedOptionId: "redis",
          allowText: true,
          kind: "question",
        },
        createdAt: now,
      });
      const answer = (optionId: string | null, messageId: string): OrchestrationCommand => ({
        type: "channel.elicitation.answer",
        commandId: nextCommandId(),
        channelId: general,
        questionMessageId: MessageId.make("message-question"),
        messageId: MessageId.make(messageId),
        optionId,
        body: "Redis",
        createdAt: now,
      });
      const channel = yield* applyCommands([
        ...setup,
        createChannel("channel-general", "channel", [backend], backend),
      ]);
      expect(yield* refusal(channel, ask([{ id: "redis", label: "Redis" }]))).toBe(
        "A question offers two or three answers.",
      );
      const asked = yield* applyTo(channel, [
        ask([
          { id: "redis", label: "Redis" },
          { id: "memory", label: "Memory" },
        ]),
      ]);
      expect(yield* refusal(asked, answer("postgres", "message-answer"))).toBe(ANSWER_OPTION_REASON);

      const events = yield* decide(asked, answer("redis", "message-answer"));
      expect(events[0]).toMatchObject({
        type: "channel.message-posted",
        payload: { authorKind: "human", answers: { questionId: "message-question", optionId: "redis" } },
      });
      // Like any person's message in the channel, the answer wakes its lead.
      expect(events.map((event) => event.type)).toContain("channel.agent-wake-requested");

      const answered = yield* applyTo(asked, [answer(null, "message-answer")]);
      expect(answered.channels?.[0]?.openElicitations).toEqual([]);
      expect(yield* refusal(answered, answer("redis", "message-answer-2"))).toBe(
        ALREADY_ANSWERED_REASON,
      );
    }),
  );
});
