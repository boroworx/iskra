import {
  McpCapabilityUnavailableError,
  PositiveInt,
  TrimmedNonEmptyString,
  WIKI_PAGE_BODY_MAX_CHARS,
  WikiSlug,
} from "@iskra/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

export class WikiSessionRequiredError extends Schema.TaggedError<WikiSessionRequiredError>()(
  "WikiSessionRequiredError",
  {},
) {
  override get message(): string {
    return "Wiki tools work only in an agent's session on a card or in a channel.";
  }
}

/** The decider or the tool refused; its reason is what the agent should read. */
export class WikiCommandRefusedError extends Schema.TaggedError<WikiCommandRefusedError>()(
  "WikiCommandRefusedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class WikiToolFailedError extends Schema.TaggedError<WikiToolFailedError>()(
  "WikiToolFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The wiki could not be read or written.";
  }
}

export const WikiToolError = Schema.Union([
  McpCapabilityUnavailableError,
  WikiSessionRequiredError,
  WikiCommandRefusedError,
  WikiToolFailedError,
]);

const reading = Context.make(Tool.Readonly, true).pipe(
  Context.add(Tool.Destructive, false),
  Context.add(Tool.Idempotent, true),
  Context.add(Tool.OpenWorld, false),
);

const writing = Context.make(Tool.Readonly, false).pipe(
  Context.add(Tool.Destructive, false),
  Context.add(Tool.Idempotent, false),
  Context.add(Tool.OpenWorld, false),
);

const Slug = WikiSlug.annotate({
  description: "The page's name: lowercase words joined by dashes, such as api-rate-limits.",
});

const WikiSearchTool = Tool.make("wiki_search", {
  description:
    "Search this project's wiki, where agents and people keep what they learned about the project: setup gotchas, how a module works, commands that must run, dead ends and why. Search before digging into something unfamiliar, and before writing a page, so you update the page that already exists.",
  parameters: Schema.Struct({
    query: TrimmedNonEmptyString.annotate({
      description: "Words to look for in page names, titles and text.",
    }),
  }),
  success: Schema.Struct({
    pages: Schema.Array(
      Schema.Struct({
        slug: Schema.String,
        title: Schema.String,
        snippet: Schema.String,
        locked: Schema.Boolean,
      }),
    ),
  }),
  failure: WikiToolError,
  dependencies,
})
  .annotate(Tool.Title, "Search the wiki")
  .annotateMerge(reading);

const WikiReadTool = Tool.make("wiki_read", {
  description:
    "Read one page of this project's wiki in full, with its revision. Pass that revision to wiki_write when you update the page.",
  parameters: Schema.Struct({ slug: Slug }),
  success: Schema.Struct({
    slug: Schema.String,
    title: Schema.String,
    body: Schema.String,
    paths: Schema.Array(Schema.String),
    locked: Schema.Boolean,
    revision: Schema.Int,
    updatedAt: Schema.String,
  }),
  failure: WikiToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a wiki page")
  .annotateMerge(reading);

const WikiWriteTool = Tool.make("wiki_write", {
  description:
    "Create or update a page in this project's wiki. Every later agent on the project can read it, and cards touching its paths get it in their brief. Write down what you had to find out the hard way: setup gotchas, how a module works, commands that must run, dead ends and why they failed. Keep pages short and current: update the page that exists (read it first and pass its revision) instead of creating a near-duplicate, and rewrite what is out of date rather than appending. Never store secrets, tokens or credentials. People see who wrote each edit, and can revert it or lock the page.",
  parameters: Schema.Struct({
    slug: Slug,
    title: TrimmedNonEmptyString.annotate({ description: "A short title for the page." }),
    body: Schema.String.annotate({
      description: `The whole page in Markdown, under ${WIKI_PAGE_BODY_MAX_CHARS} characters. It replaces the page's text.`,
    }),
    paths: Schema.optional(
      Schema.Array(TrimmedNonEmptyString).annotate({
        description:
          "Repository globs the page is about, such as src/api/**; cards touching them get the page in their brief, and ** reaches every card. Leave it out to keep an existing page's paths.",
      }),
    ),
    summary: TrimmedNonEmptyString.annotate({
      description: "What this edit changes, in a few words.",
    }),
    revision: Schema.optional(
      PositiveInt.annotate({
        description: "The revision you read with wiki_read. Leave it out only to create a new page.",
      }),
    ),
  }),
  success: Schema.Struct({ slug: Schema.String, revision: Schema.Int }),
  failure: WikiToolError,
  dependencies,
})
  .annotate(Tool.Title, "Write a wiki page")
  .annotateMerge(writing);

/** A project's wiki: every agent session reads it, and the roles that do work write it. */
export const WikiToolkit = Toolkit.make(WikiSearchTool, WikiReadTool, WikiWriteTool);

/** The wiki tools a verifier or critic is allowed, as Claude names them from the `iskra` MCP server. */
export const WIKI_READ_CLAUDE_TOOL_NAMES = ["wiki_search", "wiki_read"].map(
  (name) => `mcp__iskra__${name}`,
);

/** The wiki tools an owner, helper, coordinator or lead is allowed. */
export const WIKI_CLAUDE_TOOL_NAMES = [...WIKI_READ_CLAUDE_TOOL_NAMES, "mcp__iskra__wiki_write"];
