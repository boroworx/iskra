import {
  AgentId,
  CardId,
  type CardEvidenceItem,
  type HoldoutScenario,
  type OrchestrationCard,
} from "@iskra/contracts";
import { describe, expect, it } from "@effect/vitest";

import { redactHoldouts } from "./HoldoutStore.ts";
import { buildVerifierBrief } from "./verifierBrief.ts";

const card = {
  id: CardId.make("card-health"),
  title: "Health route",
  spec: "Add GET /health.",
  acceptance: {
    state: "confirmed",
    criteria: [
      { id: "c1", text: "GET /health answers 200.", verification: "automated" },
      { id: "c2", text: "It looks right on a phone.", verification: "manual" },
    ],
  },
  evidence: {
    evidenceId: "evidence-1",
    headSha: "abc1234def",
    purpose: "review",
    passed: true,
    checkCount: 1,
    failedChecks: [],
    unavailable: [],
    flags: [],
    flagsAcknowledgedAt: null,
    recordedAt: "2026-01-01T00:00:00.000Z",
  },
} as unknown as OrchestrationCard;

const items: ReadonlyArray<CardEvidenceItem> = [
  {
    itemId: "check-unit",
    kind: "check",
    source: "local",
    name: "unit",
    criterionId: null,
    exitCode: 0,
    timedOut: false,
    durationMs: 10,
    logTail: "ok",
    artifactPath: null,
    unavailable: null,
  },
  {
    itemId: "journey-health",
    kind: "journey",
    source: "local",
    name: "health",
    criterionId: "c1",
    exitCode: 1,
    timedOut: false,
    durationMs: 10,
    logTail: "curl: connection refused",
    artifactPath: null,
    unavailable: null,
  },
];

const scenarios: ReadonlyArray<HoldoutScenario> = [
  {
    scenarioId: "h1",
    title: "Health says ok",
    kind: "text",
    body: "GET /health returns the word ok",
    command: null,
    timeoutMinutes: 5,
  },
  {
    scenarioId: "h2",
    title: "Health is JSON",
    kind: "command",
    body: "",
    command: "node holdout-status.js",
    timeoutMinutes: 5,
  },
];

const brief = buildVerifierBrief({
  agent: { id: AgentId.make("agent-verifier"), name: "verifier-oc", rolePrompt: "" },
  card,
  headSha: "abc1234def",
  baseBranch: "main",
  diff: "diff --git a/api.ts b/api.ts\n+app.get('/health')\n",
  evidenceItems: items,
  scenarios,
  results: [{ scenarioId: "h2", exitCode: 1, timedOut: false, outputTail: "expected JSON, got text" }],
});

describe("buildVerifierBrief", () => {
  it("hands the verifier criteria, evidence, the diff and every hidden scenario with its result", () => {
    expect(brief.firstMessage).toContain("[c1] GET /health answers 200.");
    expect(brief.firstMessage).toContain("leave it out of your verdict");
    expect(brief.firstMessage).toContain("Journey health [journey-health] (local): exit 1");
    expect(brief.firstMessage).toContain("curl: connection refused");
    expect(brief.firstMessage).toContain("+app.get('/health')");
    expect(brief.firstMessage).toContain("[h1] Health says ok: GET /health returns the word ok");
    expect(brief.firstMessage).toContain("Iskra ran `node holdout-status.js` in your checkout; it exited 1.");
    expect(brief.firstMessage).toContain("expected JSON, got text");
    expect(brief.rendered.systemPrompt).toContain("call record_verdict once");
    // Nothing of how the card was built: the brief has no such sections at all.
    for (const title of ["Decisions", "Plan", "Messages", "Questions and answers", "Pull request"]) {
      expect(brief.firstMessage).not.toContain(`## ${title}`);
    }
  });

  it("stores the context with each scenario replaced by its placeholder", () => {
    const stored = JSON.stringify([brief.context, brief.rendered]);
    expect(stored).toContain("[hidden scenario h1]");
    expect(stored).toContain("[hidden scenario h2]");
    for (const secret of ["Health says ok", "returns the word ok", "holdout-status", "expected JSON, got text", "Health is JSON"]) {
      expect(stored).not.toContain(secret);
    }
  });
});

describe("redactHoldouts", () => {
  it("replaces a scenario's quoted title, body or command with its placeholder", () => {
    expect(
      redactHoldouts("Failed: node holdout-status.js printed text; GET /health returns the word ok is false.", scenarios),
    ).toBe("Failed: [hidden scenario h2] printed text; [hidden scenario h1] is false.");
  });
});
