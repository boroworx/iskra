import {
  AgentId,
  CardId,
  ChannelId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCardShell,
  type OrchestrationChannelShell,
  type OrchestrationCommand,
  type OrchestrationRun,
  type ProjectWikiPage,
} from "@iskra/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WIKI_CRITIC_READS_REASON,
  WIKI_VERIFIER_READS_REASON,
  wikiLockedReason,
} from "../../../orchestration/wikiRules.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { WikiToolkitHandlersLive } from "./handlers.ts";
import { WikiToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("run-1");
const CARD_ID = CardId.make("card-limits");
const AGENT_ID = AgentId.make("agent-backend");
const PROJECT_ID = ProjectId.make("project-1");
const CHANNEL_ID = ChannelId.make("channel-requests");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const runAs = (role: OrchestrationRun["role"]) =>
  ({
    threadId: THREAD_ID,
    role,
    channelId: role === "lead" ? CHANNEL_ID : null,
    cardId: role === "lead" ? null : CARD_ID,
    agentId: AGENT_ID,
    triggerMessageId: null,
    capabilities: ["read"],
  }) as unknown as OrchestrationRun;

const page = (slug: string, patch: Partial<ProjectWikiPage> = {}): ProjectWikiPage => ({
  slug,
  title: `Title ${slug}`,
  body: `Body of ${slug}.`,
  paths: ["src/api/**"],
  locked: false,
  revision: 2,
  updatedAt: "2026-03-01T00:00:00.000Z",
  updatedBy: { kind: "agent", agentId: AGENT_ID, cardId: CARD_ID },
  deletedAt: null,
  ...patch,
});

const makeHarness = Effect.fn("makeWikiToolkitHarness")(function* (options: {
  readonly role?: OrchestrationRun["role"];
  readonly pages?: ReadonlyArray<ProjectWikiPage>;
  readonly reject?: (command: OrchestrationCommand) => OrchestrationCommandInvariantError | null;
}) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const pages = options.pages ?? [];
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getRunByThreadId: (threadId) =>
        Effect.succeed(
          threadId === THREAD_ID ? Option.some(runAs(options.role ?? "owner")) : Option.none(),
        ),
      getCardShellById: (cardId) =>
        Effect.succeed(
          cardId === CARD_ID
            ? Option.some({ id: CARD_ID, projectId: PROJECT_ID } as OrchestrationCardShell)
            : Option.none(),
        ),
      getChannelShellById: (channelId) =>
        Effect.succeed(
          channelId === CHANNEL_ID
            ? Option.some({ id: CHANNEL_ID, projectId: PROJECT_ID } as OrchestrationChannelShell)
            : Option.none(),
        ),
      listWikiPages: (projectId) => Effect.succeed(projectId === PROJECT_ID ? pages : []),
      getWikiPage: (projectId, slug) =>
        Effect.succeed(
          Option.fromNullishOr(
            projectId === PROJECT_ID ? pages.find((entry) => entry.slug === slug) : undefined,
          ),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.gen(function* () {
          const rejection = options.reject?.(command) ?? null;
          if (rejection !== null) return yield* rejection;
          yield* Ref.update(commands, (recorded) => [...recorded, command]);
          return { sequence: 1 };
        }),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* WikiToolkit.pipe(
    Effect.provide(WikiToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof WikiToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["wiki"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result as Tool.Success<(typeof WikiToolkit.tools)[Name]>),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: THREAD_ID,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set(capabilities),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  return { commands, call };
});

describe("wiki toolkit handlers", () => {
  it.effect("searches and reads the session's project wiki, never a deleted page", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        pages: [
          page("api-limits", { body: "The rate limiter reads its limits at boot only." }),
          page("setup", { title: "Setup gotchas", body: "Run db:generate first." }),
          page("old-limits", { body: "", deletedAt: "2026-03-02T00:00:00.000Z" }),
        ],
      });
      expect(yield* harness.call("wiki_search", { query: "limits boot" })).toEqual({
        pages: [
          {
            slug: "api-limits",
            title: "Title api-limits",
            snippet: "The rate limiter reads its limits at boot only.",
            locked: false,
          },
        ],
      });
      expect(yield* harness.call("wiki_read", { slug: "setup" }, ["wiki-read"])).toMatchObject({
        title: "Setup gotchas",
        body: "Run db:generate first.",
        revision: 2,
      });
      expect(yield* harness.call("wiki_read", { slug: "old-limits" }).pipe(Effect.flip)).toMatchObject({
        _tag: "WikiCommandRefusedError",
      });
      expect(
        yield* harness.call("wiki_search", { query: "setup" }, ["board"]).pipe(Effect.flip),
      ).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "wiki" });
    }),
  );

  it.effect("writes as the session's agent and card, keeping a page's paths unless given", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ pages: [page("api-limits")] });
      expect(
        yield* harness.call("wiki_write", {
          slug: "api-limits",
          title: "API limits",
          body: "Limits load at boot; restart after editing them.",
          summary: "Say to restart",
          revision: 2,
        }),
      ).toEqual({ slug: "api-limits", revision: 3 });
      yield* harness.call("wiki_write", {
        slug: "setup",
        title: "Setup",
        body: "Run db:generate first.",
        paths: ["**"],
        summary: "New page",
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "project.wiki.agent.write",
          projectId: PROJECT_ID,
          slug: "api-limits",
          paths: ["src/api/**"],
          expectedRevision: 2,
          agentId: AGENT_ID,
          cardId: CARD_ID,
        },
        { type: "project.wiki.agent.write", slug: "setup", paths: ["**"], expectedRevision: 0 },
      ]);

      const lead = yield* makeHarness({ role: "lead" });
      yield* lead.call("wiki_write", { slug: "intake", title: "Intake", body: "x", summary: "New" });
      expect(yield* Ref.get(lead.commands)).toMatchObject([
        { projectId: PROJECT_ID, agentId: AGENT_ID, cardId: null },
      ]);
    }),
  );

  it.effect("verifiers and critics only read, and a refusal's reason reaches the agent", () =>
    Effect.gen(function* () {
      const write = { slug: "notes", title: "Notes", body: "x", summary: "New" } as const;
      for (const [role, reason] of [
        ["verifier", WIKI_VERIFIER_READS_REASON],
        ["critic", WIKI_CRITIC_READS_REASON],
      ] as const) {
        const harness = yield* makeHarness({ role });
        expect(yield* harness.call("wiki_write", write, ["wiki-read"]).pipe(Effect.flip)).toMatchObject({
          _tag: "WikiCommandRefusedError",
          detail: reason,
        });
        expect(yield* Ref.get(harness.commands)).toEqual([]);
      }

      const locked = yield* makeHarness({
        reject: (command) =>
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: wikiLockedReason("notes"),
          }),
      });
      expect(yield* locked.call("wiki_write", write).pipe(Effect.flip)).toMatchObject({
        _tag: "WikiCommandRefusedError",
        detail: wikiLockedReason("notes"),
      });
    }),
  );
});
