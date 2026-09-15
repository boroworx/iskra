import {
  McpCapabilityUnavailableError,
  PositiveInt,
  ProjectLesson,
  TrimmedNonEmptyString,
} from "@iskra/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CriterionInput } from "../board/tools.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

export class CoordinatorSessionRequiredError extends Schema.TaggedError<CoordinatorSessionRequiredError>()(
  "CoordinatorSessionRequiredError",
  {},
) {
  override get message(): string {
    return "Coordinator tools work only in a plan card's coordinator session.";
  }
}

/** The decider or the tool refused; its reason is what the coordinator should read. */
export class CoordinatorCommandRefusedError extends Schema.TaggedError<CoordinatorCommandRefusedError>()(
  "CoordinatorCommandRefusedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class CoordinatorToolFailedError extends Schema.TaggedError<CoordinatorToolFailedError>()(
  "CoordinatorToolFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The coordinator tool could not complete.";
  }
}

export const CoordinatorToolError = Schema.Union([
  McpCapabilityUnavailableError,
  CoordinatorSessionRequiredError,
  CoordinatorCommandRefusedError,
  CoordinatorToolFailedError,
]);

const writing = Context.make(Tool.Readonly, false).pipe(
  Context.add(Tool.Destructive, false),
  Context.add(Tool.Idempotent, false),
  Context.add(Tool.OpenWorld, false),
);

const ChildKey = TrimmedNonEmptyString.annotate({ description: "The child's key in your plan." });

const PlanChildInput = Schema.Struct({
  key: TrimmedNonEmptyString.annotate({
    description:
      "A short key unique in the plan, such as api or ui; other children name it in dependsOn.",
  }),
  title: TrimmedNonEmptyString,
  spec: Schema.String.annotate({
    description: "What the builder does, with the context it needs to start.",
  }),
  criteria: Schema.Array(CriterionInput),
  suggestedAgent: Schema.optional(
    Schema.NullOr(TrimmedNonEmptyString).annotate({
      description: "The builder's name from your brief; leave it out for a person to assign one.",
    }),
  ),
  dependsOn: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).annotate({
      description: "Keys of children that must land first.",
    }),
  ),
  slice: Schema.optional(
    PositiveInt.annotate({
      description:
        "1 for the first batch of work; a person checks in before each later slice. Defaults to 1.",
    }),
  ),
});

const ProposePlanTool = Tool.make("propose_plan", {
  description:
    "Propose the plan: the child cards the goal breaks into, each with acceptance criteria, its builder, what it depends on and its slice. A person approves it or redirects you; a new proposal replaces the last.",
  parameters: Schema.Struct({
    premise: Schema.String.annotate({
      description: "Why the work splits this way, in a few sentences.",
    }),
    children: Schema.Array(PlanChildInput),
  }),
  success: Schema.Struct({}),
  failure: CoordinatorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Propose the plan")
  .annotateMerge(writing);

const ReadChildWorklogTool = Tool.make("read_child_worklog", {
  description:
    "Read what happened on one of your plan's children: its criteria, decisions, questions and messages.",
  parameters: Schema.Struct({ childKey: ChildKey }),
  success: Schema.Struct({ worklog: Schema.String }),
  failure: CoordinatorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a child's worklog")
  .annotateMerge(
    Context.make(Tool.Readonly, true).pipe(
      Context.add(Tool.Destructive, false),
      Context.add(Tool.Idempotent, true),
      Context.add(Tool.OpenWorld, false),
    ),
  );

const MessageChildTool = Tool.make("message_child", {
  description:
    "Send a message to the builder of one of your plan's children; it reads it on its next turn.",
  parameters: Schema.Struct({ childKey: ChildKey, body: TrimmedNonEmptyString }),
  success: Schema.Struct({}),
  failure: CoordinatorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message a child's builder")
  .annotateMerge(writing);

const PauseChildTool = Tool.make("pause_child", {
  description:
    "Pause one of your plan's children that is going wrong, saying why. A person resumes it.",
  parameters: Schema.Struct({ childKey: ChildKey, reason: TrimmedNonEmptyString }),
  success: Schema.Struct({}),
  failure: CoordinatorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Pause a child")
  .annotateMerge(writing);

const AskPlanOwnerTool = Tool.make("ask_plan_owner", {
  description:
    "Ask a person a question about the plan, with two or three answers to pick from and the one you recommend. Their answer comes back to you.",
  parameters: Schema.Struct({
    question: TrimmedNonEmptyString,
    options: Schema.Array(TrimmedNonEmptyString).check(
      Schema.isMinLength(2),
      Schema.isMaxLength(3),
    ),
    recommended: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({}),
  failure: CoordinatorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Ask the plan's owner")
  .annotateMerge(writing);

const ProposePlanLessonTool = Tool.make("propose_plan_lesson", {
  description:
    "Suggest a lesson later work in this project should know: a quirk of the repository or a playbook that worked. A person approves it before any agent sees it.",
  parameters: Schema.Struct({
    kind: ProjectLesson.fields.kind,
    text: TrimmedNonEmptyString,
    paths: Schema.Array(TrimmedNonEmptyString).annotate({
      description: "Repository globs the lesson is about; empty for the whole project.",
    }),
  }),
  success: Schema.Struct({ lessonId: Schema.String }),
  failure: CoordinatorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Propose a lesson")
  .annotateMerge(writing);

/** A plan card's coordinator: it plans and steers its own plan's children, and reads, nothing else. */
export const CoordinatorToolkit = Toolkit.make(
  ProposePlanTool,
  ReadChildWorklogTool,
  MessageChildTool,
  PauseChildTool,
  AskPlanOwnerTool,
  ProposePlanLessonTool,
);

/** The tools a coordinator session is allowed, as Claude names them from the `iskra` MCP server. */
export const COORDINATOR_CLAUDE_TOOL_NAMES = Object.keys(CoordinatorToolkit.tools).map(
  (name) => `mcp__iskra__${name}`,
);
