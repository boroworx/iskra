import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as ThreadSettlementReactor from "../ThreadSettlementReactor.ts";
import * as PullRequestSyncReactor from "../PullRequestSyncReactor.ts";
import * as ThreadPullRequestReactor from "../ThreadPullRequestReactor.ts";
import * as RunReactor from "../RunReactor.ts";
import * as AgentDefinitionSync from "../AgentDefinitionSync.ts";
import * as CardLandingReactor from "../CardLandingReactor.ts";
import * as CardReviewReactor from "../CardReviewReactor.ts";
import * as CardVerifierReactor from "../CardVerifierReactor.ts";
import * as CardPlanReactor from "../CardPlanReactor.ts";
import * as CardMigrationReactor from "../CardMigrationReactor.ts";
import * as TriggerReactor from "../TriggerReactor.ts";
import * as OutcomeReactor from "../OutcomeReactor.ts";
import * as CardReversibilityReactor from "../CardReversibilityReactor.ts";
import * as CardSpendReactor from "../CardSpendReactor.ts";
import * as LinearSyncReactor from "../LinearSyncReactor.ts";
import * as CardSessionReactor from "../CardSessionReactor.ts";
import * as CardScheduler from "../CardScheduler.ts";
import * as CardWatchdog from "../CardWatchdog.ts";
import * as CardWorkspace from "../CardWorkspace.ts";
import * as CardRefGuard from "../CardRefGuard.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const threadSettlementReactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
  const pullRequestSyncReactor = yield* PullRequestSyncReactor.PullRequestSyncReactor;
  const threadPullRequestReactor = yield* ThreadPullRequestReactor.ThreadPullRequestReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const runReactor = yield* RunReactor.RunReactor;
  const agentDefinitionSync = yield* AgentDefinitionSync.AgentDefinitionSync;
  const cardWorkspace = yield* CardWorkspace.CardWorkspace;
  const cardSessionReactor = yield* CardSessionReactor.CardSessionReactor;
  const cardReviewReactor = yield* CardReviewReactor.CardReviewReactor;
  const cardLandingReactor = yield* CardLandingReactor.CardLandingReactor;
  const cardVerifierReactor = yield* CardVerifierReactor.CardVerifierReactor;
  const cardSpendReactor = yield* CardSpendReactor.CardSpendReactor;
  const cardPlanReactor = yield* CardPlanReactor.CardPlanReactor;
  const cardMigrationReactor = yield* CardMigrationReactor.CardMigrationReactor;
  const triggerReactor = yield* TriggerReactor.TriggerReactor;
  const outcomeReactor = yield* OutcomeReactor.OutcomeReactor;
  const cardReversibilityReactor = yield* CardReversibilityReactor.CardReversibilityReactor;
  const linearSyncReactor = yield* LinearSyncReactor.LinearSyncReactor;
  const cardScheduler = yield* CardScheduler.CardScheduler;
  const cardWatchdog = yield* CardWatchdog.CardWatchdog;
  const cardRefGuard = yield* CardRefGuard.CardRefGuard;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* threadDeletionReactor.start();
    yield* threadPullRequestReactor.start();
    yield* threadSettlementReactor.start();
    yield* pullRequestSyncReactor.start();
    yield* agentAwarenessRelay.start();
    yield* runReactor.start();
    yield* agentDefinitionSync.start();
    yield* cardWorkspace.start();
    yield* cardSessionReactor.start();
    yield* cardReviewReactor.start();
    yield* cardLandingReactor.start();
    yield* cardVerifierReactor.start();
    yield* cardPlanReactor.start();
    yield* cardMigrationReactor.start();
    yield* cardSpendReactor.start();
    yield* outcomeReactor.start();
    yield* cardReversibilityReactor.start();
    yield* linearSyncReactor.start();
    yield* triggerReactor.start();
    yield* cardScheduler.start();
    yield* cardWatchdog.start();
    yield* cardRefGuard.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
