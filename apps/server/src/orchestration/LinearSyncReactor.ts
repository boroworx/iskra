import {
  AgentId,
  ApprovalRequestId,
  CardId,
  CHANNEL_SYSTEM_AUTHOR_ID,
  CommandId,
  MessageId,
  CardLinearIssue,
  type CardActivity,
  type CardCriterion,
  type CardStatus,
  type OrchestrationCard,
  type OrchestrationCardShell,
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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as LinearClient from "../linear/LinearClient.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isFinishedCardStatus } from "./cardRules.ts";
import { liveOwnerRun } from "./decider.ts";
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

const CRITERIA_BLOCK_HEADING = "## Acceptance criteria (from Iskra)";
const CRITERIA_BLOCK_FOOTER = "_Managed by Iskra: edit them on the card._";
const CRITERIA_BLOCK = /\s*## Acceptance criteria \(from Iskra\)[\s\S]*?_Managed by Iskra: edit them on the card\._\s*/;

/** An issue description without the criteria block Iskra keeps in it. */
export const withoutCriteriaBlock = (description: string): string =>
  description.replace(CRITERIA_BLOCK, "");

/**
 * The acceptance criteria an issue's description lists: the items under an "Acceptance criteria"
 * or "Definition of done" heading, else its checklist items. Iskra's own criteria block is ignored.
 */
export function criteriaFromDescription(description: string): ReadonlyArray<CardCriterion> {
  const lines = withoutCriteriaBlock(description).split("\n");
  const heading =
    /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:acceptance criteria|definition of done)\s*(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*$/i;
  const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/;
  const checklistItem = /^\s*[-*+]\s+\[[ xX]\]\s+(.*\S)\s*$/;
  let texts: Array<string> = [];
  const start = lines.findIndex((line) => heading.test(line));
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (/^\s*#{1,6}\s/.test(line)) break;
      const match = item.exec(line);
      if (match !== null) texts.push(match[1]!);
      else if (line.trim().length > 0 && texts.length > 0) break;
    }
  }
  if (texts.length === 0) {
    texts = lines.flatMap((line) => {
      const match = checklistItem.exec(line);
      return match === null ? [] : [match[1]!];
    });
  }
  return texts
    .slice(0, 10)
    .map((text, index) => ({ id: `c${index + 1}`, text, verification: "automated" as const }));
}

/**
 * The description Linear shows: the card's spec, then its criteria in a block Iskra manages. The
 * block is left out when the spec already lists the same criteria, or when there are none.
 */
export function withCriteriaBlock(spec: string, criteria: ReadonlyArray<CardCriterion>): string {
  const listed = criteriaFromDescription(spec).map((criterion) => criterion.text);
  if (
    criteria.length === 0 ||
    (listed.length === criteria.length && criteria.every((criterion, index) => criterion.text === listed[index]))
  ) {
    return spec;
  }
  const block = [
    CRITERIA_BLOCK_HEADING,
    criteria.map((criterion) => `- ${criterion.text}`).join("\n"),
    CRITERIA_BLOCK_FOOTER,
  ].join("\n\n");
  return spec.trim().length === 0 ? block : `${spec}\n\n${block}`;
}

export const CRITERIA_QUESTION =
  "What should be true when this is done? Add an \"Acceptance criteria\" list to the issue description, or set the criteria on the card; work starts once it has them.";

/** How a card activity shows in its Linear agent session, or null when it doesn't. */
export function linearActivityOf(activity: CardActivity): LinearClient.LinearAgentActivityContent | null {
  switch (activity.kind) {
    case "decision":
    case "plan":
    case "critique":
    case "help":
      return { type: "thought", body: activity.body };
    case "message":
      // A person's message goes to Linear as a comment; its agent's replies go as responses.
      return activity.author.kind === "human" || activity.author.kind === "linear"
        ? null
        : { type: "thought", body: activity.body };
    case "elicitation": {
      const elicitation = activity.elicitation;
      const options =
        elicitation === null || elicitation.options.length === 0
          ? ""
          : `\n\n${elicitation.options
              .map(
                (option) =>
                  `- ${option.label}${option.id === elicitation.recommendedOptionId ? " (recommended)" : ""}`,
              )
              .join("\n")}`;
      return { type: "elicitation", body: `${elicitation?.question ?? activity.body}${options}` };
    }
    case "error":
      return { type: "error", body: activity.body };
    default:
      return null;
  }
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
  agentSessionId: null,
  promptsSyncedAt: null,
});

const linksEqual = Schema.toEquivalence(CardLinearIssue);

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
  const backgroundPolicy = yield* Effect.serviceOption(BackgroundPolicy.BackgroundPolicy);
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
  /** Logs a skipped step and carries on with `fallback`. */
  const orSkipped =
    <A>(fallback: A, message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>) =>
      logSkipped(message, fields)(cause).pipe(Effect.as(fallback));

  const dispatch = (command: OrchestrationCommand) => engine.dispatch(command).pipe(Effect.asVoid);
  /** Dispatches a command; false when the decider refuses it. */
  const tryDispatch = (command: OrchestrationCommand) =>
    dispatch(command).pipe(
      Effect.as(true),
      Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.succeed(false)),
    );

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
    // The criteria block is Iskra's own; the spec merges without it.
    const description = merge(link.description, withoutCriteriaBlock(issue.description), card.spec);
    const priority = merge(link.priority, issue.priority, card.priority);
    const derivedCriteria =
      finished || card.acceptance.criteria.length > 0 ? [] : criteriaFromDescription(description.value);
    const criteria = derivedCriteria.length > 0 ? derivedCriteria : card.acceptance.criteria;
    const linearDescription = withCriteriaBlock(description.value, criteria);

    const expected = linearStateFor(input.states, card.status);
    const linearMoved = issue.stateId !== link.stateId;
    let restoreStateId: string | null = null;
    if (expected !== undefined && issue.stateType !== expected.type) {
      const decision = linearMoved ? linearDecision(card.status, issue.stateType) : null;
      const decided =
        decision === null
          ? false
          : yield* tryDispatch({
              type: decision,
              commandId: yield* freshCommandId("decision"),
              cardId: card.id,
            });
      if (!decided) restoreStateId = expected.id;
    }

    const changes: LinearClient.LinearIssueChanges = {
      ...(title.push ? { title: title.value } : {}),
      ...(linearDescription !== issue.description ? { description: linearDescription } : {}),
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
    // A card from Linear without criteria takes the ones its issue lists once someone adds them.
    if (derivedCriteria.length > 0) {
      yield* tryDispatch({
        type: "card.criteria.set",
        commandId: yield* freshCommandId("criteria"),
        cardId: card.id,
        criteria: derivedCriteria,
      });
    }

    const freshComments = issue.comments.filter(
      (comment) =>
        comment.authorId !== input.viewerId &&
        (link.commentsSyncedAt === null || comment.createdAt > link.commentsSyncedAt),
    );
    const prompts =
      link.agentSessionId === null
        ? []
        : yield* linear.agentPrompts(link.agentSessionId).pipe(
            Effect.catchCause(orSkipped([], "Linear agent prompts skipped", { cardId: card.id })),
          );
    // A prompt written as a comment already arrives with the comments.
    const freshPrompts = prompts.filter(
      (prompt) =>
        prompt.sourceCommentId === null &&
        (link.promptsSyncedAt === null || prompt.createdAt > link.promptsSyncedAt),
    );
    const replies = [
      ...freshComments.map((comment) => ({ key: `comment:${comment.id}`, ...comment })),
      ...freshPrompts.map((prompt) => ({ key: `prompt:${prompt.id}`, ...prompt })),
    ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
    // ponytail: the first new reply answers the delegate's open question, whether or not it was
    // written as an answer; match Linear threads if people talk past the question.
    let question = input.ownerThreadId === null ? null : yield* openQuestion(input.ownerThreadId);
    for (const reply of replies) {
      if (question !== null && input.ownerThreadId !== null) {
        const answered = yield* tryDispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.make(`server:linear-answer:${reply.key}`),
          threadId: input.ownerThreadId,
          requestId: question,
          answers: { answer: reply.body },
          createdAt: input.nowIso,
        });
        question = null;
        if (answered) continue;
      }
      yield* dispatch({
        type: "card.message.record",
        commandId: CommandId.make(`server:linear-${reply.key}`),
        cardId: card.id,
        messageId: MessageId.make(`linear-${reply.key}`),
        authorKind: "linear",
        authorId: reply.authorName,
        body: reply.body,
        runThreadId: null,
        forOwner: true,
        createdAt: reply.createdAt,
      });
    }

    const next: CardLinearIssue = {
      ...link,
      title: title.value,
      description: description.value,
      priority: priority.value,
      stateId: restoreStateId ?? issue.stateId,
      commentsSyncedAt: issue.comments.at(-1)?.createdAt ?? link.commentsSyncedAt,
      promptsSyncedAt: prompts.at(-1)?.createdAt ?? link.promptsSyncedAt,
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
        const cardId = CardId.make(`card-linear-${issue.id}`);
        // Delegating the issue to Iskra is a person's approval; a labeled issue waits in triage.
        const delegated = issue.delegateId === viewerId;
        const criteria = criteriaFromDescription(issue.description);
        return Effect.gen(function* () {
          yield* dispatch({
            type: "card.linear.intake",
            commandId: CommandId.make(`server:linear-intake:${issue.id}`),
            cardId,
            projectId,
            title: issue.title.trim(),
            issue: linkOf(issue),
            delegated,
            createdAt: nowIso,
          });
          if (criteria.length > 0) {
            // Confirmed on a delegated card: the requester wrote them and delegating approved it.
            yield* dispatch({
              type: "card.criteria.set",
              commandId: CommandId.make(`server:linear-intake-criteria:${issue.id}`),
              cardId,
              criteria,
            });
          } else if (delegated) {
            yield* dispatch({
              type: "card.activity.record",
              commandId: CommandId.make(`server:linear-criteria-ask:${issue.id}`),
              activityId: `linear-criteria-ask:${issue.id}`,
              cardId,
              kind: "elicitation",
              author: { kind: "system", id: CHANNEL_SYSTEM_AUTHOR_ID },
              body: CRITERIA_QUESTION,
              runThreadId: null,
              deliverTo: null,
              elicitation: null,
              answers: null,
              status: null,
              evidenceId: null,
              reason: { code: "criteriaMissing", text: "The issue lists no acceptance criteria." },
              createdAt: nowIso,
            });
          }
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
        Effect.catchCause(orSkipped([], "Linear label intake skipped", { projectId, label })),
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
          description: withCriteriaBlock(card.spec, card.acceptance.criteria),
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
      const ownerThreadId = liveOwnerRun(readModel, card.id)?.threadId ?? null;
      yield* statesOf(link.teamId).pipe(
        Effect.flatMap((states) =>
          syncLinkedCard({ card, link, issue, states, viewerId, ownerThreadId, nowIso }),
        ),
        Effect.catchCause(logSkipped("Linear card sync skipped", { cardId: card.id })),
      );
    }
  });

  // Issues that could not open an agent session this run; their questions go out as comments.
  const sessionless = new Set<string>();

  /** The owner session's card and its Linear issue, when the thread is one. */
  const ownerLinkOf = Effect.fn("LinearSyncReactor.ownerLinkOf")(function* (threadId: ThreadId) {
    const run = yield* snapshots.getRunByThreadId(threadId);
    if (Option.isNone(run) || run.value.role !== "owner" || run.value.cardId === null) return null;
    const card = yield* snapshots.getCardShellById(run.value.cardId);
    if (Option.isNone(card) || card.value.linearIssue === null) return null;
    return { run: run.value, card: card.value, link: card.value.linearIssue };
  });

  /** The card's agent session on its issue, opened the first time the delegate's work shows. */
  const agentSessionFor = Effect.fn("LinearSyncReactor.agentSessionFor")(function* (
    card: OrchestrationCardShell,
    link: CardLinearIssue,
  ) {
    if (link.agentSessionId !== null) return link.agentSessionId;
    if (sessionless.has(link.id)) return null;
    const opened = yield* linear.createAgentSession(link.id).pipe(
      Effect.catchCause(
        orSkipped(null, "Linear agent session unavailable; using comments", { cardId: card.id }),
      ),
    );
    if (opened === null) {
      sessionless.add(link.id);
      return null;
    }
    yield* dispatch({
      type: "card.linear.sync",
      commandId: yield* freshCommandId("session"),
      cardId: card.id,
      issue: { ...link, agentSessionId: opened },
      syncedAt: DateTime.formatIso(yield* DateTime.now),
    });
    return opened;
  });

  /**
   * What goes to Linear as it happens: a person's comment on a card, and the delegate's session as
   * agent activity (each tool call an action, each reply a response, each question an elicitation).
   */
  const push = Effect.fn("LinearSyncReactor.push")(function* (event: OrchestrationEvent) {
    if (!(yield* linear.configured)) return;
    if (event.type === "card.message-posted" && event.payload.authorKind === "human") {
      const card = yield* snapshots.getCardShellById(event.payload.cardId);
      if (Option.isNone(card) || card.value.linearIssue === null) return;
      yield* linear.createComment(card.value.linearIssue.id, `**From Iskra:** ${event.payload.body}`);
      return;
    }
    if (event.type === "thread.message-sent") {
      if (event.payload.role !== "assistant" || event.payload.streaming) return;
      const owned = yield* ownerLinkOf(event.payload.threadId);
      if (owned === null) return;
      // A completed message's event carries no text; its text is what its deltas built up.
      const messageId = event.payload.messageId;
      const text =
        event.payload.text.trim().length > 0
          ? event.payload.text
          : Option.match(
              yield* snapshots.getThreadDetailById(event.payload.threadId, { activityKinds: [] }),
              {
                onNone: () => "",
                onSome: (thread) =>
                  thread.messages.find((message) => message.id === messageId)?.text ?? "",
              },
            );
      if (text.trim().length === 0) return;
      const session = yield* agentSessionFor(owned.card, owned.link);
      if (session !== null) {
        yield* linear.createAgentActivity(session, { type: "response", body: text });
      }
      return;
    }
    if (event.type !== "thread.activity-appended") return;
    const activity = event.payload.activity;
    if (activity.kind === "tool.completed") {
      const owned = yield* ownerLinkOf(event.payload.threadId);
      if (owned === null) return;
      const session = yield* agentSessionFor(owned.card, owned.link);
      if (session === null) return;
      const detail =
        Predicate.isObject(activity.payload) && typeof activity.payload.detail === "string"
          ? activity.payload.detail
          : "";
      yield* linear.createAgentActivity(session, {
        type: "action",
        action: activity.summary,
        parameter: detail.slice(0, 500),
      });
      return;
    }
  });

  /**
   * A card's activity as its Linear agent session shows it: decisions and plans as thoughts,
   * questions as elicitations, errors as errors. Without a session a question goes out as a comment.
   */
  const pushActivity = Effect.fn("LinearSyncReactor.pushActivity")(function* (
    activity: CardActivity,
  ) {
    const content = linearActivityOf(activity);
    if (content === null) return;
    const card = yield* snapshots.getCardShellById(activity.cardId);
    if (Option.isNone(card) || card.value.linearIssue === null) return;
    const link = card.value.linearIssue;
    const session = yield* agentSessionFor(card.value, link);
    if (session !== null) {
      yield* linear.createAgentActivity(session, content);
      return;
    }
    if (content.type !== "elicitation") return;
    const asker =
      activity.author.kind === "agent"
        ? Option.match(yield* snapshots.getAgentShellById(AgentId.make(activity.author.id)), {
            onNone: () => "The delegate",
            onSome: (value) => `@${value.name}`,
          })
        : "Iskra";
    yield* linear.createComment(link.id, `**${asker} asks:** ${content.body}\n\nReply here to answer.`);
  });

  const worker = yield* makeDrainableWorker(
    (job: { readonly kind: "sweep" } | { readonly kind: "push"; readonly event: OrchestrationEvent }) =>
      (job.kind === "sweep"
        ? sweep()
        : job.event.type === "card.activity-recorded"
          ? pushActivity(job.event.payload)
          : push(job.event)
      ).pipe(
        Effect.catchCause(logSkipped("Linear sync failed", { job: job.kind })),
      ),
  );

  const start: LinearSyncReactor["Service"]["start"] = Effect.fn("LinearSyncReactor.start")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* forkParked(
        Stream.runForEach(events, (event) =>
          event.type === "card.message-posted" ||
          event.type === "card.activity-recorded" ||
          (event.type === "thread.activity-appended" &&
            event.payload.activity.kind === "tool.completed") ||
          event.type === "thread.message-sent"
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
      // A client coming to the foreground syncs at once instead of on the next minute.
      if (Option.isSome(backgroundPolicy)) {
        yield* forkParked(
          Stream.runForEach(
            backgroundPolicy.value.streamChanges.pipe(
              Stream.map((snapshot) => snapshot.activeForegroundLeaseCount > 0),
              Stream.changes,
              Stream.filter((foreground) => foreground),
            ),
            () => worker.enqueue({ kind: "sweep" }),
          ),
        );
      }
    },
  );

  return {
    start,
    syncNow: worker.enqueue({ kind: "sweep" }).pipe(Effect.andThen(worker.drain)),
  } satisfies LinearSyncReactor["Service"];
});

export const layer = Layer.effect(LinearSyncReactor, make);
