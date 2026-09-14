import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@iskra/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadPlanProgressService } from "../../../orchestration/ThreadPlanProgress.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ThreadPlanProgressService,
];

export class BoardSessionRequiredError extends Schema.TaggedError<BoardSessionRequiredError>()(
  "BoardSessionRequiredError",
  {},
) {
  override get message(): string {
    return "Board tools work only in the session building a card.";
  }
}

/** The decider refused the command; its reason is what the agent should read. */
export class BoardCommandRefusedError extends Schema.TaggedError<BoardCommandRefusedError>()(
  "BoardCommandRefusedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class BoardToolFailedError extends Schema.TaggedError<BoardToolFailedError>()(
  "BoardToolFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The board could not be updated.";
  }
}

export const BoardToolError = Schema.Union([
  McpCapabilityUnavailableError,
  BoardSessionRequiredError,
  BoardCommandRefusedError,
  BoardToolFailedError,
]);

export const PlanStepStatus = Schema.Literals(["pending", "inProgress", "completed"]);

const ProposeCardTool = Tool.make("propose_card", {
  description:
    "Propose a new card for work you found that is outside this card. It enters triage, where a person approves or drops it; it is never assigned or started by proposing it.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString.annotate({ description: "A short, specific title." }),
    spec: Schema.String.annotate({
      description: "What the work is and why it is needed, in plain language.",
    }),
    tags: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    subCard: Schema.optional(
      Schema.Boolean.annotate({
        description: "True when the work is a part of this card rather than separate from it.",
      }),
    ),
  }),
  success: Schema.Struct({ cardId: Schema.String }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Propose a card")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const RecordDecisionTool = Tool.make("record_decision", {
  description:
    "Record a decision you made on this card and why, such as a chosen approach or a rejected alternative. Decisions are shown to people and handed to every later session on the card.",
  parameters: Schema.Struct({
    text: TrimmedNonEmptyString.annotate({ description: "The decision and its reason." }),
  }),
  success: Schema.Struct({ decisionId: Schema.String }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Record a decision")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const UpdatePlanTool = Tool.make("update_plan", {
  description:
    "Replace this card's plan with the given steps. The current step shows on the card's face. Send the whole plan each time.",
  parameters: Schema.Struct({
    steps: Schema.Array(
      Schema.Struct({ step: TrimmedNonEmptyString, status: PlanStepStatus }),
    ),
  }),
  success: Schema.Struct({ completedSteps: Schema.Int, totalSteps: Schema.Int }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update the plan")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RequestReviewTool = Tool.make("request_review", {
  description:
    "Send this card to review once the work is done and committed in its worktree. Checks then run, and a person approves the merge.",
  success: Schema.Struct({}),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Request review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const AskOwnerTool = Tool.make("ask_owner", {
  description:
    "Ask the card's owner a question you cannot answer from the spec, decisions or code. This returns at once; the answer arrives later as your next message, so end your turn after asking.",
  parameters: Schema.Struct({
    question: TrimmedNonEmptyString,
    options: Schema.optional(
      Schema.Array(TrimmedNonEmptyString).annotate({
        description: "Suggested answers. The owner can always write their own.",
      }),
    ),
  }),
  success: Schema.Struct({ requestId: Schema.String }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Ask the owner")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/** Tools create commands only: none of them approves, assigns or lands a card. */
export const BoardToolkit = Toolkit.make(
  ProposeCardTool,
  RecordDecisionTool,
  UpdatePlanTool,
  RequestReviewTool,
  AskOwnerTool,
);

/** How Claude names the board tools once they are served as the `iskra` MCP server. */
export const BOARD_CLAUDE_TOOL_NAMES = Object.keys(BoardToolkit.tools).map(
  (name) => `mcp__iskra__${name}`,
);
