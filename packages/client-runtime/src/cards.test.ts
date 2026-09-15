import {
  AgentId,
  CardId,
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
  cardBadges,
  cardDropDecision,
  cardMoveActions,
  cardWaitItems,
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
  delegateAgentId: null,
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
      ["Move to In progress", false],
      ["Move to Review", false],
      ["Move to Landing", false],
      ["Abandon", true],
    ]);
    expect(actions("abandoned")).toEqual([
      ["Reopen", true],
      ["Move to Ready", false],
      ["Move to In progress", false],
      ["Move to Review", false],
      ["Move to Landing", false],
    ]);
    expect(cardMoveActions("landed")).toEqual([]);
    expect(cardMoveActions("ready").find((action) => action.column === "inProgress")?.reason).toBe(
      "Work starts when the card's agent starts its first session; assign an agent instead.",
    );
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
    expect(labels(shell({ status: "triage", acceptance: LEGACY_CARD_CONTRACT.acceptance }))).toEqual(
      [["No acceptance criteria", false]],
    );
    expect(labels(shell({ ...base, status: "landed" }))).toEqual([]);
    expect(
      labels(
        shell({
          ...base,
          paused: { reason: { code: "pausedByPerson", text: "Paused." }, by: "human", pausedAt: at(1) },
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
          acceptance: { criteria: [], state: "draft" },
          updatedAt: at(1),
        }),
        card("checkpoint", {
          status: "inProgress",
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
          paused: {
            reason: { code: "fixRoundsExhausted", text: "CI failed twice." },
            by: "system",
            pausedAt: at(3),
          },
        }),
        card("mine", {
          status: "inProgress",
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
            openQuestion("q1", "question", at(8), { question: "Which store?", optionIds: ["a", "b"] }),
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
          openElicitations: [openQuestion("ask", "question", at(9), { question: "Which criteria?" })],
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
    expect(
      needsYouLabel(items.find((item) => item.cardId === "moved-ref")!),
    ).toBe("Refs changed outside this card");
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
    const missing = EMITTED_CODES.filter(
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
      openElicitations: [openQuestion("q2", "question", at(1)), openQuestion("k1", "checkpoint", at(1))],
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
});

describe("waitingLabel", () => {
  it("says how long at the coarsest unit", () => {
    const now = Date.parse(at(0)) + 3 * 24 * 60 * 60_000;
    expect(waitingLabel(at(0), Date.parse(at(4)))).toBe("4m");
    expect(waitingLabel(at(0), Date.parse(at(0)) + 3 * 60 * 60_000)).toBe("3h");
    expect(waitingLabel(at(0), now)).toBe("3d");
  });
});
