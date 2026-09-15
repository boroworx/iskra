import {
  AgentId,
  DEFAULT_AGENT_BLUEPRINT,
  DEFAULT_AGENT_ROLES,
  CardBriefPayload,
  CardId,
  LEGACY_CARD_CONTRACT,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationAgent,
  type OrchestrationCard,
} from "@iskra/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CARD_BRIEF_DIFF_LIMIT,
  CARD_WORKLOG_LIMIT,
  buildCardBrief,
  diffStatOf,
  renderCardBrief,
  type CardWorklogInput,
} from "./cardBrief.ts";
import type { CardActivity } from "@iskra/contracts";

const decodeCardBrief = Schema.decodeUnknownSync(CardBriefPayload);
const projectId = ProjectId.make("project-brief");

const agent = (id: string, name: string, rolePrompt = ""): OrchestrationAgent => ({
  id: AgentId.make(id),
  projectId,
  name,
  avatar: null,
  roleTags: [],
  rolePrompt,
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
  capabilities: ["read", "write"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  roles: DEFAULT_AGENT_ROLES,
  verifyWith: null,
  blueprint: DEFAULT_AGENT_BLUEPRINT,
});

const backend = agent("agent-backend", "backend", "You own the API.");
const reviewer = agent("agent-reviewer", "reviewer");

const card: OrchestrationCard = {
  id: CardId.make("card-limits"),
  projectId,
  channelId: null,
  parentCardId: null,
  title: "Rate limiting",
  spec: "Limit each API key to 100 requests a minute.",
  specState: "draft",
  tags: [],
  status: "inProgress",
  ownerHumanId: "human",
  delegateAgentId: backend.id,
  baseBranch: null,
  branch: "iskra/rate-limiting-limits",
  worktreePath: "/tmp/worktrees/rate-limiting",
  portBase: 42000,
  relations: [],
  snoozedUntil: null,
  snoozedAt: null,
  activityAt: "2026-01-01T00:00:00.000Z",
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
  createdBy: { kind: "human", id: "human" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const diff = "diff --git a/limits.ts b/limits.ts\n+export const LIMIT = 100;\n";

describe("renderCardBrief", () => {
  it("hands the owner the spec, the decision log and the diff, exactly", () => {
    const brief = buildCardBrief({
      agent: backend,
      role: "owner",
      card,
      agents: [backend, reviewer],
      decisions: [
        { author: { kind: "human", id: "human" }, text: "Use a token bucket.", createdAt: "2026-01-02T00:00:00.000Z" },
        { author: { kind: "agent", id: reviewer.id }, text: "Keys are per project.", createdAt: "2026-01-03T00:00:00.000Z" },
      ],
      baseBranch: "main",
      diff,
      question: null,
    });

    expect(decodeCardBrief(brief)).toEqual(brief);
    expect(renderCardBrief(brief)).toEqual({
      systemPrompt:
        'You are @backend, the agent building the card "Rate limiting". You work in its worktree and are the only agent writing to it. Use the board tools: record_decision for each choice that matters, update_plan as you go, ask_owner when the spec leaves you stuck (offer two or three answers and recommend one), run_checks to run the checks (never the full suite in your shell), request_checkpoint before a costly direction, propose_card for work outside this card, propose_criteria_change when the criteria are wrong, and request_review with a summary and your risk claims once your work is committed. Iskra runs the checks and captures evidence; the card enters review only when they pass.\n\nYou own the API.',
      firstMessage: [
        "# Handoff brief: Rate limiting",
        "Branch `iskra/rate-limiting-limits`, based on `main`.",
        "## Spec\n\nLimit each API key to 100 requests a minute.",
        "## Decisions\n\n- [2026-01-02T00:00:00.000Z] user: Use a token bucket.\n- [2026-01-03T00:00:00.000Z] reviewer: Keys are per project.",
        "## Changes so far\n\n```diff\ndiff --git a/limits.ts b/limits.ts\n+export const LIMIT = 100;\n```",
      ].join("\n\n"),
    });
  });

  it("hands a helper the same card read-only, with its question and no empty sections", () => {
    const rendered = renderCardBrief(
      buildCardBrief({
        agent: reviewer,
        role: "helper",
        card: { ...card, spec: "", branch: null },
        agents: [backend, reviewer],
        decisions: [],
        baseBranch: "main",
        diff: "",
        question: "Is the limit per key or per user?",
      }),
    );

    expect(rendered.systemPrompt).toBe(
      'You are @reviewer, helping on the card "Rate limiting". You can read its worktree but not change it; your answer goes to the agent building the card.',
    );
    expect(rendered.firstMessage).toBe(
      [
        "# Handoff brief: Rate limiting",
        "Based on `main`; the card has no branch yet.",
        "## Spec\n\nNo spec yet.",
        "## Decisions\n\nNo decisions recorded yet.",
        "## Changes so far\n\nNo changes yet.",
        "## Question\n\nIs the limit per key or per user?",
      ].join("\n\n"),
    );
  });

  it("counts a diff's files and changed lines, not its headers", () => {
    expect(
      diffStatOf(
        [
          "diff --git a/limits.ts b/limits.ts",
          "--- a/limits.ts",
          "+++ b/limits.ts",
          "@@ -1,2 +1,2 @@",
          "-export const LIMIT = 10;",
          "+export const LIMIT = 100;",
          "+export const WINDOW = 60;",
          "diff --git a/README.md b/README.md",
          "+Rate limits apply per key.",
        ].join("\n"),
      ),
    ).toEqual({ files: 2, additions: 3, deletions: 1 });
    expect(diffStatOf("")).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  it("cuts a diff past the limit and says so", () => {
    const brief = buildCardBrief({
      agent: backend,
      role: "owner",
      card,
      agents: [backend],
      decisions: [],
      baseBranch: "main",
      diff: "+".repeat(CARD_BRIEF_DIFF_LIMIT + 10),
      question: null,
    });

    expect(brief.diff).toHaveLength(CARD_BRIEF_DIFF_LIMIT);
    expect(brief.diffTruncated).toBe(true);
    expect(renderCardBrief(brief).firstMessage).toContain(
      "The diff was cut short; run `git diff` in the worktree for the rest.",
    );
  });
});

const at = (minute: number) => `2026-01-02T00:${String(minute).padStart(2, "0")}:00.000Z`;

const entry = (
  activityId: string,
  kind: CardActivity["kind"],
  body: string,
  minute: number,
  extra: Partial<CardActivity> = {},
): CardActivity => ({
  activityId,
  cardId: card.id,
  kind,
  author: { kind: "agent", id: backend.id },
  body,
  runThreadId: null,
  deliverTo: null,
  delivery: null,
  elicitation: null,
  answers: null,
  status: null,
  evidenceId: null,
  reason: null,
  createdAt: at(minute),
  ...extra,
});

const worklog = (overrides: Partial<CardWorklogInput> = {}): CardWorklogInput => ({
  activities: [],
  evidenceItems: [],
  projectRules: null,
  restarts: 0,
  ...overrides,
});

const ownerBrief = (
  cardOverrides: Partial<OrchestrationCard>,
  log: CardWorklogInput,
  diffText = diff,
) =>
  renderCardBrief(
    buildCardBrief({
      agent: backend,
      role: "owner",
      card: { ...card, ...cardOverrides },
      agents: [backend, reviewer],
      decisions: [],
      baseBranch: "main",
      diff: diffText,
      question: null,
      worklog: log,
    }),
  ).firstMessage;

describe("card worklog", () => {
  it("hands a restarted owner its criteria first, then the whole record, exactly", () => {
    const text = ownerBrief(
      {
        acceptance: {
          criteria: [
            { id: "c1", text: "A key over 100 a minute gets a 429.", verification: "automated" },
            { id: "c2", text: "The limit shows on the dashboard.", verification: "manual" },
          ],
          state: "confirmed",
        },
        premise: { goal: "Stop abusive clients.", getsThere: true, pushback: null },
        evidence: {
          evidenceId: "ev-1",
          headSha: "abcdef1234",
          purpose: "review",
          passed: false,
          checkCount: 2,
          failedChecks: ["test"],
          unavailable: [],
          flags: [{ kind: "skippedTest", path: "limits.test.ts", detail: "it.skip", hard: true }],
          flagsAcknowledgedAt: null,
          recordedAt: at(9),
        },
      },
      worklog({
        restarts: 1,
        projectRules: "### AGENTS.md\n\nUse pnpm.",
        activities: [
          entry("d1", "decision", "Use a token bucket.", 1, {
            author: { kind: "human", id: "human" },
          }),
          entry("p1", "plan", "- [x] Limiter", 2),
          entry("p2", "plan", "- [x] Limiter\n- [~] Router", 3),
          entry("q1", "elicitation", "Per key or account?", 4, {
            elicitation: {
              question: "Per key or account?",
              options: [
                { id: "o1", label: "Key" },
                { id: "o2", label: "Account" },
              ],
              recommendedOptionId: "o1",
              allowText: true,
              kind: "question",
            },
          }),
          entry("r1", "response", "Key", 5, {
            author: { kind: "human", id: "human" },
            answers: { questionId: "q1", optionId: "o1" },
          }),
          entry("m1", "message", "The checks failed.", 6, {
            author: { kind: "system", id: "system" },
          }),
        ],
        evidenceItems: [
          {
            itemId: "i1",
            kind: "check",
            source: "local",
            name: "lint",
            criterionId: null,
            exitCode: 0,
            timedOut: false,
            durationMs: 10,
            logTail: "ok",
            artifactPath: null,
            unavailable: null,
          },
          {
            itemId: "i2",
            kind: "check",
            source: "local",
            name: "test",
            criterionId: null,
            exitCode: 1,
            timedOut: false,
            durationMs: 10,
            logTail: "FAIL limits.test.ts\n",
            artifactPath: null,
            unavailable: null,
          },
        ],
      }),
    );

    expect(text).toBe(
      [
        "# Handoff brief: Rate limiting",
        "Branch `iskra/rate-limiting-limits`, based on `main`.",
        "## Restarted\n\nYour previous session on this card ended before the work was done. This worklog is everything recorded since; check the worktree's state before you continue.",
        "## Acceptance criteria\n\n- [c1] A key over 100 a minute gets a 429.\n- [c2] The limit shows on the dashboard. (a person checks this one)",
        "## Premise\n\nGoal: Stop abusive clients.",
        "## Spec\n\nLimit each API key to 100 requests a minute.",
        "## Plan\n\n- [x] Limiter\n- [~] Router",
        `## Decisions\n\n- [${at(1)}] user: Use a token bucket.`,
        "## Questions and answers\n\n- Q (@backend): Per key or account? (Key / Account)\n  A: user: Key",
        `## Messages\n\n[${at(6)}] Iskra: The checks failed.`,
        "## Last evidence\n\nReview evidence on abcdef1: failed.\n- lint (local): exit 0\n- test (local): exit 1\n```\nFAIL limits.test.ts\n```\n- Flag (needs a person): skippedTest limits.test.ts: it.skip",
        "## Project rules\n\n### AGENTS.md\n\nUse pnpm.",
        "## Changes so far\n\n```diff\ndiff --git a/limits.ts b/limits.ts\n+export const LIMIT = 100;\n```",
      ].join("\n\n"),
    );
  });

  it("digests older messages and drops the digest first when the worklog runs over", () => {
    const messages = Array.from({ length: 14 }, (_, index) =>
      entry(`m${index}`, "message", `message ${index}`, index),
    );
    const text = ownerBrief({}, worklog({ activities: messages }), "");
    expect(text).toContain("Earlier, in brief:\n");
    expect(text).toContain(`- [${at(3)}] @backend: message 3\n\nMost recent:`);
    expect(text).toContain(`[${at(13)}] @backend: message 13`);

    const long = messages.map((message) => ({ ...message, body: "x".repeat(9_000) }));
    const trimmed = ownerBrief({}, worklog({ activities: long }), "");
    expect(trimmed).not.toContain("Earlier, in brief");
    expect(trimmed.length).toBeLessThanOrEqual(CARD_WORKLOG_LIMIT + 1_000);
    expect(trimmed).toContain("No acceptance criteria.");
  });
});
