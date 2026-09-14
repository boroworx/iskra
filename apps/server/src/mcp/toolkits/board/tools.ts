import {
  CardEstimate,
  CardPremise,
  CardRiskClaims,
  McpCapabilityUnavailableError,
  TrimmedNonEmptyString,
} from "@iskra/contracts";
import * as Context from "effect/Context";
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

export class LeadSessionRequiredError extends Schema.TaggedError<LeadSessionRequiredError>()(
  "LeadSessionRequiredError",
  {},
) {
  override get message(): string {
    return "Lead tools work only in a channel lead's session.";
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
  LeadSessionRequiredError,
  BoardCommandRefusedError,
  BoardToolFailedError,
]);

const PlanStepStatus = Schema.Literals(["pending", "inProgress", "completed"]);

/** One acceptance criterion as an agent writes it; Iskra numbers them. */
export const CriterionInput = Schema.Struct({
  text: TrimmedNonEmptyString.annotate({
    description: "An outcome a person can observe when the work is done, such as a page or a response.",
  }),
  verification: Schema.optional(
    Schema.Literals(["automated", "manual"]).annotate({
      description:
        "manual when only a person can check it, such as mobile or device-only behavior. Defaults to automated.",
    }),
  ),
});

/** Two or three answers a person picks from; they can always write their own. */
const AnswerOptions = Schema.Array(TrimmedNonEmptyString)
  .check(Schema.isMinLength(2), Schema.isMaxLength(3))
  .annotate({ description: "Two or three short answers to pick from." });

/** Board tools only record on Iskra's board: they destroy nothing and reach nothing outside it. */
const boardToolAnnotations = Context.make(Tool.Readonly, false).pipe(
  Context.add(Tool.Destructive, false),
  Context.add(Tool.Idempotent, false),
  Context.add(Tool.OpenWorld, false),
);

const ProposeCardTool = Tool.make("propose_card", {
  description:
    "Propose a new card for work you found that is outside this card. It enters triage, where a person approves or drops it. A sub-card is a part of this card: it skips triage and you own it, so give it acceptance criteria.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString.annotate({ description: "A short, specific title." }),
    spec: Schema.String.annotate({
      description: "What the work is and why it is needed, in plain language.",
    }),
    tags: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    criteria: Schema.optional(
      Schema.Array(CriterionInput).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
    ),
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
  .annotateMerge(boardToolAnnotations);

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
  .annotateMerge(boardToolAnnotations);

const UpdatePlanTool = Tool.make("update_plan", {
  description:
    "Replace this card's plan with the given steps. The current step shows on the card's face. Send the whole plan each time.",
  parameters: Schema.Struct({
    steps: Schema.Array(Schema.Struct({ step: TrimmedNonEmptyString, status: PlanStepStatus })),
  }),
  success: Schema.Struct({ completedSteps: Schema.Int, totalSteps: Schema.Int }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update the plan")
  .annotateMerge(boardToolAnnotations)
  .annotate(Tool.Idempotent, true);

const RequestReviewTool = Tool.make("request_review", {
  description:
    "Ask for review once the work is done and committed in its worktree. Iskra then commits leftovers, rebases, runs the project's checks and captures evidence; the card enters review only if they pass, otherwise the failures come back as your next message. End your turn after asking.",
  parameters: Schema.Struct({
    summary: TrimmedNonEmptyString.annotate({
      description: "What changed and how it meets each acceptance criterion.",
    }),
    risks: CardRiskClaims.annotate({
      description:
        "Your own claims about the change's side effects, performance and compatibility risks. People read them as claims, not evidence.",
    }),
  }),
  success: Schema.Struct({}),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Request review")
  .annotateMerge(boardToolAnnotations);

const RequestCheckpointTool = Tool.make("request_checkpoint", {
  description:
    "Show a person your work so far before going further, when a wrong direction would be costly. Iskra captures the checks and preview as evidence and asks them to continue, redirect or stop; their answer arrives as your next message, so end your turn after asking.",
  parameters: Schema.Struct({
    whatToTry: TrimmedNonEmptyString.annotate({
      description: "What the person should look at or try in the current work.",
    }),
    question: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "A specific question, if you have one." }),
    ),
  }),
  success: Schema.Struct({ checkpointId: Schema.String }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Request a checkpoint")
  .annotateMerge(boardToolAnnotations);

const AskOwnerTool = Tool.make("ask_owner", {
  description:
    "Ask the person who requested the card a question you cannot answer from the spec, criteria, decisions or code. Offer two or three answers and recommend one when you can. This returns at once; the answer arrives later as your next message, so end your turn after asking.",
  parameters: Schema.Struct({
    question: TrimmedNonEmptyString,
    options: Schema.optional(AnswerOptions),
    recommended: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "The option you recommend, exactly as offered." }),
    ),
  }),
  success: Schema.Struct({ requestId: Schema.String }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Ask the owner")
  .annotateMerge(boardToolAnnotations);

const ProposeCriteriaChangeTool = Tool.make("propose_criteria_change", {
  description:
    "Propose different acceptance criteria when the confirmed ones are wrong or can't be met as written. Only a person applies the change; keep working to the current criteria until they do.",
  parameters: Schema.Struct({
    criteria: Schema.Array(CriterionInput).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
    reason: TrimmedNonEmptyString.annotate({ description: "Why the current criteria should change." }),
  }),
  success: Schema.Struct({ proposalId: Schema.String }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Propose a criteria change")
  .annotateMerge(boardToolAnnotations);

const ProposeTriageCardTool = Tool.make("propose_triage_card", {
  description:
    "Propose a card for work the message you were woken by asks for. It enters triage linked to that message, with your reasoning, acceptance criteria, estimate and the open cards it likely duplicates; a person confirms the criteria and decides what happens to it.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString.annotate({ description: "A short, specific title." }),
    spec: Schema.String.annotate({ description: "What the work is, in plain language." }),
    reasoning: TrimmedNonEmptyString.annotate({
      description: "Why this message calls for this card, and how it differs from open cards.",
    }),
    criteria: Schema.Array(CriterionInput)
      .check(Schema.isMinLength(2), Schema.isMaxLength(5))
      .annotate({ description: "Two to five observable outcomes the work is held to." }),
    estimate: CardEstimate.annotate({
      description:
        "Size S, M, L or XL, the areas of the code it likely touches, its risks, and a split into smaller cards when it is too big for one.",
    }),
    premise: CardPremise.annotate({
      description:
        "The requester's goal and whether this card gets them there. When it doesn't, ask_clarification instead of proposing.",
    }),
    likelyDuplicateCardIds: Schema.optional(
      Schema.Array(TrimmedNonEmptyString).annotate({
        description: "Ids of open cards that may already cover this work.",
      }),
    ),
    suggestedAgent: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "The name of the channel member best suited to own the card. A person confirms it when they start the work.",
      }),
    ),
    tags: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  }),
  success: Schema.Struct({ cardId: Schema.String }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Propose a triage card")
  .annotateMerge(boardToolAnnotations);

const AskClarificationTool = Tool.make("ask_clarification", {
  description:
    "Ask the requester one clarifying question in the channel, with two or three answers they can pick and the one you recommend. Their answer wakes you again; end your turn without replying after asking.",
  parameters: Schema.Struct({
    question: TrimmedNonEmptyString,
    options: AnswerOptions,
    recommended: TrimmedNonEmptyString.annotate({
      description: "The option you recommend, exactly as offered.",
    }),
  }),
  success: Schema.Struct({ messageId: Schema.String }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Ask a clarifying question")
  .annotateMerge(boardToolAnnotations);

/** Tools create commands only: none of them approves, assigns, moves or lands a card. */
export const BoardToolkit = Toolkit.make(
  ProposeCardTool,
  RecordDecisionTool,
  UpdatePlanTool,
  RequestReviewTool,
  RequestCheckpointTool,
  AskOwnerTool,
  ProposeCriteriaChangeTool,
  ProposeTriageCardTool,
  AskClarificationTool,
);

const claudeToolNames = (names: ReadonlyArray<keyof typeof BoardToolkit.tools>) =>
  names.map((name) => `mcp__iskra__${name}`);

/** The tools a card's owner session is allowed, as Claude names them from the `iskra` MCP server. */
export const BOARD_CLAUDE_TOOL_NAMES = claudeToolNames([
  "propose_card",
  "record_decision",
  "update_plan",
  "request_review",
  "request_checkpoint",
  "ask_owner",
  "propose_criteria_change",
]);

/** A channel lead proposes cards and asks clarifying questions, nothing else. */
export const LEAD_CLAUDE_TOOL_NAMES = claudeToolNames(["propose_triage_card", "ask_clarification"]);
