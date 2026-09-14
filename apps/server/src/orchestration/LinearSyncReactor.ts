import {
  ApprovalRequestId,
  CardId,
  CommandId,
  MessageId,
  type CardLinearIssue,
  type CardStatus,
  type OrchestrationCard,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type ProjectId,
  type ThreadId,
} from "@iskra/contracts";
import { makeDrainableWorker } from "@iskra/shared/DrainableWorker";
import { resolveProjectSettings } from "@iskra/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import * as LinearClient from "../linear/LinearClient.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isFinishedCardStatus } from "./cardRules.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/** The Linear workflow state type a card's derived status shows as. */
const STATE_TYPE_BY_STATUS: Record<CardStatus, string> = {
  triage: "triage",
  ready: "unstarted",
  inProgress: "started",
  inReview: "started",
  landing: "started",
  landed: "completed",
  abandoned: "canceled",
};

const STATUS_LABEL: Record<CardStatus, string> = {
  triage: "in triage",
  ready: "ready",
  inProgress: "in progress",
  inReview: "in review",
  landing: "landing",
  landed: "landed",
  abandoned: "abandoned",
};

export function linearStateFor(
  states: ReadonlyArray<LinearClient.LinearWorkflowState>,
  status: CardStatus,
): LinearClient.LinearWorkflowState | undefined {
  const type = STATE_TYPE_BY_STATUS[status];
  // A team without a triage state keeps proposals in its backlog.
  return (
    states.find((state) => state.type === type) ??
    (type === "triage" ? states.find((state) => state.type === "backlog") : undefined)
  );
}

/**
 * Invariant 15: the only Linear moves that change a card are the human decisions they stand for.
 * Moving a triage issue to a to-do state approves the card; canceling it abandons the card.
 */
export function linearDecision(
  status: CardStatus,
  stateType: string,
): "card.approve" | "card.abandon" | null {
  if (stateType === "canceled") return isFinishedCardStatus(status) ? null : "card.abandon";
  return status === "triage" && stateType === "unstarted" ? "card.approve" : null;
}

/**
 * Merges one field three ways against the value of the last sync: the side that differs from it
 * changed it, and when both did, the later edit wins.
 */
export function mergeLinearField<T>(input: {
  readonly base: T;
  readonly linear: T;
  readonly iskra: T;
  readonly linearIsNewer: boolean;
}): { readonly value: T; readonly pull: boolean; readonly push: boolean } {
  const linearChanged = input.linear !== input.base;
  const iskraChanged = input.iskra !== input.base;
  const value = linearChanged && (!iskraChanged || input.linearIsNewer) ? input.linear : input.iskra;
  return { value, pull: value !== input.iskra, push: value !== input.linear };
}

const linkOf = (issue: LinearClient.LinearIssue): CardLinearIssue => ({
  id: issue.id,
  identifier: issue.identifier,
  url: issue.url,
  teamId: issue.teamId,
  title: issue.title,
  description: issue.description,
  stateId: issue.stateId,
  priority: issue.priority,
  commentsSyncedAt: issue.comments.at(-1)?.createdAt ?? null,
});

const linksEqual = (left: CardLinearIssue, right: CardLinearIssue) =>
  left.title === right.title &&
  left.description === right.description &&
  left.stateId === right.stateId &&
  left.priority === right.priority &&
  left.commentsSyncedAt === right.commentsSyncedAt;

/**
 * Two-way sync between cards and Linear issues, by polling so a server without a public URL works.
 * Each sweep brings in issues delegated to Iskra, opens issues for approved cards of projects with
 * a Linear team, and reconciles every linked card's title, spec, status and comments. A person's
 * comment on a card and a delegate's question go to Linear as they happen.
 */
export class LinearSyncReactor extends Context.Service<
  LinearSyncReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Runs a sweep now and waits for it and every queued push. */
    readonly syncNow: Effect.Effect<void>;
  }
>()("@iskra/cli/orchestration/LinearSyncReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const linear = yield* LinearClient.LinearClient;
  const crypto = yield* Crypto.Crypto;
  // Sync commands get fresh ids: the same change can recur, and a reused id would be a no-op.
  const freshCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:linear-${tag}:${uuid}`)),
    );

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning(message, { ...fields, cause: Cause.pretty(cause) });

  const dispatch = (command: OrchestrationCommand) => engine.dispatch(command).pipe(Effect.asVoid);

  /** The oldest message-mode question the session asked and nobody has answered yet. */
  const openQuestion = Effect.fn("LinearSyncReactor.openQuestion")(function* (threadId: ThreadId) {
    const thread = yield* snapshots.getThreadDetailById(threadId, {
      activityKinds: ["user-input.requested", "user-input.resolved"],
    });
    if (Option.isNone(thread)) return null;
    const requestIdOf = (payload: unknown) =>
      Predicate.isObject(payload) && typeof payload.requestId === "string" ? payload.requestId : null;
    const resolved = new Set(
      thread.value.activities
        .filter((activity) => activity.kind === "user-input.resolved")
        .map((activity) => requestIdOf(activity.payload)),
    );
    const open = thread.value.activities.find(
      (activity) =>
        activity.kind === "user-input.requested" &&
        Predicate.isObject(activity.payload) &&
        activity.payload.responseMode === "message" &&
        !resolved.has(requestIdOf(activity.payload)),
    );
    const requestId = open === undefined ? null : requestIdOf(open.payload);
    return requestId === null ? null : ApprovalRequestId.make(requestId);
  });

  const syncLinkedCard = Effect.fn("LinearSyncReactor.syncLinkedCard")(function* (input: {
    readonly card: OrchestrationCard;
    readonly link: CardLinearIssue;
    readonly issue: LinearClient.LinearIssue;
    readonly states: ReadonlyArray<LinearClient.LinearWorkflowState>;
    readonly viewerId: string;
    readonly ownerThreadId: ThreadId | null;
    readonly nowIso: string;
  }) {
    const { card, link, issue } = input;
    // A finished card is no longer edited; its last values stand in Linear.
    const finished = isFinishedCardStatus(card.status);
    const linearIsNewer = issue.updatedAt > card.updatedAt;
    const merge = <T>(base: T, linearValue: T, iskra: T) =>
      finished
        ? { value: iskra, pull: false, push: iskra !== linearValue }
        : mergeLinearField({ base, linear: linearValue, iskra, linearIsNewer });
    const titleMerge = merge(link.title, issue.title, card.title);
    // A card needs a title; an emptied Linear title is written back.
    const title =
      titleMerge.value.trim().length === 0
        ? { value: card.title, pull: false, push: true }
        : titleMerge;
    const description = merge(link.description, issue.description, card.spec);
    const priority = merge(link.priority, issue.priority, card.priority);

    const expected = linearStateFor(input.states, card.status);
    const linearMoved = issue.stateId !== link.stateId;
    let restoreStateId: string | null = null;
    if (expected !== undefined && issue.stateType !== expected.type) {
      const decision = linearMoved ? linearDecision(card.status, issue.stateType) : null;
      const decided =
        decision === null
          ? false
          : yield* dispatch({
              type: decision,
              commandId: yield* freshCommandId("decision"),
              cardId: card.id,
            }).pipe(
              Effect.as(true),
              Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.succeed(false)),
            );
      if (!decided) restoreStateId = expected.id;
    }

    const changes: LinearClient.LinearIssueChanges = {
      ...(title.push ? { title: title.value } : {}),
      ...(description.push ? { description: description.value } : {}),
      ...(priority.push ? { priority: priority.value } : {}),
      ...(restoreStateId !== null ? { stateId: restoreStateId } : {}),
    };
    if (Object.keys(changes).length > 0) yield* linear.updateIssue(issue.id, changes);
    if (restoreStateId !== null && linearMoved) {
      yield* linear.createComment(
        issue.id,
        `Iskra sets this issue's status from its card, which is ${STATUS_LABEL[card.status]}, so it was moved back. From Linear, moving a triage issue to a to-do state approves the card and canceling the issue abandons it; everything else follows the work.`,
      );
    }
    if (title.pull || description.pull || priority.pull) {
      yield* dispatch({
        type: "card.update",
        commandId: yield* freshCommandId("update"),
        cardId: card.id,
        ...(title.pull ? { title: title.value } : {}),
        ...(description.pull ? { spec: description.value } : {}),
        ...(priority.pull ? { priority: priority.value } : {}),
      });
    }

    const fresh = issue.comments.filter(
      (comment) =>
        comment.authorId !== input.viewerId &&
        (link.commentsSyncedAt === null || comment.createdAt > link.commentsSyncedAt),
    );
    // ponytail: the first new comment answers the delegate's open question, reply or not;
    // match Linear comment threads if people talk past the question.
    let question = input.ownerThreadId === null ? null : yield* openQuestion(input.ownerThreadId);
    for (const comment of fresh) {
      if (question !== null && input.ownerThreadId !== null) {
        yield* dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.make(`server:linear-answer:${comment.id}`),
          threadId: input.ownerThreadId,
          requestId: question,
          answers: { answer: comment.body },
          createdAt: input.nowIso,
        });
        question = null;
        continue;
      }
      yield* dispatch({
        type: "card.message.record",
        commandId: CommandId.make(`server:linear-comment:${comment.id}`),
        cardId: card.id,
        messageId: MessageId.make(`linear-comment:${comment.id}`),
        authorKind: "linear",
        authorId: comment.authorName,
        body: comment.body,
        runThreadId: null,
        forOwner: true,
        createdAt: comment.createdAt,
      });
    }

    const next: CardLinearIssue = {
      ...link,
      title: title.value,
      description: description.value,
      priority: priority.value,
      stateId: restoreStateId ?? issue.stateId,
      commentsSyncedAt: issue.comments.at(-1)?.createdAt ?? link.commentsSyncedAt,
    };
    if (!linksEqual(next, link)) {
      yield* dispatch({
        type: "card.linear.sync",
        commandId: yield* freshCommandId("sync"),
        cardId: card.id,
        issue: next,
        syncedAt: input.nowIso,
      });
    }
  });

  const sweep = Effect.fn("LinearSyncReactor.sweep")(function* () {
    if (!(yield* linear.configured)) return;
    const settings = yield* serverSettings.getSettings;
    const readModel = yield* snapshots.getCommandReadModel();
    const teamByProject = new Map<ProjectId, string>();
    const labelByProject = new Map<ProjectId, string>();
    for (const project of readModel.projects) {
      const resolved = resolveProjectSettings(settings, project.id).settings;
      const teamId = resolved.linearTeamId.trim();
      if (resolved.linearLabel.trim().length > 0) {
        labelByProject.set(project.id, resolved.linearLabel.trim());
      }
      if (teamId.length > 0 && project.deletedAt === null) teamByProject.set(project.id, teamId);
    }
    const cards = readModel.cards ?? [];
    const linkedCards = cards.filter((card) => card.linearIssue !== null);
    if (teamByProject.size === 0 && linkedCards.length === 0) return;

    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const viewerId = yield* linear.viewerId;
    const statesByTeam = new Map<string, ReadonlyArray<LinearClient.LinearWorkflowState>>();
    const statesOf = (teamId: string) =>
      Effect.suspend(() => {
        const cached = statesByTeam.get(teamId);
        return cached !== undefined
          ? Effect.succeed(cached)
          : linear
              .teamStates(teamId)
              .pipe(Effect.tap((states) => Effect.sync(() => statesByTeam.set(teamId, states))));
      });

    const projectByTeam = new Map(Array.from(teamByProject, ([projectId, teamId]) => [teamId, projectId]));
    const linkedIssueIds = new Set(linkedCards.map((card) => card.linearIssue!.id));
    const intake = (issue: LinearClient.LinearIssue, projectId: ProjectId) =>
      Effect.suspend(() => {
        if (linkedIssueIds.has(issue.id) || issue.title.trim().length === 0) return Effect.void;
        linkedIssueIds.add(issue.id);
        return dispatch({
          type: "card.linear.intake",
          commandId: CommandId.make(`server:linear-intake:${issue.id}`),
          cardId: CardId.make(`card-linear-${issue.id}`),
          projectId,
          title: issue.title.trim(),
          issue: linkOf(issue),
          // Delegating the issue to Iskra is a person's approval; a labeled issue waits in triage.
          delegated: issue.delegateId === viewerId,
          createdAt: nowIso,
        }).pipe(Effect.catchCause(logSkipped("Linear intake skipped", { issue: issue.identifier })));
      });
    for (const issue of yield* linear.delegatedIssues) {
      const projectId = projectByTeam.get(issue.teamId);
      if (projectId !== undefined) yield* intake(issue, projectId);
    }
    for (const [projectId, label] of labelByProject) {
      const teamId = teamByProject.get(projectId);
      if (teamId === undefined) continue;
      const labeled = yield* linear.labeledIssues(teamId, label).pipe(
        Effect.catchCause((cause) =>
          logSkipped("Linear label intake skipped", { projectId, label })(cause).pipe(
            Effect.as<ReadonlyArray<LinearClient.LinearIssue>>([]),
          ),
        ),
      );
      for (const issue of labeled) yield* intake(issue, projectId);
    }

    for (const card of cards) {
      const teamId = teamByProject.get(card.projectId);
      if (
        teamId === undefined ||
        card.linearIssue !== null ||
        card.status === "triage" ||
        isFinishedCardStatus(card.status) ||
        card.attemptGroupId !== null
      )
        continue;
      yield* Effect.gen(function* () {
        const state = linearStateFor(yield* statesOf(teamId), card.status);
        const issue = yield* linear.createIssue({
          teamId,
          title: card.title,
          description: card.spec,
          priority: card.priority,
          ...(state === undefined ? {} : { stateId: state.id }),
        });
        yield* dispatch({
          type: "card.linear.sync",
          commandId: yield* freshCommandId("link"),
          cardId: card.id,
          issue: linkOf(issue),
          syncedAt: nowIso,
        });
      }).pipe(Effect.catchCause(logSkipped("Linear issue creation skipped", { cardId: card.id })));
    }

    const issues = yield* linear.issuesByIds(linkedCards.map((card) => card.linearIssue!.id));
    const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
    for (const card of linkedCards) {
      const link = card.linearIssue!;
      const issue = issuesById.get(link.id);
      if (issue === undefined) continue;
      const ownerThreadId =
        (readModel.liveRuns ?? []).find((run) => run.cardId === card.id && run.role === "owner")
          ?.threadId ?? null;
      yield* statesOf(link.teamId).pipe(
        Effect.flatMap((states) =>
          syncLinkedCard({ card, link, issue, states, viewerId, ownerThreadId, nowIso }),
        ),
        Effect.catchCause(logSkipped("Linear card sync skipped", { cardId: card.id })),
      );
    }
  });

  /** A person's comment on a card, or a delegate's question, goes to the card's issue at once. */
  const push = Effect.fn("LinearSyncReactor.push")(function* (event: OrchestrationEvent) {
    if (!(yield* linear.configured)) return;
    if (event.type === "card.message-posted" && event.payload.authorKind === "human") {
      const card = yield* snapshots.getCardShellById(event.payload.cardId);
      if (Option.isNone(card) || card.value.linearIssue === null) return;
      yield* linear.createComment(card.value.linearIssue.id, `**From Iskra:** ${event.payload.body}`);
      return;
    }
    if (
      event.type !== "thread.activity-appended" ||
      event.payload.activity.kind !== "user-input.requested" ||
      !Predicate.isObject(event.payload.activity.payload) ||
      event.payload.activity.payload.responseMode !== "message"
    )
      return;
    const run = yield* snapshots.getRunByThreadId(event.payload.threadId);
    if (Option.isNone(run) || run.value.role !== "owner" || run.value.cardId === null) return;
    const card = yield* snapshots.getCardShellById(run.value.cardId);
    if (Option.isNone(card) || card.value.linearIssue === null) return;
    const agent = yield* snapshots.getAgentShellById(run.value.agentId);
    const questions = event.payload.activity.payload.questions;
    const text = Array.isArray(questions)
      ? questions
          .map((question) =>
            Predicate.isObject(question) && typeof question.question === "string" ? question.question : "",
          )
          .filter((question) => question.length > 0)
          .join("\n\n")
      : "";
    if (text.length === 0) return;
    const name = Option.match(agent, { onNone: () => "The delegate", onSome: (value) => `@${value.name}` });
    yield* linear.createComment(
      card.value.linearIssue.id,
      `**${name} asks:** ${text}\n\nReply here to answer.`,
    );
  });

  const worker = yield* makeDrainableWorker(
    (job: { readonly kind: "sweep" } | { readonly kind: "push"; readonly event: OrchestrationEvent }) =>
      (job.kind === "sweep" ? sweep() : push(job.event)).pipe(
        Effect.catchCause(logSkipped("Linear sync failed", { job: job.kind })),
      ),
  );

  const start: LinearSyncReactor["Service"]["start"] = Effect.fn("LinearSyncReactor.start")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* forkParked(
        Stream.runForEach(events, (event) =>
          event.type === "card.message-posted" || event.type === "thread.activity-appended"
            ? worker.enqueue({ kind: "push", event })
            : Effect.void,
        ),
      );
      yield* forkParked(
        worker.enqueue({ kind: "sweep" }).pipe(
          Effect.andThen(worker.drain),
          Effect.repeat(Schedule.spaced("1 minute")),
          Effect.asVoid,
        ),
      );
    },
  );

  return {
    start,
    syncNow: worker.enqueue({ kind: "sweep" }).pipe(Effect.andThen(worker.drain)),
  } satisfies LinearSyncReactor["Service"];
});

export const layer = Layer.effect(LinearSyncReactor, make);
