import type {
  OrchestrationAgent,
  OrchestrationCard,
  OrchestrationChannel,
  OrchestrationEvent,
  OrchestrationProject,
  OrchestrationReadModel,
  ThreadId,
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
} from "@iskra/contracts";
import {
  DEFAULT_AGENT_BLUEPRINT,
  DEFAULT_AGENT_ROLES,
  AgentArchivedPayload,
  AgentCreatedPayload,
  AgentUnarchivedPayload,
  AgentUpdatedPayload,
  CardCreatedPayload,
  CardDecisionRecordedPayload,
  CardDelegateChangedPayload,
  CardRelationAddedPayload,
  CardRelationRemovedPayload,
  CardSessionStartedPayload,
  CardSpecStateChangedPayload,
  CardStatusChangedPayload,
  CardUpdatedPayload,
  CardWorkspaceClearedPayload,
  CardWorkspaceSetPayload,
  ChannelArchivedPayload,
  ChannelCreatedPayload,
  ChannelRunStartedPayload,
  ChannelUnarchivedPayload,
  ChannelUpdatedPayload,
  isImportedAgentSessionMessageId,
  isRunEndingSessionStatus,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ProjectOrchestrationSetPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMessageSentPayload,
  ThreadMetaUpdatedPayload,
  ThreadPinnedPayload,
  ThreadPinReorderedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadPullRequestLinkedPayload,
  ThreadPullRequestSyncedPayload,
  ThreadPullRequestUnlinkedPayload,
  ThreadRevertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSessionSetPayload,
  ThreadSettledPayload,
  ThreadSnoozedPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadUnarchivedPayload,
  ThreadUnpinnedPayload,
  ThreadUnsettledPayload,
  ThreadUnsnoozedPayload,
} from "@iskra/contracts";
import {
  legacyLinkedPullRequestOf,
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
} from "@iskra/shared/threadPullRequests";
import { compareDateTimeStrings } from "@iskra/shared/dateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";

import { cardPatches, newCard, touchCard, withSpend } from "./cardRules.ts";
import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;

// Async questions can stay open while the agent produces more activity.
// Match the database snapshot's pending-question retention.
function retainThreadActivities(activities: OrchestrationThread["activities"]) {
  const recentStart = activities.length - 500;
  if (recentStart <= 0) return activities;
  const pending = new Map<string, OrchestrationThread["activities"][number]>();
  for (const activity of activities) {
    if (!Predicate.isObject(activity.payload)) continue;
    const requestId = activity.payload.requestId;
    if (typeof requestId !== "string") continue;
    if (activity.kind === "user-input.requested" && activity.payload.responseMode === "message") {
      pending.set(requestId, activity);
    } else if (activity.kind === "user-input.resolved") {
      pending.delete(requestId);
    }
  }
  const pendingActivities = new Set(pending.values());
  return activities.filter(
    (activity, index) => index >= recentStart || pendingActivities.has(activity),
  );
}

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  // Match SQL and client projections: a missing git ref is not an interruption.
  return "completed" as const;
}

/**
 * Turn state to settle a still-running latest turn with when its session
 * leaves the "running" status, or null while the session is (re)starting or
 * running and the turn must stay unsettled.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSession["status"],
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

/** Patch that swaps a thread's links and re-derives the legacy single-PR field from them. */
function pullRequestsPatch(
  thread: Pick<OrchestrationThread, "projectId">,
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  projects: OrchestrationReadModel["projects"],
): Pick<OrchestrationThread, "pullRequests" | "linkedPullRequest"> {
  return {
    pullRequests,
    linkedPullRequest: legacyLinkedPullRequestOf(
      pullRequests,
      thread.projectId,
      projects.find((project) => project.id === thread.projectId)?.repositoryIdentity,
    ),
  };
}

function upsertPullRequestLink(
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  link: ThreadPullRequestLink,
): ReadonlyArray<ThreadPullRequestLink> {
  const index = pullRequests.findIndex((entry) => threadPullRequestKeysEqual(entry, link));
  return index === -1
    ? [...pullRequests, link]
    : pullRequests.map((entry, entryIndex) => (entryIndex === index ? link : entry));
}

function removePullRequestLink(
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  key: ThreadPullRequestKey,
): ReadonlyArray<ThreadPullRequestLink> {
  return pullRequests.filter((entry) => !threadPullRequestKeysEqual(entry, key));
}

/**
 * Host for a legacy `linkedPullRequest` being replayed into the link array.
 * Legacy links never carried one; the project's canonical key
 * (`<host>/<owner>/<name>`) is the best witness, then the link URL.
 */
function legacyPullRequestHost(
  project: OrchestrationProject | undefined,
  linked: ThreadLinkedPullRequest,
): string {
  const canonicalHost = project?.repositoryIdentity?.canonicalKey.split("/")[0];
  if (canonicalHost) return canonicalHost.toLowerCase();
  try {
    return new URL(linked.url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

function legacyLinkToPullRequests(
  thread: Pick<OrchestrationThread, "pullRequests">,
  project: OrchestrationProject | undefined,
  linked: ThreadLinkedPullRequest | null,
  linkedAt: string,
): ReadonlyArray<ThreadPullRequestLink> {
  // The legacy field held one user-chosen link, so null clears exactly the
  // manual ones and leaves created/agent/stack links alone.
  const withoutManual = thread.pullRequests.filter((entry) => entry.source !== "manual");
  if (linked === null) return withoutManual;
  return upsertPullRequestLink(withoutManual, {
    ...legacyThreadPullRequestKey(linked, legacyPullRequestHost(project, linked)),
    url: linked.url,
    source: "manual",
    linkedAt,
    snapshot: null,
    stack: null,
  });
}

function decodeForEvent<A>(
  schema: Schema.Decoder<A, never>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(toProjectorDecodeError(`${eventType}:${field}`)),
  );
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system" || isImportedAgentSessionMessageId(message.id)) {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) =>
      message.role === "user" &&
      !isImportedAgentSessionMessageId(message.id) &&
      retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          compareDateTimeStrings(left.createdAt, right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) =>
      message.role === "assistant" &&
      !isImportedAgentSessionMessageId(message.id) &&
      retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          compareDateTimeStrings(left.createdAt, right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

type AgentPatchEvent = Extract<
  OrchestrationEvent,
  { type: "agent.updated" | "agent.archived" | "agent.unarchived" }
>;
type ChannelPatchEvent = Extract<
  OrchestrationEvent,
  { type: "channel.updated" | "channel.archived" | "channel.unarchived" }
>;

/** A new agent's fields from its `agent.created` payload. */
export function newAgent(
  payload: Extract<OrchestrationEvent, { type: "agent.created" }>["payload"],
): Omit<OrchestrationAgent, "id"> {
  return {
    projectId: payload.projectId,
    name: payload.name,
    avatar: payload.avatar,
    roleTags: payload.roleTags,
    rolePrompt: payload.rolePrompt,
    modelSelection: payload.modelSelection,
    capabilities: payload.capabilities,
    roles: payload.roles ?? DEFAULT_AGENT_ROLES,
    verifyWith: payload.verifyWith ?? null,
    blueprint: payload.blueprint ?? DEFAULT_AGENT_BLUEPRINT,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    archivedAt: null,
  };
}

/** The fields an agent event changes, spread over the read model's agent or its projection row. */
export function agentPatch(
  event: AgentPatchEvent,
): Partial<Omit<OrchestrationAgent, "id" | "projectId">> {
  switch (event.type) {
    case "agent.updated": {
      const { payload } = event;
      return {
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.avatar !== undefined ? { avatar: payload.avatar } : {}),
        ...(payload.roleTags !== undefined ? { roleTags: payload.roleTags } : {}),
        ...(payload.rolePrompt !== undefined ? { rolePrompt: payload.rolePrompt } : {}),
        ...(payload.modelSelection !== undefined ? { modelSelection: payload.modelSelection } : {}),
        ...(payload.capabilities !== undefined ? { capabilities: payload.capabilities } : {}),
        ...(payload.roles !== undefined ? { roles: payload.roles } : {}),
        ...(payload.verifyWith !== undefined ? { verifyWith: payload.verifyWith } : {}),
        ...(payload.blueprint !== undefined ? { blueprint: payload.blueprint } : {}),
        updatedAt: payload.updatedAt,
      };
    }
    case "agent.archived":
      return { archivedAt: event.payload.archivedAt, updatedAt: event.payload.archivedAt };
    case "agent.unarchived":
      return { archivedAt: null, updatedAt: event.payload.updatedAt };
  }
}

/** A new channel's fields from its `channel.created` payload. */
export function newChannel(
  payload: Extract<OrchestrationEvent, { type: "channel.created" }>["payload"],
): Omit<OrchestrationChannel, "id"> {
  return {
    projectId: payload.projectId,
    kind: payload.kind,
    name: payload.name,
    topic: payload.topic,
    pinnedSpec: payload.pinnedSpec,
    wakeDepth: payload.wakeDepth,
    memberAgentIds: payload.memberAgentIds,
    leadAgentId: payload.leadAgentId ?? null,
    openElicitations: [],
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    archivedAt: null,
  };
}

/** The fields a channel event changes, spread over the read model's channel or its projection row. */
export function channelPatch(
  event: ChannelPatchEvent,
): Partial<Omit<OrchestrationChannel, "id" | "projectId" | "kind">> {
  switch (event.type) {
    case "channel.updated": {
      const { payload } = event;
      return {
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.topic !== undefined ? { topic: payload.topic } : {}),
        ...(payload.pinnedSpec !== undefined ? { pinnedSpec: payload.pinnedSpec } : {}),
        ...(payload.wakeDepth !== undefined ? { wakeDepth: payload.wakeDepth } : {}),
        ...(payload.memberAgentIds !== undefined ? { memberAgentIds: payload.memberAgentIds } : {}),
        ...(payload.leadAgentId !== undefined ? { leadAgentId: payload.leadAgentId } : {}),
        updatedAt: payload.updatedAt,
      };
    }
    case "channel.archived":
      return { archivedAt: event.payload.archivedAt, updatedAt: event.payload.archivedAt };
    case "channel.unarchived":
      return { archivedAt: null, updatedAt: event.payload.updatedAt };
  }
}

/** A channel's open lead questions after a message: a question opens one and an answer closes it. */
export function withChannelElicitations(
  openElicitations: OrchestrationChannel["openElicitations"],
  payload: Extract<OrchestrationEvent, { type: "channel.message-posted" }>["payload"],
): NonNullable<OrchestrationChannel["openElicitations"]> {
  const open = openElicitations ?? [];
  const { elicitation, answers } = payload;
  if (elicitation !== undefined) {
    return [
      ...open.filter((question) => question.messageId !== payload.messageId),
      { messageId: payload.messageId, optionIds: elicitation.options.map((option) => option.id) },
    ];
  }
  return answers === undefined
    ? open
    : open.filter((question) => question.messageId !== answers.questionId);
}

/** Replaces the entry with the same id, or appends it. */
function upsertById<T extends { readonly id: string }>(
  items: ReadonlyArray<T> | undefined,
  item: T,
): ReadonlyArray<T> {
  const current = items ?? [];
  return current.some((existing) => existing.id === item.id)
    ? current.map((existing) => (existing.id === item.id ? item : existing))
    : [...current, item];
}

function patchById<T extends { readonly id: string }>(
  items: ReadonlyArray<T> | undefined,
  id: string,
  patch: (item: T) => T,
): ReadonlyArray<T> {
  return (items ?? []).map((item) => (item.id === id ? patch(item) : item));
}

function withAgentPatch(model: OrchestrationReadModel, event: AgentPatchEvent) {
  const patch = agentPatch(event);
  return {
    ...model,
    agents: patchById(model.agents, event.payload.agentId, (agent) => ({ ...agent, ...patch })),
  };
}

function withChannelPatch(model: OrchestrationReadModel, event: ChannelPatchEvent) {
  const patch = channelPatch(event);
  return {
    ...model,
    channels: patchById(model.channels, event.payload.channelId, (channel) => ({
      ...channel,
      ...patch,
    })),
  };
}

function withProject(
  model: OrchestrationReadModel,
  projectId: string,
  patch: (project: OrchestrationReadModel["projects"][number]) => OrchestrationReadModel["projects"][number],
): OrchestrationReadModel {
  return { ...model, projects: patchById(model.projects, projectId, patch) };
}

function withProjectSpend(
  model: OrchestrationReadModel,
  projectId: string,
  turn: { readonly agentId: string; readonly costUsd: number; readonly recordedAt: string },
): OrchestrationReadModel {
  return withProject(model, projectId, (project) => ({ ...project, spend: withSpend(project.spend, turn) }));
}

function withCardPatches(
  model: OrchestrationReadModel,
  patches: ReturnType<typeof cardPatches>,
): OrchestrationReadModel {
  return {
    ...model,
    cards: patches.reduce<ReadonlyArray<OrchestrationCard>>(
      (cards, [cardId, patch]) => patchById(cards, cardId, patch),
      model.cards ?? [],
    ),
  };
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    agents: [],
    channels: [],
    cards: [],
    liveRuns: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: payload.faviconPath ?? null,
            projectIcon: payload.projectIcon ?? null,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.defaultThreadEnvMode !== undefined
                    ? { defaultThreadEnvMode: payload.defaultThreadEnvMode }
                    : {}),
                  ...(payload.autoPull !== undefined ? { autoPull: payload.autoPull } : {}),
                  ...(payload.faviconPath !== undefined
                    ? { faviconPath: payload.faviconPath }
                    : {}),
                  ...(payload.projectIcon !== undefined
                    ? { projectIcon: payload.projectIcon }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            pullRequests: [],
            branchPullRequest: null,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            unsettledAt: null,
            activeOrderKey: null,
            snoozedUntil: null,
            snoozedAt: null,
            deletedAt: null,
            messages: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            titleRegeneration: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.settled":
      return decodeForEvent(ThreadSettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: "settled",
            settledAt: payload.settledAt,
            unsettledAt: null,
            activeOrderKey: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsettled":
      return decodeForEvent(ThreadUnsettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.threads.find((thread) => thread.id === payload.threadId);
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              settledOverride: payload.reason === "user" ? "active" : null,
              settledAt: null,
              // Re-entry stamp for active-list ordering. A thread already
              // pinned active keeps its stamp: the activity reset that clears
              // the pin is not a re-entry and must not reorder the list.
              unsettledAt:
                existing?.settledOverride === "active"
                  ? (existing.unsettledAt ?? null)
                  : payload.updatedAt,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.snoozed":
      return decodeForEvent(ThreadSnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: payload.snoozedUntil,
            snoozedAt: payload.snoozedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsnoozed":
      return decodeForEvent(ThreadUnsnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pinned":
      return decodeForEvent(ThreadPinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: payload.pinnedAt,
            ...(payload.pinOrderKey !== undefined ? { pinOrderKey: payload.pinOrderKey } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unpinned":
      return decodeForEvent(ThreadUnpinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: null,
            // Unpin clears the slot: re-pinning is "pin again", not "restore
            // an ancient position".
            pinOrderKey: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pin-reordered":
      return decodeForEvent(ThreadPinReorderedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinOrderKey: payload.orderKey,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          // Legacy single-link events replay into the link array so the
          // derived linkedPullRequest and pullRequests never disagree.
          const legacyLinkPatch =
            thread !== undefined && payload.linkedPullRequest !== undefined
              ? pullRequestsPatch(
                  thread,
                  legacyLinkToPullRequests(
                    thread,
                    nextBase.projects.find((project) => project.id === thread.projectId),
                    payload.linkedPullRequest,
                    payload.updatedAt,
                  ),
                  nextBase.projects,
                )
              : {};
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...(payload.title !== undefined ? { title: payload.title } : {}),
              ...(payload.titleRegeneration !== undefined
                ? { titleRegeneration: payload.titleRegeneration }
                : {}),
              ...(payload.modelSelection !== undefined
                ? { modelSelection: payload.modelSelection }
                : {}),
              ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
              ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
              ...(payload.activeOrderKey !== undefined
                ? { activeOrderKey: payload.activeOrderKey }
                : {}),
              ...(payload.branchPullRequest !== undefined
                ? { branchPullRequest: payload.branchPullRequest }
                : {}),
              ...legacyLinkPatch,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pull-request-linked":
      return decodeForEvent(
        ThreadPullRequestLinkedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...pullRequestsPatch(
                thread,
                upsertPullRequestLink(thread.pullRequests, payload.link),
                nextBase.projects,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pull-request-unlinked":
      return decodeForEvent(
        ThreadPullRequestUnlinkedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...pullRequestsPatch(
                thread,
                removePullRequestLink(thread.pullRequests, payload),
                nextBase.projects,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pull-request-synced":
      return decodeForEvent(
        ThreadPullRequestSyncedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          // A sync for a link the user removed in the meantime is stale; drop it.
          if (
            !thread ||
            !thread.pullRequests.some((link) => threadPullRequestKeysEqual(link, payload))
          ) {
            return nextBase;
          }
          const pullRequests = thread.pullRequests.map((link) =>
            threadPullRequestKeysEqual(link, payload)
              ? { ...link, snapshot: payload.snapshot, stack: payload.stack }
              : link,
          );
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...pullRequestsPatch(thread, pullRequests, nextBase.projects),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadMessageSentPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            ...(payload.context !== undefined ? { context: payload.context } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                    ...(message.context !== undefined ? { context: message.context } : {}),
                  }
                : entry,
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );
        // A run ends when its session stops or fails; its agent may then wake again.
        const base = isRunEndingSessionStatus(session.status)
          ? {
              ...nextBase,
              liveRuns: (nextBase.liveRuns ?? []).filter(
                (run) => run.threadId !== payload.threadId,
              ),
            }
          : nextBase;
        const thread = base.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return base;
        }

        // Leaving the "running" session status is the turn-end signal: settle
        // a still-running latest turn so its duration reflects the whole turn.
        const settledTurnState = settledTurnStateForSessionStatus(session.status);
        return {
          ...base,
          threads: updateThread(base.threads, payload.threadId, {
            session,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: "running",
                    requestedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.assistantMessageId
                        : null,
                  }
                : thread.latestTurn !== null &&
                    thread.latestTurn.state === "running" &&
                    settledTurnState !== null
                  ? {
                      ...thread.latestTurn,
                      state: settledTurnState,
                      // A running turn's completedAt can only hold a mid-turn
                      // placeholder checkpoint timestamp — the session leaving
                      // "running" is the authoritative turn end.
                      completedAt: session.updatedAt,
                    }
                  : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        // Mid-turn diff updates produce placeholder checkpoints; record the
        // checkpoint, but don't settle a turn its session is still running.
        const turnStillRunning =
          thread.session?.status === "running" && thread.session.activeTurnId === payload.turnId;

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn: turnStillRunning
              ? thread.latestTurn
              : {
                  turnId: payload.turnId,
                  state:
                    thread.latestTurn?.turnId === payload.turnId &&
                    thread.latestTurn.state === "interrupted"
                      ? "interrupted"
                      : checkpointStatusToLatestTurnState(payload.status),
                  requestedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? thread.latestTurn.requestedAt
                      : payload.completedAt,
                  startedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? (thread.latestTurn.startedAt ?? payload.completedAt)
                      : payload.completedAt,
                  completedAt: payload.completedAt,
                  assistantMessageId: payload.assistantMessageId,
                },
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = retainThreadActivities(
            [
              ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
              payload.activity,
            ].toSorted(compareThreadActivities),
          );

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "agent.created":
      return decodeForEvent(AgentCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          agents: upsertById(nextBase.agents, { id: payload.agentId, ...newAgent(payload) }),
        })),
      );

    case "agent.updated":
      return decodeForEvent(AgentUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withAgentPatch(nextBase, { ...event, payload })),
      );

    case "agent.archived":
      return decodeForEvent(AgentArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withAgentPatch(nextBase, { ...event, payload })),
      );

    case "agent.unarchived":
      return decodeForEvent(AgentUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withAgentPatch(nextBase, { ...event, payload })),
      );

    case "card.created":
      return decodeForEvent(CardCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          cards: upsertById(nextBase.cards, { id: payload.cardId, ...newCard(payload) }),
        })),
      );

    case "card.updated":
      return decodeForEvent(CardUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withCardPatches(nextBase, cardPatches({ ...event, payload }))),
      );

    case "card.status-changed":
      return decodeForEvent(CardStatusChangedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withCardPatches(nextBase, cardPatches({ ...event, payload }))),
      );

    case "card.delegate-changed":
      return decodeForEvent(CardDelegateChangedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withCardPatches(nextBase, cardPatches({ ...event, payload }))),
      );

    case "card.relation-added":
      return decodeForEvent(CardRelationAddedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withCardPatches(nextBase, cardPatches({ ...event, payload }))),
      );

    case "card.relation-removed":
      return decodeForEvent(CardRelationRemovedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withCardPatches(nextBase, cardPatches({ ...event, payload }))),
      );

    case "card.workspace-set":
      return decodeForEvent(CardWorkspaceSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withCardPatches(nextBase, cardPatches({ ...event, payload }))),
      );

    case "card.workspace-cleared":
      return decodeForEvent(CardWorkspaceClearedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withCardPatches(nextBase, cardPatches({ ...event, payload }))),
      );

    // A card's decision log is paged from its projection; the read model does not hold it.
    case "card.decision-recorded":
      return decodeForEvent(CardDecisionRecordedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withCardPatches(nextBase, cardPatches({ ...event, payload }))),
      );

    case "channel.created":
      return decodeForEvent(ChannelCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          channels: upsertById(nextBase.channels, {
            id: payload.channelId,
            ...newChannel(payload),
          }),
        })),
      );

    case "channel.updated":
      return decodeForEvent(ChannelUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withChannelPatch(nextBase, { ...event, payload })),
      );

    case "channel.archived":
      return decodeForEvent(ChannelArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withChannelPatch(nextBase, { ...event, payload })),
      );

    case "channel.unarchived":
      return decodeForEvent(ChannelUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withChannelPatch(nextBase, { ...event, payload })),
      );

    case "channel.run-started":
      return decodeForEvent(ChannelRunStartedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          liveRuns: [
            ...(nextBase.liveRuns ?? []).filter((run) => run.threadId !== payload.threadId),
            {
              threadId: payload.threadId,
              role: payload.role ?? "conversation",
              channelId: payload.channelId,
              cardId: null,
              agentId: payload.agentId,
              startedAt: payload.startedAt,
            },
          ],
        })),
      );

    case "card.session-started":
      return decodeForEvent(CardSessionStartedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...withCardPatches(nextBase, [[payload.cardId, touchCard(payload.startedAt)]]),
          liveRuns: [
            ...(nextBase.liveRuns ?? []).filter((run) => run.threadId !== payload.threadId),
            {
              threadId: payload.threadId,
              role: payload.role,
              channelId: null,
              cardId: payload.cardId,
              agentId: payload.agentId,
              startedAt: payload.startedAt,
            },
          ],
        })),
      );

    // A card's activity and requests live in projections and reactors, not the read model.
    case "card.session-requested":
    case "card.helper-requested":
    case "card.critique-requested":
    case "card.delivery-updated":
      return Effect.succeed(nextBase);

    // A card's spend also counts toward its project's month.
    case "card.spend-recorded": {
      const withCard = withCardPatches(nextBase, cardPatches(event));
      const projectId = withCard.cards?.find((card) => card.id === event.payload.cardId)?.projectId;
      return Effect.succeed(
        projectId === undefined ? withCard : withProjectSpend(withCard, projectId, event.payload),
      );
    }

    case "project.spend-recorded":
      return Effect.succeed(withProjectSpend(nextBase, event.payload.projectId, event.payload));

    case "project.knowledge-proposed": {
      const { projectId, lesson } = event.payload;
      return Effect.succeed(
        withProject(nextBase, projectId, (project) => ({
          ...project,
          knowledge: [
            ...(project.knowledge ?? []).filter((entry) => entry.lessonId !== lesson.lessonId),
            lesson,
          ],
        })),
      );
    }

    // Only proposed and approved lessons stay in the read model.
    case "project.knowledge-added":
    case "project.knowledge-dismissed":
    case "project.knowledge-removed": {
      const { projectId, lessonId } = event.payload;
      const approved = event.type === "project.knowledge-added";
      return Effect.succeed(
        withProject(nextBase, projectId, (project) => ({
          ...project,
          knowledge: (project.knowledge ?? []).flatMap((lesson) =>
            lesson.lessonId !== lessonId
              ? [lesson]
              : approved
                ? [{ ...lesson, state: "approved" as const }]
                : [],
          ),
        })),
      );
    }

    // Fires are read from their projection; nothing decides on them.
    case "project.trigger-fired":
      return Effect.succeed(nextBase);

    case "card.plan-proposed":
    case "card.plan-approved":
    case "card.plan-slice-released":
    case "card.migration-enumerated":
    case "card.migration-phase-changed":
    case "card.migration-items-updated":
    case "card.migration-instructions-set":
    case "card.outcome-recorded":
    case "card.revert-requested":
    case "card.checkpoint-restore-requested":
    case "card.message-posted":
    case "card.spec-submitted":
    case "card.snoozed":
    case "card.linear-synced":
    case "card.budget-set":
    case "card.unpriced-accepted":
    case "card.checks-updated":
    case "card.diff-measured":
    case "card.unsnoozed":
    case "card.activity-recorded":
    case "card.acceptance-set":
    case "card.paused":
    case "card.resumed":
    case "card.wait-noted":
    case "card.checkpoint-requested":
    case "card.checkpoint-resolved":
    case "card.evidence-recorded":
    case "card.flags-acknowledged":
    case "card.fix-rounds-reset":
    case "card.landing-linked":
    case "card.verifier-selected":
    case "card.verdict-recorded":
    case "card.verifier-overridden":
    case "card.verifier-rerun-requested":
    case "card.services-restart-requested":
      return Effect.succeed(withCardPatches(nextBase, cardPatches(event)));

    case "project.orchestration-set":
      return decodeForEvent(
        ProjectOrchestrationSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? { ...project, orchestration: payload.orchestration, updatedAt: payload.updatedAt }
              : project,
          ),
        })),
      );

    case "card.spec-state-changed":
      return decodeForEvent(CardSpecStateChangedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => withCardPatches(nextBase, cardPatches({ ...event, payload }))),
      );

    // Channel messages are paged from their projection; only a lead's open questions stay here.
    case "channel.message-posted": {
      const { payload } = event;
      if (payload.elicitation === undefined && payload.answers === undefined) {
        return Effect.succeed(nextBase);
      }
      return Effect.succeed({
        ...nextBase,
        channels: patchById(nextBase.channels, payload.channelId, (channel) => ({
          ...channel,
          openElicitations: withChannelElicitations(channel.openElicitations, payload),
        })),
      });
    }

    default:
      return Effect.succeed(nextBase);
  }
}
