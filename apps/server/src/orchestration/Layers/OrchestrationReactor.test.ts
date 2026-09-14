import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as ThreadSettlementReactor from "../ThreadSettlementReactor.ts";
import * as PullRequestSyncReactor from "../PullRequestSyncReactor.ts";
import * as ThreadPullRequestReactor from "../ThreadPullRequestReactor.ts";
import * as RunReactor from "../RunReactor.ts";
import * as AgentDefinitionSync from "../AgentDefinitionSync.ts";
import * as CardReviewReactor from "../CardReviewReactor.ts";
import * as CardSpendReactor from "../CardSpendReactor.ts";
import * as LinearSyncReactor from "../LinearSyncReactor.ts";
import * as CardSessionReactor from "../CardSessionReactor.ts";
import * as CardWorkspace from "../CardWorkspace.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";

describe("OrchestrationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("starts every orchestration reactor", async () => {
    const started: string[] = [];

    runtime = ManagedRuntime.make(
      Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
        Layer.provideMerge(
          Layer.succeed(ProviderRuntimeIngestionService, {
            start: () => {
              started.push("provider-runtime-ingestion");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderCommandReactor, {
            start: () => {
              started.push("provider-command-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CheckpointReactor, {
            start: () => {
              started.push("checkpoint-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadDeletionReactor, {
            start: () => {
              started.push("thread-deletion-reactor");
              return Effect.void;
            },
            drainThrough: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadPullRequestReactor.ThreadPullRequestReactor, {
            start: () => {
              started.push("thread-pull-request-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadSettlementReactor.ThreadSettlementReactor, {
            start: () => {
              started.push("thread-settlement-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(PullRequestSyncReactor.PullRequestSyncReactor, {
            start: () => {
              started.push("pull-request-sync-reactor");
              return Effect.void;
            },
            drain: Effect.void,
            requestSync: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(AgentAwarenessRelay.AgentAwarenessRelay, {
            publishThread: () => Effect.void,
            start: () => {
              started.push("agent-awareness-relay");
              return Effect.void;
            },
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(RunReactor.RunReactor, {
            start: () => {
              started.push("run-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(AgentDefinitionSync.AgentDefinitionSync, {
            start: () => {
              started.push("agent-definition-sync");
              return Effect.void;
            },
            reconcile: () => Effect.void,
            save: () => Effect.die("not used"),
            importDefinitions: () => Effect.die("not used"),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CardWorkspace.CardWorkspace, {
            start: () => {
              started.push("card-workspace");
              return Effect.void;
            },
            ensure: () => Effect.die("not used"),
            diff: () => Effect.die("not used"),
            runChecks: () => Effect.die("not used"),
            changedFiles: () => Effect.die("not used"),
            land: () => Effect.die("not used"),
            runScript: () => Effect.die("not used"),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CardSessionReactor.CardSessionReactor, {
            start: () => {
              started.push("card-session-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CardReviewReactor.CardReviewReactor, {
            start: () => {
              started.push("card-review-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CardSpendReactor.CardSpendReactor, {
            start: () => {
              started.push("card-spend-reactor");
              return Effect.void;
            },
            recordTurn: () => Effect.void,
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(LinearSyncReactor.LinearSyncReactor, {
            start: () => {
              started.push("linear-sync-reactor");
              return Effect.void;
            },
            syncNow: Effect.void,
          }),
        ),
      ),
    );

    const reactor = await runtime!.runPromise(Effect.service(OrchestrationReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    expect(started).toEqual([
      "provider-runtime-ingestion",
      "provider-command-reactor",
      "checkpoint-reactor",
      "thread-deletion-reactor",
      "thread-pull-request-reactor",
      "thread-settlement-reactor",
      "pull-request-sync-reactor",
      "agent-awareness-relay",
      "run-reactor",
      "agent-definition-sync",
      "card-workspace",
      "card-session-reactor",
      "card-review-reactor",
      "card-spend-reactor",
      "linear-sync-reactor",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
