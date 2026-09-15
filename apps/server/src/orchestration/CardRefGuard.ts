import {
  CHANNEL_SYSTEM_AUTHOR_ID,
  CommandId,
  type CardId,
  type OrchestrationEvent,
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
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";

import { ProcessRunner } from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import { runSessionChange } from "./RunReactor.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/** Ref name → object id, for `refs/heads` and `refs/tags`. */
export type RefSnapshot = ReadonlyMap<string, string>;

export interface RefChange {
  readonly ref: string;
  readonly kind: "moved" | "created" | "deleted";
  readonly before: string | null;
  readonly after: string | null;
}

export const REF_MOVED_OUTSIDE_CARD = "refMovedOutsideCard";

/** Every ref outside `exclusions` that was created, deleted or moved between two snapshots. */
export const refChanges = (
  before: RefSnapshot,
  after: RefSnapshot,
  exclusions: ReadonlySet<string>,
): ReadonlyArray<RefChange> =>
  [...new Set([...before.keys(), ...after.keys()])]
    .filter((ref) => !exclusions.has(ref) && before.get(ref) !== after.get(ref))
    .toSorted()
    .map((ref) => {
      const old = before.get(ref) ?? null;
      const current = after.get(ref) ?? null;
      return {
        ref,
        kind: old === null ? "created" : current === null ? "deleted" : "moved",
        before: old,
        after: current,
      };
    });

const listRefs = (refs: ReadonlyArray<string>) =>
  refs.length === 1 ? refs[0]! : `${refs.slice(0, -1).join(", ")} and ${refs.at(-1)!}`;

/** What the card says: who changed which refs, what Iskra put back, and each ref's ids for recovery. */
export const refGuardMessage = (
  agent: string,
  changes: ReadonlyArray<RefChange>,
  unrestored: ReadonlyArray<string>,
): { readonly summary: string; readonly body: string } => {
  const done = (["moved", "created", "deleted"] as const).flatMap((kind) => {
    const refs = changes.filter((change) => change.kind === kind).map((change) => change.ref);
    return refs.length === 0 ? [] : [`${kind} ${listRefs(refs)}`];
  });
  const restored =
    unrestored.length === 0
      ? `Iskra restored ${changes.length === 1 ? "it" : "them"}`
      : `Iskra could not restore ${listRefs(unrestored)}`;
  const summary = `${agent} ${listRefs(done)}; ${restored} and paused the card.`;
  const short = (id: string | null) => id?.slice(0, 12) ?? "none";
  const details = changes.map((change) => `- ${change.ref}: ${short(change.before)} → ${short(change.after)}`);
  return { summary, body: [summary, "", ...details].join("\n") };
};

/**
 * Guards the repository's shared refs while a card's agent works. A card worktree's sandboxed
 * shell can write the common `.git` (docs/findings/m1-claude-run-enforcement.md), so each card
 * run's turn snapshots `refs/heads` and `refs/tags` when it is requested and compares when it
 * settles or its session ends. A ref created, deleted or moved meanwhile, other than a card's own
 * branch, is put back (compare-and-swap, so a newer write is never clobbered), recorded on the card
 * and the card is paused. It detects and restores after the turn; it does not prevent the write.
 *
 * Iskra's own writes to the repository's branches (a card's branch created or deleted, a landing's
 * fast-forward) go through `serverRefWrite`, which holds the same per-repository lock as the
 * snapshots and moves open turns' baselines to the ref's new value. Remote-tracking refs and
 * checkpoint refs are outside `refs/heads` and `refs/tags`, so pushes and checkpoints never count.
 */
export class CardRefGuard extends Context.Service<
  CardRefGuard,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Waits until every event published so far has been handled. */
    readonly drain: Effect.Effect<void>;
    /** Runs Iskra's own write to `ref` in the repository at `root`; guarded turns accept its result. */
    readonly serverRefWrite: <A, E, R>(
      root: string,
      ref: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("@iskra/cli/orchestration/CardRefGuard") {}

interface TurnWindow {
  readonly key: string;
  readonly cardId: CardId;
  readonly root: string;
  readonly baseline: Map<string, string>;
}

type GuardRequest =
  | { readonly kind: "open"; readonly threadId: ThreadId; readonly eventId: string }
  | { readonly kind: "close"; readonly threadId: ThreadId };

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const processRunner = yield* ProcessRunner;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // Keyed by the repository's common git dir, so projects sharing a repository share a lock.
  // ponytail: in memory; a server restart mid-turn loses that turn's snapshot and it goes unchecked.
  const windows = new Map<ThreadId, TurnWindow & { readonly eventId: string }>();
  const locks = new Map<string, Semaphore.Semaphore>();
  const withRepoLock = (key: string) => {
    let lock = locks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(key, lock);
    }
    return lock.withPermits(1);
  };

  const git = (root: string, args: ReadonlyArray<string>) =>
    processRunner.run({ command: "git", args: ["-C", root, ...args], timeout: "30 seconds" }).pipe(
      Effect.flatMap((output) =>
        output.code === 0
          ? Effect.succeed(Option.some(output.stdout.trim()))
          : Effect.logDebug("card ref guard git call failed", { root, args, stderr: output.stderr.trim() }).pipe(
              Effect.as(Option.none<string>()),
            ),
      ),
      Effect.catch((error) =>
        Effect.logWarning("card ref guard could not run git", { root, error: error.message }).pipe(
          Effect.as(Option.none<string>()),
        ),
      ),
    );

  const repoKey = (root: string) => git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

  const snapshot = (root: string) =>
    git(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"]).pipe(
      Effect.map(
        Option.map(
          (stdout) =>
            new Map(
              stdout
                .split("\n")
                .filter((line) => line.length > 0)
                .map((line) => {
                  const at = line.lastIndexOf(" ");
                  return [line.slice(0, at), line.slice(at + 1)] as const;
                }),
            ),
        ),
      ),
    );

  const serverRefWrite: CardRefGuard["Service"]["serverRefWrite"] = (root, ref, effect) =>
    Effect.gen(function* () {
      const key = yield* repoKey(root);
      if (Option.isNone(key)) return yield* effect;
      return yield* withRepoLock(key.value)(
        Effect.gen(function* () {
          const before = Option.map(yield* snapshot(root), (refs) => refs.get(ref));
          return yield* effect.pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                const after = Option.map(yield* snapshot(root), (refs) => refs.get(ref));
                if (Option.isNone(before) || Option.isNone(after) || before.value === after.value) return;
                for (const window of windows.values()) {
                  if (window.key !== key.value) continue;
                  if (after.value === undefined) window.baseline.delete(ref);
                  else window.baseline.set(ref, after.value);
                }
              }),
            ),
          );
        }),
      );
    });

  const readRunCard = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const run = yield* snapshotQuery.getRunByThreadId(threadId);
      if (Option.isNone(run) || run.value.cardId === null) return undefined;
      const model = yield* snapshotQuery.getCommandReadModel();
      const cardId = run.value.cardId;
      const card = (model.cards ?? []).find((candidate) => candidate.id === cardId);
      const project = model.projects.find((candidate) => candidate.id === card?.projectId);
      if (card === undefined || project === undefined) return undefined;
      return { run: run.value, card, project, model };
    });

  const open = Effect.fn("CardRefGuard.open")(function* (threadId: ThreadId, eventId: string) {
    const found = yield* readRunCard(threadId);
    if (found === undefined) return;
    const root = found.project.workspaceRoot;
    const key = yield* repoKey(root);
    if (Option.isNone(key)) return;
    yield* withRepoLock(key.value)(
      Effect.gen(function* () {
        const refs = yield* snapshot(root);
        if (Option.isNone(refs)) return;
        windows.set(threadId, { key: key.value, cardId: found.card.id, root, baseline: new Map(refs.value), eventId });
      }),
    );
  });

  /** Puts one ref back only if it still holds what the snapshot saw. */
  const restore = (root: string, change: RefChange) =>
    git(
      root,
      change.after === null
        ? ["update-ref", "-m", "iskra: restore a ref moved outside its card", change.ref, change.before!, ""]
        : change.before === null
          ? ["update-ref", "-d", change.ref, change.after]
          : ["update-ref", "-m", "iskra: restore a ref moved outside its card", change.ref, change.before, change.after],
    ).pipe(Effect.map(Option.isSome));

  const close = Effect.fn("CardRefGuard.close")(function* (threadId: ThreadId) {
    const window = windows.get(threadId);
    if (window === undefined) return;
    windows.delete(threadId);
    const outcome = yield* withRepoLock(window.key)(
      Effect.gen(function* () {
        const after = yield* snapshot(window.root);
        if (Option.isNone(after)) return undefined;
        const found = yield* readRunCard(threadId);
        // Card branches move with their own agents and with landing's rebase.
        const exclusions = new Set(
          (found?.model.cards ?? []).flatMap((card) => (card.branch === null ? [] : [`refs/heads/${card.branch}`])),
        );
        const changes = refChanges(window.baseline, after.value, exclusions);
        if (changes.length === 0) return undefined;
        const unrestored: Array<string> = [];
        for (const change of changes) {
          if (!(yield* restore(window.root, change))) unrestored.push(change.ref);
        }
        return { changes, unrestored, found };
      }),
    );
    if (outcome === undefined) return;
    const { changes, unrestored, found } = outcome;
    const agentName = found?.model.agents?.find((agent) => agent.id === found.run.agentId)?.name;
    const message = refGuardMessage(agentName === undefined ? "The card's agent" : `@${agentName}`, changes, unrestored);
    const reason: Reason = { code: REF_MOVED_OUTSIDE_CARD, text: message.summary };
    yield* Effect.logWarning("card agent changed refs outside its card", {
      cardId: window.cardId,
      threadId,
      refs: changes.map((change) => change.ref),
      unrestored,
    });
    yield* engine
      .dispatch({
        type: "card.activity.record",
        commandId: CommandId.make(`card-ref-guard:${window.eventId}`),
        activityId: `card-ref-guard:${window.eventId}`,
        cardId: window.cardId,
        kind: "error",
        author: { kind: "system", id: CHANNEL_SYSTEM_AUTHOR_ID },
        body: message.body,
        runThreadId: threadId,
        deliverTo: null,
        elicitation: null,
        answers: null,
        status: null,
        evidenceId: null,
        reason,
        createdAt: yield* nowIso,
      })
      .pipe(Effect.catch((error) => Effect.logWarning("card ref guard could not record", { error: error.message })));
    if (found?.card.paused === null) {
      yield* engine
        .dispatch({
          type: "card.pause.system",
          commandId: CommandId.make(`card-ref-guard-pause:${window.eventId}`),
          cardId: window.cardId,
          reason,
        })
        .pipe(Effect.catch((error) => Effect.logWarning("card ref guard could not pause", { error: error.message })));
    }
  });

  const worker = yield* makeDrainableWorker((request: GuardRequest) =>
    (request.kind === "open" ? open(request.threadId, request.eventId) : close(request.threadId)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("card ref guard request failed", { kind: request.kind, cause: Cause.pretty(cause) }),
      ),
    ),
  );

  // The newest event sequence handed to the worker, so `drain` also covers events still in transit.
  const handled = yield* TxRef.make(0);

  const processEvent = (event: OrchestrationEvent) => {
    const request: GuardRequest | null =
      event.type === "thread.turn-start-requested"
        ? { kind: "open", threadId: event.payload.threadId, eventId: event.eventId }
        : event.type === "thread.session-set" &&
            (runSessionChange(event.payload.session) === "settled" ||
              runSessionChange(event.payload.session) === "ended")
          ? { kind: "close", threadId: event.payload.threadId }
          : null;
    return (request === null ? Effect.void : worker.enqueue(request)).pipe(
      Effect.andThen(TxRef.update(handled, (sequence) => Math.max(sequence, event.sequence))),
    );
  };

  const start = Effect.fn("CardRefGuard.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    const latest = yield* engine.latestSequence;
    yield* TxRef.update(handled, (sequence) => Math.max(sequence, latest));
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  const drain = Effect.gen(function* () {
    const latest = yield* engine.latestSequence;
    yield* TxRef.get(handled).pipe(
      Effect.tap((sequence) => (sequence < latest ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );
    yield* worker.drain;
  });

  return { start, drain, serverRefWrite } satisfies CardRefGuard["Service"];
});

export const layer = Layer.effect(CardRefGuard, make);
