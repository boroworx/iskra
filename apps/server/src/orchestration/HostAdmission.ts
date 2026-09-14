import * as NodeOS from "node:os";

import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  type CardId,
  type CardPriority,
  type CardRuntimeSettings,
  type ProjectId,
  type Reason,
} from "@iskra/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import { HostResources } from "../resourceTelemetry/HostResources.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

export type AdmissionRefusal = "concurrency" | "load" | "memory";
export type Admission = { readonly ok: true } | { readonly ok: false; readonly reason: AdmissionRefusal };

/**
 * Whether the machine takes another heavy job now: refused while `concurrency` jobs already run,
 * while the 1-minute load exceeds cores × `thresholds.load`, or while the free memory share is
 * below `thresholds.freeMem`.
 */
export const admitHeavyJob = (input: {
  readonly running: number;
  readonly concurrency: number;
  readonly load1: number;
  readonly cores: number;
  readonly freeMemRatio: number;
  readonly thresholds: CardRuntimeSettings["admission"];
}): Admission =>
  input.running >= input.concurrency
    ? { ok: false, reason: "concurrency" }
    : input.load1 > input.cores * input.thresholds.load
      ? { ok: false, reason: "load" }
      : input.freeMemRatio < input.thresholds.freeMem
        ? { ok: false, reason: "memory" }
        : { ok: true };

/** Queue order of card priorities: urgent (1) first, then 2, 3, 4, and no priority (0) last. */
export const priorityRank = (priority: CardPriority): number => (priority === 0 ? 5 : priority);

export const WAITING_FOR_CAPACITY: Reason = {
  code: "waitingForCapacity",
  text: "Waiting for machine capacity",
};

/** How long a denied heavy job waits before the machine is asked again. */
export const ADMISSION_RETRY = "15 seconds";

export type HeavyJobKind = "checks" | "runChecks" | "journey" | "evidence" | "setup" | "landing";

/** A heavy job asking for the machine. A card-scoped job shows why it waits on its card. */
export interface HeavyJob {
  readonly cardId?: CardId;
  readonly projectId: ProjectId;
  readonly priority: CardPriority;
  readonly label: string;
  readonly kind: HeavyJobKind;
}

export interface HeavyJobEntry {
  readonly job: HeavyJob;
  // Epoch millis: when it first asked (kept across a requeue), and when it last started.
  readonly enqueuedAt: number;
  readonly startedAt: number | null;
}

export interface HostAdmissionSnapshot {
  readonly running: ReadonlyArray<HeavyJobEntry>;
  // In the order they will start.
  readonly waiting: ReadonlyArray<HeavyJobEntry>;
  // Epoch millis since free memory has been below the admission threshold, while jobs ran or waited.
  readonly memoryPressureSince: number | null;
}

export interface HostSample {
  readonly load1: number;
  readonly cores: number;
  readonly freeMemRatio: number;
}

/**
 * The environment-wide heavy-job queue. `run` waits for admission, runs the effect, and frees the
 * slot when it ends; interrupting the caller while it waits leaves the queue. Waiting jobs start by
 * card priority, then by how long they have waited.
 */
export class HostAdmission extends Context.Service<
  HostAdmission,
  {
    readonly run: <A, E, R>(job: HeavyJob, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly snapshot: Effect.Effect<HostAdmissionSnapshot>;
    /**
     * Interrupts the lowest-priority running job (the newest among equals) and puts it back in the
     * queue, where it starts again from scratch. Returns the job, or null when none runs.
     */
    readonly cancelLowestPriority: Effect.Effect<HeavyJob | null>;
  }
>()("@iskra/cli/orchestration/HostAdmission") {}

interface Entry {
  readonly id: number;
  readonly job: HeavyJob;
  readonly enqueuedAt: number;
  startedAt: number | null;
  admit: Deferred.Deferred<void>;
  cancel: Deferred.Deferred<void>;
  // Whether the card currently shows this job's wait reason.
  noted: boolean;
}

const byQueueOrder = (a: Entry, b: Entry) =>
  priorityRank(a.job.priority) - priorityRank(b.job.priority) ||
  a.enqueuedAt - b.enqueuedAt ||
  a.id - b.id;

const removeFrom = (entries: Array<Entry>, entry: Entry) => {
  const index = entries.indexOf(entry);
  if (index >= 0) entries.splice(index, 1);
};

export const make = (sample: Effect.Effect<HostSample>) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const settings = yield* ServerSettingsService;
    const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);
    const lock = yield* Semaphore.make(1);

    // Mutated only in synchronous steps; admission decisions run under `lock`.
    const waiting: Array<Entry> = [];
    const running: Array<Entry> = [];
    let memoryPressureSince: number | null = null;
    let nextId = 0;

    const note = (entry: Entry, reason: Reason | null) =>
      Effect.gen(function* () {
        const cardId = entry.job.cardId;
        if (cardId === undefined) return;
        yield* engine
          .dispatch({
            type: "card.wait.note",
            commandId: CommandId.make(
              `host-admission-wait:${cardId}:${entry.enqueuedAt}:${entry.id}:${reason?.code ?? "none"}:${yield* nowMillis}`,
            ),
            cardId,
            threadId: null,
            reason,
            notedAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("heavy job wait note was not recorded", {
                cardId,
                error: error.message,
              }),
            ),
          );
      });

    /** Starts every waiting job the machine admits now; notes why the rest wait. */
    const admitLocked = Effect.gen(function* () {
      const notes: Array<readonly [Entry, Reason | null]> = [];
      while (waiting.length > 0 || running.length > 0) {
        const runtime = (yield* settings.getSettings.pipe(
          Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
        )).cardRuntime;
        const host = yield* sample;
        const now = yield* nowMillis;
        memoryPressureSince =
          host.freeMemRatio < runtime.admission.freeMem ? (memoryPressureSince ?? now) : null;
        waiting.sort(byQueueOrder);
        const head = waiting[0];
        if (head === undefined) break;
        const admission = admitHeavyJob({
          running: running.length,
          concurrency: runtime.heavyJobConcurrency,
          load1: host.load1,
          cores: host.cores,
          freeMemRatio: host.freeMemRatio,
          thresholds: runtime.admission,
        });
        if (!admission.ok) {
          for (const entry of waiting) {
            if (!entry.noted) {
              entry.noted = true;
              notes.push([entry, WAITING_FOR_CAPACITY]);
            }
          }
          break;
        }
        waiting.shift();
        head.startedAt = now;
        running.push(head);
        if (head.noted) {
          head.noted = false;
          notes.push([head, null]);
        }
        yield* Deferred.succeed(head.admit, undefined);
      }
      if (waiting.length === 0 && running.length === 0) memoryPressureSince = null;
      return notes;
    });

    // Notes go out after the lock is released, so a slow dispatch never holds up admission.
    const pump = lock.withPermits(1)(admitLocked).pipe(
      Effect.flatMap((notes) =>
        Effect.forEach(notes, ([entry, reason]) => note(entry, reason), { discard: true }),
      ),
    );

    const leave = (entry: Entry) =>
      Effect.suspend(() => {
        removeFrom(waiting, entry);
        removeFrom(running, entry);
        return entry.noted ? note(entry, null) : Effect.void;
      }).pipe(Effect.andThen(pump));

    const run = <A, E, R>(job: HeavyJob, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const entry: Entry = {
          id: nextId++,
          job,
          enqueuedAt: yield* nowMillis,
          startedAt: null,
          admit: yield* Deferred.make<void>(),
          cancel: yield* Deferred.make<void>(),
          noted: false,
        };
        while (true) {
          waiting.push(entry);
          const outcome = yield* Effect.gen(function* () {
            yield* pump;
            yield* Deferred.await(entry.admit);
            return yield* effect.pipe(
              Effect.map((value) => ({ done: true as const, value })),
              Effect.raceFirst(
                Deferred.await(entry.cancel).pipe(Effect.as({ done: false as const })),
              ),
            );
          }).pipe(Effect.ensuring(leave(entry)));
          if (outcome.done) return outcome.value;
          // Cancelled for capacity: ask again, keeping its place by original wait time.
          entry.startedAt = null;
          entry.admit = yield* Deferred.make<void>();
          entry.cancel = yield* Deferred.make<void>();
        }
      });

    const view = (entry: Entry): HeavyJobEntry => ({
      job: entry.job,
      enqueuedAt: entry.enqueuedAt,
      startedAt: entry.startedAt,
    });

    const snapshot = Effect.sync(
      (): HostAdmissionSnapshot => ({
        running: running.map(view),
        waiting: [...waiting].sort(byQueueOrder).map(view),
        memoryPressureSince,
      }),
    );

    const cancelLowestPriority = Effect.suspend(() => {
      const victim = [...running].sort(byQueueOrder).at(-1);
      return victim === undefined
        ? Effect.succeed(null)
        : Deferred.succeed(victim.cancel, undefined).pipe(Effect.as(victim.job));
    });

    // Asks the machine again on a fixed spacing while anything waits or runs.
    yield* pump.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("heavy job admission failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.repeat(Schedule.spaced(ADMISSION_RETRY)),
      Effect.forkScoped,
    );

    return HostAdmission.of({ run, snapshot, cancelLowestPriority });
  });

/** Load from os.loadavg, free memory from HostResources (which counts reclaimable cache on macOS). */
const hostSample = Effect.gen(function* () {
  const resources = yield* HostResources;
  return Effect.gen(function* () {
    const snapshot = yield* resources.read;
    return {
      load1: NodeOS.loadavg()[0] ?? 0,
      cores: NodeOS.availableParallelism(),
      freeMemRatio:
        snapshot.totalMemoryBytes > 0
          ? snapshot.availableMemoryBytes / snapshot.totalMemoryBytes
          : 1,
    } satisfies HostSample;
  });
});

export const layer = Layer.effect(HostAdmission, Effect.flatMap(hostSample, make));

/** The queue over a sample the caller controls, for tests. */
export const layerWithSample = (sample: Effect.Effect<HostSample>) =>
  Layer.effect(HostAdmission, make(sample));
