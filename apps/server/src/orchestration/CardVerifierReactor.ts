import {
  CHANNEL_SYSTEM_AUTHOR_ID,
  CommandId,
  projectOrchestrationOf,
  type CardId,
  type CardVerdict,
  type HoldoutScenario,
  type OrchestrationAgent,
  type OrchestrationCard,
  type OrchestrationEvent,
  type ThreadId,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionCardRepositoryLive } from "../persistence/Layers/ProjectionCards.ts";
import { ProjectionCardRepository } from "../persistence/Services/ProjectionCards.ts";
import { ProcessRunner } from "../processRunner.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { verificationRequired } from "./cardRules.ts";
import { cardRunStartCommands, cardRunThreadId } from "./cardRunStart.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import { HostAdmission } from "./HostAdmission.ts";
import { HoldoutStore, redactHoldouts } from "./HoldoutStore.ts";
import { runSessionChange } from "./RunReactor.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { buildVerifierBrief, type HoldoutCommandResult } from "./verifierBrief.ts";
import { selectVerifier } from "./verifierSelection.ts";

/**
 * Verifies cards in review when their project's verifier is on or their builder's template
 * always verifies. For the card's latest commit it picks a verifier (selectVerifier), checks out a
 * detached snapshot with its own ports and services, runs the command hidden scenarios there, and
 * starts the verifier's read-only session from a brief with nothing of how the card was built.
 *
 * A failed verdict sends the card back to work with the failed criteria's notes and a count of
 * failed hidden scenarios, never their text, using a review fix round. A passed one needs nothing
 * here: the landing reactor re-checks the gate. A verifier that ends without a verdict is started
 * once more, then the card asks a person to rerun it. The snapshot and session go when the verdict
 * lands, the card leaves review, or a newer commit is verified.
 */
export class CardVerifierReactor extends Context.Service<
  CardVerifierReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/CardVerifierReactor") {}

type VerifierRequest =
  // `trigger` names what asked (an event id), so a rerun at the same commit starts a new run
  // instead of replaying the first run's commands.
  | { readonly kind: "verify"; readonly cardId: CardId; readonly trigger: string }
  | { readonly kind: "verdict"; readonly verdict: CardVerdict }
  | { readonly kind: "session"; readonly threadId: ThreadId }
  | { readonly kind: "release"; readonly cardId: CardId }
  | { readonly kind: "recover" };

/** A verifier at work on a card: its session and the snapshot it reads. */
interface Verifying {
  readonly headSha: string;
  readonly threadId: ThreadId;
  readonly trigger: string;
  readonly attempt: number;
  readonly release: Effect.Effect<void>;
}

/** Automatic starts after the first when a verifier ends without a verdict. */
export const VERIFIER_AUTOMATIC_RERUNS = 1;
const HOLDOUT_OUTPUT_TAIL = 2_000;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What the builder reads when the verifier fails its work: notes and counts, never scenario text. */
export function verifierFeedback(input: {
  readonly card: Pick<OrchestrationCard, "acceptance">;
  readonly verdict: Pick<CardVerdict, "criteria" | "diffJudge" | "scenarios">;
  readonly scenarios: ReadonlyArray<Pick<HoldoutScenario, "scenarioId" | "title" | "body" | "command">>;
}): { readonly headline: string; readonly body: string } {
  const failed = input.verdict.criteria.filter((criterion) => !criterion.pass);
  const hiddenFailed = input.verdict.scenarios.filter((scenario) => !scenario.satisfied).length;
  const headline = [
    failed.length > 0 ? `The verifier found ${plural(failed.length, "criterion", "criteria")} not met` : null,
    input.verdict.diffJudge.matchesCriteria ? null : "the diff doesn't do what the criteria ask",
    hiddenFailed > 0 ? `${plural(hiddenFailed, "hidden scenario", "hidden scenarios")} failed` : null,
  ]
    .filter((part) => part !== null)
    .join("; ");
  const clean = (text: string) => redactHoldouts(text, input.scenarios);
  const body = [
    `${headline.length > 0 ? headline : "The verifier didn't pass this commit"}.`,
    ...failed.map((criterion) => {
      const text = input.card.acceptance.criteria.find((entry) => entry.id === criterion.criterionId)?.text;
      return `- ${criterion.criterionId}${text === undefined ? "" : ` (${text})`}: ${clean(criterion.note)}`;
    }),
    ...input.verdict.diffJudge.concerns.map((concern) => `- Concern: ${clean(concern)}`),
    ...(hiddenFailed > 0
      ? [`- ${plural(hiddenFailed, "hidden scenario", "hidden scenarios")} failed. They stay hidden; fix what the criteria and notes point at.`]
      : []),
  ].join("\n");
  return { headline: headline.length > 0 ? headline : "The verifier didn't pass this commit", body };
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const workspace = yield* CardWorkspace.CardWorkspace;
  const admission = yield* HostAdmission;
  const runner = yield* ProcessRunner;
  const registry = yield* ProviderRegistry;
  const holdouts = yield* HoldoutStore;
  const cards = yield* ProjectionCardRepository;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // In memory: a restart loses verifier sessions anyway (see recover).
  const verifying = new Map<CardId, Verifying>();

  const readModel = () => snapshotQuery.getCommandReadModel();

  /** Stops the card's verifier session and removes its snapshot. */
  const release = Effect.fn("CardVerifierReactor.release")(function* (cardId: CardId) {
    const current = verifying.get(cardId);
    if (current === undefined) return;
    verifying.delete(cardId);
    yield* engine
      .dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make(`card-verifier-stop:${current.threadId}`),
        threadId: current.threadId,
        createdAt: yield* nowIso,
      })
      .pipe(Effect.ignore);
    yield* current.release;
  });

  /** Asks a person to rerun the verifier (attention `verifierError`), saying why. */
  const raiseError = (cardId: CardId, key: string, text: string) =>
    Effect.gen(function* () {
      yield* engine
        .dispatch({
          type: "card.activity.record",
          commandId: CommandId.make(`card-verifier-error:${key}`),
          activityId: `card-verifier-error:${key}`,
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
          reason: { code: "verifierError", text },
          createdAt: yield* nowIso,
        })
        .pipe(Effect.ignore);
    });

  const runHoldout = (
    card: OrchestrationCard,
    snapshot: CardWorkspace.CardSnapshot,
    scenario: HoldoutScenario & { readonly command: string },
  ): Effect.Effect<HoldoutCommandResult> =>
    admission
      .run(
        {
          cardId: card.id,
          projectId: card.projectId,
          priority: card.priority,
          label: `hidden scenario ${scenario.scenarioId}`,
          kind: "holdout",
        },
        runner.run({
          command: "sh",
          args: ["-c", scenario.command],
          cwd: snapshot.path,
          // Only what a scenario needs to reach the snapshot's services; no server secrets.
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            ...Object.fromEntries(
              Object.entries(snapshot.ports).map(([name, port]) => [
                `ISKRA_PORT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
                String(port),
              ]),
            ),
          },
          timeout: `${scenario.timeoutMinutes} minutes`,
          timeoutBehavior: "timedOutResult",
        }),
      )
      .pipe(
        Effect.map((output) => ({
          scenarioId: scenario.scenarioId,
          exitCode: output.code,
          timedOut: output.timedOut,
          outputTail: `${output.stdout}${output.stderr}`.slice(-HOLDOUT_OUTPUT_TAIL),
        })),
        Effect.catch((error) =>
          Effect.succeed({
            scenarioId: scenario.scenarioId,
            exitCode: null,
            timedOut: false,
            outputTail: `It couldn't run: ${error.message}`,
          }),
        ),
      );

  const startVerifier = Effect.fn("CardVerifierReactor.startVerifier")(function* (input: {
    readonly card: OrchestrationCard;
    readonly builder: OrchestrationAgent;
    readonly agents: ReadonlyArray<OrchestrationAgent>;
    readonly headSha: string;
    readonly trigger: string;
    readonly attempt: number;
  }) {
    const { card, headSha, attempt } = input;
    const evidence = card.evidence;
    if (evidence === null) return;
    const key = `verify-${card.id}-${headSha.slice(0, 12)}-${input.trigger}-${attempt}`;
    yield* release(card.id);

    const choice = selectVerifier({
      builder: input.builder,
      agents: input.agents,
      providers: yield* registry.getProviders,
    });
    if ("refusal" in choice) {
      return yield* raiseError(card.id, key, `No verifier can check this card: ${choice.refusal}`);
    }
    const selected = yield* engine
      .dispatch({
        type: "card.verifier.select",
        commandId: CommandId.make(`card-verifier-select:${key}`),
        cardId: card.id,
        headSha,
        verifier: {
          agentId: choice.agent.id,
          instanceId: choice.modelSelection.instanceId,
          model: choice.modelSelection.model,
          reason: choice.reason,
        },
      })
      .pipe(
        Effect.as(true),
        Effect.catchTag("OrchestrationCommandInvariantError", (refusal) =>
          Effect.logInfo("verifier not selected", { cardId: card.id, detail: refusal.detail }).pipe(
            Effect.as(false),
          ),
        ),
      );
    if (!selected) return;

    const started = Effect.gen(function* () {
      const snapshot = yield* workspace.snapshot(card.id, headSha);
      verifying.set(card.id, {
        headSha,
        threadId: cardRunThreadId(key),
        trigger: input.trigger,
        attempt,
        release: snapshot.release,
      });
      const scenarios = yield* holdouts.list(card.projectId);
      const commands = scenarios.flatMap((scenario) =>
        scenario.kind === "command" && scenario.command !== null
          ? [{ ...scenario, command: scenario.command }]
          : [],
      );
      if (commands.length > 0) yield* snapshot.ensureServices;
      const results: Array<HoldoutCommandResult> = [];
      for (const scenario of commands) {
        results.push(yield* runHoldout(card, snapshot, scenario));
      }
      const { baseBranch, diff } = yield* workspace.diff(card.id);
      const evidenceItems = yield* cards.listEvidenceItems({
        cardId: card.id,
        evidenceId: evidence.evidenceId,
      });
      const brief = buildVerifierBrief({
        agent: choice.agent,
        card,
        headSha,
        baseBranch,
        diff,
        evidenceItems,
        scenarios,
        results,
      });
      const startedAt = yield* nowIso;
      for (const command of cardRunStartCommands({
        key,
        card: { ...card, branch: null, worktreePath: snapshot.path },
        agent: choice.agent,
        role: "verifier",
        modelSelection: choice.modelSelection,
        capabilities: choice.capabilities,
        // The run stores the redacted brief; only the turn carries the scenarios.
        context: brief.context,
        rendered: brief.rendered,
        restarts: 0,
        startedAt,
      })) {
        yield* engine.dispatch(
          command.type === "thread.turn.start"
            ? { ...command, message: { ...command.message, text: brief.firstMessage } }
            : command,
        );
      }
    });
    yield* started.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              yield* release(card.id);
              const error = Cause.squash(cause);
              yield* raiseError(
                card.id,
                key,
                `The verifier couldn't start: ${error instanceof Error ? error.message : String(error)}`,
              );
            }),
      ),
    );
  });

  const verify = Effect.fn("CardVerifierReactor.verify")(function* (cardId: CardId, trigger: string) {
    const model = yield* readModel();
    const card = model.cards?.find((candidate) => candidate.id === cardId);
    const project = model.projects.find((candidate) => candidate.id === card?.projectId);
    if (card === undefined || project === undefined || card.status !== "inReview" || card.evidence === null) {
      return;
    }
    const agents = (model.agents ?? []).filter((agent) => agent.projectId === card.projectId);
    const builder = agents.find((agent) => agent.id === card.delegateAgentId);
    if (builder === undefined || !verificationRequired(projectOrchestrationOf(project), builder)) {
      return;
    }
    const { headSha } = card.evidence;
    const { verification } = card;
    // Already verifying, verified or overridden at this commit; a rerun sends it back to pending.
    if (
      verification.headSha === headSha &&
      verification.state !== "pending" &&
      verification.state !== "off"
    ) {
      return;
    }
    yield* startVerifier({ card, builder, agents, headSha, trigger, attempt: 0 });
  });

  const onVerdict = Effect.fn("CardVerifierReactor.onVerdict")(function* (verdict: CardVerdict) {
    yield* release(verdict.cardId);
    if (verdict.passed) return;
    const model = yield* readModel();
    const card = model.cards?.find((candidate) => candidate.id === verdict.cardId);
    if (card === undefined || card.status !== "inReview") return;
    const { headline, body } = verifierFeedback({
      card,
      verdict,
      scenarios: yield* holdouts.list(card.projectId),
    });
    yield* engine.dispatch({
      type: "card.activity.record",
      commandId: CommandId.make(`card-verifier-feedback:${verdict.verdictId}`),
      activityId: `card-verifier-feedback:${verdict.verdictId}`,
      cardId: card.id,
      kind: "message",
      author: { kind: "system", id: CHANNEL_SYSTEM_AUTHOR_ID },
      body,
      runThreadId: null,
      deliverTo: "builder",
      elicitation: null,
      answers: null,
      status: null,
      evidenceId: null,
      reason: { code: "verifierFailed", text: headline },
      createdAt: yield* nowIso,
    });
    yield* engine
      .dispatch({
        type: "card.work.return",
        commandId: CommandId.make(`card-verifier-return:${verdict.verdictId}`),
        cardId: card.id,
        reason: headline,
        round: "review",
      })
      .pipe(
        Effect.asVoid,
        // The project's review rounds are used up: the card waits for a person instead.
        Effect.catchTag("OrchestrationCommandInvariantError", (refusal) =>
          engine
            .dispatch({
              type: "card.pause.system",
              commandId: CommandId.make(`card-verifier-pause:${verdict.verdictId}`),
              cardId: card.id,
              reason: { code: "fixRoundsExhausted", text: refusal.detail },
            })
            .pipe(Effect.ignore),
        ),
      );
  });

  /** A verifier's turn ended or its session did, without the verdict that would have released it. */
  const onSession = Effect.fn("CardVerifierReactor.onSession")(function* (threadId: ThreadId) {
    const entry = [...verifying.entries()].find(([, current]) => current.threadId === threadId);
    if (entry === undefined) return;
    const [cardId, current] = entry;
    yield* release(cardId);
    const model = yield* readModel();
    const card = model.cards?.find((candidate) => candidate.id === cardId);
    if (card === undefined || card.status !== "inReview" || card.evidence?.headSha !== current.headSha) {
      return;
    }
    const agents = (model.agents ?? []).filter((agent) => agent.projectId === card.projectId);
    const builder = agents.find((agent) => agent.id === card.delegateAgentId);
    if (builder !== undefined && current.attempt < VERIFIER_AUTOMATIC_RERUNS) {
      return yield* startVerifier({
        card,
        builder,
        agents,
        headSha: current.headSha,
        trigger: current.trigger,
        attempt: current.attempt + 1,
      });
    }
    yield* raiseError(
      cardId,
      `${current.threadId}:ended`,
      "The verifier ended without a verdict; rerun it when you're ready.",
    );
  });

  /** After a restart no verifier session survives: verify what waits, and flag what was lost. */
  const recover = Effect.fn("CardVerifierReactor.recover")(function* () {
    const model = yield* readModel();
    const trigger = `recover-${yield* nowIso}`;
    for (const card of model.cards ?? []) {
      if (card.status !== "inReview") continue;
      if (card.verification.state === "running") {
        yield* raiseError(
          card.id,
          `lost:${card.verification.headSha ?? "none"}`,
          "The verifier was lost to a server restart; rerun it.",
        );
      } else {
        yield* verify(card.id, trigger);
      }
    }
  });

  const handle = (request: VerifierRequest) => {
    switch (request.kind) {
      case "verify":
        return verify(request.cardId, request.trigger);
      case "verdict":
        return onVerdict(request.verdict);
      case "session":
        return onSession(request.threadId);
      case "release":
        return release(request.cardId);
      case "recover":
        return recover();
    }
  };

  const worker = yield* makeDrainableWorker((request: VerifierRequest) =>
    handle(request).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("card verifier reactor request failed", {
              kind: request.kind,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "card.status-changed":
        return event.payload.to === "inReview"
          ? worker.enqueue({ kind: "verify", cardId: event.payload.cardId, trigger: event.eventId })
          : verifying.has(event.payload.cardId)
            ? worker.enqueue({ kind: "release", cardId: event.payload.cardId })
            : Effect.void;
      case "card.evidence-recorded":
      case "card.verifier-rerun-requested":
        return worker.enqueue({ kind: "verify", cardId: event.payload.cardId, trigger: event.eventId });
      case "card.verdict-recorded":
        return worker.enqueue({ kind: "verdict", verdict: event.payload.verdict });
      case "thread.session-set": {
        const change = runSessionChange(event.payload.session);
        const { threadId } = event.payload;
        return (change === "settled" || change === "ended") &&
          [...verifying.values()].some((current) => current.threadId === threadId)
          ? worker.enqueue({ kind: "session", threadId })
          : Effect.void;
      }
      default:
        return Effect.void;
    }
  };

  const start = Effect.fn("CardVerifierReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
    yield* worker.enqueue({ kind: "recover" });
  });

  return { start, drain: worker.drain } satisfies CardVerifierReactor["Service"];
});

export const layer = Layer.effect(CardVerifierReactor, make).pipe(
  Layer.provide(ProjectionCardRepositoryLive),
);
