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
import * as CardReviewReactor from "../CardReviewReactor.ts";
import * as CardSpendReactor from "../CardSpendReactor.ts";
import * as CardSessionReactor from "../CardSessionReactor.ts";
import * as CardWorkspace from "../CardWorkspace.ts";
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
  const cardSpendReactor = yield* CardSpendReactor.CardSpendReactor;

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
    yield* cardSpendReactor.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
