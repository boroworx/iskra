import {
  CardVerdictCriterion,
  CardVerdictDiffJudge,
  CardVerdictScenario,
  McpCapabilityUnavailableError,
  TrimmedNonEmptyString,
} from "@iskra/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { VERIFIER_SESSION_ONLY_REASON } from "../../../orchestration/cardRules.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { WIKI_READ_CLAUDE_TOOL_NAMES } from "../wiki/tools.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

export class VerifierSessionRequiredError extends Schema.TaggedError<VerifierSessionRequiredError>()(
  "VerifierSessionRequiredError",
  {},
) {
  override get message(): string {
    return VERIFIER_SESSION_ONLY_REASON;
  }
}

/** The decider or the tool refused; its reason is what the verifier should read. */
export class VerifierCommandRefusedError extends Schema.TaggedError<VerifierCommandRefusedError>()(
  "VerifierCommandRefusedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class VerifierToolFailedError extends Schema.TaggedError<VerifierToolFailedError>()(
  "VerifierToolFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The verifier tool could not complete.";
  }
}

export const VerifierToolError = Schema.Union([
  McpCapabilityUnavailableError,
  VerifierSessionRequiredError,
  VerifierCommandRefusedError,
  VerifierToolFailedError,
]);

const reading = Context.make(Tool.Readonly, true).pipe(
  Context.add(Tool.Destructive, false),
  Context.add(Tool.Idempotent, true),
  Context.add(Tool.OpenWorld, false),
);

const ItemInput = Schema.Struct({
  itemId: TrimmedNonEmptyString.annotate({
    description: "The evidence item's id, as the brief lists it in brackets.",
  }),
});

const RecordVerdictTool = Tool.make("record_verdict", {
  description:
    "Record your verdict on the commit you were given, once. Give every automated acceptance criterion by its id a pass or fail, the evidence you relied on and a short note; say whether the diff does what the criteria ask, with any concerns; and say for every hidden scenario by its id whether it is satisfied. Iskra decides whether the card passed. Never quote a hidden scenario in a note.",
  parameters: Schema.Struct({
    criteria: Schema.Array(CardVerdictCriterion),
    diffJudge: CardVerdictDiffJudge,
    scenarios: Schema.Array(CardVerdictScenario),
  }),
  success: Schema.Struct({ verdictId: Schema.String }),
  failure: VerifierToolError,
  dependencies,
})
  .annotate(Tool.Title, "Record the verdict")
  .annotateMerge(
    Context.make(Tool.Readonly, false).pipe(
      Context.add(Tool.Destructive, false),
      Context.add(Tool.Idempotent, false),
      Context.add(Tool.OpenWorld, false),
    ),
  );

const ViewEvidenceTool = Tool.make("view_evidence", {
  description:
    "Read one item of the card's latest evidence: a check's or journey's exit and the end of its log, or whether a capture was taken.",
  parameters: ItemInput,
  success: Schema.Struct({
    itemId: Schema.String,
    kind: Schema.String,
    name: Schema.String,
    criterionId: Schema.NullOr(Schema.String),
    exitCode: Schema.NullOr(Schema.Int),
    timedOut: Schema.Boolean,
    logTail: Schema.String,
    unavailable: Schema.NullOr(Schema.String),
  }),
  failure: VerifierToolError,
  dependencies,
})
  .annotate(Tool.Title, "View evidence")
  .annotateMerge(reading);

export const ViewScreenshotTool = Tool.make("view_screenshot", {
  description: "Look at a screenshot from the card's latest evidence (PNG, up to 1 MB).",
  parameters: ItemInput,
  success: Schema.Struct({
    itemId: Schema.String,
    name: Schema.String,
    screenshot: Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Int,
      height: Schema.Int,
    }),
  }),
  failure: VerifierToolError,
  dependencies,
})
  .annotate(Tool.Title, "View a screenshot")
  .annotateMerge(reading);

/** A verifier's tools: they read the card's evidence and record one verdict, nothing else. */
export const VerifierToolkit = Toolkit.make(RecordVerdictTool, ViewEvidenceTool);

/** Registered by hand so the PNG goes out as image content. */
export const VerifierScreenshotToolkit = Toolkit.make(ViewScreenshotTool);

/** The tools a card's verifier session is allowed, as Claude names them from the `iskra` MCP server. */
export const VERIFIER_CLAUDE_TOOL_NAMES = [
  ...["record_verdict", "view_evidence", "view_screenshot"].map((name) => `mcp__iskra__${name}`),
  // A verifier reads the wiki and never writes it, so hidden scenarios can't reach a shared page.
  ...WIKI_READ_CLAUDE_TOOL_NAMES,
];
