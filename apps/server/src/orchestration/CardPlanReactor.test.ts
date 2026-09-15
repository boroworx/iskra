import {
  AgentId,
  CardId,
  CommandId,
  DEFAULT_PROJECT_ORCHESTRATION,
  ProjectId,
  ProviderInstanceId,
  type CardPlan,
  type PullRequestActivity,
  type PullRequestDetail,
} from "@iskra/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import type { SourceControlProvider } from "../sourceControl/SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { REVIEW_REQUESTED_CODE } from "./CardEvidence.ts";
import * as CardLandingReactor from "./CardLandingReactor.ts";
import * as CardPlanReactor from "./CardPlanReactor.ts";
import { PLAN_DIGEST_CODE, planStep } from "./CardPlanReactor.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import { cardWorkspaceTestLayer, makeGitRepo, nextEventOn, now } from "./reactor.testkit.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const plan = (
  currentSlice: number,
  slices: ReadonlyArray<number>,
  state: CardPlan["state"] = "approved",
) =>
  ({
    state,
    revision: 1,
    proposalActivityId: null,
    premise: "",
    children: slices.map((slice, index) => ({
      key: `c${index + 1}`,
      title: `Child ${index + 1}`,
      spec: "",
      criteria: [],
      suggestedAgent: null,
      dependsOn: [],
      slice,
    })),
    integrationBranch: "iskra/plan-x",
    currentSlice,
    approvedAt: now,
  }) satisfies CardPlan;

describe("planStep", () => {
  it.each([
    ["waits before approval", plan(1, [1, 2], "proposed"), [{ slice: 1, status: "landed" }], null],
    ["waits with no children yet", plan(1, [1]), [], null],
    [
      "waits while the current slice still works",
      plan(1, [1, 1, 2]),
      [
        { slice: 1, status: "landed" },
        { slice: 1, status: "inReview" },
        { slice: 2, status: "ready" },
      ],
      null,
    ],
    [
      "asks about the next slice once the current one finished",
      plan(1, [1, 1, 2]),
      [
        { slice: 1, status: "landed" },
        { slice: 1, status: "abandoned" },
        { slice: 2, status: "ready" },
      ],
      { kind: "checkpoint", slice: 1, next: 2 },
    ],
    [
      "skips an empty slice number",
      plan(1, [1, 3]),
      [
        { slice: 1, status: "landed" },
        { slice: 3, status: "ready" },
      ],
      { kind: "checkpoint", slice: 1, next: 3 },
    ],
    [
      "goes to review once the last slice finished",
      plan(2, [1, 2]),
      [
        { slice: 1, status: "landed" },
        { slice: 2, status: "abandoned" },
      ],
      { kind: "review" },
    ],
    [
      "waits while the last slice works",
      plan(2, [1, 2]),
      [
        { slice: 1, status: "landed" },
        { slice: 2, status: "inProgress" },
      ],
      null,
    ],
  ] as const)("%s", (_name, current, children, expected) => {
    expect(planStep(current, children)).toEqual(expected);
  });
});

const host = {
  created: [] as Array<{ readonly baseRefName: string; readonly headSelector: string }>,
};

const provider = {
  createChangeRequest: (input: { baseRefName: string; headSelector: string }) =>
    Effect.sync(
      () =>
        void host.created.push({
          baseRefName: input.baseRefName,
          headSelector: input.headSelector,
        }),
    ),
  listChangeRequests: () =>
    Effect.succeed([
      {
        provider: "github",
        number: 9,
        title: "Health and version",
        url: "https://github.com/acme/app/pull/9",
        baseRefName: "main",
        headRefName: "iskra/plan",
        state: "open",
        updatedAt: Option.none(),
      },
    ]),
} as unknown as SourceControlProvider["Service"];

const layer = Layer.mergeAll(CardPlanReactor.layer, CardLandingReactor.layer).pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(GitVcsDriver)({
        pushCurrentBranch: () =>
          Effect.void as unknown as ReturnType<GitVcsDriver["Service"]["pushCurrentBranch"]>,
      }),
      Layer.mock(SourceControlProviderRegistry)({ resolve: () => Effect.succeed(provider) }),
      Layer.mock(PullRequestService)({
        detail: () =>
          Effect.succeed({
            state: "open",
            mergeability: "mergeable",
            checks: [],
          } as unknown as PullRequestDetail),
        activity: () =>
          Effect.succeed({ comments: [], reviewThreads: [] } as unknown as PullRequestActivity),
      }),
    ),
  ),
  Layer.provideMerge(cardWorkspaceTestLayer("iskra-card-plan-test-")),
);

it.layer(layer)("CardPlanReactor", (it) => {
  it.effect(
    "lands a child into the plan's integration branch, asks at the slice checkpoint, then opens the plan's pull request against the base",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const workspace = yield* CardWorkspace.CardWorkspace;
        const planReactor = yield* CardPlanReactor.CardPlanReactor;
        yield* planReactor.start();
        yield* (yield* CardLandingReactor.CardLandingReactor).start();
        const next = nextEventOn(yield* engine.subscribeDomainEvents);
        const { fileSystem, path, root, git, gitIn } = yield* makeGitRepo("iskra-plan-repo-");
        const origin = yield* fileSystem.makeTempDirectoryScoped({ prefix: "iskra-plan-origin-" });
        yield* gitIn(origin, "init", "--bare", "--quiet", "--initial-branch=main");
        yield* git("remote", "add", "origin", origin);
        yield* git("push", "--quiet", "origin", "main");
        const base = yield* git("rev-parse", "main");

        let commands = 0;
        const commandId = () => CommandId.make(`cmd-plan-${(commands += 1)}`);
        const projectId = ProjectId.make("project-plan");
        const coordinator = AgentId.make("agent-plan-coordinator");
        const builder = AgentId.make("agent-plan-builder");
        const planId = CardId.make("card-plan");
        yield* engine.dispatch({
          type: "project.create",
          commandId: commandId(),
          projectId,
          title: "plan",
          workspaceRoot: root,
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "project.orchestration.set",
          commandId: commandId(),
          projectId,
          orchestration: {
            ...DEFAULT_PROJECT_ORCHESTRATION,
            landing: "pullRequest",
            checksWaived: true,
            verifier: { mode: "off" },
            sideEffectGuard: { acknowledgedAt: now, killSwitchEnv: null },
          },
        });
        for (const [agentId, name, capabilities, roles] of [
          [coordinator, "coordinator", ["read"], ["coordinator"]],
          [builder, "builder", ["read", "write"], ["builder"]],
        ] as const) {
          yield* engine.dispatch({
            type: "agent.create",
            commandId: commandId(),
            agentId,
            projectId,
            name,
            roleTags: [],
            rolePrompt: "",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-haiku-4-5",
            },
            capabilities,
            roles,
            createdAt: now,
          });
        }
        yield* engine.dispatch({
          type: "card.create",
          commandId: commandId(),
          cardId: planId,
          projectId,
          title: "Health and version",
          spec: "Add /health, then /version.",
          tags: [],
          kind: "plan",
          criteria: [{ id: "c1", text: "Both endpoints answer.", verification: "automated" }],
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "card.approve",
          commandId: commandId(),
          cardId: planId,
          delegateAgentId: coordinator,
        });
        yield* engine.dispatch({ type: "card.work.start", commandId: commandId(), cardId: planId });
        const criteria = [{ id: "c1", text: "It answers.", verification: "automated" as const }];
        yield* engine.dispatch({
          type: "card.plan.propose",
          commandId: commandId(),
          cardId: planId,
          premise: "Health first.",
          children: [
            {
              key: "health",
              title: "Health",
              spec: "Add /health.",
              criteria,
              suggestedAgent: "builder",
              dependsOn: [],
              slice: 1,
            },
            {
              key: "version",
              title: "Version",
              spec: "Add /version.",
              criteria,
              suggestedAgent: "builder",
              dependsOn: ["health"],
              slice: 2,
            },
          ],
          createdAt: now,
        });

        // Approval makes the integration branch from the base and pushes it.
        yield* engine.dispatch({
          type: "card.plan.approve",
          commandId: commandId(),
          cardId: planId,
          revision: 1,
        });
        yield* next("card.workspace-set", (event) => event.payload.cardId === planId);
        yield* planReactor.drain; // The push follows the workspace.
        const cards = Effect.map(snapshotQuery.getCommandReadModel(), (model) => model.cards ?? []);
        const planCard = (yield* cards).find((card) => card.id === planId)!;
        const branch = planCard.plan!.integrationBranch!;
        expect(planCard.branch).toBe(branch);
        expect(yield* git("ls-remote", "origin", `refs/heads/${branch}`)).toContain(base);
        const childOf = (key: string) =>
          Effect.map(cards, (all) =>
            all.find((card) => card.parentCardId === planId && card.planKey === key)!,
          );
        const health = yield* childOf("health");
        const version = yield* childOf("version");
        expect(version).toMatchObject({ heldByCheckpoint: true, baseBranch: branch });

        // The builder's commit on the first child, in a worktree started from the plan's branch.
        yield* engine.dispatch({
          type: "card.work.start",
          commandId: commandId(),
          cardId: health.id,
        });
        const info = yield* workspace.ensure(health.id);
        yield* fileSystem.writeFileString(path.join(info.worktreePath, "health.txt"), "ok\n");
        yield* gitIn(info.worktreePath, "add", ".");
        yield* gitIn(info.worktreePath, "commit", "--quiet", "-m", "Add health");
        const head = yield* gitIn(info.worktreePath, "rev-parse", "HEAD");
        const passing = (evidenceId: string, headSha: string) => ({
          type: "card.evidence.record" as const,
          commandId: commandId(),
          evidenceId,
          headSha,
          purpose: "review" as const,
          items: [
            {
              itemId: "check:test",
              kind: "check" as const,
              source: "local" as const,
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
        yield* engine.dispatch({ ...passing("evidence-health", head), cardId: health.id });
        yield* engine.dispatch({
          type: "card.review.enter",
          commandId: commandId(),
          cardId: health.id,
          headSha: head,
        });

        // It lands by itself, into the plan's branch and not the base, which origin follows.
        const landed = yield* next(
          "card.status-changed",
          (event) => event.payload.cardId === health.id && event.payload.to === "landed",
        );
        expect(landed.payload.landedSha).toBe(head);
        expect(yield* git("rev-parse", branch)).toBe(head);
        expect(yield* git("rev-parse", "main")).toBe(base);
        expect(yield* git("ls-remote", "origin", `refs/heads/${branch}`)).toContain(head);

        // Slice 1 finished: the coordinator hears it and a person is asked before slice 2.
        const checkpoint = yield* next(
          "card.checkpoint-requested",
          (event) => event.payload.cardId === planId,
        );
        expect(checkpoint.payload.checkpoint.checkpointId).toBe("plan-slice-1");
        const digests = (yield* snapshotQuery.getCardActivity(planId, {
          limit: 200,
        })).activities.filter((activity) => activity.reason?.code === PLAN_DIGEST_CODE);
        expect(digests.every((activity) => activity.deliverTo === "coordinator")).toBe(true);
        expect(digests.map((activity) => activity.body).join("\n")).toContain(
          '- health "Health": landed',
        );

        yield* engine.dispatch({
          type: "card.checkpoint.resolve",
          commandId: commandId(),
          cardId: planId,
          decision: "continue",
        });
        expect(
          (yield* next("card.plan-slice-released", (event) => event.payload.cardId === planId))
            .payload.releasedCardIds,
        ).toEqual([version.id]);

        // With the last child dropped, the plan asks for its own review.
        yield* engine.dispatch({
          type: "card.abandon",
          commandId: commandId(),
          cardId: version.id,
        });
        yield* next(
          "card.activity-recorded",
          (event) =>
            event.payload.cardId === planId && event.payload.reason?.code === REVIEW_REQUESTED_CODE,
        );

        // The plan's one pull request goes from its branch to the base.
        const planHead = yield* git("rev-parse", branch);
        yield* engine.dispatch({ ...passing("evidence-plan", planHead), cardId: planId });
        yield* engine.dispatch({
          type: "card.review.enter",
          commandId: commandId(),
          cardId: planId,
          headSha: planHead,
        });
        const linked = yield* next(
          "card.landing-linked",
          (event) => event.payload.cardId === planId,
        );
        expect(linked.payload.landing).toMatchObject({ mode: "pullRequest", draft: false });
        expect(host.created).toEqual([{ baseRefName: "main", headSelector: branch }]);
      }),
  );
});
