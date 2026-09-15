import {
  AUTOMATION_REASON_CODES,
  AgentId,
  CardId,
  DEFAULT_PROJECT_ORCHESTRATION,
  LEGACY_CARD_CONTRACT,
  ProjectId,
  ThreadId,
  type CardOpenElicitation,
  type CardStatus,
  type OrchestrationCard,
  type OrchestrationCardShell,
} from "@iskra/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_COLUMNS,
  REASON_LABEL,
  VERIFIER_NOT_PASSED_TEXT,
  cardBadges,
  cardDropDecision,
  cardMoveActions,
  cardVerificationRequired,
  overrideVerifierRefusal,
  rerunVerifierRefusal,
  verifierMergeRefusal,
  cardWaitItems,
  delegateReadOnlyWarning,
  elicitationAnswer,
  isCardSnoozed,
  needsYouItems,
  needsYouLabel,
  openCheckpointActivityId,
  reasonLabel,
  waitingLabel,
} from "./cards.ts";

const projectId = ProjectId.make("project-board");
// Minutes past midnight on 2026-01-01, as an ISO timestamp.
const at = (minute: number) =>
  `2026-01-01T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;

const card = (id: string, overrides: Partial<OrchestrationCard> = {}): OrchestrationCard => ({
  id: CardId.make(id),
  projectId,
  channelId: null,
  parentCardId: null,
  title: `Card ${id}`,
  spec: "",
  specState: "draft",
  tags: [],
  status: "ready",
  ownerHumanId: "human",
  baseBranch: null,
  branch: null,
  worktreePath: null,
  portBase: null,
  relations: [],
  createdBy: { kind: "human", id: "human" },
  createdAt: at(0),
  updatedAt: at(0),
  snoozedUntil: null,
  snoozedAt: null,
  activityAt: at(0),
  diffStat: null,
  checks: null,
  spentUsd: 0,
  budgetCapUsd: 10,
  unpricedTurns: 0,
  acceptsUnpriced: false,
  reviewReturns: 0,
  attemptGroupId: null,
  linearIssue: null,
  sourceMessageId: null,
  proposalReasoning: null,
  suggestedAgentId: null,
  priority: 0,
  ...LEGACY_CARD_CONTRACT,
  // Owned and held to a confirmed criterion, so nothing asks for an agent or criteria by default.
  delegateAgentId: AgentId.make("agent-default"),
  acceptance: {
    state: "confirmed",
    criteria: [{ id: "default", text: "Works.", verification: "automated" }],
  },
  ...overrides,
});

/** An open question as the card shell lists it, answered in words unless options are given. */
const openQuestion = (
  activityId: string,
  kind: CardOpenElicitation["kind"],
  askedAt: string,
  overrides: Partial<CardOpenElicitation> = {},
): CardOpenElicitation => ({
  activityId,
  kind,
  optionIds: [],
  askedAt,
  question: "",
  options: [],
  recommendedOptionId: null,
  allowText: true,
  ...overrides,
});

describe("cardDropDecision", () => {
  it("turns only the human decisions into commands, and snaps every other drop back with a reason", () => {
    const decisions = (status: CardStatus) =>
      Object.fromEntries(
        BOARD_COLUMNS.map((column) => {
          const decision = cardDropDecision(status, column);
          return [column, decision.kind === "command" ? decision.type : decision.kind];
        }),
      );

    expect(decisions("triage")).toEqual({
      triage: "none",
      ready: "card.approve",
      inProgress: "refuse",
      inReview: "refuse",
      landing: "refuse",
      done: "card.abandon",
    });
    expect(decisions("ready")).toMatchObject({ triage: "card.unapprove", inProgress: "refuse" });
    expect(decisions("inProgress")).toMatchObject({ inReview: "refuse", done: "card.abandon" });
    expect(decisions("inReview")).toMatchObject({ landing: "card.merge.approve", ready: "refuse" });
    expect(decisions("landing")).toMatchObject({
      inReview: "card.merge.cancel",
      done: "card.abandon",
    });
    expect(decisions("abandoned")).toMatchObject({
      triage: "card.reopen",
      ready: "refuse",
      done: "none",
    });
    expect(decisions("landed")).toMatchObject({ triage: "refuse", done: "none" });

    expect(cardDropDecision("ready", "inProgress")).toEqual({
      kind: "refuse",
      reason:
        "Work starts when the card's agent starts its first session; assign an agent instead.",
    });
  });
});

describe("cardMoveActions", () => {
  it("offers the drop decisions as buttons and says why every other move is not a button", () => {
    const actions = (status: CardStatus) =>
      cardMoveActions(status).map((action) => [action.label, action.type !== null]);

    expect(actions("triage")).toEqual([
      ["Approve", true],
      ["Move to In Progress", false],
      ["Move to Review", false],
      ["Move to Landing", false],
      ["Abandon", true],
    ]);
    expect(actions("abandoned")).toEqual([
      ["Reopen", true],
      ["Move to Ready", false],
      ["Move to In Progress", false],
      ["Move to Review", false],
      ["Move to Landing", false],
    ]);
    expect(cardMoveActions("landed")).toEqual([]);
    expect(cardMoveActions("ready").find((action) => action.column === "inProgress")?.reason).toBe(
      "Work starts when the card's agent starts its first session; assign an agent instead.",
    );
  });

  it("keeps Approve merge disabled with the verifier's reason until it passes", () => {
    const merge = cardMoveActions("inReview", VERIFIER_NOT_PASSED_TEXT).find(
      (action) => action.column === "landing",
    );
    expect(merge).toEqual({
      column: "landing",
      label: "Approve merge",
      type: null,
      reason: "The verifier hasn't passed every criterion yet.",
    });
    expect(cardDropDecision("inReview", "landing", VERIFIER_NOT_PASSED_TEXT).kind).toBe("refuse");
  });
});

describe("verifier refusals", () => {
  const verification = (
    state: OrchestrationCard["verification"]["state"],
    headSha: string | null = "abc",
  ): OrchestrationCard["verification"] => ({
    state,
    headSha,
    verdictId: null,
    verifier: null,
    satisfaction: null,
    override: null,
  });
  const evidence = (headSha: string): OrchestrationCard["evidence"] => ({
    evidenceId: "e1",
    headSha,
    purpose: "review",
    passed: true,
    checkCount: 1,
    failedChecks: [],
    unavailable: [],
    flags: [],
    flagsAcknowledgedAt: null,
    recordedAt: at(1),
  });
  const reviewed = (state: OrchestrationCard["verification"]["state"], headSha = "abc") =>
    card("v", {
      status: "inReview",
      verification: verification(state),
      evidence: evidence(headSha),
    });
  const off = { verifier: { mode: "off" as const } };
  const on = { verifier: { mode: "on" as const } };

  it("requires the verifier from the project, the builder's template or a started verification", () => {
    expect(cardVerificationRequired(reviewed("off"), off, undefined)).toBe(false);
    expect(cardVerificationRequired(reviewed("off"), on, undefined)).toBe(true);
    expect(
      cardVerificationRequired(reviewed("off"), off, {
        blueprint: { preflight: "none", uiCapture: "auto", uiPaths: [], verify: "always" },
      }),
    ).toBe(true);
    expect(cardVerificationRequired(reviewed("running"), off, undefined)).toBe(true);
  });

  it("holds the merge until the verifier passed the latest commit or a person overrode it", () => {
    expect(verifierMergeRefusal(reviewed("off"), true)).toBe(VERIFIER_NOT_PASSED_TEXT);
    expect(verifierMergeRefusal(reviewed("failed"), true)).toBe(VERIFIER_NOT_PASSED_TEXT);
    expect(verifierMergeRefusal(reviewed("passed", "newer"), true)).toBe(VERIFIER_NOT_PASSED_TEXT);
    expect(verifierMergeRefusal(reviewed("passed"), true)).toBeNull();
    expect(verifierMergeRefusal(reviewed("overridden"), true)).toBeNull();
    expect(verifierMergeRefusal(reviewed("off"), false)).toBeNull();
  });

  it("overrides only a failed or pending verification, and reruns any verification in review", () => {
    expect(overrideVerifierRefusal(reviewed("failed"), true)).toBeNull();
    expect(overrideVerifierRefusal(reviewed("off"), true)).toBeNull();
    expect(overrideVerifierRefusal(reviewed("passed"), true)).toBe(
      "Only a failed or pending verification can be overridden.",
    );
    expect(rerunVerifierRefusal(reviewed("failed"))).toBeNull();
    // A verifier that died leaves the card "running"; the server refuses only a live one.
    expect(rerunVerifierRefusal(reviewed("running"))).toBeNull();
    expect(rerunVerifierRefusal({ ...reviewed("failed"), status: "inProgress" })).toBe(
      "Only a card in review is verified.",
    );
  });

  it("doesn't ask for a merge while a verifier still checks or failed the card", () => {
    const now = Date.parse(at(10));
    const kinds = (cards: ReadonlyArray<OrchestrationCard>, verifier: "off" | "on") =>
      needsYouItems({
        cards,
        sessions: [],
        projects: [
          {
            id: projectId,
            orchestration: {
              ...DEFAULT_PROJECT_ORCHESTRATION,
              sideEffectGuard: { acknowledgedAt: at(0), killSwitchEnv: null },
              verifier: { mode: verifier },
            },
          },
        ],
        now,
      }).map((item) => item.kind);
    expect(kinds([reviewed("off")], "off")).toEqual(["readyToMerge"]);
    expect(kinds([reviewed("off")], "on")).toEqual([]);
    expect(kinds([reviewed("running")], "off")).toEqual([]);
    expect(kinds([reviewed("passed")], "on")).toEqual(["readyToMerge"]);
  });
});

describe("cardBadges", () => {
  const shell = (overrides: Partial<OrchestrationCardShell> = {}): OrchestrationCardShell => ({
    ...card("face"),
    acceptance: {
      criteria: [{ id: "c1", text: "It works", verification: "automated" }],
      state: "confirmed",
    },
    ownerSession: null,
    ...overrides,
  });
  const labels = (face: OrchestrationCardShell, blocked = false) =>
    cardBadges(face, { blocked, snoozed: false }).map((badge) => [badge.label, badge.alarming]);

  it("labels the session in words and counts failed checks against the retry limit", () => {
    expect(
      labels(
        shell({
          status: "inReview",
          specState: "approved",
          checks: { state: "failed", failedRuns: 2, summary: "", updatedAt: at(1) },
          ownerSession: {
            threadId: ThreadId.make("owner"),
            agentId: AgentId.make("agent"),
            state: "awaitingInput",
            since: at(1),
            planProgress: null,
          },
        }),
        true,
      ),
    ).toEqual([
      ["Blocked", true],
      ["Waiting for you", true],
      ["Checks failed 2/3", true],
    ]);
  });

  it("shows a spent card's budget before its unpriced model, and nothing spent on a finished card", () => {
    const spent = { specState: "approved" as const, spentUsd: 10, unpricedTurns: 1 };
    expect(labels(shell({ status: "inProgress", ...spent }))).toEqual([["Budget reached", true]]);
    expect(
      labels(shell({ status: "inProgress", specState: "approved", unpricedTurns: 1 })),
    ).toEqual([["Unpriced model", true]]);
    expect(labels(shell({ status: "landed", ...spent }))).toEqual([]);
    expect(labels(shell({ status: "ready" }))).toEqual([["Spec draft", false]]);
  });

  it("marks cards without confirmed criteria, and says why a card waits or is paused", () => {
    const base = { status: "inProgress" as const, specState: "approved" as const };
    expect(labels(shell({ ...base, acceptance: LEGACY_CARD_CONTRACT.acceptance }))).toEqual([
      ["No acceptance criteria", false],
    ]);
    expect(labels(shell({ ...base, acceptance: { criteria: [], state: "draft" } }))).toEqual([
      ["Criteria not confirmed", false],
    ]);
    expect(
      labels(
        shell({
          ...base,
          waitReason: { code: "reviewCapacity", text: "5 agent PRs wait.", since: at(1) },
        }),
      ),
    ).toEqual([["Waiting for agent pull requests to be reviewed", false]]);
    expect(
      labels(
        shell({
          ...base,
          waitReason: { code: "waitingForCapacity", text: "Load is high.", since: at(1) },
          paused: {
            reason: { code: "stuck", text: "It kept repeating." },
            by: "system",
            pausedAt: at(1),
          },
        }),
      ),
    ).toEqual([["Stuck", true]]);
    // Only unfinished cards say they have no criteria, triage included; finished ones never.
    expect(
      labels(shell({ status: "triage", acceptance: LEGACY_CARD_CONTRACT.acceptance })),
    ).toEqual([["No acceptance criteria", false]]);
    expect(labels(shell({ ...base, status: "landed" }))).toEqual([]);
    expect(
      labels(
        shell({
          ...base,
          paused: {
            reason: { code: "pausedByPerson", text: "Paused." },
            by: "human",
            pausedAt: at(1),
          },
        }),
      ),
    ).toEqual([["Paused", false]]);
  });
});

describe("needsYouItems", () => {
  it("lists what waits on a person across projects, longest waiting first", () => {
    const items = needsYouItems({
      cards: [
        card("proposal", { status: "triage", createdAt: at(10) }),
        card("draft-spec", { spec: "Limit keys.", updatedAt: at(5) }),
        card("empty-spec"),
        card("approved-spec", { spec: "Done.", specState: "approved" }),
        card("asking", { status: "inProgress", specState: "approved" }),
        card("lost", { status: "inProgress", specState: "skipped" }),
        card("gone", { status: "abandoned", spec: "Old." }),
      ],
      sessions: [
        { cardId: CardId.make("asking"), state: "awaitingInput", since: at(1) },
        { cardId: CardId.make("lost"), state: "stale", since: at(20) },
        { cardId: CardId.make("approved-spec"), state: "active", since: at(2) },
      ],
      now: Date.parse(at(30)),
    });

    expect(items.map((item) => [item.kind, item.cardId])).toEqual([
      ["awaitingInput", "asking"],
      ["spec", "draft-spec"],
      ["triage", "proposal"],
      ["sessionFailed", "lost"],
    ]);
  });

  it("hides a snoozed card until its time passes or it has new activity, but never hides a question", () => {
    const snoozed = card("snoozed", {
      status: "triage",
      snoozedAt: at(10),
      snoozedUntil: at(60),
      activityAt: at(5),
    });
    const list = (cards: ReadonlyArray<OrchestrationCard>, now: number) =>
      needsYouItems({
        cards,
        sessions: [{ cardId: CardId.make("snoozed"), state: "awaitingInput", since: at(12) }],
        now,
      }).map((item) => item.kind);

    expect(list([snoozed], Date.parse(at(30)))).toEqual(["awaitingInput"]);
    expect(list([snoozed], Date.parse(at(61)))).toEqual(["triage", "awaitingInput"]);
    expect(list([{ ...snoozed, activityAt: at(20) }], Date.parse(at(30)))).toEqual([
      "triage",
      "awaitingInput",
    ]);

    const untilActivity = { ...snoozed, snoozedUntil: null };
    expect(isCardSnoozed(untilActivity, Date.parse("2026-01-08T00:00:00.000Z"))).toBe(true);
    expect(isCardSnoozed({ ...untilActivity, activityAt: at(11) }, Date.parse(at(30)))).toBe(false);
  });
});

describe("needsYouItems before work starts", () => {
  const confirmed = (criteria: number) => ({
    acceptance: {
      state: "confirmed" as const,
      criteria: Array.from({ length: criteria }, (_, index) => ({
        id: `c${index}`,
        text: "Works.",
        verification: "automated" as const,
      })),
    },
    specState: "skipped" as const,
  });
  const kinds = (cards: ReadonlyArray<OrchestrationCard>) =>
    needsYouItems({ cards, sessions: [], now: Date.parse(at(30)) }).map((item) => [
      item.kind,
      item.cardId,
    ]);

  it("asks for an agent on an open card with none, unless a person paused it", () => {
    const agent = AgentId.make("agent-1");
    const unowned = { ...confirmed(1), delegateAgentId: null };
    expect(
      kinds([
        card("ready", unowned),
        card("restart", { ...unowned, status: "inProgress" }),
        card("owned", { ...confirmed(1), delegateAgentId: agent }),
        card("proposal", { ...unowned, status: "triage" }),
        card("held", {
          ...unowned,
          paused: {
            reason: { code: "pausedByPerson", text: "Paused." },
            by: "human",
            pausedAt: at(1),
          },
        }),
      ]),
    ).toEqual([
      ["needsAgent", "ready"],
      ["needsAgent", "restart"],
      ["triage", "proposal"],
    ]);
  });

  it("asks for criteria on an unfinished card confirmed with none", () => {
    const agent = AgentId.make("agent-1");
    const items = needsYouItems({
      cards: [
        card("legacy", { ...confirmed(0), delegateAgentId: agent }),
        card("fine", { ...confirmed(1), delegateAgentId: agent }),
        card("done", { ...confirmed(0), status: "landed" }),
      ],
      sessions: [],
      now: Date.parse(at(30)),
    });
    expect(items.map((item) => [item.kind, item.cardId])).toEqual([["criteria", "legacy"]]);
    expect(needsYouLabel(items[0]!)).toBe("No acceptance criteria");
  });

  it("asks for write access when the queue says the card's agent can only read", () => {
    const readOnly = card("reader", {
      ...confirmed(1),
      delegateAgentId: AgentId.make("agent-1"),
      waitReason: {
        code: "delegateReadOnly",
        text: "@reader can only read; give it write access in its agent settings to work on cards.",
        since: at(3),
      },
    });
    const guarded = card("guarded", {
      ...confirmed(1),
      delegateAgentId: AgentId.make("agent-1"),
      waitReason: { code: "sideEffectGuard", text: "Review the guard.", since: at(4) },
    });
    const items = needsYouItems({ cards: [readOnly], sessions: [], now: Date.parse(at(30)) });
    expect(items.map((item) => [item.kind, item.reason])).toEqual([
      ["delegateReadOnly", readOnly.waitReason!.text],
    ]);
    expect(needsYouLabel(items[0]!)).toBe("Its agent can only read");
    // Approve & start warns in the queue's own words, and says nothing for an older server.
    const reader = { name: "reader", capabilities: ["read" as const] };
    expect(delegateReadOnlyWarning(reader)).toBe(readOnly.waitReason!.text);
    expect(delegateReadOnlyWarning({ ...reader, capabilities: ["read", "write"] })).toBeNull();
    expect(delegateReadOnlyWarning({ name: "reader" })).toBeNull();
    // Both wait on a person, so neither is listed as waiting on Iskra.
    expect(cardWaitItems([readOnly, guarded])).toEqual([]);
  });
});

describe("needsYouItems in review", () => {
  it("asks for a merge once checks pass, and for a person once the agent's retries run out", () => {
    const checks = (state: "passed" | "failed", failedRuns: number) => ({
      state,
      failedRuns,
      summary: "",
      updatedAt: at(3),
    });
    const items = needsYouItems({
      cards: [
        card("passing", { status: "inReview", specState: "approved", checks: checks("passed", 0) }),
        card("retrying", {
          status: "inReview",
          specState: "approved",
          checks: checks("failed", 2),
        }),
        card("exhausted", {
          status: "inReview",
          specState: "approved",
          checks: checks("failed", 3),
        }),
        card("unchecked", { status: "inReview", specState: "approved" }),
      ],
      sessions: [],
      now: Date.parse(at(10)),
    });

    expect(items.map((item) => [item.kind, item.cardId])).toEqual([
      ["readyToMerge", "passing"],
      ["fixRoundsExhausted", "exhausted"],
    ]);
  });
});

describe("needsYouItems on the card contract", () => {
  const evidence = (overrides: Partial<NonNullable<OrchestrationCard["evidence"]>> = {}) => ({
    evidenceId: "e1",
    headSha: "abc",
    purpose: "review" as const,
    passed: true,
    checkCount: 2,
    failedChecks: [],
    unavailable: [],
    flags: [],
    flagsAcknowledgedAt: null,
    recordedAt: at(4),
    ...overrides,
  });
  const hardFlag = {
    kind: "deletedTest" as const,
    path: "a.test.ts",
    detail: "deleted",
    hard: true,
  };

  it("says why each card waits, and holds merges on flags and missing captures", () => {
    const review = { status: "inReview" as const, specState: "approved" as const };
    const items = needsYouItems({
      cards: [
        card("criteria", {
          status: "ready",
          delegateAgentId: null,
          acceptance: { criteria: [], state: "draft" },
          updatedAt: at(1),
        }),
        card("checkpoint", {
          status: "inProgress",
          // Another project's, so the side-effect guard item below stays with "unguarded".
          projectId: ProjectId.make("project-other"),
          checkpoint: {
            checkpointId: "k1",
            whatToTry: "Split the form",
            question: "Keep the old layout?",
            evidenceId: null,
            requestedAt: at(2),
          },
        }),
        card("exhausted", {
          status: "inProgress",
          projectId: ProjectId.make("project-other"),
          paused: {
            reason: { code: "fixRoundsExhausted", text: "CI failed twice." },
            by: "system",
            pausedAt: at(3),
          },
        }),
        card("mine", {
          status: "inProgress",
          projectId: ProjectId.make("project-other"),
          paused: {
            reason: { code: "pausedByPerson", text: "Paused." },
            by: "human",
            pausedAt: at(3),
          },
        }),
        card("flagged", { ...review, evidence: evidence({ flags: [hardFlag] }) }),
        card("acknowledged", {
          ...review,
          evidence: evidence({ flags: [hardFlag], flagsAcknowledgedAt: at(5) }),
        }),
        card("no-host", { ...review, evidence: evidence({ unavailable: ["home screenshot"] }) }),
        card("unguarded", {
          status: "ready",
          delegateAgentId: AgentId.make("builder"),
          updatedAt: at(6),
        }),
        card("moved-ref", {
          status: "inProgress",
          paused: {
            reason: { code: "refMovedOutsideCard", text: "It moved main." },
            by: "system",
            pausedAt: at(7),
          },
        }),
        card("refs", {
          status: "inProgress",
          paused: {
            reason: { code: "refMovedOutsideCard", text: "Refs changed." },
            by: "system",
            pausedAt: at(7),
          },
          openElicitations: [openQuestion("refs-1", "refsChanged", at(7))],
        }),
        card("asked", {
          status: "inProgress",
          openElicitations: [
            openQuestion("k9", "checkpoint", at(7)),
            openQuestion("q1", "question", at(8), {
              question: "Which store?",
              optionIds: ["a", "b"],
            }),
            openQuestion("q2", "question", at(9), { question: "Per key?" }),
          ],
        }),
        card("comment", {
          status: "inReview",
          attention: [
            {
              activityId: "comment-1",
              code: "untrustedComment",
              text: "stranger on the pull request: Use tabs.",
              createdAt: at(9),
              actions: ["forward", "dismiss"],
            },
          ],
        }),
        card("linear", {
          status: "ready",
          openElicitations: [
            openQuestion("ask", "question", at(9), { question: "Which criteria?" }),
          ],
          attention: [
            {
              activityId: "ask",
              code: "criteriaMissing",
              text: "Which criteria?",
              createdAt: at(9),
              actions: ["addCriteria"],
            },
          ],
        }),
        card("ci", { ...review, evidence: evidence({ pendingCi: ["build"] }) }),
        card("capacity", {
          status: "inProgress",
          waitReason: { code: "waitingForCapacity", text: "Load is high.", since: at(8) },
        }),
      ],
      sessions: [],
      projects: [{ id: projectId }],
      now: Date.parse(at(10)),
    });

    expect(items.map((item) => [item.kind, item.cardId, item.reason])).toEqual([
      [
        "criteria",
        "criteria",
        "Work starts only once a person confirms them; they are what checks and review hold the work to.",
      ],
      ["needsAgent", "criteria", null],
      ["checkpoint", "checkpoint", "Keep the old layout?"],
      ["fixRoundsExhausted", "exhausted", "CI failed twice."],
      ["scopeFlags", "flagged", "a.test.ts: deleted"],
      ["readyToMerge", "acknowledged", null],
      [
        "evidenceMissing",
        "no-host",
        "No desktop client was connected to capture the preview (home screenshot).",
      ],
      ["readyToMerge", "no-host", null],
      [
        "sideEffectGuard",
        "unguarded",
        "Agents don't start work until someone checks this project's scheduled jobs and outbound APIs in project settings.",
      ],
      ["paused", "moved-ref", "It moved main."],
      // The refs question stands in for its pause until the refs are restored or kept.
      ["refsChanged", "refs", null],
      // One item per open question with its words; a checkpoint's is not one.
      ["awaitingInput", "asked", "Which store?"],
      ["awaitingInput", "asked", "Per key?"],
      ["attention", "comment", "stranger on the pull request: Use tabs."],
      // Asking for criteria shows once, as its attention item.
      ["attention", "linear", "Which criteria?"],
    ]);
    expect(needsYouLabel(items.find((item) => item.cardId === "moved-ref")!)).toBe(
      "Refs changed outside this card",
    );
    expect(items.find((item) => item.cardId === "refs")).toMatchObject({
      activityId: "refs-1",
      snoozable: false,
    });
    const comment = items.find((item) => item.cardId === "comment")!;
    expect([needsYouLabel(comment), comment.activityId, comment.snoozable]).toEqual([
      "Comment from outside the repository",
      "comment-1",
      true,
    ]);
    expect(items.find((item) => item.cardId === "asked")!.since).toBe(at(8));
    expect(
      cardWaitItems([
        card("capacity", {
          status: "inProgress",
          waitReason: { code: "waitingForCapacity", text: "Load is high.", since: at(8) },
        }),
        card("ci", { ...review, evidence: evidence({ pendingCi: ["build"] }) }),
      ]).map((item) => [item.cardId, item.label, item.reason]),
    ).toEqual([
      ["ci", "Waiting for CI", "No result yet from build."],
      ["capacity", "Waiting for machine capacity", "Load is high."],
    ]);
  });
});

describe("reasonLabel", () => {
  // Every code the server emits (m1-followups: L2, L4 and integration); a new one belongs here.
  const EMITTED_CODES = [
    // waits
    "waitingForCapacity",
    "waitingForSlot",
    "reviewCapacity",
    "waitingForMemory",
    "blocked",
    "startFailed",
    // pauses
    "sessionFailed",
    "stuck",
    "awaitingInput",
    "wallClock",
    "budgetBreaker",
    "fixRoundsExhausted",
    "checkpointStopped",
    "pausedByPerson",
    "refMovedOutsideCard",
    // watchdog errors
    "stalled",
    "repeatedAction",
    "errorLoop",
    "idleInProgress",
    "checksHung",
    "memoryPressure",
    // evidence not captured
    "noPreviewHost",
    "noRunScript",
    "previewFailed",
    "previewUrlRefused",
    "pendingCi",
    // needs you
    "checksMissing",
    "untrustedComment",
    "accessRequest",
    "landingBlocked",
    "pullRequestOpenFailed",
    "pullRequestClosed",
    "criteriaMissing",
    "ciChecksNeedPullRequest",
    // builder feedback and activities
    "checksFailed",
    "ciFailed",
    "rebaseConflict",
    "reviewRefused",
    "reviewComment",
    "exclusivePathChanged",
    "overlap",
    "noWorktree",
    "reviewRequested",
    "runChecksRequested",
    "runChecksResult",
    "mergedOnHost",
    "pullRequestReopened",
  ];

  it("gives every emitted code a short label and a tooltip", () => {
    const missing = [...EMITTED_CODES, ...AUTOMATION_REASON_CODES].filter(
      (code) => !Object.hasOwn(REASON_LABEL, code) || REASON_LABEL[code]!.hint.length === 0,
    );
    expect(missing).toEqual([]);
  });

  it("names the known codes and falls back to the server's own words", () => {
    expect(reasonLabel({ code: "waitingForCapacity", text: "x" }).label).toBe(
      "Waiting for machine capacity",
    );
    expect(reasonLabel({ code: "refMovedOutsideCard", text: "x" }).label).toBe(
      "Refs changed outside this card",
    );
    expect(reasonLabel({ code: "somethingNew", text: "Waiting on the moon." })).toEqual({
      label: "Waiting on the moon.",
      hint: "Waiting on the moon.",
    });
    expect(reasonLabel({ code: "constructor", text: "Not a label." }).label).toBe("Not a label.");
  });
});

describe("elicitationAnswer", () => {
  const question = {
    options: [
      { id: "keep", label: "Keep the old layout" },
      { id: "new", label: "Use the new one" },
    ],
    allowText: true,
  };

  it("sends an offered option by its label, or trimmed words when the question takes them", () => {
    expect(elicitationAnswer(question, { optionId: "new" })).toEqual({
      optionId: "new",
      body: "Use the new one",
    });
    expect(elicitationAnswer(question, { text: "  both  " })).toEqual({
      optionId: null,
      body: "both",
    });
    expect(elicitationAnswer(question, { optionId: "other" })).toBeNull();
    expect(elicitationAnswer(question, { text: "   " })).toBeNull();
    expect(elicitationAnswer({ ...question, allowText: false }, { text: "both" })).toBeNull();
  });

  it("finds a checkpoint's question by its kind, not by assuming its id", () => {
    const shell = {
      openElicitations: [
        openQuestion("q2", "question", at(1)),
        openQuestion("k1", "checkpoint", at(1)),
      ],
    };
    expect(openCheckpointActivityId(shell)).toBe("k1");
    expect(openCheckpointActivityId({ openElicitations: [] })).toBeNull();
  });
});

describe("needsYouItems on budget", () => {
  it("asks a person to raise a spent card's cap, or to accept an unpriced model", () => {
    const items = needsYouItems({
      cards: [
        card("spent", { status: "inProgress", specState: "approved", spentUsd: 10 }),
        card("unpriced", { status: "inProgress", specState: "approved", unpricedTurns: 2 }),
        card("accepted", {
          status: "inProgress",
          specState: "approved",
          unpricedTurns: 2,
          acceptsUnpriced: true,
        }),
        card("landed", { status: "landed", specState: "approved", spentUsd: 12 }),
      ],
      sessions: [],
      now: Date.parse(at(10)),
    });

    expect(items.map((item) => [item.kind, item.cardId])).toEqual([
      ["budgetReached", "spent"],
      ["unpricedModel", "unpriced"],
    ]);
  });

  it("shows a plan's unpriced model beside its open question, even when the plan is snoozed", () => {
    // Its children spend from the plan, so this item is the only way their sessions start again.
    const plan = card("plan", {
      kind: "plan",
      status: "inProgress",
      specState: "approved",
      unpricedTurns: 1,
      activityAt: at(1),
      openElicitations: [
        openQuestion("ask-1", "question", at(2), { question: "Which slice first?" }),
      ],
    });
    const kinds = (cards: ReadonlyArray<OrchestrationCard>) =>
      needsYouItems({ cards, sessions: [], now: Date.parse(at(10)) }).map((item) => item.kind);

    expect(kinds([plan])).toEqual(["unpricedModel", "awaitingInput"]);
    expect(kinds([{ ...plan, snoozedAt: at(3), snoozedUntil: null }])).toEqual([
      "unpricedModel",
      "awaitingInput",
    ]);
  });
});

describe("needsYouItems for plans, lessons, outcomes, reverts and budgets", () => {
  it("lists each new kind once, with what it decides", () => {
    const project = {
      id: projectId,
      orchestration: {
        ...DEFAULT_PROJECT_ORCHESTRATION,
        sideEffectGuard: { acknowledgedAt: at(0), killSwitchEnv: null },
      },
      knowledge: [
        {
          lessonId: "lesson-1",
          kind: "quirk" as const,
          text: "Run migrations before tests.",
          paths: [],
          state: "proposed" as const,
          sourceCardId: CardId.make("landed"),
          createdAt: at(6),
        },
        {
          lessonId: "lesson-2",
          kind: "quirk" as const,
          text: "Already approved.",
          paths: [],
          state: "approved" as const,
          sourceCardId: CardId.make("landed"),
          createdAt: at(6),
        },
      ],
    };
    const attention = (
      activityId: string,
      code: "outcomeFlawed" | "revertConflict",
      minute: number,
    ) => ({
      activityId,
      code,
      text: code,
      createdAt: at(minute),
      actions: [],
    });
    const items = needsYouItems({
      cards: [
        card("plan", {
          kind: "plan",
          status: "inProgress",
          specState: "approved",
          openElicitations: [openQuestion("plan-q", "plan", at(1), { question: "Approve?" })],
        }),
        card("slice", {
          kind: "plan",
          status: "inProgress",
          specState: "approved",
          checkpoint: {
            checkpointId: "slice-1",
            whatToTry: "Slice 1 landed.",
            question: null,
            evidenceId: null,
            requestedAt: at(2),
          },
          openElicitations: [openQuestion("slice-q", "checkpoint", at(2))],
        }),
        card("landed", {
          status: "landed",
          specState: "approved",
          attention: [attention("flawed-a", "outcomeFlawed", 3)],
        }),
        card("revert", {
          status: "inProgress",
          specState: "approved",
          attention: [attention("conflict-a", "revertConflict", 4)],
        }),
        card("capped-1", {
          specState: "approved",
          waitReason: {
            code: "budgetCap",
            text: "This project reached its $5 monthly budget.",
            since: at(5),
          },
        }),
        card("capped-2", {
          specState: "approved",
          waitReason: {
            code: "budgetCap",
            text: "This project reached its $5 monthly budget.",
            since: at(7),
          },
        }),
      ],
      sessions: [],
      projects: [project],
      now: Date.parse(at(10)),
    });

    expect(items.map((item) => [item.kind, item.cardId, item.activityId ?? item.lessonId])).toEqual(
      [
        ["planApproval", "plan", "plan-q"],
        ["sliceCheckpoint", "slice", null],
        ["outcomeFlawed", "landed", "flawed-a"],
        ["revertConflict", "revert", "conflict-a"],
        ["budgetCap", "capped-1", null],
        ["lessonProposed", "landed", "lesson-1"],
      ],
    );
    expect(needsYouLabel(items[2]!)).toBe("It turned out flawed; add a hidden scenario");
    // A budget wait is a person's, so it isn't listed as waiting on Iskra too.
    expect(
      cardWaitItems([
        card("capped-1", { waitReason: { code: "budgetCap", text: "x", since: at(5) } }),
      ]),
    ).toEqual([]);
  });
});

describe("needsYouItems for access requests", () => {
  it("names the agent and the domains it needs, and never snoozes the wait", () => {
    const [item] = needsYouItems({
      cards: [
        card("blocked", {
          status: "inProgress",
          specState: "approved",
          attention: [
            {
              activityId: "access-1",
              code: "accessRequest",
              text: "gh needs the GitHub API.",
              createdAt: at(2),
              actions: ["allowAccess", "dismiss"],
              domains: ["api.github.com", "github.com"],
            },
          ],
        }),
      ],
      sessions: [],
      now: Date.parse(at(10)),
    });
    expect(item).toMatchObject({
      kind: "accessRequest",
      activityId: "access-1",
      reason: "gh needs the GitHub API.",
      domains: ["api.github.com", "github.com"],
      snoozable: false,
    });
    expect(needsYouLabel(item!, "builder1")).toBe(
      "@builder1 needs access to api.github.com, github.com",
    );
    expect(needsYouLabel(item!)).toBe("Its agent needs access to api.github.com, github.com");
  });
});

describe("waitingLabel", () => {
  it("says how long at the coarsest unit", () => {
    const now = Date.parse(at(0)) + 3 * 24 * 60 * 60_000;
    expect(waitingLabel(at(0), Date.parse(at(4)))).toBe("4m");
    expect(waitingLabel(at(0), Date.parse(at(0)) + 3 * 60 * 60_000)).toBe("3h");
    expect(waitingLabel(at(0), now)).toBe("3d");
  });
});
