import {
  CHANNEL_SYSTEM_AUTHOR_ID,
  CommandId,
  type CardId,
  type CardRefChange,
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
import { REFS_CHANGED_OPTIONS } from "./cardRules.ts";
import { runSessionChange } from "./RunReactor.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/** Ref name → object id, for `refs/heads` and `refs/tags`. */
export type RefSnapshot = ReadonlyMap<string, string>;

export type RefChange = CardRefChange;

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

const short = (id: string | null) => id?.slice(0, 7) ?? "nothing";

/** What the card says. It doesn't accuse: the person may have made these changes themselves. */
export const refGuardMessage = (agent: string, changes: ReadonlyArray<RefChange>): string => {
  const described = changes.map((change) =>
    change.kind === "moved"
      ? `${change.ref} moved ${short(change.before)} → ${short(change.after)}`
      : change.kind === "created"
        ? `${change.ref} created at ${short(change.after)}`
        : `${change.ref} deleted (was ${short(change.before)})`,
  );
  return `Refs outside this card changed during ${agent}'s turn: ${described.join(", ")}. If the agent did this, restore them; if you did, keep them.`;
};

/**
 * Watches the repository's shared refs while a card's agent works. A card worktree's sandboxed
 * shell can write the common `.git` and the sandbox can't carve the card's own branch out of a ref
 * deny (docs/findings/m1-claude-run-enforcement.md), so each card run's turn snapshots `refs/heads`
 * and `refs/tags` when it is requested and compares when it settles or its session ends. A ref
 * created, deleted or moved meanwhile, other than a card's own branch, is reported on the card as
 * a refsChanged question and the card is paused. Nothing is put back automatically: the person may
 * have committed in their own checkout meanwhile. `card.refs.restore` puts the named refs back
 * (compare-and-swap, so a ref that changed again is skipped); `card.refs.keep` leaves them.
 *
 * Iskra's own writes to the repository's branches (a card's branch created or deleted, a landing's
 * fast-forward, a restore) hold the same per-repository lock as the snapshots and move open turns'
 * baselines to the ref's new value. Remote-tracking refs and checkpoint refs are outside
 * `refs/heads` and `refs/tags`, so pushes and checkpoints never count.
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
  readonly eventId: string;
}

type GuardRequest =
  | { readonly kind: "open"; readonly threadId: ThreadId; readonly eventId: string }
  | { readonly kind: "close"; readonly threadId: ThreadId }
  | {
      readonly kind: "restore";
      readonly cardId: CardId;
      readonly reportId: string;
      readonly changes: ReadonlyArray<RefChange>;
    };

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const processRunner = yield* ProcessRunner;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // Keyed by the repository's common git dir, so projects sharing a repository share a lock.
  // ponytail: in memory; a server restart mid-turn loses that turn's snapshot and it goes unchecked.
  const windows = new Map<ThreadId, TurnWindow>();
  const locks = new Map<string, Semaphore.Semaphore>();
  const withRepoLock = (key: string) => {
    let lock = locks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(key, lock);
    }
    return lock.withPermits(1);
  };

  /** Open turns in the repository accept Iskra's own write of `ref`. */
  const acceptServerWrite = (key: string, ref: string, value: string | undefined) => {
    for (const window of windows.values()) {
      if (window.key !== key) continue;
      if (value === undefined) window.baseline.delete(ref);
      else window.baseline.set(ref, value);
    }
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
                acceptServerWrite(key.value, ref, after.value);
              }),
            ),
          );
        }),
      );
    });

  const readCard = (cardId: CardId) =>
    Effect.gen(function* () {
      const model = yield* snapshotQuery.getCommandReadModel();
      const card = (model.cards ?? []).find((candidate) => candidate.id === cardId);
      const project = model.projects.find((candidate) => candidate.id === card?.projectId);
      if (card === undefined || project === undefined) return undefined;
      return { card, project, model };
    });

  const readRunCard = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const run = yield* snapshotQuery.getRunByThreadId(threadId);
      if (Option.isNone(run) || run.value.cardId === null) return undefined;
      const found = yield* readCard(run.value.cardId);
      return found === undefined ? undefined : { ...found, run: run.value };
    });

  const record = (
    cardId: CardId,
    activityId: string,
    entry: { readonly kind: "error" | "message"; readonly body: string; readonly runThreadId: ThreadId | null },
    report: { readonly reason: Reason; readonly changes: ReadonlyArray<RefChange> } | null,
  ) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "card.activity.record",
        commandId: CommandId.make(activityId),
        activityId,
        cardId,
        kind: entry.kind,
        author: { kind: "system", id: CHANNEL_SYSTEM_AUTHOR_ID },
        body: entry.body,
        runThreadId: entry.runThreadId,
        deliverTo: null,
        elicitation:
          report === null
            ? null
            : {
                question: "Restore these refs, or keep them?",
                options: REFS_CHANGED_OPTIONS,
                recommendedOptionId: null,
                allowText: false,
                kind: "refsChanged",
              },
        answers: null,
        status: null,
        evidenceId: null,
        reason: report?.reason ?? null,
        refChanges: report?.changes ?? null,
        createdAt: yield* nowIso,
      });
    }).pipe(Effect.catch((error) => Effect.logWarning("card ref guard could not record", { error: error.message })));

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
        return changes.length === 0 ? undefined : { changes, found };
      }),
    );
    if (outcome === undefined) return;
    const { changes, found } = outcome;
    const agentName = found?.model.agents?.find((agent) => agent.id === found.run.agentId)?.name;
    const text = refGuardMessage(agentName === undefined ? "the agent" : `@${agentName}`, changes);
    const reason: Reason = { code: REF_MOVED_OUTSIDE_CARD, text };
    yield* Effect.logWarning("refs outside a card changed during its agent's turn", {
      cardId: window.cardId,
      threadId,
      refs: changes.map((change) => change.ref),
    });
    yield* record(
      window.cardId,
      `card-ref-guard:${window.eventId}`,
      { kind: "error", body: text, runThreadId: threadId },
      { reason, changes },
    );
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

  /** Puts reported refs back for a person, each only if it still holds what the report saw. */
  const restore = Effect.fn("CardRefGuard.restore")(function* (
    cardId: CardId,
    reportId: string,
    changes: ReadonlyArray<RefChange>,
  ) {
    const found = yield* readCard(cardId);
    const root = found?.project.workspaceRoot;
    const key = root === undefined ? Option.none<string>() : yield* repoKey(root);
    const lines =
      root === undefined || Option.isNone(key)
        ? ["Iskra couldn't open the card's repository, so nothing was restored."]
        : yield* withRepoLock(key.value)(
            Effect.gen(function* () {
              const current = yield* snapshot(root);
              const result: Array<string> = [];
              for (const change of changes) {
                const now = Option.isSome(current) ? (current.value.get(change.ref) ?? null) : undefined;
                if (now !== change.after) {
                  result.push(
                    `Skipped ${change.ref}: it changed again after the report (now ${short(now ?? null)}), so it was left as it is.`,
                  );
                  continue;
                }
                const message = "iskra: a person restored a ref changed outside its card";
                const written = yield* git(
                  root,
                  change.before === null
                    ? ["update-ref", "-m", message, "-d", change.ref, change.after!]
                    : ["update-ref", "-m", message, change.ref, change.before, change.after ?? ""],
                );
                if (Option.isNone(written)) {
                  result.push(`Skipped ${change.ref}: it changed while restoring, so it was left as it is.`);
                  continue;
                }
                acceptServerWrite(key.value, change.ref, change.before ?? undefined);
                result.push(
                  change.before === null
                    ? `Deleted ${change.ref}.`
                    : `Restored ${change.ref} to ${short(change.before)}.`,
                );
              }
              return result;
            }),
          );
    yield* record(cardId, `${reportId}:restored`, { kind: "message", body: lines.join("\n"), runThreadId: null }, null);
  });

  const worker = yield* makeDrainableWorker((request: GuardRequest) =>
    (request.kind === "open"
      ? open(request.threadId, request.eventId)
      : request.kind === "close"
        ? close(request.threadId)
        : restore(request.cardId, request.reportId, request.changes)
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("card ref guard request failed", { kind: request.kind, cause: Cause.pretty(cause) }),
      ),
    ),
  );

  // The newest event sequence handed to the worker, so `drain` also covers events still in transit.
  const handled = yield* TxRef.make(0);

  const requestOf = (event: OrchestrationEvent): GuardRequest | null => {
    switch (event.type) {
      case "thread.turn-start-requested":
        return { kind: "open", threadId: event.payload.threadId, eventId: event.eventId };
      case "thread.session-set": {
        const change = runSessionChange(event.payload.session);
        return change === "settled" || change === "ended" ? { kind: "close", threadId: event.payload.threadId } : null;
      }
      case "card.activity-recorded": {
        // Only the decider's answer to card.refs.restore is a person's restore with refs.
        const { author, answers, refChanges: changes, cardId } = event.payload;
        return author.kind === "human" && answers?.optionId === "restore" && changes
          ? { kind: "restore", cardId, reportId: answers.questionId, changes }
          : null;
      }
      default:
        return null;
    }
  };

  const processEvent = (event: OrchestrationEvent) => {
    const request = requestOf(event);
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
