import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  type ClientOrchestrationCommand,
} from "@iskra/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  type EnvironmentRpcFailure,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcUnavailableError,
  request,
} from "../rpc/client.ts";

type CommandType = ClientOrchestrationCommand["type"];
type CommandOf<T extends CommandType> = Extract<ClientOrchestrationCommand, { readonly type: T }>;
type CommandInput<T extends CommandType> = Omit<
  CommandOf<T>,
  "type" | "commandId" | "createdAt"
> & {
  readonly commandId?: CommandId;
} & ("createdAt" extends keyof CommandOf<T>
    ? {
        readonly createdAt?: CommandOf<T>["createdAt"];
      }
    : {});

export type CreateProjectInput = CommandInput<"project.create">;
export type UpdateProjectInput = CommandInput<"project.meta.update">;
export type DeleteProjectInput = CommandInput<"project.delete">;
export type CreateThreadInput = CommandInput<"thread.create">;
export type DeleteThreadInput = CommandInput<"thread.delete">;
export type ArchiveThreadInput = CommandInput<"thread.archive">;
export type UnarchiveThreadInput = CommandInput<"thread.unarchive">;
export type SettleThreadInput = CommandInput<"thread.settle">;
export type UnsettleThreadInput = CommandInput<"thread.unsettle">;
export type SnoozeThreadInput = CommandInput<"thread.snooze">;
export type UnsnoozeThreadInput = CommandInput<"thread.unsnooze">;
export type PinThreadInput = CommandInput<"thread.pin">;
export type UnpinThreadInput = CommandInput<"thread.unpin">;
export type ReorderPinnedThreadInput = CommandInput<"thread.pin.reorder">;
export type ReorderActiveThreadInput = CommandInput<"thread.active.reorder">;
export type UpdateThreadMetadataInput = CommandInput<"thread.meta.update">;
export type LinkThreadPullRequestInput = CommandInput<"thread.pull-request.link">;
export type UnlinkThreadPullRequestInput = CommandInput<"thread.pull-request.unlink">;
export type SetThreadRuntimeModeInput = CommandInput<"thread.runtime-mode.set">;
export type SetThreadInteractionModeInput = CommandInput<"thread.interaction-mode.set">;
export type StartThreadTurnInput = CommandInput<"thread.turn.start">;
export type InterruptThreadTurnInput = CommandInput<"thread.turn.interrupt">;
export type RespondToThreadApprovalInput = CommandInput<"thread.approval.respond">;
export type RespondToThreadUserInputInput = CommandInput<"thread.user-input.respond">;
export type DismissThreadUserInputInput = CommandInput<"thread.user-input.dismiss">;
export type RevertThreadCheckpointInput = CommandInput<"thread.checkpoint.revert"> & {
  readonly restoreFiles?: boolean;
};
export type StopThreadSessionInput = CommandInput<"thread.session.stop">;

type DispatchTag = typeof ORCHESTRATION_WS_METHODS.dispatchCommand;
type CommandEffect = Effect.Effect<
  EnvironmentRpcSuccess<DispatchTag>,
  EnvironmentRpcFailure<DispatchTag> | EnvironmentRpcUnavailableError,
  Crypto.Crypto | EnvironmentSupervisor
>;

function commandId(input: { readonly commandId?: CommandId }) {
  return Effect.gen(function* () {
    if (input.commandId !== undefined) {
      return input.commandId;
    }
    const crypto = yield* Crypto.Crypto;
    return yield* crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make));
  });
}

type CommandMetadata = { readonly commandId?: CommandId; readonly createdAt?: string };

function timestampedCommandMetadata(input: CommandMetadata) {
  return Effect.all({
    commandId: commandId(input),
    createdAt:
      input.createdAt === undefined
        ? DateTime.now.pipe(Effect.map(DateTime.formatIso))
        : Effect.succeed(input.createdAt),
  });
}

function dispatch(command: ClientOrchestrationCommand) {
  return request(ORCHESTRATION_WS_METHODS.dispatchCommand, command);
}

export const createProject: (input: CreateProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createProject",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "project.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

/** A wrapper that fills in the command id. */
function command<T extends CommandType>(
  name: string,
  type: T,
): (input: CommandInput<T>) => CommandEffect {
  return Effect.fn(`EnvironmentCommands.${name}`)(function* (input: {
    readonly commandId?: CommandId;
  }) {
    const id = yield* commandId(input);
    return yield* dispatch({
      ...input,
      type: type as CommandType,
      commandId: id,
    } as ClientOrchestrationCommand);
  });
}

/** A wrapper that fills in the command id and, unless the caller gives one, the creation time. */
function timestampedCommand<T extends CommandType>(
  name: string,
  type: T,
): (input: Omit<CommandOf<T>, "type" | keyof CommandMetadata> & CommandMetadata) => CommandEffect {
  return Effect.fn(`EnvironmentCommands.${name}`)(function* (input: CommandMetadata) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: type as CommandType,
      ...metadata,
    } as ClientOrchestrationCommand);
  });
}

export const updateChannel = command("updateChannel", "channel.update");
export const createAgent = timestampedCommand("createAgent", "agent.create");
export const createChannel = timestampedCommand("createChannel", "channel.create");
export const postChannelMessage = timestampedCommand("postChannelMessage", "channel.message.post");
export const sendAgentSessionMessage = timestampedCommand(
  "sendAgentSessionMessage",
  "agent.session.message",
);
/** A direct message to an agent, opening its DM channel on the first one. */
export const postAgentDm = timestampedCommand("postAgentDm", "agent.dm.post");
export const archiveChannel = command("archiveChannel", "channel.archive");
export const unarchiveChannel = command("unarchiveChannel", "channel.unarchive");

/** A human decision on a card: its reverse is another of these. */
export type CardDecisionInput = CommandInput<"card.approve"> & {
  readonly type:
    | "card.approve"
    | "card.unapprove"
    | "card.merge.approve"
    | "card.merge.cancel"
    | "card.abandon"
    | "card.reopen"
    | "card.unpriced.accept"
    | "card.unpriced.refuse"
    | "card.attempt.promote"
    | "card.unassign"
    | "card.spec.approve"
    | "card.spec.skip"
    | "card.spec.reopen"
    | "card.criteria.confirm"
    | "card.evidence.capture"
    | "card.verifier.rerun"
    | "card.services.restart"
    | "card.fix-rounds.reset"
    | "card.pause"
    | "card.resume";
};

export const decideCard: (input: CardDecisionInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.decideCard",
)(function* (input) {
  const id = yield* commandId(input);
  return yield* dispatch({ commandId: id, cardId: input.cardId, type: input.type });
});

export const startCardAttempts = timestampedCommand("startCardAttempts", "card.attempts.start");
export const setCardBudget = command("setCardBudget", "card.budget.set");
export const snoozeCard = timestampedCommand("snoozeCard", "card.snooze");
/** A person's edit of a card's fields: title, spec, tags or priority. */
export const updateCard = command("updateCard", "card.update");
export const unsnoozeCard = command("unsnoozeCard", "card.unsnooze");
/** A person's new card; the client names its id. Priority is set afterwards with `updateCard`. */
export const createCard = timestampedCommand("createCard", "card.create");
export const assignCard = command("assignCard", "card.assign");
/**
 * Approve & start: approves a triage card, approves its draft spec and assigns its owner in one
 * step, so the owner session starts. Also starts a ready card that has no owner yet.
 */
export const approveAndStartCard = command("approveAndStartCard", "card.approve");
/** A person's message for the card's owner session. */
export const postCardMessage = timestampedCommand("postCardMessage", "card.message.post");
export const commentOnCardReview = timestampedCommand("commentOnCardReview", "card.review.comment");
export const addCardRelation = command("addCardRelation", "card.relation.add");
export const removeCardRelation = command("removeCardRelation", "card.relation.remove");
/** A person's acceptance criteria: a draft in triage, confirmed once the card is approved. */
export const setCardCriteria = command("setCardCriteria", "card.criteria.set");
/**
 * A person putting back refs that changed outside a card during an agent turn, all or the named
 * ones. Compare-and-swap: a ref that changed again since is skipped and reported.
 */
export const restoreCardRefs = command("restoreCardRefs", "card.refs.restore");
/** A person keeping refs that changed outside a card as they are, such as their own work. */
export const keepCardRefs = command("keepCardRefs", "card.refs.keep");
/** A person sending a comment from outside the repository to the card's agent, as a suggestion. */
export const forwardCardComment = command("forwardCardComment", "card.comment.forward");
/** A person setting aside something waiting on them that allows it, such as a comment. */
export const dismissCardAttention = command("dismissCardAttention", "card.attention.dismiss");
/** A person letting a card past a failed or pending verifier, saying why. */
export const overrideCardVerifier = command("overrideCardVerifier", "card.verifier.override");
export const acknowledgeCardFlags = command("acknowledgeCardFlags", "card.flags.acknowledge");
/**
 * A person answering a card's open question: the owner's, a checkpoint (option ids continue,
 * redirect or stop; the body is the note) or a criteria change.
 */
export const answerCardElicitation = timestampedCommand(
  "answerCardElicitation",
  "card.elicitation.answer",
);
/** A person answering a lead's question with an offered option or their own words. */
export const answerChannelElicitation = timestampedCommand(
  "answerChannelElicitation",
  "channel.elicitation.answer",
);
/** A person replacing a project's whole orchestration policy. */
export const setProjectOrchestration = command(
  "setProjectOrchestration",
  "project.orchestration.set",
);

export const updateProject: (input: UpdateProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateProject",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "project.meta.update",
    commandId: yield* commandId(input),
  });
});

export const deleteProject: (input: DeleteProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteProject",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "project.delete",
    commandId: yield* commandId(input),
  });
});

export const createThread: (input: CreateThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createThread",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const deleteThread: (input: DeleteThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.delete",
    commandId: yield* commandId(input),
  });
});

export const archiveThread: (input: ArchiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.archiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.archive",
    commandId: yield* commandId(input),
  });
});

export const unarchiveThread: (input: UnarchiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unarchiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unarchive",
    commandId: yield* commandId(input),
  });
});

export const settleThread: (input: SettleThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.settleThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.settle",
    commandId: yield* commandId(input),
  });
});

export const unsettleThread: (input: UnsettleThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsettleThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unsettle",
    commandId: yield* commandId(input),
  });
});

export const snoozeThread: (input: SnoozeThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.snoozeThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.snooze",
    commandId: yield* commandId(input),
  });
});

export const unsnoozeThread: (input: UnsnoozeThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsnoozeThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unsnooze",
    commandId: yield* commandId(input),
  });
});

export const pinThread: (input: PinThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.pinThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.pin",
    commandId: yield* commandId(input),
  });
});

export const unpinThread: (input: UnpinThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unpinThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unpin",
    commandId: yield* commandId(input),
  });
});

export const reorderPinnedThread: (input: ReorderPinnedThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.reorderPinnedThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.pin.reorder",
    commandId: yield* commandId(input),
  });
});

export const reorderActiveThread: (input: ReorderActiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.reorderActiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.active.reorder",
    commandId: yield* commandId(input),
  });
});

export const updateThreadMetadata: (input: UpdateThreadMetadataInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateThreadMetadata",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.meta.update",
    commandId: yield* commandId(input),
  });
});

export const linkThreadPullRequest: (input: LinkThreadPullRequestInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.linkThreadPullRequest")(function* (input) {
    return yield* dispatch({
      ...input,
      type: "thread.pull-request.link",
      commandId: yield* commandId(input),
    });
  });

export const unlinkThreadPullRequest: (input: UnlinkThreadPullRequestInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.unlinkThreadPullRequest")(function* (input) {
    return yield* dispatch({
      ...input,
      type: "thread.pull-request.unlink",
      commandId: yield* commandId(input),
    });
  });

export const setThreadRuntimeMode: (input: SetThreadRuntimeModeInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.setThreadRuntimeMode",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.runtime-mode.set",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const setThreadInteractionMode: (input: SetThreadInteractionModeInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.setThreadInteractionMode")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.interaction-mode.set",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const startThreadTurn: (input: StartThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.startThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.turn.start",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const interruptThreadTurn: (input: InterruptThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.interruptThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.turn.interrupt",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const respondToThreadApproval: (input: RespondToThreadApprovalInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadApproval")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.approval.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const respondToThreadUserInput: (input: RespondToThreadUserInputInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadUserInput")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.user-input.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const dismissThreadUserInput: (input: DismissThreadUserInputInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.dismissThreadUserInput")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.user-input.dismiss",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const revertThreadCheckpoint: (input: RevertThreadCheckpointInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.revertThreadCheckpoint")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    const { restoreFiles, ...command } = input;
    return yield* dispatch({
      ...command,
      type: restoreFiles === false ? "thread.conversation.revert" : "thread.checkpoint.revert",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const stopThreadSession: (input: StopThreadSessionInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.stopThreadSession",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.session.stop",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});
