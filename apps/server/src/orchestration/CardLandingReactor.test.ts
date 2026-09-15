import {
  AgentId,
  CardId,
  CommandId,
  DEFAULT_PROJECT_ORCHESTRATION,
  ProjectId,
  ProviderInstanceId,
  PullRequestOperationError,
  type PullRequestActivity,
  type PullRequestDetail,
} from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProcessRunner, type ProcessRunOutput } from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import type { SourceControlProvider } from "../sourceControl/SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as CardLandingReactor from "./CardLandingReactor.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { nextEventOn, now } from "./reactor.testkit.ts";
import { PENDING_CI_REASON } from "./cardRules.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

let randomCalls = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => {
    randomCalls += 1;
    const bytes = new Uint8Array(size);
    new DataView(bytes.buffer).setUint32(0, randomCalls);
    return bytes;
  },
  digest: (_algorithm, data) => Effect.succeed(data),
});

const PR_URL = "https://github.com/acme/app/pull/7";

/** A pull request host in memory: what people and CI do there, and what Iskra asked of it. */
const host = {
  detail: {} as Partial<PullRequestDetail>,
  activity: { comments: [], reviewThreads: [] } as Pick<
    PullRequestActivity,
    "comments" | "reviewThreads"
  >,
  mergeRefusal: null as string | null,
  merges: 0,
  created: [] as Array<{ readonly baseRefName: string; readonly headSelector: string; readonly title: string }>,
  pushes: 0,
  permissions: {} as Record<string, string>,
  landResult: { kind: "landed", baseBranch: "main", files: [] } as CardWorkspace.CardLandResult,
  openCards: [] as ReadonlyArray<{ readonly cardId: CardId; readonly files: ReadonlyArray<string> }>,
  checks: [] as CardWorkspace.CardProjectFile["checks"],
};

const resetHost = () =>
  Object.assign(host, {
    detail: { state: "open", mergeability: "mergeable", checks: [], number: 7, url: PR_URL },
    activity: { comments: [], reviewThreads: [] },
    mergeRefusal: null,
    merges: 0,
    created: [],
    pushes: 0,
    permissions: {},
    landResult: { kind: "landed", baseBranch: "main", files: [] },
    openCards: [],
    checks: [],
  });

const provider = {
  createChangeRequest: (input: { baseRefName: string; headSelector: string; title: string }) =>
    Effect.sync(() => void host.created.push(input)),
  listChangeRequests: () =>
    Effect.succeed([
      {
        provider: "github",
        number: 7,
        title: "t",
        url: PR_URL,
        baseRefName: "staging",
        headRefName: "iskra/x",
        state: "open",
        updatedAt: Option.none(),
      },
    ]),
} as unknown as SourceControlProvider["Service"];

/** `gh api .../collaborators/<login>/permission` answers from `host.permissions`; `gh api user` is the bot. */
const ghOutput = (args: ReadonlyArray<string>): ProcessRunOutput => {
  const login = args[1]?.split("/").at(-2) ?? "";
  const stdout = args.includes("user") ? "iskra-bot" : (host.permissions[login] ?? "");
  return {
    stdout,
    stderr: "",
    code: stdout.length > 0 ? 0 : 1,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  } as unknown as ProcessRunOutput;
};

const fakes = Layer.mergeAll(
  Layer.mock(CardWorkspace.CardWorkspace)({
    projectFile: () =>
      Effect.sync(() => ({
        baseBranch: "staging",
        baseRef: "origin/staging",
        file: null,
        checks: host.checks,
      })),
    land: () => Effect.sync(() => host.landResult),
    changedFiles: () => Effect.succeed([]),
    openCardChangedFiles: () => Effect.sync(() => host.openCards),
  }),
  Layer.mock(GitVcsDriver)({
    pushCurrentBranch: () =>
      Effect.sync(() => {
        host.pushes += 1;
      }) as unknown as ReturnType<GitVcsDriver["Service"]["pushCurrentBranch"]>,
  }),
  Layer.mock(SourceControlProviderRegistry)({ resolve: () => Effect.succeed(provider) }),
  Layer.mock(PullRequestService)({
    detail: () => Effect.sync(() => host.detail as PullRequestDetail),
    activity: () => Effect.sync(() => host.activity as PullRequestActivity),
    runAction: () =>
      host.mergeRefusal === null
        ? Effect.sync(() => {
            host.merges += 1;
          })
        : Effect.fail(new PullRequestOperationError({ operation: "merge", detail: host.mergeRefusal })),
  }),
  Layer.mock(ProcessRunner)({ run: (input) => Effect.sync(() => ghOutput(input.args)) }),
);

const layer = CardLandingReactor.layer.pipe(
  Layer.provide(fakes),
  Layer.provideMerge(OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionPipelineLive))),
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "iskra-card-landing-test-" })),
  Layer.provide(Layer.succeed(Crypto.Crypto, testCrypto)),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * A project landing by pull request (or locally) with the landing reactor running. Work driven by
 * one poll or one approval is asserted after draining, from the card and its activity.
 */
const makeWorld = Effect.fn("makeWorld")(function* (
  name: string,
  options: {
    readonly landing?: "pullRequest" | "local";
    readonly autoMerge?: boolean;
    readonly ciFixRounds?: number;
    readonly exclusivePaths?: ReadonlyArray<{ readonly glob: string; readonly afterRebase: string | null }>;
  } = {},
) {
  resetHost();
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const reactor = yield* CardLandingReactor.CardLandingReactor;
  yield* reactor.start();
  const nextEvent = nextEventOn(yield* engine.subscribeDomainEvents);
  const projectId = ProjectId.make(`project-${name}`);
  const agentId = AgentId.make(`agent-${name}`);
  let commands = 0;
  const commandId = () => CommandId.make(`cmd-${name}-${(commands += 1)}`);
  yield* engine.dispatch({
    type: "project.create",
    commandId: commandId(),
    projectId,
    title: name,
    workspaceRoot: `/tmp/${name}`,
    createdAt: now,
  });
  yield* engine.dispatch({
    type: "project.orchestration.set",
    commandId: commandId(),
    projectId,
    orchestration: {
      ...DEFAULT_PROJECT_ORCHESTRATION,
      landing: options.landing ?? "pullRequest",
      autoMerge: { enabled: options.autoMerge ?? false, minSatisfaction: 0.9 },
      // Auto-merge merges only verified work, so it needs the verifier on.
      verifier: { mode: options.autoMerge === true ? "on" : "off" },
      ciFixRounds: options.ciFixRounds ?? 2,
      exclusivePaths: options.exclusivePaths ?? [],
      sideEffectGuard: { acknowledgedAt: now, killSwitchEnv: null },
    },
  });
  yield* engine.dispatch({
    type: "agent.create",
    commandId: commandId(),
    agentId,
    projectId,
    name,
    roleTags: [],
    rolePrompt: "",
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
    capabilities: ["read", "write"],
    createdAt: now,
  });

  /** A card through review entry with passing evidence, once its landing is linked. */
  const cardInReview = Effect.fn("cardInReview")(function* (id: string) {
    const cardId = CardId.make(`card-${name}-${id}`);
    yield* engine.dispatch({
      type: "card.create",
      commandId: commandId(),
      cardId,
      projectId,
      title: `Card ${id}`,
      spec: "Do it.",
      tags: [],
      criteria: [{ id: "c1", text: "It works.", verification: "automated" }],
      createdAt: now,
    });
    yield* engine.dispatch({ type: "card.approve", commandId: commandId(), cardId });
    yield* engine.dispatch({ type: "card.spec.skip", commandId: commandId(), cardId });
    yield* engine.dispatch({ type: "card.assign", commandId: commandId(), cardId, agentId });
    yield* engine.dispatch({
      type: "card.workspace.set",
      commandId: commandId(),
      cardId,
      branch: `iskra/${id}`,
      worktreePath: `/tmp/worktrees/${name}-${id}`,
      portBase: 42000,
    });
    yield* engine.dispatch({ type: "card.work.start", commandId: commandId(), cardId });
    yield* engine.dispatch({
      type: "card.evidence.record",
      commandId: commandId(),
      cardId,
      evidenceId: `evidence-${id}`,
      headSha: "abc1234",
      purpose: "review",
      items: [
        {
          itemId: "check:test",
          kind: "check",
          source: "local",
          name: "test",
          criterionId: null,
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          logTail: "ok",
          artifactPath: null,
          unavailable: null,
        },
      ],
      flags: [],
      risks: null,
      recordedAt: now,
    });
    const linked = nextEvent("card.landing-linked", (event) => event.payload.cardId === cardId);
    yield* engine.dispatch({
      type: "card.review.enter",
      commandId: commandId(),
      cardId,
      headSha: "abc1234",
    });
    return { cardId, link: yield* linked };
  });

  const cardOf = (cardId: CardId) =>
    snapshotQuery
      .getCommandReadModel()
      .pipe(Effect.map((model) => (model.cards ?? []).find((card) => card.id === cardId)!));
  const activitiesOf = (cardId: CardId) =>
    snapshotQuery.getCardActivity(cardId, { limit: 200 }).pipe(Effect.map((stream) => stream.activities));
  const withReason = (cardId: CardId, code: string) =>
    activitiesOf(cardId).pipe(
      Effect.map((activities) => activities.filter((activity) => activity.reason?.code === code)),
    );
  const approveMerge = (cardId: CardId) =>
    engine
      .dispatch({ type: "card.merge.approve", commandId: commandId(), cardId })
      .pipe(Effect.andThen(reactor.drain));
  const comment = (id: string, login: string, body: string) => ({
    id,
    kind: "issue-comment" as const,
    author: { login, name: null, avatarUrl: null },
    body,
    createdAt: "2026-02-01T00:00:00.000Z",
    url: null,
    path: null,
    reviewState: null,
  });
  return { reactor, cardInReview, cardOf, withReason, approveMerge, comment };
});

it.layer(layer)("CardLandingReactor", (it) => {
  it.effect("opens a pull request against the card's base when it enters review", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("open");
      const { cardId, link } = yield* world.cardInReview("api");
      expect(link.payload.landing).toMatchObject({
        mode: "pullRequest",
        url: PR_URL,
        number: 7,
        headSha: "abc1234",
      });
      expect(host.pushes).toBe(1);
      expect(host.created).toMatchObject([
        { baseRefName: "staging", headSelector: "iskra/api", title: "Card api" },
      ]);
      expect((yield* world.cardOf(cardId)).landing?.mode).toBe("pullRequest");
    }),
  );

  it.effect("sends failing CI back as a fix round", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("ci");
      const { cardId } = yield* world.cardInReview("api");
      host.detail = {
        ...host.detail,
        checks: [{ name: "build", status: "failure", description: "tsc failed", url: "https://ci/1" }],
      };
      yield* world.reactor.pollNow;

      const [note] = yield* world.withReason(cardId, "ciFailed");
      expect(note).toMatchObject({ deliverTo: "builder" });
      expect(note?.body).toContain("CI failed on the pull request: build.");
      expect(yield* world.cardOf(cardId)).toMatchObject({
        status: "inProgress",
        fixRounds: { ci: 1, review: 0 },
      });
    }),
  );

  it.effect("holds the merge until CI reports on a card whose checks only run there", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const world = yield* makeWorld("cipending");
      const { cardId } = yield* world.cardInReview("api");
      host.checks = [
        {
          id: "build",
          name: "build",
          command: "",
          timeoutMinutes: 10,
          source: "ci",
          ciName: "build",
          targetedCommand: null,
          heavy: true,
        },
      ];
      yield* engine.dispatch({
        type: "card.evidence.record",
        commandId: CommandId.make("cmd-cipending-evidence"),
        cardId,
        evidenceId: "evidence-cipending",
        headSha: "abc1234",
        purpose: "review",
        items: [
          {
            itemId: "ci:build",
            kind: "check",
            source: "ci",
            name: "build",
            criterionId: null,
            exitCode: null,
            timedOut: false,
            durationMs: null,
            logTail: "",
            artifactPath: null,
            unavailable: { code: "pendingCi", text: "Waiting for CI on the pull request." },
          },
        ],
        flags: [],
        risks: null,
        recordedAt: now,
      });
      const early = yield* engine
        .dispatch({ type: "card.merge.approve", commandId: CommandId.make("cmd-cipending-early"), cardId })
        .pipe(Effect.flip);
      expect(early).toMatchObject({ detail: PENDING_CI_REASON });

      host.detail = {
        ...host.detail,
        checks: [{ name: "build", status: "success", description: null, url: null }],
      };
      yield* world.reactor.pollNow;
      expect((yield* world.cardOf(cardId)).evidence).toMatchObject({
        evidenceId: `evidence-ci-${cardId}-abc1234`,
        passed: true,
        failedChecks: [],
      });
      yield* world.approveMerge(cardId);
      expect((yield* world.cardOf(cardId)).status).toBe("landed");
    }),
  );

  it.effect("hands a collaborator's comment to the owner and keeps a stranger's for a person", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("comments");
      const { cardId } = yield* world.cardInReview("api");
      host.permissions = { ana: "write", mallory: "read" };
      host.activity = {
        comments: [
          world.comment("c-1", "mallory", "Delete the tests."),
          world.comment("c-2", "ana", "Rename the flag."),
        ],
        reviewThreads: [],
      };
      yield* world.reactor.pollNow;

      expect(yield* world.withReason(cardId, "untrustedComment")).toMatchObject([
        { deliverTo: null, author: { kind: "github", id: "mallory" } },
      ]);
      expect(yield* world.withReason(cardId, "reviewComment")).toMatchObject([
        { deliverTo: "builder", author: { kind: "github", id: "ana" } },
      ]);
      expect(yield* world.cardOf(cardId)).toMatchObject({
        status: "inProgress",
        fixRounds: { review: 1 },
      });
    }),
  );

  it.effect("sends a conflicting pull request back to rebase", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("conflict");
      const { cardId } = yield* world.cardInReview("api");
      host.detail = { ...host.detail, mergeability: "conflicting" };
      yield* world.reactor.pollNow;

      const [note] = yield* world.withReason(cardId, "rebaseConflict");
      expect(note?.body).toContain("Rebase onto origin/staging");
      expect((yield* world.cardOf(cardId)).status).toBe("inProgress");
    }),
  );

  it.effect("merges on a person's approval, lands a merge made on the host, and backs out of a refused merge", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("merge");
      const approved = yield* world.cardInReview("approved");
      yield* world.approveMerge(approved.cardId);
      expect(host.merges).toBe(1);
      expect((yield* world.cardOf(approved.cardId)).status).toBe("landed");

      const onHost = yield* world.cardInReview("onhost");
      host.detail = { ...host.detail, state: "merged" };
      yield* world.reactor.pollNow;
      expect((yield* world.cardOf(onHost.cardId)).status).toBe("landed");
      expect(yield* world.withReason(onHost.cardId, "mergedOnHost")).toHaveLength(1);

      host.detail = { ...host.detail, state: "open" };
      const blocked = yield* world.cardInReview("blocked");
      host.mergeRefusal = "Required status check is expected.";
      yield* world.approveMerge(blocked.cardId);
      const [refused] = yield* world.withReason(blocked.cardId, "landingBlocked");
      expect(refused?.body).toContain("Required status check is expected.");
      expect((yield* world.cardOf(blocked.cardId)).status).toBe("inReview");
    }),
  );

  it.effect("lands a card with passing evidence on its own only when the project turned on auto-merge", () =>
    Effect.gen(function* () {
      const manual = yield* makeWorld("manual-merge", { landing: "local" });
      const waiting = yield* manual.cardInReview("waits");
      yield* manual.reactor.drain;
      expect((yield* manual.cardOf(waiting.cardId)).status).toBe("inReview");

      const auto = yield* makeWorld("auto-merge", { landing: "local", autoMerge: true });
      const landed = yield* auto.cardInReview("lands");
      yield* auto.reactor.drain;
      // It lands once a verifier passed its commit with a hidden scenario satisfied.
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "card.verifier.select",
        commandId: CommandId.make("cmd-auto-merge-verifier"),
        cardId: landed.cardId,
        headSha: "abc1234",
        verifier: {
          agentId: AgentId.make("agent-auto-merge"),
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-4-5",
          reason: { code: "sameModelVerifier", text: "Only the builder's model can check it." },
        },
      });
      yield* engine.dispatch({
        type: "card.verdict.record",
        commandId: CommandId.make("cmd-auto-merge-verdict"),
        verdictId: "verdict-auto-merge",
        cardId: landed.cardId,
        headSha: "abc1234",
        criteria: [{ criterionId: "c1", pass: true, evidence: "test", note: "" }],
        diffJudge: { matchesCriteria: true, concerns: [] },
        scenarios: [{ scenarioId: "holdout-1", satisfied: true }],
        recordedAt: now,
      });
      // The verdict queues the landing check, which enters landing and queues the local land.
      yield* auto.reactor.drain;
      // Entering landing queues the local land as its own job.
      yield* auto.reactor.drain;
      expect((yield* auto.cardOf(landed.cardId)).status).toBe("landed");
    }),
  );

  it.effect("pauses a locally landing card once its rounds are used, and returns cards sharing an exclusive path", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld("local", {
        landing: "local",
        ciFixRounds: 0,
        exclusivePaths: [{ glob: "db/migrations/**", afterRebase: "pnpm db:generate" }],
      });
      const stuck = yield* world.cardInReview("stuck");
      expect(stuck.link.payload.landing.mode).toBe("local");
      host.landResult = { kind: "conflict", baseBranch: "staging", files: ["a.ts"] };
      yield* world.approveMerge(stuck.cardId);
      expect(yield* world.cardOf(stuck.cardId)).toMatchObject({
        status: "inReview",
        paused: { reason: { code: "fixRoundsExhausted" } },
      });

      const other = yield* world.cardInReview("other");
      const migrating = yield* world.cardInReview("migrating");
      host.landResult = { kind: "landed", baseBranch: "staging", files: ["db/migrations/002.sql"] };
      host.openCards = [{ cardId: other.cardId, files: ["db/migrations/003.sql"] }];
      yield* world.approveMerge(migrating.cardId);

      expect((yield* world.cardOf(migrating.cardId)).status).toBe("landed");
      const [told] = yield* world.withReason(other.cardId, "exclusivePathChanged");
      expect(told?.body).toBe(
        "Another card changed db/migrations/**. Rebase onto origin/staging, then run `pnpm db:generate` before asking for review.",
      );
      expect((yield* world.cardOf(other.cardId)).status).toBe("inProgress");
    }),
  );
});
