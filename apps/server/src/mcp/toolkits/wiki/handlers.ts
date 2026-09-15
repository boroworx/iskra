import { CommandId, type OrchestrationCommand } from "@iskra/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  searchWikiPages,
  WIKI_CRITIC_READS_REASON,
  WIKI_VERIFIER_READS_REASON,
} from "../../../orchestration/wikiRules.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  WikiCommandRefusedError,
  WikiSessionRequiredError,
  WikiToolFailedError,
  WikiToolkit,
} from "./tools.ts";

/** The most pages one search returns. */
export const WIKI_SEARCH_LIMIT = 10;

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const failed = (cause: unknown) => new WikiToolFailedError({ cause });

  /**
   * The project, agent and card always come from the run behind the credential, never from the
   * tool's input: a card's session writes to its card's project, a lead to its channel's.
   */
  const requireSession = Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const scope = yield* McpInvocationContext.requireMcpCapability(
      invocation.capabilities.has("wiki-read") ? "wiki-read" : "wiki",
    );
    const run = yield* snapshots.getRunByThreadId(scope.threadId).pipe(Effect.mapError(failed));
    if (Option.isNone(run)) return yield* new WikiSessionRequiredError({});
    const { cardId, channelId } = run.value;
    const projectId =
      cardId !== null
        ? Option.map(
            yield* snapshots.getCardShellById(cardId).pipe(Effect.mapError(failed)),
            (card) => card.projectId,
          )
        : channelId !== null
          ? Option.map(
              yield* snapshots.getChannelShellById(channelId).pipe(Effect.mapError(failed)),
              (channel) => channel.projectId,
            )
          : Option.none();
    if (Option.isNone(projectId)) return yield* new WikiSessionRequiredError({});
    return {
      threadId: scope.threadId,
      role: run.value.role,
      agentId: run.value.agentId,
      cardId,
      projectId: projectId.value,
    };
  });

  const dispatch = (command: OrchestrationCommand) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.mapError((error) =>
        error._tag === "OrchestrationCommandInvariantError"
          ? new WikiCommandRefusedError({ detail: error.detail })
          : failed(error),
      ),
    );

  return WikiToolkit.of({
    wiki_search: (input) =>
      Effect.gen(function* () {
        const session = yield* requireSession;
        const pages = yield* snapshots.listWikiPages(session.projectId).pipe(Effect.mapError(failed));
        return {
          pages: searchWikiPages(pages, input.query, WIKI_SEARCH_LIMIT).map((page) => ({
            slug: page.slug,
            title: page.title,
            snippet: page.snippet ?? "",
            locked: page.locked,
          })),
        };
      }),
    wiki_read: (input) =>
      Effect.gen(function* () {
        const session = yield* requireSession;
        const page = yield* snapshots
          .getWikiPage(session.projectId, input.slug)
          .pipe(Effect.mapError(failed));
        if (Option.isNone(page) || page.value.deletedAt !== null) {
          return yield* new WikiCommandRefusedError({
            detail: `This project has no wiki page "${input.slug}". Search with wiki_search, or create it with wiki_write.`,
          });
        }
        const { slug, title, body, paths, locked, revision, updatedAt } = page.value;
        return { slug, title, body, paths, locked, revision, updatedAt };
      }),
    // Verifiers and critics read only; what a verifier knows of hidden scenarios never reaches a page.
    wiki_write: (input) =>
      Effect.gen(function* () {
        const session = yield* requireSession;
        if (session.role === "verifier" || session.role === "critic") {
          return yield* new WikiCommandRefusedError({
            detail:
              session.role === "verifier" ? WIKI_VERIFIER_READS_REASON : WIKI_CRITIC_READS_REASON,
          });
        }
        yield* McpInvocationContext.requireMcpCapability("wiki");
        const page = yield* snapshots
          .getWikiPage(session.projectId, input.slug)
          .pipe(Effect.mapError(failed));
        const live = Option.filter(page, (current) => current.deletedAt === null);
        yield* dispatch({
          type: "project.wiki.agent.write",
          commandId: CommandId.make(`server:mcp-wiki-write:${session.threadId}:${yield* uuid}`),
          projectId: session.projectId,
          slug: input.slug,
          title: input.title,
          body: input.body,
          paths: input.paths ?? Option.match(live, { onNone: () => [], onSome: (current) => current.paths }),
          summary: input.summary,
          expectedRevision: input.revision ?? 0,
          agentId: session.agentId,
          cardId: session.cardId,
        });
        return {
          slug: input.slug,
          revision: Option.match(page, { onNone: () => 1, onSome: (current) => current.revision + 1 }),
        };
      }),
  });
});

export const WikiToolkitHandlersLive = WikiToolkit.toLayer(make);
