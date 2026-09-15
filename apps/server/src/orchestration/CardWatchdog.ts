import {
  CHANNEL_SYSTEM_AUTHOR_ID,
  CommandId,
  type CardId,
  type OrchestrationCard,
  type OrchestrationEvent,
  type OrchestrationLiveRun,
  type Reason,
  type ThreadId,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionRunLivenessRepositoryLive } from "../persistence/Layers/ProjectionRunLiveness.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionRunLivenessRepository } from "../persistence/Services/ProjectionRunLiveness.ts";
import {
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivity,
} from "../persistence/Services/ProjectionThreadActivities.ts";
import { forkParked } from "../serverActivation.ts";
import { CardWorkspace } from "./CardWorkspace.ts";
import { HostAdmission } from "./HostAdmission.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  checksHung,
  hungJobAction,
  memoryPressureActions,
  MEMORY_PRESSURE_REASON,
  SERVICE_RESTORED_CODE,
  watchOwnerRun,
  watchServices,
  type OwnerRunFacts,
  type ServiceProbe,
  type WatchdogAction,
  type WatchdogRule,
} from "./watchdogRules.ts";

/**
 * Watches live card owners once a minute, and soon after a tool call finishes. It nudges a session
 * that stalls, repeats itself or keeps failing, stops one that hangs so the scheduler restarts it,
 * and pauses the card when a nudge did not help, a question went unanswered, the card ran too long
 * or overspent. It flags check runs that hang, and under memory pressure cancels the
 * lowest-priority heavy job and interrupts the lowest-priority owner turn. It only ever records,
 * nudges, stops, interrupts and pauses; it never kills a process itself.
 */
export class CardWatchdog extends Context.Service<
  CardWatchdog,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/CardWatchdog") {}

/** The reason a reactor step that died is recorded with on its card. */
export const REACTOR_FAILED_CODE = "reactorFailed";

/**
 * Wraps a reactor's per-card step: a failure or defect (never an interrupt) is logged and, when the
 * step has a card, recorded on it as an error with reason `reactorFailed`, so a job that died shows
 * on the card instead of only in the server log.
 */
export const catchReactorCause =
  (input: {
    readonly engine: OrchestrationEngine.OrchestrationEngineService["Service"];
    readonly reactor: string;
    readonly cardId: CardId | null;
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | void, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
        const error = Cause.squash(cause);
        const detail = error instanceof Error ? error.message : String(error);
        const text = `${input.reactor} stopped on this card: ${detail}`.slice(0, 500);
        const { cardId } = input;
        return Effect.logWarning(`${input.reactor} failed`, { cardId, cause: Cause.pretty(cause) }).pipe(
          Effect.andThen(
            cardId === null
              ? Effect.void
              : Effect.gen(function* () {
                  const now = yield* DateTime.now;
                  const activityId = `reactor-failed:${input.reactor}:${cardId}:${DateTime.toEpochMillis(now)}`;
                  yield* input.engine.dispatch({
                    type: "card.activity.record",
                    commandId: CommandId.make(activityId),
                    activityId,
                    cardId,
                    kind: "error",
                    author: { kind: "system", id: CHANNEL_SYSTEM_AUTHOR_ID },
                    body: text,
                    runThreadId: null,
                    deliverTo: null,
                    elicitation: null,
                    answers: null,
                    status: null,
                    evidenceId: null,
                    reason: { code: REACTOR_FAILED_CODE, text },
                    createdAt: DateTime.formatIso(now),
                  });
                }).pipe(Effect.catchCause(() => Effect.void)),
          ),
        );
      }),
    );

const EPOCH = "1970-01-01T00:00:00.000Z";
// ponytail: checks triggered by tool calls run at most this often; the tick covers the rest.
const ACTIVITY_CHECK_SPACING_MS = 15_000;

const toMillis = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

const payloadString = (payload: unknown, key: string) =>
  Predicate.isObject(payload) && Predicate.hasProperty(payload, key) && Predicate.isString(payload[key])
    ? payload[key]
    : undefined;

/** Tool calls that finished (oldest first), the oldest still running, and the newest activity. */
export const toolFactsOf = (activities: ReadonlyArray<ProjectionThreadActivity>) => {
  const completedIds = new Set(
    activities.flatMap((activity) => {
      const id = payloadString(activity.payload, "toolCallId");
      return activity.kind === "tool.completed" && id !== undefined ? [id] : [];
    }),
  );
  const oldestRunning = activities.find((activity) => {
    const id = payloadString(activity.payload, "toolCallId");
    return activity.kind === "tool.started" && id !== undefined && !completedIds.has(id);
  });
  return {
    tools: activities.flatMap((activity) =>
      activity.kind === "tool.completed"
        ? [
            {
              key: `${activity.summary}:${payloadString(activity.payload, "detail") ?? ""}`,
              failed: payloadString(activity.payload, "status") === "failed",
              at: toMillis(activity.createdAt),
            },
          ]
        : [],
    ),
    toolRunningSince: oldestRunning === undefined ? null : toMillis(oldestRunning.createdAt),
    lastActivityAt: activities.at(-1) === undefined ? null : toMillis(activities.at(-1)!.createdAt),
  };
};

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const threadActivities = yield* ProjectionThreadActivityRepository;
  const liveness = yield* ProjectionRunLivenessRepository;
  const admission = yield* HostAdmission;
  const workspace = yield* CardWorkspace;
  const layerScope = yield* Scope.Scope;
  const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // In memory, per session: a restarted server starts every session with a clean slate.
  const strikes = new Map<ThreadId, Map<WatchdogRule, { count: number; at: number }>>();
  // How often each heavy job was started over for hanging, by its admission id.
  const hungStrikes = new Map<number, number>();
  // Each watched card's ports that stopped listening, and whether that outage was reported.
  const outages = new Map<CardId, ReadonlyMap<string, { readonly since: number; readonly reported: boolean }>>();
  const flaggedChecks = new Set<string>();
  const interruptedForMemory = new Set<ThreadId>();
  let lastCheckAt = 0;

  const logFailure = (what: string) => (error: { readonly message: string }) =>
    Effect.logWarning(`card watchdog could not ${what}`, { error: error.message });

  /** Records a system entry on the card; `forBuilder` also delivers it as the owner's next turn. */
  const record = (input: {
    readonly activityId: string;
    readonly cardId: CardId;
    readonly threadId: ThreadId | null;
    readonly kind: "error" | "message";
    readonly body: string;
    readonly reason: Reason | null;
    readonly forBuilder: boolean;
  }) =>
    Effect.gen(function* () {
      yield* engine
        .dispatch({
          type: "card.activity.record",
          commandId: CommandId.make(`card-watchdog:${input.activityId}`),
          activityId: input.activityId,
          cardId: input.cardId,
          kind: input.kind,
          author: { kind: "system", id: CHANNEL_SYSTEM_AUTHOR_ID },
          body: input.body,
          runThreadId: input.threadId,
          deliverTo: input.forBuilder ? "builder" : null,
          elicitation: null,
          answers: null,
          status: null,
          evidenceId: null,
          reason: input.reason,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.catch(logFailure("record card activity")));
    });

  const apply = Effect.fn("CardWatchdog.apply")(function* (
    run: OrchestrationLiveRun & { readonly cardId: CardId },
    action: WatchdogAction,
    now: number,
  ) {
    const threadStrikes = strikes.get(run.threadId) ?? new Map();
    const count = (threadStrikes.get(action.rule)?.count ?? 0) + 1;
    threadStrikes.set(action.rule, { count, at: now });
    strikes.set(run.threadId, threadStrikes);
    const key = `${run.threadId}:${action.rule}:${count}`;

    yield* record({
      activityId: `watchdog:${key}`,
      cardId: run.cardId,
      threadId: run.threadId,
      kind: "error",
      body: action.reason.text,
      reason: action.reason,
      forBuilder: false,
    });
    if (action.kind === "nudge") {
      return yield* record({
        activityId: `watchdog-nudge:${key}`,
        cardId: run.cardId,
        threadId: run.threadId,
        kind: "message",
        body: action.message,
        reason: null,
        forBuilder: true,
      });
    }
    const createdAt = yield* nowIso;
    if (action.kind === "stop" || action.session === "stop") {
      yield* engine
        .dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`card-watchdog-stop:${key}`),
          threadId: run.threadId,
          createdAt,
        })
        .pipe(Effect.catch(logFailure("stop a session")));
    } else if (action.session === "interrupt") {
      yield* engine
        .dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make(`card-watchdog-interrupt:${key}`),
          threadId: run.threadId,
          createdAt,
        })
        .pipe(Effect.catch(logFailure("interrupt a turn")));
    }
    if (action.kind === "pause") {
      yield* engine
        .dispatch({
          type: "card.pause.system",
          commandId: CommandId.make(`card-watchdog-pause:${key}`),
          cardId: run.cardId,
          reason: action.reason,
        })
        .pipe(Effect.catch(logFailure("pause a card")));
    }
  });

  /** Brings a service (or the preview's run script) back, and says so on the card once it answers. */
  const restartService = (cardId: CardId, down: ServiceProbe) =>
    Effect.gen(function* () {
      if (down.kind === "service") {
        yield* workspace.ensureServices(cardId);
      } else {
        yield* workspace.runScript({ cardId, scriptId: down.name });
      }
      const text = `${down.kind === "service" ? `Service ${down.name}` : "The preview"} is running again.`;
      yield* record({
        activityId: `watchdog-restored:${cardId}:${down.name}:${yield* nowMillis}`,
        cardId,
        threadId: null,
        kind: "message",
        body: text,
        reason: { code: SERVICE_RESTORED_CODE, text },
        forBuilder: false,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("card watchdog could not restart a service", { cardId, error: error.message }),
      ),
    );

  const ownerFacts = Effect.fn("CardWatchdog.ownerFacts")(function* (
    run: OrchestrationLiveRun & { readonly cardId: CardId },
    card: OrchestrationCard,
  ) {
    const shell = yield* snapshotQuery.getThreadShellById(run.threadId);
    if (Option.isNone(shell) || shell.value.session === null) {
      return undefined;
    }
    const { session } = shell.value;
    const activities = yield* threadActivities.listByThreadId({ threadId: run.threadId, limit: 40 });
    const tool = toolFactsOf(activities);
    const owners = yield* liveness.listCardOwnerRuns({ cardId: card.id, since: EPOCH });
    const sessionSince = toMillis(session.updatedAt);
    return {
      threadId: run.threadId,
      cardId: card.id,
      cardStatus: card.status,
      spentUsd: card.spentUsd,
      budgetCapUsd: card.budgetCapUsd,
      turnActive: session.status === "running" || session.activeTurnId !== null,
      awaitingInput: shell.value.hasPendingApprovals || shell.value.hasPendingUserInput,
      sessionSince,
      lastEventAt: Math.max(sessionSince, tool.lastActivityAt ?? 0),
      toolRunningSince: tool.toolRunningSince,
      tools: tool.tools,
      workStartedAt: toMillis(owners.at(-1)?.startedAt ?? run.startedAt),
      strikes: strikes.get(run.threadId) ?? new Map(),
    } satisfies OwnerRunFacts;
  });

  const check = Effect.fn("CardWatchdog.check")(function* () {
    const now = yield* nowMillis;
    lastCheckAt = now;
    const readModel = yield* snapshotQuery.getCommandReadModel();
    const cards = new Map((readModel.cards ?? []).map((card) => [card.id, card] as const));
    // A verifier session is held to the same liveness rules as the owner.
    const owners = (readModel.liveRuns ?? []).flatMap((run) =>
      (run.role === "owner" || run.role === "verifier") && run.cardId !== null
        ? [{ ...run, cardId: run.cardId }]
        : [],
    );
    const liveThreads = new Set(owners.map((run) => run.threadId));
    for (const threadId of strikes.keys()) {
      if (!liveThreads.has(threadId)) strikes.delete(threadId);
    }

    const activeOwners: Array<{ threadId: ThreadId; priority: OrchestrationCard["priority"]; startedAt: string }> = [];
    for (const run of owners) {
      const card = cards.get(run.cardId);
      if (card === undefined || card.paused !== null) continue;
      const facts = yield* ownerFacts(run, card);
      if (facts === undefined) continue;
      if (facts.turnActive) {
        activeOwners.push({ threadId: run.threadId, priority: card.priority, startedAt: run.startedAt });
      }
      const action = watchOwnerRun(facts, now);
      if (action !== null) yield* apply(run, action, now);
    }

    for (const card of cards.values()) {
      if (card.checks === null) continue;
      const key = `${card.id}:${card.checks.updatedAt}`;
      if (flaggedChecks.has(key) || !checksHung({ state: card.checks.state, updatedAt: toMillis(card.checks.updatedAt) }, now)) {
        continue;
      }
      flaggedChecks.add(key);
      yield* record({
        activityId: `watchdog-checks-hung:${key}`,
        cardId: card.id,
        threadId: null,
        kind: "error",
        body: "The card's checks have been running past every check's time limit.",
        reason: { code: "checksHung", text: "The card's checks have been running past every check's time limit." },
        forBuilder: false,
      });
    }

    const snapshot = yield* admission.snapshot;

    // Heavy jobs past their limit: started over once, then stopped.
    const liveJobIds = new Set([...snapshot.running, ...snapshot.waiting].map((entry) => entry.id));
    for (const id of hungStrikes.keys()) {
      if (!liveJobIds.has(id)) hungStrikes.delete(id);
    }
    for (const entry of snapshot.running) {
      const struck = hungStrikes.get(entry.id) ?? 0;
      const action = hungJobAction(entry, struck, now);
      if (action === null) continue;
      hungStrikes.set(entry.id, struck + 1);
      yield* admission.cancel(entry.id, action.cancel);
      if (entry.job.cardId !== undefined) {
        yield* record({
          activityId: `watchdog-hung:${entry.job.cardId}:${entry.enqueuedAt}:${entry.id}:${struck + 1}`,
          cardId: entry.job.cardId,
          threadId: null,
          kind: "error",
          body: action.reason.text,
          reason: action.reason,
          forBuilder: false,
        });
      }
    }

    // Services and previews of cards in review, verifying, or mid-blueprint must keep listening.
    for (const cardId of outages.keys()) {
      if (!cards.has(cardId)) outages.delete(cardId);
    }
    for (const card of cards.values()) {
      const watched =
        card.paused === null &&
        card.worktreePath !== null &&
        (card.status === "inReview" ||
          card.verification.state === "running" ||
          snapshot.running.some((entry) => entry.job.cardId === card.id));
      if (!watched) {
        outages.delete(card.id);
        continue;
      }
      const probes = yield* workspace
        .serviceHealth(card.id)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<ServiceProbe> => []));
      const next = watchServices({ probes, outages: outages.get(card.id) ?? new Map(), now });
      outages.set(card.id, next.outages);
      for (const down of next.report) {
        yield* record({
          activityId: `watchdog-${down.reason.code}:${card.id}:${down.name}:${now}`,
          cardId: card.id,
          threadId: null,
          kind: "error",
          body: down.reason.text,
          reason: down.reason,
          forBuilder: false,
        });
        // A restart can wait a minute on readiness, so it never holds up the rest of the check.
        yield* restartService(card.id, down).pipe(Effect.forkIn(layerScope));
      }
    }

    const pressure = memoryPressureActions({ admission: snapshot, activeOwners, now });
    if (pressure.cancelHeavyJob) {
      yield* admission.cancelLowestPriority;
    }
    const interruptRun = owners.find((run) => run.threadId === pressure.interrupt);
    if (interruptRun !== undefined) {
      interruptedForMemory.add(interruptRun.threadId);
      yield* engine
        .dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make(`card-watchdog-memory:${interruptRun.threadId}:${now}`),
          threadId: interruptRun.threadId,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.catch(logFailure("interrupt a turn")));
      yield* record({
        activityId: `watchdog-memory:${interruptRun.threadId}:${now}`,
        cardId: interruptRun.cardId,
        threadId: interruptRun.threadId,
        kind: "error",
        body: MEMORY_PRESSURE_REASON.text,
        reason: MEMORY_PRESSURE_REASON,
        forBuilder: false,
      });
    }
    // Memory freed: the interrupted owners pick up where they left off.
    if (snapshot.memoryPressureSince === null) {
      for (const threadId of interruptedForMemory) {
        interruptedForMemory.delete(threadId);
        const run = owners.find((candidate) => candidate.threadId === threadId);
        if (run === undefined) continue;
        yield* record({
          activityId: `watchdog-memory-resume:${threadId}:${now}`,
          cardId: run.cardId,
          threadId,
          kind: "message",
          body: "The machine has memory to spare again. Continue where you left off.",
          reason: null,
          forBuilder: true,
        });
      }
    }
  });

  let checkQueued = false;
  const worker = yield* makeDrainableWorker((request: "check") =>
    Effect.suspend(() => {
      checkQueued = false;
      return check();
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("card watchdog request failed", { request, cause: Cause.pretty(cause) }),
      ),
    ),
  );
  const requestCheck = Effect.suspend(() => {
    if (checkQueued) return Effect.void;
    checkQueued = true;
    return worker.enqueue("check");
  });

  const processEvent = (event: OrchestrationEvent) =>
    event.type === "thread.activity-appended" && event.payload.activity.kind === "tool.completed"
      ? nowMillis.pipe(
          Effect.flatMap((now) =>
            now - lastCheckAt >= ACTIVITY_CHECK_SPACING_MS ? requestCheck : Effect.void,
          ),
        )
      : Effect.void;

  const start = Effect.fn("CardWatchdog.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
    yield* forkParked(requestCheck.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid));
  });

  return { start, drain: worker.drain } satisfies CardWatchdog["Service"];
});

export const layer = Layer.effect(CardWatchdog, make).pipe(
  Layer.provide(ProjectionThreadActivityRepositoryLive),
  Layer.provide(ProjectionRunLivenessRepositoryLive),
);
