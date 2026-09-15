import * as NodeOS from "node:os";

import {
  CHANNEL_SYSTEM_AUTHOR_ID,
  CardId,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  cardOriginOf,
  projectOrchestrationOf,
  type CardMigration,
  type OrchestrationCard,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { REVIEW_REQUESTED_CODE, renderReviewRequest } from "./CardEvidence.ts";
import { environmentSessionCapOf } from "./cardQueue.ts";
import { isFinishedCardStatus } from "./cardRules.ts";
import { CardWorkspace } from "./CardWorkspace.ts";
import { migrationBatch, migrationSample } from "./planRules.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/** The reason code a migration pauses with when its items can't be listed. */
export const MIGRATION_ENUMERATE_FAILED_CODE = "migrationEnumerateFailed";
/** Pauses that mean a child won't finish by itself: its item is blocked and the sweep goes on. */
const BLOCKING_PAUSE_CODES: ReadonlySet<string> = new Set([
  "fixRoundsExhausted",
  "startFailed",
  "sessionFailed",
]);
const SAMPLE_REACHED: ReadonlySet<OrchestrationCard["status"]> = new Set([
  "inReview",
  "landing",
  "landed",
  "abandoned",
]);

/** What a migration does next. */
export type MigrationStep =
  | { readonly kind: "start" }
  | { readonly kind: "enumerate" }
  | {
      readonly kind: "phase";
      readonly phase: CardMigration["phase"];
      readonly keys: ReadonlyArray<string>;
    }
  | { readonly kind: "tune" }
  | { readonly kind: "review" }
  | null;

/**
 * A migration's next step, from the card and its children. Ready and approved, it starts; in
 * progress it lists its items, samples a few, asks a person to tune once the sample reached review,
 * sweeps the rest so running items stay within `capacity`, and asks for review once every item
 * landed or was blocked. Tuning waits for the person, whose answer starts the sweep.
 */
export function migrationStep(
  card: Pick<
    OrchestrationCard,
    "status" | "migration" | "paused" | "delegateAgentId" | "specState" | "acceptance"
  >,
  children: ReadonlyArray<Pick<OrchestrationCard, "id" | "status" | "paused">>,
  capacity: number,
): MigrationStep {
  const { migration } = card;
  if (migration === null || card.paused !== null) return null;
  if (card.status === "ready") {
    return card.delegateAgentId !== null &&
      card.specState !== "draft" &&
      card.acceptance.state === "confirmed"
      ? { kind: "start" }
      : null;
  }
  if (card.status !== "inProgress") return null;
  const { items } = migration;
  switch (migration.phase) {
    case "enumerating":
      return items.length === 0
        ? { kind: "enumerate" }
        : { kind: "phase", phase: "sampling", keys: migrationSample(items, migration.sampleSize) };
    case "sampling": {
      const byId = new Map(children.map((child) => [child.id as string, child] as const));
      const reached = items
        .filter((item) => item.childCardId !== null)
        .every((item) => {
          const child = byId.get(item.childCardId!);
          return (
            item.state === "landed" ||
            item.state === "blocked" ||
            (child !== undefined && (SAMPLE_REACHED.has(child.status) || child.paused !== null))
          );
        });
      return reached ? { kind: "tune" } : null;
    }
    case "tuning":
      return null;
    case "sweeping": {
      if (items.every((item) => item.state === "landed" || item.state === "blocked")) {
        return { kind: "phase", phase: "done", keys: [] };
      }
      const batch = migrationBatch(items, capacity);
      return batch.length === 0 ? null : { kind: "phase", phase: "sweeping", keys: batch };
    }
    case "done":
      return { kind: "review" };
  }
}

/**
 * Runs migration cards. It lists the items with the card's enumerate command in a snapshot of the
 * migration's branch, starts a child card for a sample, raises a tuning checkpoint once the sample
 * reached review (a redirect rewrites the instructions), then sweeps the rest in batches the
 * machine's session cap bounds. A child that lands marks its item landed; one dropped or paused for
 * a person marks it blocked, and the sweep goes on. When every item is landed or blocked the
 * migration asks for review and opens its one pull request.
 */
export class CardMigrationReactor extends Context.Service<
  CardMigrationReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/CardMigrationReactor") {}

type MigrationJob =
  | { readonly kind: "advance"; readonly cardId: CardId }
  | {
      readonly kind: "child";
      readonly event: OrchestrationEvent & { readonly payload: { readonly cardId: CardId } };
    }
  | { readonly kind: "sweep"; readonly cardId: CardId; readonly key: string };

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const workspace = yield* CardWorkspace;
  const settings = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const newCardId = crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(CardId.make));

  // ponytail: reads the whole command read model per job, like the other card reactors.
  const readModel = () => snapshotQuery.getCommandReadModel();

  /** Dispatches a command; a refusal only means the step already happened or no longer applies. */
  const dispatchOrLog = (what: string, command: OrchestrationCommand) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catchTag("OrchestrationCommandInvariantError", (refusal) =>
        Effect.logInfo("migration reactor: " + what + " refused", { detail: refusal.detail }),
      ),
    );

  /** Says why the migration stopped and pauses it for a person. */
  const stopWith = (card: OrchestrationCard, key: string, text: string) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "card.activity.record",
        commandId: CommandId.make(`migration-error:${key}`),
        activityId: `migration-error:${key}`,
        cardId: card.id,
        kind: "error",
        author: { kind: "system", id: CHANNEL_SYSTEM_AUTHOR_ID },
        body: text,
        runThreadId: null,
        deliverTo: null,
        elicitation: null,
        answers: null,
        status: null,
        evidenceId: null,
        reason: { code: MIGRATION_ENUMERATE_FAILED_CODE, text: text.slice(0, 200) },
        createdAt: yield* nowIso,
      });
      yield* dispatchOrLog("pause", {
        type: "card.pause.system",
        commandId: CommandId.make(`migration-pause:${key}`),
        cardId: card.id,
        reason: { code: MIGRATION_ENUMERATE_FAILED_CODE, text: text.slice(0, 200) },
      });
    });

  /** A failed listing can be tried again after a person resumes, so each failure is its own entry. */
  const stopAfterFailure = (card: OrchestrationCard, text: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.flatMap((attempt) => stopWith(card, `enumerate:${card.id}:${attempt}`, text)),
    );

  const capacityOf = Effect.fn("CardMigrationReactor.capacityOf")(function* (
    card: OrchestrationCard,
  ) {
    const model = yield* readModel();
    const project = model.projects.find((candidate) => candidate.id === card.projectId);
    const runtime = (yield* settings.getSettings.pipe(
      Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
    )).cardRuntime;
    const sessionCap = project === undefined ? null : projectOrchestrationOf(project).sessionCap;
    return Math.max(
      1,
      sessionCap ??
        environmentSessionCapOf({
          cores: NodeOS.availableParallelism(),
          totalMemBytes: NodeOS.totalmem(),
          override: runtime.environmentSessionCap,
        }),
    );
  });

  const startPhase = Effect.fn("CardMigrationReactor.startPhase")(function* (
    card: OrchestrationCard,
    phase: CardMigration["phase"],
    keys: ReadonlyArray<string>,
  ) {
    const children = yield* Effect.forEach(keys, (key) =>
      Effect.map(newCardId, (cardId) => ({ key, cardId })),
    );
    yield* dispatchOrLog(`phase ${phase}`, {
      type: "card.migration.phase",
      commandId: CommandId.make(
        `migration-phase:${card.id}:${phase}:${keys[0] ?? "none"}:${keys.length}`,
      ),
      cardId: card.id,
      phase,
      ...(children.length === 0 ? {} : { children }),
    });
  });

  // Cards whose enumerate command is running in this process.
  const enumerating = new Set<CardId>();

  const advance = Effect.fn("CardMigrationReactor.advance")(function* (cardId: CardId) {
    const model = yield* readModel();
    const card = (model.cards ?? []).find((candidate) => candidate.id === cardId);
    if (card === undefined || card.kind !== "migration" || card.migration === null) return;
    const children = (model.cards ?? []).filter((child) => child.parentCardId === card.id);
    const step = migrationStep(card, children, yield* capacityOf(card));
    switch (step?.kind) {
      case undefined:
        return;
      case "start":
        return yield* dispatchOrLog("start", {
          type: "card.work.start",
          commandId: CommandId.make(`migration-start:${card.id}`),
          cardId,
        });
      case "enumerate": {
        if (enumerating.has(cardId)) return;
        enumerating.add(cardId);
        return yield* Effect.gen(function* () {
          const items = yield* workspace.enumerateItems(cardId);
          if (items.length === 0) {
            return yield* stopWith(
              card,
              `empty:${cardId}`,
              "The enumerate command listed no items.",
            );
          }
          yield* engine.dispatch({
            type: "card.migration.enumerate",
            commandId: CommandId.make(`migration-enumerate:${cardId}:${items.length}:${items[0]}`),
            cardId,
            items,
          });
        }).pipe(
          Effect.catchTags({
            OrchestrationCommandInvariantError: (refusal) => stopAfterFailure(card, refusal.detail),
            CardWorkspaceError: (error) => stopAfterFailure(card, error.message),
          }),
          Effect.ensuring(Effect.sync(() => enumerating.delete(cardId))),
        );
      }
      case "phase":
        return yield* startPhase(card, step.phase, step.keys);
      case "tune": {
        const sampled = card.migration.items.filter((item) => item.childCardId !== null).length;
        yield* startPhase(card, "tuning", []);
        return yield* dispatchOrLog("tuning checkpoint", {
          type: "card.checkpoint.request",
          commandId: CommandId.make(`migration-tune:${cardId}`),
          cardId,
          checkpoint: {
            checkpointId: `migration-tune-${cardId}`,
            whatToTry: `The first ${sampled} ${sampled === 1 ? "item" : "items"} reached review. Check them, then continue, redirect with better instructions, or stop.`,
            question: null,
            evidenceId: null,
            requestedAt: yield* nowIso,
          },
        });
      }
      case "review": {
        if (card.delegateAgentId === null) return;
        const key = `migration-review:${cardId}`;
        return yield* dispatchOrLog("review", {
          type: "card.activity.record",
          commandId: CommandId.make(key),
          activityId: key,
          cardId,
          kind: "message",
          author: { kind: "agent", id: card.delegateAgentId },
          body: renderReviewRequest(
            `Every item of the migration landed or was blocked (${card.migration.items.filter((item) => item.state === "blocked").length} blocked); its branch is ready for review.`,
            { sideEffect: "medium", performance: "low", compatibility: "medium", notes: "" },
          ),
          runThreadId: null,
          deliverTo: null,
          elicitation: null,
          answers: null,
          status: null,
          evidenceId: null,
          reason: { code: REVIEW_REQUESTED_CODE, text: "Asked for review." },
          createdAt: yield* nowIso,
        });
      }
    }
  });

  /** A person answered the tuning checkpoint (or resumed a stopped one): the sweep starts. */
  const sweep = Effect.fn("CardMigrationReactor.sweep")(function* (cardId: CardId) {
    const card = ((yield* readModel()).cards ?? []).find((candidate) => candidate.id === cardId);
    if (
      card?.migration?.phase !== "tuning" ||
      card.checkpoint !== null ||
      card.paused !== null ||
      card.status !== "inProgress"
    ) {
      return;
    }
    yield* startPhase(
      card,
      "sweeping",
      migrationBatch(card.migration.items, yield* capacityOf(card)),
    );
  });

  /** A child moved: its item may be landed or blocked, and its migration may take its next step. */
  const onChild = Effect.fn("CardMigrationReactor.onChild")(function* (
    event: OrchestrationEvent & { readonly payload: { readonly cardId: CardId } },
  ) {
    const model = yield* readModel();
    const child = (model.cards ?? []).find((card) => card.id === event.payload.cardId);
    if (
      child === undefined ||
      child.parentCardId === null ||
      cardOriginOf(child).kind !== "migration"
    ) {
      return yield* advance(event.payload.cardId);
    }
    const migration = (model.cards ?? []).find((card) => card.id === child.parentCardId);
    const item = migration?.migration?.items.find(
      (candidate) => candidate.childCardId === child.id,
    );
    const state =
      event.type === "card.status-changed" && event.payload.to === "landed"
        ? "landed"
        : (event.type === "card.status-changed" && event.payload.to === "abandoned") ||
            (event.type === "card.paused" && BLOCKING_PAUSE_CODES.has(event.payload.reason.code))
          ? "blocked"
          : null;
    if (migration !== undefined && item !== undefined && state !== null && item.state !== state) {
      yield* dispatchOrLog("item update", {
        type: "card.migration.items.update",
        commandId: CommandId.make(`migration-item:${event.eventId}`),
        cardId: migration.id,
        items: [{ key: item.key, state }],
      });
    }
    if (migration !== undefined) yield* advance(migration.id);
  });

  const worker = yield* makeDrainableWorker((job: MigrationJob) =>
    (job.kind === "advance"
      ? advance(job.cardId)
      : job.kind === "sweep"
        ? sweep(job.cardId)
        : onChild(job.event)
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("card migration reactor job failed", {
              kind: job.kind,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "card.status-changed":
      case "card.paused":
        return worker.enqueue({ kind: "child", event });
      case "card.delegate-changed":
      case "card.acceptance-set":
      case "card.spec-state-changed":
      case "card.migration-enumerated":
      case "card.migration-phase-changed":
      case "card.migration-items-updated":
        return worker.enqueue({ kind: "advance", cardId: event.payload.cardId });
      case "card.checkpoint-resolved":
        return event.payload.decision === "stop"
          ? Effect.void
          : worker.enqueue({ kind: "sweep", cardId: event.payload.cardId, key: event.eventId });
      case "card.resumed":
        return Effect.andThen(
          worker.enqueue({ kind: "sweep", cardId: event.payload.cardId, key: event.eventId }),
          worker.enqueue({ kind: "advance", cardId: event.payload.cardId }),
        );
      default:
        return Effect.void;
    }
  };

  const start = Effect.fn("CardMigrationReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
    // After a restart every open migration takes its next step.
    const model = yield* readModel().pipe(
      Effect.orElseSucceed(() => ({ cards: [] as ReadonlyArray<OrchestrationCard> })),
    );
    for (const card of model.cards ?? []) {
      if (card.kind === "migration" && !isFinishedCardStatus(card.status)) {
        yield* worker.enqueue({ kind: "advance", cardId: card.id });
      }
    }
  });

  return { start, drain: worker.drain } satisfies CardMigrationReactor["Service"];
});

export const layer = Layer.effect(CardMigrationReactor, make);
