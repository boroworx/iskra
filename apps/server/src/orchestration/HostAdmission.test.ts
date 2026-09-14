// @effect-diagnostics nodeBuiltinImport:off - the kill test probes real processes and a pid file.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CardId, ProjectId, type OrchestrationCommand } from "@iskra/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { TestClock } from "effect/testing";

import { ProcessRunner } from "../processRunner.ts";
import * as ProcessRunnerLayer from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ADMISSION_RETRY,
  admitHeavyJob,
  HostAdmission,
  layerWithSample,
  type HeavyJob,
  type HostAdmissionSnapshot,
} from "./HostAdmission.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

const thresholds = { load: 1, freeMem: 0.2 };

describe("admitHeavyJob", () => {
  it.each([
    [{ running: 0, load1: 2, freeMemRatio: 0.5 }, { ok: true }],
    [{ running: 1, load1: 2, freeMemRatio: 0.5 }, { ok: false, reason: "concurrency" }],
    [{ running: 0, load1: 9, freeMemRatio: 0.5 }, { ok: false, reason: "load" }],
    [{ running: 0, load1: 8, freeMemRatio: 0.2 }, { ok: true }],
    [{ running: 0, load1: 2, freeMemRatio: 0.1 }, { ok: false, reason: "memory" }],
    // Concurrency is reported before load, and load before memory.
    [{ running: 1, load1: 9, freeMemRatio: 0.1 }, { ok: false, reason: "concurrency" }],
    [{ running: 0, load1: 9, freeMemRatio: 0.1 }, { ok: false, reason: "load" }],
  ])("%j → %j", (input, expected) => {
    expect(admitHeavyJob({ ...input, concurrency: 1, cores: 8, thresholds })).toEqual(expected);
  });
});

const projectId = ProjectId.make("project-admission");
const job = (name: string, priority: HeavyJob["priority"], cardId?: string): HeavyJob => ({
  projectId,
  priority,
  label: name,
  kind: "checks",
  ...(cardId === undefined ? {} : { cardId: CardId.make(cardId) }),
});

const makeWorld = Effect.gen(function* () {
  const freeMem = yield* Ref.make(0.5);
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const layer = layerWithSample(
    Effect.map(Ref.get(freeMem), (freeMemRatio) => ({ load1: 1, cores: 8, freeMemRatio })),
  ).pipe(
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({ sequence: 0 })),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
  );
  return { freeMem, dispatched, layer };
});

const until = (predicate: (snapshot: HostAdmissionSnapshot) => boolean) =>
  Effect.gen(function* () {
    const admission = yield* HostAdmission;
    return yield* admission.snapshot.pipe(Effect.repeat({ until: predicate }));
  });

const waitNotes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "card.wait.note" ? [[command.cardId, command.reason?.code ?? null]] : [],
  );

/** Whether a process with this id still runs (a signal 0 probe). */
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("HostAdmission", () => {
  it.effect("starts waiting jobs by card priority, then by how long they waited", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeWorld;
      yield* Effect.gen(function* () {
        const admission = yield* HostAdmission;
        const gate = yield* Deferred.make<void>();
        const order = yield* Ref.make<ReadonlyArray<string>>([]);
        const record = (name: string) => Ref.update(order, (all) => [...all, name]);

        const first = yield* admission
          .run(job("first", 4), Effect.andThen(record("first"), Deferred.await(gate)))
          .pipe(Effect.forkChild);
        yield* until((snapshot) => snapshot.running.length === 1);
        const low = yield* admission.run(job("low", 0), record("low")).pipe(Effect.forkChild);
        yield* until((snapshot) => snapshot.waiting.length === 1);
        const normal = yield* admission.run(job("normal", 3), record("normal")).pipe(Effect.forkChild);
        yield* until((snapshot) => snapshot.waiting.length === 2);
        const urgent = yield* admission.run(job("urgent", 1), record("urgent")).pipe(Effect.forkChild);
        yield* until((snapshot) => snapshot.waiting.length === 3);

        expect((yield* admission.snapshot).waiting.map((entry) => entry.job.label)).toEqual([
          "urgent",
          "normal",
          "low",
        ]);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.joinAll([first, low, normal, urgent]);
        expect(yield* Ref.get(order)).toEqual(["first", "urgent", "normal", "low"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("holds a job while memory is short, notes why on its card, and runs it once memory frees", () =>
    Effect.gen(function* () {
      const { freeMem, dispatched, layer } = yield* makeWorld;
      yield* Effect.gen(function* () {
        const admission = yield* HostAdmission;
        yield* Ref.set(freeMem, 0.1);
        const waiting = yield* admission
          .run(job("checks", 2, "card-a"), Effect.succeed("ran"))
          .pipe(Effect.forkChild);
        yield* until((snapshot) => snapshot.waiting.length === 1 && snapshot.memoryPressureSince !== null);
        expect(waitNotes(yield* Ref.get(dispatched))).toEqual([["card-a", "waitingForCapacity"]]);

        // Still short at the next retry: nothing runs and the note is not repeated.
        yield* TestClock.adjust(ADMISSION_RETRY);
        expect((yield* admission.snapshot).waiting).toHaveLength(1);
        expect(waitNotes(yield* Ref.get(dispatched))).toHaveLength(1);

        yield* Ref.set(freeMem, 0.5);
        yield* TestClock.adjust(ADMISSION_RETRY);
        expect(yield* Fiber.join(waiting)).toBe("ran");
        expect(waitNotes(yield* Ref.get(dispatched))).toEqual([
          ["card-a", "waitingForCapacity"],
          ["card-a", null],
        ]);
        expect(yield* admission.snapshot).toEqual({ running: [], waiting: [], memoryPressureSince: null });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("cancels the lowest-priority running job and runs it again once admitted", () =>
    Effect.gen(function* () {
      const { freeMem, layer } = yield* makeWorld;
      yield* Effect.gen(function* () {
        const admission = yield* HostAdmission;
        const attempts = yield* Ref.make(0);
        const gate = yield* Deferred.make<void>();
        const fiber = yield* admission
          .run(
            job("suite", 4, "card-b"),
            Effect.andThen(Ref.update(attempts, (n) => n + 1), Deferred.await(gate)).pipe(
              Effect.as("done"),
            ),
          )
          .pipe(Effect.forkChild);
        yield* until((snapshot) => snapshot.running.length === 1);

        yield* Ref.set(freeMem, 0.1);
        expect((yield* admission.cancelLowestPriority)?.label).toBe("suite");
        yield* until((snapshot) => snapshot.running.length === 0 && snapshot.waiting.length === 1);
        expect(yield* Ref.get(attempts)).toBe(1);
        expect(yield* admission.cancelLowestPriority).toBeNull();

        yield* Ref.set(freeMem, 0.5);
        yield* TestClock.adjust(ADMISSION_RETRY);
        yield* until((snapshot) => snapshot.running.length === 1);
        expect(yield* Ref.get(attempts)).toBe(2);
        yield* Deferred.succeed(gate, undefined);
        expect(yield* Fiber.join(fiber)).toBe("done");
      }).pipe(Effect.provide(layer));
    }),
  );

  // Real processes and real time: the cancelled job's shell and the sleep it started must both die.
  it.live("kills the processes a cancelled job spawned, then runs the job again", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeWorld;
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "iskra-admission-kill-"));
      const pidFile = NodePath.join(directory, "sleep.pid");
      yield* Effect.gen(function* () {
        const admission = yield* HostAdmission;
        const runner = yield* ProcessRunner;
        const attempts = yield* Ref.make(0);
        const suite = Ref.updateAndGet(attempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? runner
                  .run({
                    command: "sh",
                    args: ["-c", `sleep 60 & echo $! > "${pidFile}"; wait`],
                    timeout: "2 minutes",
                  })
                  .pipe(Effect.orDie, Effect.asVoid)
              : Effect.void,
          ),
        );
        const fiber = yield* admission.run(job("suite", 4, "card-kill"), suite).pipe(Effect.forkChild);

        const poll = { schedule: Schedule.spaced("20 millis"), times: 250 } as const;
        const pid = yield* Effect.sync(() =>
          NodeFS.existsSync(pidFile) ? Number(NodeFS.readFileSync(pidFile, "utf8").trim()) : 0,
        ).pipe(Effect.repeat({ ...poll, until: (value) => value > 0 }));
        expect(isAlive(pid)).toBe(true);

        expect((yield* admission.cancelLowestPriority)?.label).toBe("suite");
        yield* Fiber.join(fiber);
        expect(yield* Ref.get(attempts)).toBe(2);
        const alive = yield* Effect.sync(() => isAlive(pid)).pipe(
          Effect.repeat({ ...poll, until: (running) => !running }),
        );
        expect(alive).toBe(false);
      }).pipe(
        Effect.provide(Layer.mergeAll(layer, ProcessRunnerLayer.layer.pipe(Layer.provide(NodeServices.layer)))),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect("drops a waiting job whose caller gives up", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeWorld;
      yield* Effect.gen(function* () {
        const admission = yield* HostAdmission;
        const gate = yield* Deferred.make<void>();
        const first = yield* admission.run(job("first", 1), Deferred.await(gate)).pipe(Effect.forkChild);
        yield* until((snapshot) => snapshot.running.length === 1);
        const second = yield* admission.run(job("second", 1), Effect.void).pipe(Effect.forkChild);
        yield* until((snapshot) => snapshot.waiting.length === 1);
        yield* Fiber.interrupt(second);
        expect((yield* admission.snapshot).waiting).toEqual([]);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
      }).pipe(Effect.provide(layer));
    }),
  );
});
