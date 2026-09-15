import {
  projectOrchestrationOf,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type ProjectId,
  type ProjectTrigger,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  TRIGGER_POLL_MS,
  cardPullRequestKeys,
  ciFailureSources,
  dueScheduleMinutes,
  iskraCommitShas,
  iskraMentions,
  safeLogin,
  triggerIntakeCommand,
  type TriggerSource,
} from "./triggerRules.ts";
import * as TriggerSources from "./triggerSources.ts";

/**
 * Turns the outside into cards through each project's enabled triggers. Every minute it fires due
 * schedules; every five minutes per project it reads failed CI runs on the watched branch and
 * @iskra mentions on open pull requests no card owns. A fire only ever dispatches
 * `card.trigger.intake`, whose ids derive from the source, so a source seen again is a no-op;
 * the decider refuses untrusted authors and records the refusal. It never writes back to the host.
 */
export class TriggerReactor extends Context.Service<
  TriggerReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly pollNow: Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/TriggerReactor") {}

const OVERLAP_MS = 60_000;

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const sources = yield* TriggerSources.TriggerSources;
  // ponytail: in memory, so runs and comments from before this server started never fire; read
  // the project's latest fire instead if a restart dropping them matters.
  let startedAt: number | null = null;
  const polledAt = new Map<ProjectId, number>();
  // When each enabled schedule was first seen on, so a newly saved one never fires the minute
  // before it. ponytail: in memory, so the first tick after a restart skips the previous minute too.
  const scheduleSeenAt = new Map<string, number>();

  const fire = (project: OrchestrationProject, trigger: ProjectTrigger, source: TriggerSource, createdAt: string) =>
    engine.dispatch(triggerIntakeCommand({ projectId: project.id, trigger, source, createdAt })).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.logWarning("trigger could not fire", {
          projectId: project.id,
          triggerId: trigger.id,
          sourceKey: source.sourceKey,
          error: error.message,
        }),
      ),
    );

  const pollProject = Effect.fn("TriggerReactor.pollProject")(function* (
    project: OrchestrationProject,
    readModel: OrchestrationReadModel,
    nowMs: number,
    sinceMs: number,
    liveSchedules: Set<string>,
  ) {
    const createdAt = isoOf(nowMs);
    const policy = projectOrchestrationOf(project);
    const triggers = policy.triggers.filter((trigger) => trigger.enabled);
    for (const trigger of triggers) {
      if (trigger.kind !== "schedule" || trigger.schedule === null) continue;
      const key = `${project.id}\n${trigger.id}\n${trigger.schedule.cron}\n${trigger.schedule.timezone}`;
      liveSchedules.add(key);
      const seenAt = scheduleSeenAt.get(key) ?? nowMs;
      scheduleSeenAt.set(key, seenAt);
      for (const minute of dueScheduleMinutes(trigger, nowMs, seenAt)) {
        yield* fire(project, trigger, { sourceKey: minute, label: "a schedule", text: null, author: null }, createdAt);
      }
    }

    const lastPolled = polledAt.get(project.id);
    const hosted = triggers.filter((trigger) => trigger.kind !== "schedule");
    if (hosted.length === 0 || (lastPolled !== undefined && nowMs - lastPolled < TRIGGER_POLL_MS)) return;
    polledAt.set(project.id, nowMs);
    const cards = (readModel.cards ?? []).filter((card) => card.projectId === project.id);
    const sinceIso = isoOf(sinceMs);
    const cwd = project.workspaceRoot;

    for (const trigger of hosted.filter((candidate) => candidate.kind === "ciFailure")) {
      const branch = trigger.branch ?? policy.baseBranch ?? (yield* sources.defaultBranch(cwd));
      if (branch === null) continue;
      const runs = yield* sources.failedRuns({ cwd, branch });
      for (const source of ciFailureSources(runs, { branch, sinceIso, skipShas: iskraCommitShas(cards) })) {
        yield* fire(project, trigger, source, createdAt);
      }
    }

    const commentTriggers = hosted.filter((candidate) => candidate.kind === "prComment");
    if (commentTriggers.length === 0) return;
    const linked = cardPullRequestKeys(cards);
    // Only pull requests touched since the last read (a minute of overlap) have their comments read.
    const touchedSince = isoOf(Math.max(sinceMs, (lastPolled ?? sinceMs) - OVERLAP_MS));
    for (const pr of yield* sources.openPullRequests(project.id)) {
      if (
        pr.updatedAt < touchedSince ||
        pr.headBranch.startsWith("iskra/") ||
        linked.has(`${pr.repository}#${pr.number}`.toLowerCase())
      ) {
        continue;
      }
      const ref = { projectId: project.id, host: pr.host, repository: pr.repository, number: pr.number };
      for (const comment of iskraMentions(yield* sources.comments(ref), sinceIso)) {
        const login = safeLogin(comment.author.login);
        const trusted = yield* sources.isTrusted({ cwd, ref, login });
        const source: TriggerSource = {
          sourceKey: `comment-${comment.id}`,
          label: `@${login} on pull request ${pr.repository}#${pr.number}`,
          text: comment.body,
          author: { login, trusted },
        };
        for (const trigger of commentTriggers) {
          yield* fire(project, trigger, source, createdAt);
        }
      }
    }
  });

  const tick = Effect.fn("TriggerReactor.tick")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const sinceMs = (startedAt ??= nowMs);
    const readModel = yield* snapshotQuery.getCommandReadModel();
    const liveSchedules = new Set<string>();
    for (const project of readModel.projects) {
      if (project.deletedAt !== null) continue;
      yield* pollProject(project, readModel, nowMs, sinceMs, liveSchedules);
    }
    // A schedule turned off, changed or removed starts over when it is on again.
    for (const key of scheduleSeenAt.keys()) {
      if (!liveSchedules.has(key)) scheduleSeenAt.delete(key);
    }
  });

  let tickQueued = false;
  const worker = yield* makeDrainableWorker((_request: "tick") =>
    Effect.suspend(() => {
      tickQueued = false;
      return tick();
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("trigger reactor tick failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );
  // A slow tick (host reads) never piles up more behind it.
  const requestTick = Effect.suspend(() => {
    if (tickQueued) return Effect.void;
    tickQueued = true;
    return worker.enqueue("tick");
  });

  const start = Effect.fn("TriggerReactor.start")(function* () {
    yield* forkParked(requestTick.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid));
  });

  return {
    start,
    pollNow: requestTick.pipe(Effect.andThen(worker.drain)),
    drain: worker.drain,
  } satisfies TriggerReactor["Service"];
});

/** The reactor over whatever `TriggerSources` is provided; tests give it a fake. */
export const layerWithoutSources = Layer.effect(TriggerReactor, make);

export const layer = layerWithoutSources.pipe(Layer.provide(TriggerSources.layer));
