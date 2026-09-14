import {
  AgentId,
  CardBriefPayload,
  CardId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationAgent,
  type OrchestrationCard,
} from "@iskra/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CARD_BRIEF_DIFF_LIMIT, buildCardBrief, diffStatOf, renderCardBrief } from "./cardBrief.ts";

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
        'You are @backend, the agent building the card "Rate limiting". You work in its worktree and are the only agent writing to it.\n\nYou own the API.',
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
