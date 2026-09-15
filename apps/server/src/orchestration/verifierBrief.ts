import type {
  CardBriefPayload,
  CardEvidenceItem,
  HoldoutScenario,
  OrchestrationAgent,
  OrchestrationCard,
  RenderedRunContext,
} from "@iskra/contracts";

import { CARD_BRIEF_DIFF_LIMIT, renderCardBrief } from "./cardBrief.ts";
import { hiddenScenarioPlaceholder } from "./HoldoutStore.ts";

const EVIDENCE_TAIL_LIMIT = 2_000;
const HOLDOUT_OUTPUT_LIMIT = 2_000;

/** What running a command scenario in the verifier's snapshot showed. */
export interface HoldoutCommandResult {
  readonly scenarioId: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputTail: string;
}

const tail = (text: string, limit: number) =>
  text.length > limit ? `…${text.slice(text.length - limit)}` : text;

const fenced = (text: string) => `\`\`\`\n${text.trimEnd()}\n\`\`\``;

function renderScenario(
  scenario: HoldoutScenario,
  result: HoldoutCommandResult | undefined,
): string {
  if (scenario.kind === "text") {
    return `- [${scenario.scenarioId}] ${scenario.title}: ${scenario.body}`;
  }
  const outcome =
    result === undefined
      ? "did not run."
      : result.timedOut
        ? "timed out."
        : `exited ${result.exitCode ?? "without a code"}.`;
  return [
    `- [${scenario.scenarioId}] ${scenario.title}${scenario.body.trim().length > 0 ? `: ${scenario.body}` : ""}`,
    `  Iskra ran \`${scenario.command}\` in your checkout; it ${outcome}`,
    ...(result === undefined || result.outputTail.trim().length === 0
      ? []
      : [fenced(tail(result.outputTail, HOLDOUT_OUTPUT_LIMIT))]),
  ].join("\n");
}

/**
 * The verifier's brief: the criteria, the spec, the latest evidence, the diff and the hidden
 * scenarios, and nothing of how the card was built (no decisions, plan, messages, transcript or
 * risk claims). Pure. `context` and `rendered` are what the run stores, with every scenario
 * replaced by its placeholder because the context inspector shows stored contexts; `firstMessage`
 * is the one the verifier's turn is sent with, scenarios in full.
 */
export function buildVerifierBrief(input: {
  readonly agent: Pick<OrchestrationAgent, "id" | "name" | "rolePrompt">;
  readonly card: Pick<OrchestrationCard, "id" | "title" | "spec" | "acceptance" | "evidence">;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly diff: string;
  readonly evidenceItems: ReadonlyArray<CardEvidenceItem>;
  readonly scenarios: ReadonlyArray<HoldoutScenario>;
  readonly results: ReadonlyArray<HoldoutCommandResult>;
}): { readonly context: CardBriefPayload; readonly rendered: RenderedRunContext; readonly firstMessage: string } {
  const { card } = input;
  const diffTruncated = input.diff.length > CARD_BRIEF_DIFF_LIMIT;
  const diff = diffTruncated ? input.diff.slice(0, CARD_BRIEF_DIFF_LIMIT) : input.diff;

  const criteria = card.acceptance.criteria
    .map(
      (criterion) =>
        `- [${criterion.id}] ${criterion.text}${criterion.verification === "manual" ? " (a person checks this one; leave it out of your verdict)" : ""}`,
    )
    .join("\n");

  const evidence = card.evidence;
  const evidenceBody =
    evidence === null
      ? "No evidence was captured."
      : [
          `Captured on ${evidence.headSha.slice(0, 7)}: ${evidence.passed ? "passed" : "failed"}.`,
          ...input.evidenceItems.map((item) => {
            if (item.kind === "check" || item.kind === "journey") {
              const passed = item.exitCode === 0 && !item.timedOut;
              return `- ${item.kind === "journey" ? "Journey" : "Check"} ${item.name} [${item.itemId}] (${item.source}): ${item.timedOut ? "timed out" : `exit ${item.exitCode ?? "none"}`}${passed || item.logTail.trim().length === 0 ? "" : `\n${fenced(tail(item.logTail, EVIDENCE_TAIL_LIMIT))}`}`;
            }
            return `- ${item.kind === "screenshot" ? "Screenshot" : "Recording"} ${item.name} [${item.itemId}]${item.criterionId === null ? "" : ` for ${item.criterionId}`}: ${item.unavailable === null ? "captured; open it with view_screenshot" : `not captured (${item.unavailable.text})`}`;
          }),
          ...evidence.flags.map(
            (flag) =>
              `- Scope flag${flag.hard ? " (needs a person)" : ""}: ${flag.kind} ${flag.path}${flag.detail.length > 0 ? `: ${flag.detail}` : ""}`,
          ),
        ].join("\n");

  const changes =
    diff.trim().length === 0
      ? "No changes against the base."
      : [
          `\`\`\`diff\n${diff.trimEnd()}\n\`\`\``,
          diffTruncated ? "The diff was cut short; run `git diff` in your checkout for the rest." : "",
        ]
          .filter((part) => part.length > 0)
          .join("\n\n");

  const scenarioSection = (reveal: boolean) =>
    input.scenarios.length === 0
      ? ""
      : [
          "Each must hold for the card to pass. Say for each whether it is satisfied.",
          ...input.scenarios.map((scenario) =>
            reveal
              ? renderScenario(
                  scenario,
                  input.results.find((result) => result.scenarioId === scenario.scenarioId),
                )
              : `- ${hiddenScenarioPlaceholder(scenario.scenarioId)}`,
          ),
        ].join("\n");

  const payload = (reveal: boolean): CardBriefPayload => ({
    agent: { id: input.agent.id, name: input.agent.name, rolePrompt: input.agent.rolePrompt },
    role: "verifier",
    card: { id: card.id, title: card.title, spec: card.spec, branch: null, baseBranch: input.baseBranch },
    decisions: [],
    diff,
    diffTruncated,
    question: null,
    sections: [
      { title: "Commit", body: `You are checking commit ${input.headSha}.` },
      { title: "Acceptance criteria", body: criteria },
      { title: "Spec", body: card.spec.trim().length === 0 ? "No spec." : card.spec.trim() },
      { title: "Evidence", body: evidenceBody },
      { title: "Changes", body: changes },
      { title: "Hidden scenarios", body: scenarioSection(reveal) },
      {
        title: "Your verdict",
        body: "Call record_verdict once with a result, the evidence you relied on and a note for every automated criterion, whether the diff matches the criteria with any concerns, and whether each hidden scenario is satisfied.",
      },
    ].filter((section) => section.body.trim().length > 0),
  });

  const context = payload(false);
  return {
    context,
    rendered: renderCardBrief(context),
    firstMessage: renderCardBrief(payload(true)).firstMessage,
  };
}
