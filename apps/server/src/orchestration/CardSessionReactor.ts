import {
  CHANNEL_SYSTEM_AUTHOR_ID,
  CommandId,
  MessageId,
  ThreadId,
  type AgentId,
  type CardActivity,
  type CardCritiqueFocus,
  type CardId,
  type CardMove,
  type CardSessionRole,
  type OrchestrationAgent,
  type OrchestrationCard,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionCardRepositoryLive } from "../persistence/Layers/ProjectionCards.ts";
import { ProjectionRunLivenessRepositoryLive } from "../persistence/Layers/ProjectionRunLiveness.ts";
import { ProjectionCardRepository } from "../persistence/Services/ProjectionCards.ts";
import {
  ProjectionRunLivenessRepository,
  type ProjectionOwnerRun,
} from "../persistence/Services/ProjectionRunLiveness.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  buildCardBrief,
  diffStatOf,
  loadCardWorklog,
  renderCardActivities,
  renderCardBrief,
} from "./cardBrief.ts";
import { isFinishedCardStatus } from "./cardRules.ts";
import { cardRunStartCommands } from "./cardRunStart.ts";
import * as CardWorkspace from "./CardWorkspace.ts";
import { buildCoordinatorBrief } from "./coordinatorBrief.ts";
import { liveOwnerRun } from "./decider.ts";
import { errorText } from "./Errors.ts";
import { runSessionChange } from "./RunReactor.ts";
import { budgetHold, environmentSpendUsd } from "./watchdogRules.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Runs card sessions. A requested session (from the scheduler, or a person asking for a fresh one)
 * starts the card's owner in its worktree from a handoff brief (spec, decisions and diff).
 * Reassigning stops the idle owner session; the scheduler starts the new agent's once it has
 * ended, so a card never has two writers. An owner lost to an error or a server restart returns
 * its unread messages to the card and is restarted by the scheduler, until repeated losses pause
 * the card. A helper answers a question read-only; its answer joins the card's activity for the owner.
 *
 * Messages for the owner go in as its next turn once it is idle, never into a
 * running turn, and are `delivered` only once that turn runs. A message whose
 * turn never ran is `undelivered`; one still pending when the session ends
 * waits for the card's next owner session (invariant 10).
 *
 * A plan card's session is its coordinator: read-only, outside any worktree, briefed on its plan,
 * and handed what is meant for it (`deliverTo: coordinator`) as its next turn once idle.
 *
 * A card from a channel reports back there: its owner starting, asking something, sending it to
 * review, and its landing or being dropped. The notes wake no one.
 */
export class CardSessionReactor extends Context.Service<
  CardSessionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/CardSessionReactor") {}

type SessionStartEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "card.session-requested"
      | "card.helper-requested"
      | "card.critique-requested"
      | "card.spec-submitted";
  }
>;

/** What a critic the builder asked for is told to look at. */
const CRITIQUE_QUESTION: Record<CardCritiqueFocus, string> = {
  spec: "Critique the spec: what is missing, ambiguous or risky for the work as it stands?",
  diff: "Critique the diff: does it meet each acceptance criterion, and what would you change?",
};

/** The question a started session answers, if it was asked one. */
const questionOf = (event: SessionStartEvent): string | null =>
  event.type === "card.helper-requested"
    ? event.payload.question
    : event.type === "card.critique-requested"
      ? CRITIQUE_QUESTION[event.payload.focus]
      : null;

type CardSessionRequest =
  | { readonly kind: "assigned"; readonly cardId: CardId; readonly key: string }
  | { readonly kind: "session"; readonly role: CardSessionRole; readonly event: SessionStartEvent }
  | { readonly kind: "deliver"; readonly cardId: CardId }
  | { readonly kind: "deliverCoordinator"; readonly cardId: CardId }
  | { readonly kind: "deliverProject"; readonly projectId: OrchestrationCard["projectId"] }
  | { readonly kind: "finished"; readonly cardId: CardId; readonly key: string }
  | { readonly kind: "settled"; readonly threadId: ThreadId }
  | { readonly kind: "running"; readonly threadId: ThreadId }
  | { readonly kind: "ended"; readonly threadId: ThreadId; readonly failed: boolean }
  | { readonly kind: "progress"; readonly event: ProgressEvent };

type ProgressEvent = Extract<
  OrchestrationEvent,
  { type: "card.status-changed" | "card.activity-recorded" }
>;

const EPOCH = "1970-01-01T00:00:00.000Z";

/** What a status move says in the card's channel, given the card's title and its owner's @name. */
const PROGRESS_NOTES: Partial<Record<CardMove, (title: string, owner: string) => string>> = {
  workStarted: (title, owner) => `${owner} started work on ${title}`,
  requestReview: (title) => `${title} is ready for review`,
  landed: (title) => `${title} landed`,
  mergedOnHost: (title) => `${title} landed`,
  abandon: (title) => `${title} was dropped`,
};

/** An owner lost this many times within the window pauses its card instead of restarting. */
export const MAX_OWNER_RESTARTS_PER_HOUR = 3;

/** Restarts before a new owner session: one more than a previous owner that failed, else none. */
const restartsAfter = (previous: ProjectionOwnerRun | undefined) =>
  previous !== undefined && previous.sessionStatus === "error" ? previous.restarts + 1 : 0;

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const cards = yield* ProjectionCardRepository;
  const workspace = yield* CardWorkspace.CardWorkspace;
  const liveness = yield* ProjectionRunLivenessRepository;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Optional so the reactor builds without settings; the machine's budget then holds nothing.
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // ponytail: reads the whole command read model per request, like RunReactor; add
  // narrow card and live-run queries if card sessions become frequent enough to profile.
  const readModel = () => snapshotQuery.getCommandReadModel();

  const liveCardRuns = (cardId: CardId) =>
    readModel().pipe(
      Effect.map((model) => (model.liveRuns ?? []).filter((run) => run.cardId === cardId)),
    );

  /** Says on the card why a session did not start, instead of dropping it (invariant 4). */
  const postSystem = (cardId: CardId, key: string, body: string) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "card.activity.record",
        commandId: CommandId.make(`card-system:${key}`),
        activityId: `card-system:${key}`,
        cardId,
        kind: "error",
        author: { kind: "system", id: CHANNEL_SYSTEM_AUTHOR_ID },
        body,
        runThreadId: null,
        deliverTo: null,
        elicitation: null,
        answers: null,
        status: null,
        evidenceId: null,
        reason: { code: "startFailed", text: body },
        createdAt: yield* nowIso,
      });
    });

  const stopSession = (threadId: ThreadId, key: string) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make(`card-session-stop:${key}`),
        threadId,
        createdAt: yield* nowIso,
      });
    });

  const startCoordinator = Effect.fn("CardSessionReactor.startCoordinator")(function* (
    card: OrchestrationCard,
    agent: OrchestrationAgent,
    model: OrchestrationReadModel,
    key: string,
  ) {
    const { baseBranch } = yield* workspace.diff(card.id);
    const { context, rendered } = buildCoordinatorBrief({
      agent,
      card,
      agents: (model.agents ?? []).filter((candidate) => candidate.projectId === card.projectId),
      children: (model.cards ?? []).filter(
        (child) => child.parentCardId === card.id && child.planKey !== null,
      ),
      activities: yield* cards.listActivities({ cardId: card.id, limit: 200 }),
      baseBranch,
    });
    for (const command of cardRunStartCommands({
      key,
      card,
      agent,
      role: "coordinator",
      modelSelection: agent.modelSelection,
      capabilities: ["read"],
      context,
      rendered,
      restarts: 0,
      startedAt: yield* nowIso,
    })) {
      yield* engine.dispatch(command);
    }
  });

  const startSessionUnsafe = Effect.fn("CardSessionReactor.startSession")(function* (input: {
    readonly cardId: CardId;
    readonly agentId: AgentId;
    readonly role: CardSessionRole;
    readonly key: string;
    readonly question: string | null;
  }) {
    const model = yield* readModel();
    const card = model.cards?.find((candidate) => candidate.id === input.cardId);
    const agent = model.agents?.find((candidate) => candidate.id === input.agentId);
    const project = model.projects.find((candidate) => candidate.id === card?.projectId);
    if (card === undefined || agent === undefined || project === undefined) {
      return yield* Effect.logWarning("card session reactor could not resolve a session", input);
    }
    if (input.role === "owner" && card.kind === "plan") {
      yield* startCoordinator(card, agent, model, input.key);
      if (card.status === "ready") {
        yield* engine.dispatch({
          type: "card.work.start",
          commandId: CommandId.make(`card-work-start:${input.key}`),
          cardId: card.id,
        });
      }
      return;
    }
    // The owner writes in the card's worktree, created now if this is the first session.
    const current =
      input.role === "owner" ? { ...card, ...(yield* workspace.ensure(card.id)) } : card;
    const { baseBranch, diff } = yield* workspace.diff(card.id);
    const restarts =
      input.role === "owner"
        ? restartsAfter((yield* liveness.listCardOwnerRuns({ cardId: card.id, since: EPOCH }))[0])
        : 0;
    // The brief is the card's worklog: its activity, latest evidence and the repository's rules.
    const worklog = yield* loadCardWorklog({
      card: current,
      root: current.worktreePath ?? project.workspaceRoot,
      restarts,
      project,
      diff,
    }).pipe(
      Effect.provideService(ProjectionCardRepository, cards),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const context = buildCardBrief({
      agent,
      role: input.role,
      card: current,
      agents: (model.agents ?? []).filter((candidate) => candidate.projectId === card.projectId),
      decisions: [],
      baseBranch,
      diff,
      question: input.question,
      worklog,
    });
    const rendered = renderCardBrief(context);
    for (const command of cardRunStartCommands({
      key: input.key,
      card: current,
      agent,
      role: input.role,
      modelSelection: agent.modelSelection,
      // A helper reads; the owner gets whatever its agent is allowed.
      capabilities: input.role === "owner" ? agent.capabilities : ["read"],
      context,
      rendered,
      restarts,
      startedAt: yield* nowIso,
    })) {
      yield* engine.dispatch(command);
    }
    if (input.role === "owner" && card.status === "ready") {
      yield* engine.dispatch({
        type: "card.work.start",
        commandId: CommandId.make(`card-work-start:${input.key}`),
        cardId: card.id,
      });
    }
  });

  /**
   * Says on the card why a session did not start, instead of dropping it (invariant 4). An owner's
   * failure is a typed wait the scheduler retries; a helper's or critic's is a note on the card.
   */
  const startSession = (input: Parameters<typeof startSessionUnsafe>[0]) =>
    startSessionUnsafe(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        const message = errorText(Cause.squash(cause));
        return input.role === "owner"
          ? Effect.gen(function* () {
              yield* engine.dispatch({
                type: "card.wait.note",
                commandId: CommandId.make(`card-start-failed:${input.key}`),
                cardId: input.cardId,
                threadId: null,
                reason: { code: "startFailed", text: `The session could not start: ${message}` },
                notedAt: yield* nowIso,
              });
            })
          : postSystem(input.cardId, input.key, `A ${input.role} could not start: ${message}`);
      }),
    );

  const onAssigned = Effect.fn("CardSessionReactor.onAssigned")(function* (
    cardId: CardId,
    key: string,
  ) {
    const model = yield* readModel();
    const card = model.cards?.find((candidate) => candidate.id === cardId);
    if (card === undefined || isFinishedCardStatus(card.status)) {
      return;
    }
    // Hand off: the scheduler starts the new agent once this session has ended.
    const owner = liveOwnerRun(model, cardId);
    if (owner !== undefined && owner.agentId !== card.delegateAgentId) {
      yield* stopSession(owner.threadId, key);
    }
  });

  const deliverToOwner = Effect.fn("CardSessionReactor.deliverToOwner")(function* (cardId: CardId) {
    const owner = liveOwnerRun(yield* readModel(), cardId);
    if (owner === undefined) {
      return;
    }
    const thread = yield* snapshotQuery.getThreadShellById(owner.threadId);
    const session = Option.isSome(thread) ? thread.value.session : null;
    // Only into an idle session; a running turn takes the messages when it settles.
    if (session === null || session.status !== "ready" || session.activeTurnId !== null) {
      return;
    }
    const open = yield* cards.listOpenBuilderActivities({ cardId });
    if (open.some((activity) => activity.deliveryThreadId === owner.threadId)) {
      return; // A turn carrying earlier messages is already on its way.
    }
    yield* sendTurn(
      cardId,
      owner.threadId,
      open.filter((activity) => activity.delivery === "pending"),
    );
  });

  /** A live coordinator run on the card, if it has one. */
  const liveCoordinatorRun = (model: OrchestrationReadModel, cardId: CardId) =>
    (model.liveRuns ?? []).find((run) => run.cardId === cardId && run.role === "coordinator");

  const openCoordinatorActivities = (cardId: CardId) =>
    cards
      .listActivities({ cardId, limit: 200 })
      .pipe(
        Effect.map((activities) =>
          activities.filter(
            (activity) =>
              activity.deliverTo === "coordinator" &&
              (activity.delivery === "pending" || activity.delivery === "sent"),
          ),
        ),
      );

  const deliverToCoordinator = Effect.fn("CardSessionReactor.deliverToCoordinator")(function* (
    cardId: CardId,
  ) {
    const coordinator = liveCoordinatorRun(yield* readModel(), cardId);
    if (coordinator === undefined) {
      return;
    }
    const thread = yield* snapshotQuery.getThreadShellById(coordinator.threadId);
    const session = Option.isSome(thread) ? thread.value.session : null;
    if (session === null || session.status !== "ready" || session.activeTurnId !== null) {
      return;
    }
    const open = yield* openCoordinatorActivities(cardId);
    // A card has one coordinator, so anything sent is on its way to this session.
    if (open.some((activity) => activity.delivery === "sent")) {
      return;
    }
    yield* sendTurn(cardId, coordinator.threadId, open);
  });

  /** Sends waiting messages as one turn of an idle session and marks them sent. */
  const sendTurn = Effect.fn("CardSessionReactor.sendTurn")(function* (
    cardId: CardId,
    threadId: ThreadId,
    waiting: ReadonlyArray<Pick<CardActivity, "activityId" | "author" | "body" | "createdAt">>,
  ) {
    if (waiting.length === 0) {
      return;
    }
    const model = yield* readModel();
    // Past a monthly budget the messages wait: raising the cap delivers them (see deliverProject).
    const project = model.projects.find(
      (candidate) => candidate.id === model.cards?.find((card) => card.id === cardId)?.projectId,
    );
    const run = model.liveRuns?.find((candidate) => candidate.threadId === threadId);
    const now = yield* nowIso;
    const environmentBudgetUsd = Option.isSome(settings)
      ? ((yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => null)))?.cardRuntime
          .monthlyBudgetUsd ?? null)
      : null;
    const held =
      project === undefined
        ? null
        : budgetHold({
            project,
            agent: model.agents?.find((agent) => agent.id === run?.agentId) ?? null,
            environmentBudgetUsd,
            environmentSpentUsd: environmentSpendUsd(model.projects, now),
            now,
          });
    if (held !== null) {
      return yield* Effect.logInfo("card messages wait for the monthly budget", {
        cardId,
        reason: held.text,
      });
    }
    const messageIds = waiting.map((activity) => MessageId.make(activity.activityId));
    // Each attempt gets its own id: a turn refused at the budget cap is tried again after a
    // raise, and the engine never re-decides a rejected command id. Sent messages are skipped,
    // so a repeated attempt cannot deliver twice.
    const attempt = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const key = `${threadId}:${messageIds.join(",")}:${attempt}`;
    const createdAt = yield* nowIso;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`card-owner-turn:${key}`),
      threadId: threadId,
      message: {
        messageId: MessageId.make(`card-owner-turn:${key}`),
        role: "user",
        text: renderCardActivities(waiting, model.agents ?? []),
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt,
    });
    yield* engine.dispatch({
      type: "card.delivery.update",
      commandId: CommandId.make(`card-delivery:sent:${key}`),
      cardId,
      messageIds,
      status: "sent",
      threadId: threadId,
      updatedAt: createdAt,
    });
  });

  const updateThreadDeliveries = (
    cardId: CardId,
    threadId: ThreadId,
    status: "pending" | "delivered" | "undelivered",
    to: "builder" | "coordinator" = "builder",
  ) =>
    Effect.gen(function* () {
      const sent =
        to === "coordinator"
          ? (yield* openCoordinatorActivities(cardId)).filter(
              (activity) => activity.delivery === "sent",
            )
          : (yield* cards.listOpenBuilderActivities({ cardId })).filter(
              (activity) => activity.delivery === "sent" && activity.deliveryThreadId === threadId,
            );
      if (sent.length === 0) {
        return;
      }
      const messageIds = sent.map((activity) => MessageId.make(activity.activityId));
      yield* engine.dispatch({
        type: "card.delivery.update",
        commandId: CommandId.make(`card-delivery:${status}:${threadId}:${messageIds.join(",")}`),
        cardId,
        messageIds,
        status,
        threadId,
        updatedAt: yield* nowIso,
      });
    });

  /** Records the card's diff size for its face; a failed measurement keeps the last one. */
  const measureDiff = (cardId: CardId, threadId: ThreadId) =>
    Effect.gen(function* () {
      const { diff } = yield* workspace.diff(cardId);
      const measuredAt = yield* nowIso;
      yield* engine.dispatch({
        type: "card.diff.record",
        commandId: CommandId.make(`card-diff:${threadId}:${measuredAt}`),
        cardId,
        diffStat: diffStatOf(diff),
        measuredAt,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("card diff could not be measured", { cardId, error: error.message }),
      ),
    );

  const settleTurn = Effect.fn("CardSessionReactor.settleTurn")(function* (threadId: ThreadId) {
    const run = yield* snapshotQuery.getRunByThreadId(threadId);
    if (Option.isNone(run) || run.value.cardId === null) {
      return;
    }
    const { cardId, agentId, role } = run.value;
    if (role === "owner") {
      yield* measureDiff(cardId, threadId);
      return yield* deliverToOwner(cardId);
    }
    // A verifier answers through record_verdict; CardVerifierReactor settles its session.
    if (role === "verifier") {
      return;
    }
    // A coordinator answers through its tools and stays up for what its plan's children send it.
    if (role === "coordinator") {
      return yield* deliverToCoordinator(cardId);
    }
    const thread = yield* snapshotQuery.getThreadDetailById(threadId, { activityKinds: [] });
    const turnId = Option.isSome(thread) ? thread.value.latestTurn?.turnId : undefined;
    if (Option.isNone(thread) || turnId === undefined) {
      return;
    }
    const reply = thread.value.messages.findLast(
      (message) =>
        message.role === "assistant" && message.turnId === turnId && message.text.trim().length > 0,
    );
    if (reply !== undefined) {
      // A helper's answer waits for the owner, and so does a critique while the owner is at work;
      // a spec critique before work starts stays on the card.
      const building =
        (yield* readModel()).cards?.find((candidate) => candidate.id === cardId)?.status ===
        "inProgress";
      yield* engine.dispatch({
        type: "card.activity.record",
        commandId: CommandId.make(`card-${role}-reply:${threadId}:${turnId}`),
        activityId: `card-${role}-reply:${threadId}:${turnId}`,
        cardId,
        kind: role === "helper" ? "help" : "critique",
        author: { kind: "agent", id: agentId },
        body: reply.text,
        runThreadId: threadId,
        deliverTo: role === "helper" || building ? "builder" : null,
        elicitation: null,
        answers: null,
        status: null,
        evidenceId: null,
        reason: null,
        createdAt: yield* nowIso,
      });
    }
    yield* stopSession(threadId, `${threadId}:${turnId}`);
  });

  const markDelivered = Effect.fn("CardSessionReactor.markDelivered")(function* (
    threadId: ThreadId,
  ) {
    const run = yield* snapshotQuery.getRunByThreadId(threadId);
    if (
      Option.isSome(run) &&
      run.value.cardId !== null &&
      (run.value.role === "owner" || run.value.role === "coordinator")
    ) {
      yield* updateThreadDeliveries(
        run.value.cardId,
        threadId,
        "delivered",
        run.value.role === "owner" ? "builder" : "coordinator",
      );
    }
  });

  /**
   * An owner session ended. A reassignment waiting for it is the scheduler's to start. One lost to
   * an error or a restart hands its unread messages back to the card, and the scheduler restarts
   * the card from its brief, unless the owner failed more than MAX_OWNER_RESTARTS_PER_HOUR times
   * in the last hour, which pauses the card for a person instead.
   */
  const endSession = Effect.fn("CardSessionReactor.endSession")(function* (
    threadId: ThreadId,
    failed: boolean,
  ) {
    const run = yield* snapshotQuery.getRunByThreadId(threadId);
    if (Option.isSome(run) && run.value.cardId !== null && run.value.role === "coordinator") {
      // Unread messages wait for the coordinator the scheduler starts next.
      const planCardId = run.value.cardId;
      const plan = (yield* readModel()).cards?.find((candidate) => candidate.id === planCardId);
      return yield* updateThreadDeliveries(
        planCardId,
        threadId,
        plan === undefined || isFinishedCardStatus(plan.status) ? "undelivered" : "pending",
        "coordinator",
      );
    }
    if (Option.isNone(run) || run.value.cardId === null || run.value.role !== "owner") {
      return;
    }
    const { cardId } = run.value;
    const card = (yield* readModel()).cards?.find((candidate) => candidate.id === cardId);
    const lost = failed && card !== undefined && !isFinishedCardStatus(card.status);
    yield* updateThreadDeliveries(cardId, threadId, lost ? "pending" : "undelivered");
    if (!lost || card.paused !== null || card.status === "inReview" || card.status === "landing") {
      return;
    }
    const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 1 }));
    const failures = (yield* liveness.listCardOwnerRuns({ cardId, since })).filter(
      (owner) => owner.sessionStatus === "error",
    ).length;
    if (failures <= MAX_OWNER_RESTARTS_PER_HOUR) {
      return;
    }
    yield* engine.dispatch({
      type: "card.pause.system",
      commandId: CommandId.make(`card-session-failed:${threadId}`),
      cardId,
      reason: {
        code: "sessionFailed",
        text: `The agent's session failed ${failures} times in the last hour; resume the card to try again.`,
      },
    });
  });

  /**
   * Posts a card's progress in the channel it came from. The message id derives from the event, so
   * a replayed event posts once; a channel archived since is skipped.
   */
  const postProgress = Effect.fn("CardSessionReactor.postProgress")(function* (
    event: ProgressEvent,
  ) {
    let cardId: CardId;
    let marker = "card-progress";
    let note: (title: string, owner: string) => string;
    if (event.type === "card.status-changed") {
      const moveNote = PROGRESS_NOTES[event.payload.move];
      if (moveNote === undefined) {
        return;
      }
      cardId = event.payload.cardId;
      note = moveNote;
    } else {
      const activity = event.payload;
      const question = activity.elicitation?.question ?? activity.body;
      if (activity.kind !== "elicitation" || activity.author.kind !== "agent") {
        return;
      }
      cardId = activity.cardId;
      marker = "card-question";
      note = (_title, owner) => `${owner} asks: ${question}`;
    }
    const model = yield* readModel();
    const card = model.cards?.find((candidate) => candidate.id === cardId);
    // Attempts run beside their card; only the card itself reports to the channel.
    if (card === undefined || card.channelId === null || card.attemptGroupId !== null) {
      return;
    }
    const owner = model.agents?.find((agent) => agent.id === card.delegateAgentId)?.name;
    yield* engine
      .dispatch({
        type: "channel.message.system.post",
        commandId: CommandId.make(`card-progress:${event.eventId}`),
        channelId: card.channelId,
        messageId: MessageId.make(`${event.eventId}:${marker}:${card.id}`),
        body: note(card.title, owner === undefined ? "Its agent" : `@${owner}`),
        createdAt: yield* nowIso,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("card progress was not posted", {
            cardId: card.id,
            error: error.message,
          }),
        ),
      );
  });

  const handle = (request: CardSessionRequest) => {
    switch (request.kind) {
      case "assigned":
        return onAssigned(request.cardId, request.key);
      case "session": {
        const { event } = request;
        return startSession({
          cardId: event.payload.cardId,
          agentId: event.payload.agentId,
          role: request.role,
          key: event.eventId,
          question: questionOf(event),
        });
      }
      case "deliver":
        return deliverToOwner(request.cardId);
      case "deliverCoordinator":
        return deliverToCoordinator(request.cardId);
      case "deliverProject":
        return readModel().pipe(
          Effect.flatMap((model) =>
            Effect.forEach(
              (model.liveRuns ?? []).flatMap((run) =>
                run.cardId !== null &&
                model.cards?.find((card) => card.id === run.cardId)?.projectId === request.projectId
                  ? [
                      run.role === "coordinator"
                        ? deliverToCoordinator(run.cardId)
                        : run.role === "owner"
                          ? deliverToOwner(run.cardId)
                          : Effect.void,
                    ]
                  : [],
              ),
              (deliver) => deliver,
              { discard: true },
            ),
          ),
        );
      case "finished":
        return liveCardRuns(request.cardId).pipe(
          Effect.flatMap((runs) =>
            Effect.forEach(
              runs,
              (run) => stopSession(run.threadId, `${request.key}:${run.threadId}`),
              {
                discard: true,
              },
            ),
          ),
        );
      case "settled":
        return settleTurn(request.threadId);
      case "running":
        return markDelivered(request.threadId);
      case "ended":
        return endSession(request.threadId, request.failed);
      case "progress":
        return postProgress(request.event);
    }
  };

  const worker = yield* makeDrainableWorker((request: CardSessionRequest) =>
    handle(request).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("card session reactor request failed", {
              kind: request.kind,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "card.delegate-changed":
        return worker.enqueue({
          kind: "assigned",
          cardId: event.payload.cardId,
          key: event.eventId,
        });
      case "card.session-requested":
        return worker.enqueue({ kind: "session", role: "owner", event });
      case "card.helper-requested":
        return worker.enqueue({ kind: "session", role: "helper", event });
      case "card.critique-requested":
      case "card.spec-submitted":
        return worker.enqueue({ kind: "session", role: "critic", event });
      case "card.activity-recorded": {
        const deliver =
          event.payload.deliverTo === "builder"
            ? worker.enqueue({ kind: "deliver", cardId: event.payload.cardId })
            : event.payload.deliverTo === "coordinator"
              ? worker.enqueue({ kind: "deliverCoordinator", cardId: event.payload.cardId })
              : Effect.void;
        // An agent's question is worth a note in the card's channel.
        return event.payload.kind === "elicitation" && event.payload.author.kind === "agent"
          ? Effect.andThen(deliver, worker.enqueue({ kind: "progress", event }))
          : deliver;
      }
      // A raised cap or an accepted model lets the card spend again. Starting a session, here or
      // after returnToWork or the plan gate, is the scheduler's.
      case "card.budget-set":
      case "card.unpriced-accepted":
        return worker.enqueue({ kind: "deliver", cardId: event.payload.cardId });
      // A raised monthly budget lets the project's card sessions take their waiting messages.
      case "project.orchestration-set":
        return worker.enqueue({ kind: "deliverProject", projectId: event.payload.projectId });
      case "card.status-changed": {
        const progress = worker.enqueue({ kind: "progress", event });
        return isFinishedCardStatus(event.payload.to)
          ? Effect.andThen(
              progress,
              worker.enqueue({
                kind: "finished",
                cardId: event.payload.cardId,
                key: event.eventId,
              }),
            )
          : progress;
      }
      case "thread.session-set": {
        const { session, threadId } = event.payload;
        const kind = runSessionChange(session);
        return kind === null
          ? Effect.void
          : worker.enqueue(
              kind === "ended"
                ? { kind, threadId, failed: session.status === "error" }
                : { kind, threadId },
            );
      }
      default:
        return Effect.void;
    }
  };

  const start = Effect.fn("CardSessionReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain: worker.drain } satisfies CardSessionReactor["Service"];
});

export const layer = Layer.effect(CardSessionReactor, make).pipe(
  Layer.provide(ProjectionCardRepositoryLive),
  Layer.provide(ProjectionRunLivenessRepositoryLive),
);
