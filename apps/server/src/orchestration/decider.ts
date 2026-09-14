import {
  CHANNEL_HUMAN_AUTHOR_ID,
  CHANNEL_SYSTEM_AUTHOR_ID,
  DEFAULT_CHANNEL_WAKE_DEPTH,
  EventId,
  MAX_SCRIPT_ID_LENGTH,
  SCRIPT_RUN_COMMAND_PATTERN,
  MessageId,
  ThreadLinkedPullRequest,
  UserInputRequestedPayload,
  isImportedAgentSessionMessageId,
  type AgentId,
  type CardId,
  type CardMove,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadPullRequestKey,
  type ThreadPullRequestLink,
  type OrchestrationThreadActivity,
  DEFAULT_PROJECT_RUN_CAP,
} from "@iskra/contracts";
import {
  legacyLinkedPullRequestOf,
  legacyThreadPullRequestKey,
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
} from "@iskra/shared/threadPullRequests";
import { compareDateTimeStrings } from "@iskra/shared/dateTime";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as PlatformError from "effect/PlatformError";

import {
  OrchestrationCommandInvariantError,
  OrchestrationThreadSettleBlockedError,
  type OrchestrationCommandRejection,
} from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireAgent,
  requireAgentAbsent,
  requireAgentNameAvailable,
  requireCard,
  requireCardAbsent,
  requireChannel,
  requireChannelAbsent,
  requireValidChannelMembers,
  requireActiveProjectWorkspaceRootAbsent,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import {
  canChangeDelegate,
  cardBudgetRefusal,
  cardFactsOf,
  isFinishedCardStatus,
  nextCardStatus,
} from "./cardRules.ts";
import { parseMentions } from "./mentions.ts";
import { projectEvent } from "./projector.ts";
import { decideWake, projectLiveRunCount } from "./wakeRouting.ts";
import { threadHasQueuedTurnStart } from "./ThreadSettlementPolicy.ts";

const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const decodeUserInputRequestedPayload = Schema.decodeUnknownOption(UserInputRequestedPayload);
const threadPullRequestLinksEqual = Schema.toEquivalence(Schema.NullOr(ThreadLinkedPullRequest));

/**
 * Blocked-on-you work derived from the thread's retained activities: an
 * approval or user-input request with no later resolution for the same
 * requestId. The server-side twin of the shell's hasPendingApprovals /
 * hasPendingUserInput flags, which the decider read model does not carry.
 * The clearing rules MUST match ProjectionPipeline's pending accounting —
 * resolved activities always clear, respond.failed clears only when the
 * failure detail marks the request stale/unknown — or settle would be
 * rejected on threads whose shell flags read as clear.
 */
function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
}

// Scans the read model's activities, which the projector caps at the most
// recent 500 plus pending async questions. Async questions remain actionable
// while the agent works, so they must not expire with the activity window.
function openRequests(thread: Pick<OrchestrationThread, "activities">) {
  const requests = new Map<string, OrchestrationThreadActivity>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      requests.set(requestId, activity);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      requests.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      requests.delete(requestId);
    }
  }
  return requests;
}

/** Apply the shared shell-level rule to the detailed command read model. */
function hasQueuedTurnStartForThread(
  thread: Pick<OrchestrationThread, "messages" | "latestTurn" | "session">,
  now: string,
): boolean {
  let latestUserMessageAt: string | null = null;
  let latestUserMessageAtMs = Number.NEGATIVE_INFINITY;
  for (const message of thread.messages) {
    if (message.role !== "user" || isImportedAgentSessionMessageId(message.id)) continue;
    const messageAtMs = Date.parse(message.createdAt);
    latestUserMessageAtMs = Math.max(latestUserMessageAtMs, messageAtMs);
    if (messageAtMs === latestUserMessageAtMs) {
      latestUserMessageAt = message.createdAt;
    }
  }
  return threadHasQueuedTurnStart(
    {
      latestUserMessageAt: Number.isFinite(latestUserMessageAtMs) ? latestUserMessageAt : null,
      latestTurn: thread.latestTurn,
      session: thread.session,
    },
    now,
  );
}

function findPullRequestLink(
  thread: Pick<OrchestrationThread, "pullRequests">,
  key: ThreadPullRequestKey,
): ThreadPullRequestLink | undefined {
  return thread.pullRequests.find((link) => threadPullRequestKeysEqual(link, key));
}

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

/** A card status command: the rules derive the target status, never the client. */
const decideCardMove = Effect.fn("decideCardMove")(function* (input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: Extract<OrchestrationCommand, { readonly cardId: CardId }>;
  readonly move: CardMove;
  readonly reason?: string;
}): Effect.fn.Return<
  PlannedOrchestrationEvent,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const card = yield* requireCard({
    readModel: input.readModel,
    command: input.command,
    cardId: input.command.cardId,
  });
  const result = nextCardStatus(cardFactsOf(input.readModel.cards ?? [], card), input.move);
  if (!result.ok) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail: result.reason,
    });
  }
  const occurredAt = yield* nowIso;
  return {
    ...(yield* withEventBase({
      aggregateKind: "card",
      aggregateId: card.id,
      occurredAt,
      commandId: input.command.commandId,
    })),
    type: "card.status-changed",
    payload: {
      cardId: card.id,
      from: card.status,
      to: result.status,
      move: input.move,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      updatedAt: occurredAt,
    },
  };
});

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandRejection | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

/** The card's live owner session, if it has one. */
const liveOwnerRun = (readModel: OrchestrationReadModel, cardId: CardId) =>
  (readModel.liveRuns ?? []).find((run) => run.cardId === cardId && run.role === "owner");

const FINISHED_CARD_SESSION_REASON = "A card that has landed or been abandoned takes no new sessions.";
// Invariant 12: no writing before the plan gate.
const PLAN_GATE_REASON = "Approve or skip the card's spec before an agent writes to it.";
const SPEC_DECISION_TARGET = {
  "card.spec.approve": "approved",
  "card.spec.skip": "skipped",
  "card.spec.reopen": "draft",
} as const;
const SECOND_WRITER_REASON =
  "The card already has a live session writing to it; one session writes at a time.";
const sessionCapReason = `${DEFAULT_PROJECT_RUN_CAP} sessions are already live in this project.`;

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
  userInputActivity,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly userInputActivity?: OrchestrationThreadActivity;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandRejection | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireActiveProjectWorkspaceRootAbsent({
        readModel,
        command,
        workspaceRoot: command.workspaceRoot,
        exceptProjectId: command.projectId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          // Project creation has no user model choice. Older clients sent an
          // automatic seed here, but only a metadata update records an
          // explicit project default.
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.scripts !== undefined) {
        // Persisted IDs predate shortcut validation. Let users edit or remove them
        // without allowing another invalid ID to enter the project.
        const existingIds = new Set(project.scripts.map((script) => script.id));
        for (const script of command.scripts) {
          if (!existingIds.has(script.id) && !isScriptRunCommand(`script.${script.id}.run`)) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Script ID '${script.id}' must be 1-${MAX_SCRIPT_ID_LENGTH} lowercase letters, digits or hyphens, starting with a letter or digit.`,
            });
          }
        }
      }
      if (command.workspaceRoot !== undefined) {
        yield* requireActiveProjectWorkspaceRootAbsent({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          exceptProjectId: command.projectId,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.defaultThreadEnvMode !== undefined
            ? { defaultThreadEnvMode: command.defaultThreadEnvMode }
            : {}),
          ...(command.autoPull !== undefined ? { autoPull: command.autoPull } : {}),
          ...(command.faviconPath !== undefined ? { faviconPath: command.faviconPath } : {}),
          ...(command.projectIcon !== undefined ? { projectIcon: command.projectIcon } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(command.historyImport === true ? { metadata: { historyImport: true } } : {}),
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.settle":
    case "thread.auto-settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.type === "thread.auto-settle" && thread.settledOverride !== null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} changed before automatic settlement`,
          }),
        );
      }
      // The server owns settle eligibility. A stale command must not settle
      // a thread whose session is coming alive or working.
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* new OrchestrationThreadSettleBlockedError({ threadId: command.threadId });
      }
      const pendingRequests = openRequests(thread);
      // Manual settlement dismisses async questions without answering them.
      // Native callbacks and approvals still need a response or interruption.
      if (
        Array.from(pendingRequests.values()).some(
          (activity) =>
            command.type === "thread.auto-settle" ||
            activity.kind !== "user-input.requested" ||
            !Predicate.isObject(activity.payload) ||
            activity.payload.responseMode !== "message",
        )
      ) {
        return yield* new OrchestrationThreadSettleBlockedError({ threadId: command.threadId });
      }
      const occurredAt = yield* nowIso;
      // Settling inside the adoption window would hide just-requested work.
      if (hasQueuedTurnStartForThread(thread, occurredAt)) {
        return yield* new OrchestrationThreadSettleBlockedError({ threadId: command.threadId });
      }
      // Settling an already-settled thread re-emits with the original
      // settledAt: the engine rejects zero-event commands, and bulk-settle /
      // double-click must stay silent no-ops rather than surface errors.
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
      const settledEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.settled" as const,
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled
            ? thread.settledAt
            : command.type === "thread.auto-settle"
              ? command.settledAt
              : occurredAt,
          // A re-emission is a projected no-op: keep the existing updatedAt
          // so duplicate settles neither rewind nor churn ordering. A fresh
          // settle stamps the command time.
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
      // Settling is "I'm done with this": clear states that would keep the
      // row pinned or snoozed instead of showing the new settled state.
      const companionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      for (const [requestId, request] of pendingRequests) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.activity-appended",
          payload: {
            threadId: command.threadId,
            activity: {
              id: EventId.make(`settle:${command.commandId}:${requestId}`),
              kind: "user-input.resolved",
              summary: "User input dismissed",
              tone: "info",
              turnId: request.turnId,
              createdAt: occurredAt,
              payload: { requestId, responseMode: "message" },
            },
          },
        });
      }
      if (thread.pinnedAt != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unpinned" as const,
          payload: {
            threadId: command.threadId,
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return companionEvents.length > 0 ? [settledEvent, ...companionEvents] : settledEvent;
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): reducing the event a
      // second time lands on the same override state. A re-emission keeps
      // the existing updatedAt so duplicates do not churn ordering.
      const alreadyPinnedActive = thread.settledOverride === "active";
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // A wake time in the past would create a thread that is snoozed and
      // woken at once — the row would never leave the inbox but still carry
      // snooze state. Reject instead of silently normalizing. The negated
      // comparison also catches unparseable wake times (IsoDateTime is
      // structurally just a string): NaN fails every comparison, and an
      // unparseable snoozedUntil must never persist.
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future`,
          }),
        );
      }
      // Blocked-on-you work must not be snoozed away: a pending approval or
      // user-input request is the agent waiting on the user, and hiding it
      // defeats the request. (A running session IS snoozable — snooze only
      // affects visibility, never the agent.)
      if (openRequests(thread).size > 0) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be snoozed`,
          }),
        );
      }
      // A queued turn start — a user message no turn has adopted yet — is
      // invisible pending work: no session, no pending flags. Snoozing in
      // that window would hide a just-requested turn exactly the way settle
      // would.
      if (hasQueuedTurnStartForThread(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be snoozed`,
          }),
        );
      }
      // Re-snoozing an already-snoozed thread to the SAME wake time is a
      // duplicate (double-click, raced clients): re-emit with the original
      // timestamps so the projection is a no-op. A different wake time is a
      // real change and stamps fresh.
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): waking a thread that
      // is not snoozed lands on the same null state without churning
      // updatedAt.
      const alreadyAwake = thread.snoozedUntil == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyAwake ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Re-pinning an already-pinned thread is a duplicate (double-click,
      // raced clients): re-emit with the original timestamps so the
      // projection is a no-op. Pinning has no lifecycle invariants — a pin
      // only ever promotes visibility, so it can never hide pending work.
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pinned" as const,
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          // A fresh pin takes the client's slot in the arranged order; on a
          // re-pin the existing key wins so raced duplicates cannot move a
          // thread the user already placed.
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
      // Pinning is a promotion: it clears the parked states rather than
      // silently outranking them. An explicit settle un-settles (reason
      // "user", same override the un-settle button stamps), and a snooze's
      // return ticket is spent — the thread is on top NOW, not on Tuesday.
      const promotionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }

    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): unpinning a thread
      // that is not pinned lands on the same null state without churning
      // updatedAt.
      const alreadyUnpinned = thread.pinnedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Only pinned threads have a slot in the arranged order. Rejecting
      // (rather than silently pinning) keeps a raced reorder-after-unpin
      // from resurrecting a pin the user just cleared.
      if (thread.pinnedAt == null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} is not pinned and cannot be reordered`,
          }),
        );
      }
      // Idempotent by re-emission (see thread.settle): a duplicate drop on
      // the same slot keeps the existing updatedAt so it projects as a no-op.
      const keyUnchanged = thread.pinOrderKey === command.orderKey;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: keyUnchanged ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.active.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Snooze retains this slot. Changing it cannot wake the thread, and
      // accepting it handles races with snooze and retained wake timestamps.
      if (
        thread.deletedAt !== null ||
        thread.pinnedAt != null ||
        thread.settledOverride === "settled"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} is not active and cannot be reordered`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          activeOrderKey: command.orderKey,
          // Arranging the list is not thread activity or a lifecycle transition.
          updatedAt: thread.updatedAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Old clients only see the derived single link. Unlink that request through
      // the same command path as modern clients, including stack dismissal, while
      // retaining other links they cannot see. Historical metadata events still replay unchanged.
      const legacy = legacyLinkedPullRequestOf(
        thread.pullRequests,
        thread.projectId,
        readModel.projects.find((project) => project.id === thread.projectId)?.repositoryIdentity,
      );
      const currentPullRequest =
        legacy === null
          ? null
          : (thread.pullRequests.find(
              (link) => link.url === legacy.url && link.number === legacy.number,
            ) ?? null);
      if (command.linkedPullRequest != null) {
        const { linkedPullRequest: linked, ...metadata } = command;
        const project = readModel.projects.find((project) => project.id === thread.projectId);
        let host = project?.repositoryIdentity?.canonicalKey.split("/")[0] ?? "unknown";
        try {
          host = new URL(linked.url).hostname;
        } catch {
          // Historical clients can send links without a parseable URL.
        }
        const hasMetadata = Object.entries(metadata).some(
          ([key, value]) => !["type", "commandId", "threadId"].includes(key) && value !== undefined,
        );
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...(hasMetadata ? [metadata] : []),
            ...(currentPullRequest?.source === "manual"
              ? [
                  {
                    type: "thread.pull-request.unlink" as const,
                    commandId: command.commandId,
                    threadId: command.threadId,
                    host: currentPullRequest.host,
                    repository: currentPullRequest.repository,
                    number: currentPullRequest.number,
                  },
                ]
              : []),
            {
              type: "thread.pull-request.link",
              commandId: command.commandId,
              threadId: command.threadId,
              ...legacyThreadPullRequestKey(linked, host),
              url: linked.url,
              source: "manual",
            },
          ],
        });
      }

      if (command.linkedPullRequest === null && currentPullRequest !== null) {
        const { linkedPullRequest: _linkedPullRequest, ...metadata } = command;
        const hasMetadata = Object.entries(metadata).some(
          ([key, value]) => !["type", "commandId", "threadId"].includes(key) && value !== undefined,
        );
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...(hasMetadata ? [metadata] : []),
            {
              type: "thread.pull-request.unlink",
              commandId: command.commandId,
              threadId: command.threadId,
              host: currentPullRequest.host,
              repository: currentPullRequest.repository,
              number: currentPullRequest.number,
            },
          ],
        });
      }
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.regenerateTitle === true
            ? {
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: {
                  requestId: command.commandId,
                  startedAt: occurredAt,
                },
              }
            : {}),
          ...(command.title !== undefined && thread.titleRegeneration != null
            ? { titleRegeneration: null }
            : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.linkedPullRequest !== undefined
            ? { linkedPullRequest: command.linkedPullRequest }
            : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pull-request.link": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const key = normalizeThreadPullRequestKey(command);
      const existing = findPullRequestLink(thread, key);
      // An explicit link on a dismissed stack member un-dismisses it; any
      // other duplicate is a no-op the engine would reject as zero-event.
      const undismisses =
        existing?.source === "stack-dismissed" &&
        (command.source === "manual" || command.source === "agent" || command.source === "created");
      if (existing !== undefined && !undismisses) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `pull request ${key.host}/${key.repository}#${key.number} is already linked to thread ${command.threadId}`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pull-request-linked",
        payload: {
          threadId: command.threadId,
          link:
            existing !== undefined
              ? { ...existing, url: command.url, source: command.source }
              : {
                  ...key,
                  url: command.url,
                  source: command.source,
                  linkedAt: occurredAt,
                  snapshot: null,
                  stack: null,
                },
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pull-request.unlink": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const key = normalizeThreadPullRequestKey(command);
      const existing = findPullRequestLink(thread, key);
      if (existing === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `pull request ${key.host}/${key.repository}#${key.number} is not linked to thread ${command.threadId}`,
        });
      }
      const occurredAt = yield* nowIso;
      const eventBase = yield* withEventBase({
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt,
        commandId: command.commandId,
      });
      // Any known native-stack member needs a tombstone, regardless of who linked it.
      // A sibling can rediscover it even before this link has its own stack snapshot.
      const belongsToStack =
        existing.source === "stack" ||
        existing.stack !== null ||
        thread.pullRequests.some(
          (link) =>
            link.host.toLowerCase() === key.host &&
            link.repository.toLowerCase() === key.repository &&
            link.stack?.layers.some((layer) => layer.number === key.number),
        );
      if (belongsToStack) {
        return {
          ...eventBase,
          type: "thread.pull-request-linked",
          payload: {
            threadId: command.threadId,
            link: { ...existing, source: "stack-dismissed" },
            updatedAt: occurredAt,
          },
        };
      }
      return {
        ...eventBase,
        type: "thread.pull-request-unlinked",
        payload: {
          threadId: command.threadId,
          ...key,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pull-request-link.sync": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const key = normalizeThreadPullRequestKey(command);
      if (findPullRequestLink(thread, key) === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `pull request ${key.host}/${key.repository}#${key.number} is not linked to thread ${command.threadId}`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pull-request-synced",
        payload: {
          threadId: command.threadId,
          ...key,
          snapshot: command.snapshot,
          stack: command.stack,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pull-request.sync": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} was deleted before pull request discovery`,
        });
      }
      if (
        thread.projectId !== command.projectId ||
        thread.branch !== command.expected.branch ||
        thread.worktreePath !== command.expected.worktreePath ||
        !threadPullRequestLinksEqual(
          thread.linkedPullRequest ?? null,
          command.expected.linkedPullRequest,
        ) ||
        !threadPullRequestLinksEqual(
          thread.branchPullRequest ?? null,
          command.expected.branchPullRequest,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} changed before pull request discovery`,
        });
      }
      const project = yield* requireProject({ readModel, command, projectId: command.projectId });
      if (project.deletedAt !== null || project.workspaceRoot !== command.expected.workspaceRoot) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `project ${command.projectId} changed before pull request discovery`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          branchPullRequest: command.branchPullRequest,
          ...(command.linkedPullRequest !== undefined
            ? { linkedPullRequest: command.linkedPullRequest }
            : {}),
          updatedAt: thread.updatedAt,
        },
      };
    }

    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestIsCurrent = thread.titleRegeneration?.requestId === command.requestId;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(requestIsCurrent && command.title !== undefined ? { title: command.title } : {}),
          ...(requestIsCurrent ? { titleRegeneration: null } : {}),
          updatedAt: requestIsCurrent ? occurredAt : thread.updatedAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      if (isImportedAgentSessionMessageId(command.message.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message id '${command.message.messageId}' uses the reserved imported-session namespace.`,
        });
      }
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Invariant 13: a card's session starts no turn past its budget or on an unaccepted unpriced model.
      const budgetRun = (readModel.liveRuns ?? []).find(
        (run) => run.threadId === command.threadId && run.cardId !== null,
      );
      const budgetCard =
        budgetRun === undefined
          ? undefined
          : readModel.cards?.find((candidate) => candidate.id === budgetRun.cardId);
      const budgetRefusal = budgetCard === undefined ? null : cardBudgetRefusal(budgetCard);
      if (budgetRefusal !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: budgetRefusal,
        });
      }
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          ...(command.message.context !== undefined ? { context: command.message.context } : {}),
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      // Real activity resets ANY override: it wakes an explicitly settled
      // thread, and it clears a keep-active pin back to neutral so the
      // thread can auto-settle again after this burst of work goes stale.
      // A snooze clears the same way — sending a message to a snoozed
      // thread is the user re-engaging, so the return ticket is spent.
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (targetThread.settledOverride !== null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      if (targetThread.snoozedUntil != null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      return [...lifecycleResetEvents, userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const request = userInputActivity;
      const attachments = Object.values(command.attachmentsByQuestionId ?? {}).flat();
      let questionTextById: Record<string, string> = {};
      if (attachments.length > 0) {
        const payload =
          request?.kind === "user-input.requested"
            ? decodeUserInputRequestedPayload(request.payload)
            : Option.none();
        if (Option.isNone(payload)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail:
              request?.kind === "user-input.resolved"
                ? "This question has already been answered."
                : "This question is no longer pending.",
          });
        }
        questionTextById = Object.fromEntries(
          payload.value.questions.map((question) => [question.id, question.question]),
        );
        for (const questionId of Object.keys(command.attachmentsByQuestionId ?? {})) {
          const question = payload.value.questions.find((question) => question.id === questionId);
          if (!question || question.allowCustomAnswer === false) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "This question does not accept file references.",
            });
          }
        }
      }
      if (
        request &&
        Predicate.isObject(request.payload) &&
        request.payload.responseMode === "message"
      ) {
        const payload = decodeUserInputRequestedPayload(request.payload);
        if (request.kind !== "user-input.requested" || Option.isNone(payload)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "This question has already been answered.",
          });
        }
        const replies: string[] = [];
        for (const question of payload.value.questions) {
          const answer = command.answers[question.id];
          if (
            typeof answer !== "string" ||
            (answer.trim().length === 0 && !command.attachmentsByQuestionId?.[question.id]?.length)
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Answer each question before sending.",
            });
          }
          const questionAttachments = command.attachmentsByQuestionId?.[question.id] ?? [];
          const attachmentLabels = questionAttachments
            .map((attachment) => `Attached file: ${attachment.name} (${attachment.id})`)
            .join("\n");
          replies.push(
            [`${question.question}\n${answer.trim()}`, attachmentLabels].filter(Boolean).join("\n"),
          );
        }
        // Commit the answer and its message together. The normal turn path
        // steers a running agent or resumes an idle session.
        return yield* decideCommandSequence({
          readModel,
          commands: [
            {
              type: "thread.activity.append",
              commandId: command.commandId,
              threadId: command.threadId,
              createdAt: command.createdAt,
              activity: {
                id: EventId.make(`async-answer:${command.requestId}`),
                kind: "user-input.resolved",
                summary: "User input submitted",
                tone: "info",
                turnId: request.turnId,
                createdAt: command.createdAt,
                payload: {
                  requestId: command.requestId,
                  responseMode: "message",
                  answers: command.answers,
                  ...(command.attachmentsByQuestionId
                    ? { attachmentsByQuestionId: command.attachmentsByQuestionId }
                    : {}),
                },
              },
            },
            {
              type: "thread.turn.start",
              commandId: command.commandId,
              threadId: command.threadId,
              createdAt: command.createdAt,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              message: {
                messageId: MessageId.make(`async-answer:${command.requestId}`),
                role: "user",
                text: replies.join("\n\n"),
                attachments,
              },
            },
          ],
        });
      }
      const responseEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: { requestId: command.requestId },
        })),
        type: "thread.user-input-response-requested" as const,
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          ...(command.attachmentsByQuestionId
            ? { attachmentsByQuestionId: command.attachmentsByQuestionId }
            : {}),
          createdAt: command.createdAt,
        },
      };
      if (attachments.length === 0) return responseEvent;
      const historyEvent = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.activity.append",
          commandId: command.commandId,
          threadId: command.threadId,
          createdAt: command.createdAt,
          activity: {
            id: EventId.make(`question-answer:${command.commandId}`),
            kind: "user-input.answer-submitted",
            summary: "Question answer submitted",
            tone: "info",
            turnId: request?.turnId ?? null,
            createdAt: command.createdAt,
            payload: {
              requestId: command.requestId,
              answers: command.answers,
              questionTextById,
              attachmentsByQuestionId: command.attachmentsByQuestionId,
              detail: attachments.map((attachment) => attachment.name).join("\n"),
            },
          },
        },
      });
      return [...(Array.isArray(historyEvent) ? historyEvent : [historyEvent]), responseEvent];
    }

    case "thread.user-input.dismiss": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const request = userInputActivity;
      if (request === undefined || request.kind !== "user-input.requested") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This question has already been answered.",
        });
      }
      // Only async questions can be dropped silently. A native callback
      // question leaves the provider blocked until it gets a reply, so it
      // still needs an answer or an interrupted turn.
      if (!Predicate.isObject(request.payload) || request.payload.responseMode !== "message") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This question needs an answer. Answer it or stop the turn.",
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: {
            id: EventId.make(`async-dismiss:${command.requestId}`),
            kind: "user-input.resolved",
            summary: "User input dismissed",
            tone: "info",
            turnId: request.turnId,
            createdAt: command.createdAt,
            payload: { requestId: command.requestId, responseMode: "message" },
          },
        },
      };
    }

    case "thread.conversation.revert":
    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          ...(command.type === "thread.conversation.revert" ? { restoreFiles: false } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Settle-cleanup stops are conditional: between the settle landing and
      // this command, another client may have re-engaged the thread (a turn
      // start unsettles it and brings the session alive). Commands are
      // decided serially against this read model, so checking here — not in
      // the dispatcher's pre-settle snapshot — closes that race.
      if (command.onlyIfSettled === true) {
        const sessionComingAlive =
          thread.session?.status === "starting" || thread.session?.status === "running";
        if (
          thread.settledOverride !== "settled" ||
          sessionComingAlive ||
          hasQueuedTurnStartForThread(thread, command.createdAt)
        ) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `thread ${command.threadId} was re-engaged after settle; skipping session stop`,
            }),
          );
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
      // Only a session coming alive is activity worth waking a settled thread
      // for — status writes like ready/stopped/error arrive after the fact and
      // must not fight a user's explicit settle. Snooze is deliberately NOT
      // cleared here: snooze never pauses the agent, so its session starting
      // or erroring is not the user re-engaging. Blocked/failed work still
      // surfaces immediately — effectiveSnoozed refuses to classify a thread
      // with a raised hand (approval / input / failure / fresh completion)
      // as snoozed, without spending the return ticket.
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !isSessionActivity) {
        return sessionSetEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, sessionSetEvent];
    }

    case "thread.message.assistant.delta": {
      if (isImportedAgentSessionMessageId(command.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message id '${command.messageId}' uses the reserved imported-session namespace.`,
        });
      }
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      if (isImportedAgentSessionMessageId(command.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message id '${command.messageId}' uses the reserved imported-session namespace.`,
        });
      }
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.history.import": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        thread.messages.length > 0 ||
        thread.latestTurn !== null ||
        thread.session !== null ||
        openRequests(thread).size > 0
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' must be active and empty before history can be imported.`,
        });
      }
      const firstMessage = command.messages[0];
      if (firstMessage === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Thread history imports require at least one message.",
        });
      }

      const events: Array<PlannedOrchestrationEvent> = [];
      for (const message of command.messages) {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: message.createdAt,
            commandId: command.commandId,
            metadata: { historyImport: true },
          })),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            turnId: null,
            streaming: false,
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
          },
        });
      }
      const settledAt = command.messages.reduce(
        (latest, message) =>
          compareDateTimeStrings(message.createdAt, latest) > 0 ? message.createdAt : latest,
        firstMessage.createdAt,
      );
      events.push({
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: settledAt,
          commandId: command.commandId,
          metadata: { historyImport: true },
        })),
        type: "thread.settled",
        payload: {
          threadId: command.threadId,
          settledAt,
          updatedAt: settledAt,
        },
      });
      return events;
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityAppendedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      // An approval or user-input request is blocked-on-you work — it must
      // never stay hidden inside a settled slim row.
      const wakesSettledThread =
        command.activity.kind === "approval.requested" ||
        command.activity.kind === "user-input.requested";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !wakesSettledThread) {
        return activityAppendedEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, activityAppendedEvent];
    }

    case "agent.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireAgentAbsent({
        readModel,
        command,
        agentId: command.agentId,
      });
      yield* requireAgentNameAvailable({
        readModel,
        command,
        projectId: command.projectId,
        name: command.name,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "agent",
          aggregateId: command.agentId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "agent.created",
        payload: {
          agentId: command.agentId,
          projectId: command.projectId,
          name: command.name,
          avatar: command.avatar ?? null,
          roleTags: command.roleTags,
          rolePrompt: command.rolePrompt,
          modelSelection: command.modelSelection,
          capabilities: command.capabilities,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "agent.update": {
      const agent = yield* requireAgent({
        readModel,
        command,
        agentId: command.agentId,
      });
      if (command.name !== undefined) {
        yield* requireAgentNameAvailable({
          readModel,
          command,
          projectId: agent.projectId,
          name: command.name,
          exceptAgentId: agent.id,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "agent",
          aggregateId: command.agentId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "agent.updated",
        payload: {
          agentId: command.agentId,
          ...(command.name !== undefined ? { name: command.name } : {}),
          ...(command.avatar !== undefined ? { avatar: command.avatar } : {}),
          ...(command.roleTags !== undefined ? { roleTags: command.roleTags } : {}),
          ...(command.rolePrompt !== undefined ? { rolePrompt: command.rolePrompt } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.capabilities !== undefined ? { capabilities: command.capabilities } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "agent.archive": {
      const agent = yield* requireAgent({
        readModel,
        command,
        agentId: command.agentId,
      });
      if (agent.archivedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Agent '${command.agentId}' is already archived.`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "agent",
          aggregateId: command.agentId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "agent.archived",
        payload: {
          agentId: command.agentId,
          archivedAt: occurredAt,
        },
      };
    }

    case "agent.unarchive": {
      const agent = yield* requireAgent({
        readModel,
        command,
        agentId: command.agentId,
      });
      if (agent.archivedAt === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Agent '${command.agentId}' is not archived.`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "agent",
          aggregateId: command.agentId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "agent.unarchived",
        payload: {
          agentId: command.agentId,
          updatedAt: occurredAt,
        },
      };
    }

    case "card.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireCardAbsent({
        readModel,
        command,
        cardId: command.cardId,
      });
      const channelId = command.channelId ?? null;
      if (
        channelId !== null &&
        !(readModel.channels ?? []).some(
          (channel) => channel.id === channelId && channel.projectId === command.projectId,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Channel '${channelId}' is not in project '${command.projectId}'.`,
        });
      }
      const parentCardId = command.parentCardId ?? null;
      if (parentCardId !== null) {
        const parent = yield* requireCard({ readModel, command, cardId: parentCardId });
        if (parent.projectId !== command.projectId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Parent card '${parentCardId}' is in another project.`,
          });
        }
        if (isFinishedCardStatus(parent.status)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "A sub-card cannot be added to a card that has landed or been abandoned.",
          });
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "card.created",
        payload: {
          cardId: command.cardId,
          projectId: command.projectId,
          channelId,
          parentCardId,
          title: command.title,
          spec: command.spec,
          specState: "draft",
          tags: command.tags,
          // Every card starts as a proposal; only a human approves it into work.
          status: "triage",
          ownerHumanId: CHANNEL_HUMAN_AUTHOR_ID,
          baseBranch: command.baseBranch ?? null,
          createdBy: { kind: "human", id: CHANNEL_HUMAN_AUTHOR_ID },
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "card.update": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      if (isFinishedCardStatus(card.status)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A card that has landed or been abandoned cannot be edited.",
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "card.updated",
        payload: {
          cardId: command.cardId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.spec !== undefined ? { spec: command.spec } : {}),
          // Changing an approved or skipped spec sends it back through the plan gate.
          ...(command.spec !== undefined &&
          command.spec !== card.spec &&
          card.specState !== "draft"
            ? { specState: "draft" as const }
            : {}),
          ...(command.tags !== undefined ? { tags: command.tags } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "card.approve":
      return yield* decideCardMove({ readModel, command, move: "approve" });
    case "card.unapprove":
      return yield* decideCardMove({ readModel, command, move: "unapprove" });
    case "card.merge.approve":
      return yield* decideCardMove({ readModel, command, move: "approveMerge" });
    case "card.merge.cancel":
      return yield* decideCardMove({ readModel, command, move: "cancelLanding" });
    case "card.abandon":
      return yield* decideCardMove({ readModel, command, move: "abandon" });
    case "card.reopen":
      return yield* decideCardMove({ readModel, command, move: "reopen" });
    case "card.work.start":
      return yield* decideCardMove({ readModel, command, move: "workStarted" });
    case "card.review.request":
      return yield* decideCardMove({ readModel, command, move: "requestReview" });
    case "card.work.return":
      return yield* decideCardMove({
        readModel,
        command,
        move: "returnToWork",
        reason: command.reason,
      });
    case "card.land":
      return yield* decideCardMove({ readModel, command, move: "landed" });

    case "card.assign":
    case "card.unassign": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      let delegateAgentId: AgentId | null = null;
      if (command.type === "card.assign") {
        const agent = yield* requireAgent({ readModel, command, agentId: command.agentId });
        if (agent.projectId !== card.projectId || agent.archivedAt !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Agent '${agent.id}' is not an active agent of this card's project.`,
          });
        }
        if (card.delegateAgentId === agent.id) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `@${agent.name} is already assigned to this card.`,
          });
        }
        delegateAgentId = agent.id;
      } else if (card.delegateAgentId === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "No agent is assigned to this card.",
        });
      }
      // An idle owner session is stopped and handed off; one mid-turn holds the card.
      const owner = liveOwnerRun(readModel, card.id);
      const ownerThread =
        owner === undefined
          ? undefined
          : readModel.threads.find((thread) => thread.id === owner.threadId);
      const allowed = canChangeDelegate(card, (ownerThread?.session?.activeTurnId ?? null) !== null);
      if (!allowed.ok) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: allowed.reason,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "card.delegate-changed",
        payload: {
          cardId: command.cardId,
          delegateAgentId,
          updatedAt: occurredAt,
        },
      };
    }

    case "card.relation.add":
    case "card.relation.remove": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      const exists = card.relations.some(
        (relation) => relation.kind === command.kind && relation.cardId === command.otherCardId,
      );
      if (command.type === "card.relation.add") {
        const other = yield* requireCard({ readModel, command, cardId: command.otherCardId });
        const problem =
          other.id === card.id
            ? "A card cannot relate to itself."
            : other.projectId !== card.projectId
              ? "Related cards must be in the same project."
              : command.kind === "overlaps"
                ? "Overlaps are flagged by the server when a card lands."
                : exists
                  ? "These cards already have that relation."
                  : null;
        if (problem !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: problem,
          });
        }
      } else if (!exists) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "These cards do not have that relation.",
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: command.type === "card.relation.add" ? "card.relation-added" : "card.relation-removed",
        payload: {
          cardId: command.cardId,
          kind: command.kind,
          otherCardId: command.otherCardId,
          updatedAt: occurredAt,
        },
      };
    }

    case "card.workspace.set": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      if (isFinishedCardStatus(card.status)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A card that has landed or been abandoned cannot get a workspace.",
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "card.workspace-set",
        payload: {
          cardId: command.cardId,
          branch: command.branch,
          worktreePath: command.worktreePath,
          portBase: command.portBase,
          updatedAt: occurredAt,
        },
      };
    }

    case "card.workspace.clear": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      if (card.worktreePath === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This card has no workspace to clear.",
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "card.workspace-cleared",
        payload: {
          cardId: command.cardId,
          updatedAt: occurredAt,
        },
      };
    }

    case "card.decision.record": {
      yield* requireCard({ readModel, command, cardId: command.cardId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "card.decision-recorded",
        payload: {
          cardId: command.cardId,
          decisionId: command.decisionId,
          author: { kind: "human", id: CHANNEL_HUMAN_AUTHOR_ID },
          text: command.text,
          createdAt: command.createdAt,
        },
      };
    }

    case "card.spend.record": {
      yield* requireCard({ readModel, command, cardId: command.cardId });
      if (!Number.isFinite(command.costUsd) || command.costUsd < 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A turn's cost must be a finite amount of zero or more.",
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt: command.recordedAt,
          commandId: command.commandId,
        })),
        type: "card.spend-recorded",
        payload: {
          cardId: command.cardId,
          threadId: command.threadId,
          agentId: command.agentId,
          turnId: command.turnId,
          costUsd: command.costUsd,
          costSource: command.costSource,
          recordedAt: command.recordedAt,
        },
      };
    }

    // Only a person raises a card's cap (invariant 13).
    case "card.budget.set": {
      yield* requireCard({ readModel, command, cardId: command.cardId });
      if (!Number.isFinite(command.capUsd) || command.capUsd <= 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A budget cap must be a positive amount.",
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "card.budget-set",
        payload: { cardId: command.cardId, capUsd: command.capUsd, updatedAt: occurredAt },
      };
    }

    case "card.unpriced.accept":
    case "card.unpriced.refuse": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      const accepts = command.type === "card.unpriced.accept";
      if (card.acceptsUnpriced === accepts) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: accepts
            ? "The card already runs its unpriced model uncapped."
            : "The card already holds its unpriced model for a person to accept.",
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "card.unpriced-accepted",
        payload: { cardId: command.cardId, accepts, updatedAt: occurredAt },
      };
    }

    case "card.checks.record": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      const previousFailures = card.checks?.failedRuns ?? 0;
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        })),
        type: "card.checks-updated",
        payload: {
          cardId: command.cardId,
          checks: {
            state: command.state,
            // A pass clears the streak; a run in progress keeps it until it ends.
            failedRuns:
              command.state === "passed"
                ? 0
                : command.state === "failed"
                  ? previousFailures + 1
                  : previousFailures,
            summary: command.summary,
            updatedAt: command.updatedAt,
          },
        },
      };
    }

    // Invariant 8: overlaps are flagged by the server when a card lands.
    case "card.overlap.flag": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      const other = yield* requireCard({ readModel, command, cardId: command.otherCardId });
      if (other.id === card.id || other.projectId !== card.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Only two different cards of one project can overlap.",
        });
      }
      if (
        card.relations.some(
          (relation) => relation.kind === "overlaps" && relation.cardId === other.id,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "These cards are already flagged as overlapping.",
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "card.relation-added",
        payload: {
          cardId: command.cardId,
          kind: "overlaps",
          otherCardId: command.otherCardId,
          updatedAt: occurredAt,
        },
      };
    }

    case "card.review.comment": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      if (isFinishedCardStatus(card.status)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A card that has landed or been abandoned takes no review comments.",
        });
      }
      const comment: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "card.message-posted",
        payload: {
          cardId: command.cardId,
          messageId: command.messageId,
          authorKind: "human",
          authorId: CHANNEL_HUMAN_AUTHOR_ID,
          body: command.body,
          runThreadId: null,
          forOwner: true,
          createdAt: command.createdAt,
        },
      };
      // A comment on a card in review sends it back to work, with the comment as its next turn.
      return card.status === "inReview" || card.status === "landing"
        ? [
            comment,
            yield* decideCardMove({
              readModel,
              command,
              move: "returnToWork",
              reason: "A review comment came in.",
            }),
          ]
        : comment;
    }

    case "card.diff.record": {
      yield* requireCard({ readModel, command, cardId: command.cardId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt: command.measuredAt,
          commandId: command.commandId,
        })),
        type: "card.diff-measured",
        payload: {
          cardId: command.cardId,
          diffStat: command.diffStat,
          measuredAt: command.measuredAt,
        },
      };
    }

    case "card.snooze": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      const refuse = (detail: string) =>
        new OrchestrationCommandInvariantError({ commandType: command.type, detail });
      if (isFinishedCardStatus(card.status)) {
        return yield* refuse("A card that has landed or been abandoned waits on no one.");
      }
      // A wake time must be real and after the snooze itself; an unparseable one fails too.
      if (
        command.snoozedUntil !== null &&
        !(Date.parse(command.snoozedUntil) > Date.parse(command.createdAt))
      ) {
        return yield* refuse("Snooze until a time in the future.");
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "card.snoozed",
        payload: {
          cardId: command.cardId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: command.createdAt,
        },
      };
    }

    case "card.unsnooze": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      if (card.snoozedAt === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The card is not snoozed.",
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "card.unsnoozed",
        payload: { cardId: command.cardId, updatedAt: occurredAt },
      };
    }

    case "card.spec.approve":
    case "card.spec.skip":
    case "card.spec.reopen": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      const refuse = (detail: string) =>
        new OrchestrationCommandInvariantError({ commandType: command.type, detail });
      if (isFinishedCardStatus(card.status)) {
        return yield* refuse("A card that has landed or been abandoned keeps its spec as it is.");
      }
      const to = SPEC_DECISION_TARGET[command.type];
      if (to === "draft" ? card.specState === "draft" : card.specState !== "draft") {
        return yield* refuse(
          card.specState === "draft"
            ? "The spec is already a draft."
            : `The spec is already ${card.specState}.`,
        );
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "card.spec-state-changed",
        payload: {
          cardId: command.cardId,
          from: card.specState,
          to,
          by: { kind: "human", id: CHANNEL_HUMAN_AUTHOR_ID },
          updatedAt: occurredAt,
        },
      };
    }

    case "card.spec.submit": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      const refuse = (detail: string) =>
        new OrchestrationCommandInvariantError({ commandType: command.type, detail });
      if (isFinishedCardStatus(card.status)) {
        return yield* refuse(FINISHED_CARD_SESSION_REASON);
      }
      if (card.specState !== "draft") {
        return yield* refuse("Only a draft spec is reviewed; reopen the spec first.");
      }
      if (card.spec.trim().length === 0) {
        return yield* refuse("Write a spec before submitting it.");
      }
      const criticId = command.agentId ?? card.delegateAgentId;
      if (criticId === null) {
        return yield* refuse("Choose an agent to review the spec.");
      }
      const critic = yield* requireAgent({ readModel, command, agentId: criticId });
      if (critic.projectId !== card.projectId || critic.archivedAt !== null) {
        return yield* refuse(`@${critic.name} isn't an active agent of this card's project.`);
      }
      if (projectLiveRunCount(readModel, card.projectId) >= DEFAULT_PROJECT_RUN_CAP) {
        return yield* refuse(sessionCapReason);
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "card.spec-submitted",
        payload: {
          cardId: command.cardId,
          agentId: critic.id,
          submittedAt: occurredAt,
        },
      };
    }

    case "card.session.start": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      const refuse = (detail: string) =>
        new OrchestrationCommandInvariantError({ commandType: command.type, detail });
      if (isFinishedCardStatus(card.status)) {
        return yield* refuse(FINISHED_CARD_SESSION_REASON);
      }
      if (card.delegateAgentId === null) {
        return yield* refuse("Assign an agent before starting a session.");
      }
      if (card.specState === "draft") {
        return yield* refuse(PLAN_GATE_REASON);
      }
      // Invariant 11: one writer per card.
      if (liveOwnerRun(readModel, card.id) !== undefined) {
        return yield* refuse(SECOND_WRITER_REASON);
      }
      if (projectLiveRunCount(readModel, card.projectId) >= DEFAULT_PROJECT_RUN_CAP) {
        return yield* refuse(sessionCapReason);
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "card.session-requested",
        payload: {
          cardId: command.cardId,
          agentId: card.delegateAgentId,
          requestedAt: command.createdAt,
        },
      };
    }

    case "card.helper.request": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      const agent = yield* requireAgent({ readModel, command, agentId: command.agentId });
      const refuse = (detail: string) =>
        new OrchestrationCommandInvariantError({ commandType: command.type, detail });
      if (agent.projectId !== card.projectId || agent.archivedAt !== null) {
        return yield* refuse(`@${agent.name} isn't an active agent of this card's project.`);
      }
      if (isFinishedCardStatus(card.status)) {
        return yield* refuse(FINISHED_CARD_SESSION_REASON);
      }
      if (projectLiveRunCount(readModel, card.projectId) >= DEFAULT_PROJECT_RUN_CAP) {
        return yield* refuse(sessionCapReason);
      }
      const cardEventBase = () =>
        withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        });
      return [
        {
          ...(yield* cardEventBase()),
          type: "card.message-posted",
          payload: {
            cardId: command.cardId,
            messageId: command.messageId,
            authorKind: "human",
            authorId: CHANNEL_HUMAN_AUTHOR_ID,
            body: `@${agent.name} ${command.question}`,
            runThreadId: null,
            forOwner: false,
            createdAt: command.createdAt,
          },
        },
        {
          ...(yield* cardEventBase()),
          type: "card.helper-requested",
          payload: {
            cardId: command.cardId,
            agentId: agent.id,
            messageId: command.messageId,
            question: command.question,
            requestedAt: command.createdAt,
          },
        },
      ];
    }

    case "card.message.post": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      if (isFinishedCardStatus(card.status)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A card that has landed or been abandoned takes no new messages.",
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "card.message-posted",
        payload: {
          cardId: command.cardId,
          messageId: command.messageId,
          authorKind: "human",
          authorId: CHANNEL_HUMAN_AUTHOR_ID,
          body: command.body,
          runThreadId: null,
          forOwner: true,
          createdAt: command.createdAt,
        },
      };
    }

    case "card.session.record": {
      const card = yield* requireCard({ readModel, command, cardId: command.cardId });
      const agent = yield* requireAgent({ readModel, command, agentId: command.agentId });
      const refuse = (detail: string) =>
        new OrchestrationCommandInvariantError({ commandType: command.type, detail });
      if (isFinishedCardStatus(card.status)) {
        return yield* refuse(FINISHED_CARD_SESSION_REASON);
      }
      if (agent.projectId !== card.projectId || agent.archivedAt !== null) {
        return yield* refuse(`@${agent.name} isn't an active agent of this card's project.`);
      }
      if (command.role === "owner") {
        if (card.delegateAgentId !== agent.id) {
          return yield* refuse(`Only the card's assigned agent writes to it, not @${agent.name}.`);
        }
        // Invariant 11: one writer per card.
        if (liveOwnerRun(readModel, card.id) !== undefined) {
          return yield* refuse(SECOND_WRITER_REASON);
        }
        if (card.worktreePath === null) {
          return yield* refuse("An owner session works in the card's worktree, which is missing.");
        }
        if (card.specState === "draft") {
          return yield* refuse(PLAN_GATE_REASON);
        }
        const beyond = command.capabilities.filter(
          (capability) => !agent.capabilities.includes(capability),
        );
        if (beyond.length > 0) {
          return yield* refuse(`@${agent.name} is not allowed ${beyond.join(", ")}.`);
        }
      } else if (command.capabilities.some((capability) => capability !== "read")) {
        // Invariant 11: helpers and critics are read-only.
        return yield* refuse(`A ${command.role} session is read-only.`);
      }
      if (projectLiveRunCount(readModel, card.projectId) >= DEFAULT_PROJECT_RUN_CAP) {
        return yield* refuse(sessionCapReason);
      }
      const overBudget = cardBudgetRefusal(card);
      if (overBudget !== null) {
        return yield* refuse(overBudget);
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt: command.startedAt,
          commandId: command.commandId,
        })),
        type: "card.session-started",
        payload: {
          threadId: command.threadId,
          cardId: command.cardId,
          agentId: command.agentId,
          role: command.role,
          capabilities: command.capabilities,
          context: command.context,
          rendered: command.rendered,
          startedAt: command.startedAt,
        },
      };
    }

    case "card.message.record": {
      yield* requireCard({ readModel, command, cardId: command.cardId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "card.message-posted",
        payload: {
          cardId: command.cardId,
          messageId: command.messageId,
          authorKind: command.authorKind,
          authorId: command.authorId,
          body: command.body,
          runThreadId: command.runThreadId,
          forOwner: command.forOwner,
          createdAt: command.createdAt,
        },
      };
    }

    case "card.delivery.update": {
      yield* requireCard({ readModel, command, cardId: command.cardId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "card",
          aggregateId: command.cardId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        })),
        type: "card.delivery-updated",
        payload: {
          cardId: command.cardId,
          messageIds: command.messageIds,
          status: command.status,
          threadId: command.threadId,
          updatedAt: command.updatedAt,
        },
      };
    }

    // A DM writes into one of the agent's live sessions under its delivery rules,
    // and never starts one.
    case "agent.session.message": {
      const run = (readModel.liveRuns ?? []).find(
        (candidate) => candidate.threadId === command.threadId,
      );
      const refuse = (detail: string) =>
        new OrchestrationCommandInvariantError({ commandType: command.type, detail });
      if (run === undefined) {
        return yield* refuse("That session has ended; a DM message never starts a session.");
      }
      if (run.role === "helper" || run.role === "critic") {
        return yield* refuse(`A ${run.role} takes no messages; write to the card's owner session.`);
      }
      if (run.cardId !== null) {
        return yield* decideOrchestrationCommand({
          command: {
            type: "card.message.post",
            commandId: command.commandId,
            cardId: run.cardId,
            messageId: command.messageId,
            body: command.body,
            createdAt: command.createdAt,
          },
          readModel,
        });
      }
      if (run.channelId === null) {
        return yield* refuse("That session belongs to no channel or card.");
      }
      const agent = yield* requireAgent({ readModel, command, agentId: run.agentId });
      const projectAgents = (readModel.agents ?? []).filter(
        (candidate) => candidate.projectId === agent.projectId,
      );
      // Posted in the session's channel, addressed to the agent so it joins its live run.
      const addressed = parseMentions(command.body, projectAgents).includes(agent.id);
      return yield* decideOrchestrationCommand({
        command: {
          type: "channel.message.post",
          commandId: command.commandId,
          channelId: run.channelId,
          messageId: command.messageId,
          body: addressed ? command.body : `@${agent.name} ${command.body}`,
          createdAt: command.createdAt,
        },
        readModel,
      });
    }

    case "channel.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireChannelAbsent({
        readModel,
        command,
        channelId: command.channelId,
      });
      yield* requireValidChannelMembers({
        readModel,
        command,
        projectId: command.projectId,
        kind: command.kind,
        memberAgentIds: command.memberAgentIds,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "channel.created",
        payload: {
          channelId: command.channelId,
          projectId: command.projectId,
          kind: command.kind,
          name: command.name,
          topic: command.topic ?? "",
          pinnedSpec: command.pinnedSpec ?? "",
          wakeDepth: command.wakeDepth ?? DEFAULT_CHANNEL_WAKE_DEPTH,
          memberAgentIds: command.memberAgentIds,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "channel.update": {
      const channel = yield* requireChannel({
        readModel,
        command,
        channelId: command.channelId,
      });
      if (command.memberAgentIds !== undefined) {
        yield* requireValidChannelMembers({
          readModel,
          command,
          projectId: channel.projectId,
          kind: channel.kind,
          memberAgentIds: command.memberAgentIds,
          exceptChannelId: channel.id,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "channel.updated",
        payload: {
          channelId: command.channelId,
          ...(command.name !== undefined ? { name: command.name } : {}),
          ...(command.topic !== undefined ? { topic: command.topic } : {}),
          ...(command.pinnedSpec !== undefined ? { pinnedSpec: command.pinnedSpec } : {}),
          ...(command.wakeDepth !== undefined ? { wakeDepth: command.wakeDepth } : {}),
          ...(command.memberAgentIds !== undefined
            ? { memberAgentIds: command.memberAgentIds }
            : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "channel.archive": {
      const channel = yield* requireChannel({
        readModel,
        command,
        channelId: command.channelId,
      });
      if (channel.archivedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Channel '${command.channelId}' is already archived.`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "channel.archived",
        payload: {
          channelId: command.channelId,
          archivedAt: occurredAt,
        },
      };
    }

    case "channel.unarchive": {
      const channel = yield* requireChannel({
        readModel,
        command,
        channelId: command.channelId,
      });
      if (channel.archivedAt === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Channel '${command.channelId}' is not archived.`,
        });
      }
      // Members may have been archived, or gained another DM, while this channel was archived.
      yield* requireValidChannelMembers({
        readModel,
        command,
        projectId: channel.projectId,
        kind: channel.kind,
        memberAgentIds: channel.memberAgentIds,
        exceptChannelId: channel.id,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "channel.unarchived",
        payload: {
          channelId: command.channelId,
          updatedAt: occurredAt,
        },
      };
    }

    case "channel.message.post": {
      const channel = yield* requireChannel({
        readModel,
        command,
        channelId: command.channelId,
      });
      if (channel.archivedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Channel '${command.channelId}' is archived and cannot receive messages.`,
        });
      }
      const projectAgents = (readModel.agents ?? []).filter(
        (agent) => agent.projectId === channel.projectId,
      );
      const mentions = parseMentions(command.body, projectAgents);
      const channelEventBase = () =>
        withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        });
      const messageEvent: PlannedOrchestrationEvent = {
        ...(yield* channelEventBase()),
        type: "channel.message-posted",
        payload: {
          channelId: command.channelId,
          messageId: command.messageId,
          authorKind: "human",
          authorId: CHANNEL_HUMAN_AUTHOR_ID,
          body: command.body,
          createdAt: command.createdAt,
          ...(mentions.length > 0 ? { mentions } : {}),
        },
      };

      // Invariant 3: only a mention, or a message in an agent's DM, wakes anyone.
      const targets = channel.kind === "dm" ? channel.memberAgentIds : mentions;
      const events: PlannedOrchestrationEvent[] = [messageEvent];
      let newRuns = 0;
      for (const agentId of targets) {
        const agent = projectAgents.find((candidate) => candidate.id === agentId);
        if (agent === undefined) {
          continue;
        }
        const decision = decideWake({ readModel, channel, agent, newRuns });
        if (decision.kind === "refuse") {
          // Invariant 4: a refused wake is said in the channel, never dropped silently.
          events.push({
            ...(yield* channelEventBase()),
            type: "channel.message-posted",
            payload: {
              channelId: command.channelId,
              messageId: MessageId.make(`${command.messageId}:system:${agent.id}`),
              authorKind: "system",
              authorId: CHANNEL_SYSTEM_AUTHOR_ID,
              body: decision.reason,
              createdAt: command.createdAt,
            },
          });
          continue;
        }
        if (decision.liveRunThreadId === undefined) {
          newRuns += 1;
        }
        events.push({
          ...(yield* channelEventBase()),
          type: "channel.agent-wake-requested",
          payload: {
            channelId: command.channelId,
            agentId: agent.id,
            triggerMessageId: command.messageId,
            requestedAt: command.createdAt,
            ...(decision.liveRunThreadId !== undefined
              ? { liveRunThreadId: decision.liveRunThreadId }
              : {}),
          },
        });
      }
      return events.length === 1 ? messageEvent : events;
    }

    case "channel.agent.wake": {
      const channel = yield* requireChannel({
        readModel,
        command,
        channelId: command.channelId,
      });
      const agent = yield* requireAgent({
        readModel,
        command,
        agentId: command.agentId,
      });
      if (channel.archivedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Channel '${channel.id}' is archived and cannot wake agents.`,
        });
      }
      const decision = decideWake({ readModel, channel, agent, newRuns: 0 });
      if (decision.kind === "refuse") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: decision.reason,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "channel.agent-wake-requested",
        payload: {
          channelId: command.channelId,
          agentId: command.agentId,
          triggerMessageId: command.triggerMessageId,
          requestedAt: command.createdAt,
          ...(decision.liveRunThreadId !== undefined
            ? { liveRunThreadId: decision.liveRunThreadId }
            : {}),
        },
      };
    }

    case "channel.run.start": {
      yield* requireChannel({
        readModel,
        command,
        channelId: command.channelId,
      });
      yield* requireAgent({
        readModel,
        command,
        agentId: command.agentId,
      });
      // Invariant 1: a conversation run never writes. Writing needs a card.
      if (command.capabilities.some((capability) => capability !== "read")) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A channel conversation run is read-only; writing requires a card.",
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt: command.startedAt,
          commandId: command.commandId,
        })),
        type: "channel.run-started",
        payload: {
          threadId: command.threadId,
          channelId: command.channelId,
          agentId: command.agentId,
          triggerMessageId: command.triggerMessageId,
          capabilities: command.capabilities,
          context: command.context,
          rendered: command.rendered,
          startedAt: command.startedAt,
        },
      };
    }

    case "channel.delivery.update": {
      yield* requireChannel({
        readModel,
        command,
        channelId: command.channelId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        })),
        type: "channel.delivery-updated",
        payload: {
          channelId: command.channelId,
          agentId: command.agentId,
          messageIds: command.messageIds,
          status: command.status,
          runThreadId: command.runThreadId,
          updatedAt: command.updatedAt,
        },
      };
    }

    case "channel.message.agent.post": {
      const channel = yield* requireChannel({
        readModel,
        command,
        channelId: command.channelId,
      });
      yield* requireAgent({
        readModel,
        command,
        agentId: command.agentId,
      });
      if (channel.archivedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Channel '${command.channelId}' is archived and cannot receive messages.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "channel.message-posted",
        payload: {
          channelId: command.channelId,
          messageId: command.messageId,
          authorKind: "agent",
          authorId: command.agentId,
          body: command.body,
          createdAt: command.createdAt,
          runThreadId: command.runThreadId,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
