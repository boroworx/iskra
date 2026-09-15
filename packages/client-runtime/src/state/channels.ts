import {
  ORCHESTRATION_WS_METHODS,
  type OrchestrationChannelMessage,
  type OrchestrationChannelRun,
  type OrchestrationChannelStreamItem,
  type OrchestrationMessage,
  type OrchestrationThread,
  type TurnId,
} from "@iskra/contracts";
import type * as Crypto from "effect/Crypto";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  answerChannelElicitation,
  approveProjectLesson,
  archiveChannel,
  createAgent,
  createChannel,
  dismissProjectLesson,
  postAgentDm,
  postChannelMessage,
  removeProjectLesson,
  sendAgentSessionMessage,
  unarchiveChannel,
  updateChannel,
} from "../operations/commands.ts";
import { request, subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

/** What a channel subscription holds: its messages, and the runs seen live in it. */
export interface ChannelState {
  readonly messages: ReadonlyArray<OrchestrationChannelMessage>;
  /** Runs live when the subscription saw them; each run's session says whether it still is. */
  readonly runs: ReadonlyArray<OrchestrationChannelRun>;
}

export const EMPTY_CHANNEL_STATE: ChannelState = { messages: [], runs: [] };

/**
 * A channel's state after one stream item. A snapshot replaces it, so a
 * resubscription starts clean; a message or run already held is not added
 * twice; a delivery replaces that agent's earlier standing on its message.
 */
export function applyChannelStreamItem(
  state: ChannelState,
  item: OrchestrationChannelStreamItem,
): ChannelState {
  switch (item.kind) {
    case "snapshot":
      return { messages: item.messages, runs: item.runs };
    case "message":
      return state.messages.some((message) => message.id === item.message.id)
        ? state
        : { ...state, messages: [...state.messages, item.message] };
    case "run":
      // ponytail: ended runs stay until the next snapshot; prune them if long-open channels collect many.
      return state.runs.some((run) => run.threadId === item.run.threadId)
        ? state
        : { ...state, runs: [...state.runs, item.run] };
    case "delivery":
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === item.messageId
            ? {
                ...message,
                deliveries: [
                  ...(message.deliveries ?? []).filter(
                    (delivery) => delivery.agentId !== item.delivery.agentId,
                  ),
                  item.delivery,
                ],
              }
            : message,
        ),
      };
  }
}

/** How long a run with no session yet reads as starting, and a finished turn as settling. */
export const RUN_SETTLE_GRACE_MS = 60_000;

export interface LiveRunPreview {
  readonly turnId: TurnId | null;
  /** The newest non-empty thing the run said this turn: the reply the server will post. */
  readonly message: OrchestrationMessage | null;
  /** True while it waits on an approval or a person's answer. */
  readonly waiting: boolean;
}

/**
 * What a channel shows for a run until its reply lands, or null. A run shows while its session
 * starts or runs a turn (or has no session yet, briefly), and while a finished turn's text waits
 * to be posted. It hides once the channel holds this turn's reply, which then shows instead.
 */
export function liveRunPreview(input: {
  readonly run: OrchestrationChannelRun;
  readonly thread: Pick<OrchestrationThread, "session" | "latestTurn" | "messages"> | null;
  readonly awaitingInput: boolean;
  readonly channelMessages: ReadonlyArray<Pick<OrchestrationChannelMessage, "id">>;
  readonly now: number;
}): LiveRunPreview | null {
  const { run, thread, now } = input;
  const session = thread?.session ?? null;
  const turnId = session?.activeTurnId ?? thread?.latestTurn?.turnId ?? null;
  const replyId = `run-reply:${run.threadId}:${turnId}`;
  if (turnId !== null && input.channelMessages.some((message) => message.id === replyId)) {
    return null;
  }
  const message =
    turnId === null
      ? null
      : (thread?.messages.findLast(
          (candidate) =>
            candidate.role === "assistant" &&
            candidate.turnId === turnId &&
            candidate.text.trim().length > 0,
        ) ?? null);
  const completedAt = thread?.latestTurn?.completedAt ?? null;
  const live =
    session === null
      ? now - Date.parse(run.startedAt) < RUN_SETTLE_GRACE_MS
      : session.status === "starting" ||
        session.status === "running" ||
        session.activeTurnId !== null ||
        // Between a turn ending and its reply posting, keep the text in place so it doesn't blink.
        (session.status !== "stopped" &&
          session.status !== "error" &&
          message !== null &&
          completedAt !== null &&
          now - Date.parse(completedAt) < RUN_SETTLE_GRACE_MS);
  return live ? { turnId, message, waiting: input.awaitingInput } : null;
}

export function createChannelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  return {
    messages: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:channels:messages",
      subscribe: (input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.subscribeChannel>) =>
        subscribe(ORCHESTRATION_WS_METHODS.subscribeChannel, input).pipe(
          Stream.mapAccum(
            (): ChannelState => EMPTY_CHANNEL_STATE,
            (current, item) => {
              const next = applyChannelStreamItem(current, item);
              return [next, [next]] as const;
            },
          ),
        ),
    }),
    agentRuns: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:channels:agent-runs",
      tag: ORCHESTRATION_WS_METHODS.listAgentRuns,
    }),
    postMessage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:channel:post-message",
      execute: postChannelMessage,
    }),
    answerElicitation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:channel:answer-elicitation",
      execute: answerChannelElicitation,
    }),
    sessionMessage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:agent:session-message",
      execute: sendAgentSessionMessage,
    }),
    dmPost: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:agent:dm-post",
      execute: postAgentDm,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:channel:archive",
      execute: archiveChannel,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:channel:unarchive",
      execute: unarchiveChannel,
    }),
    archivedChannels: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:channels:archived",
      tag: ORCHESTRATION_WS_METHODS.listArchivedChannels,
    }),
    agentDefinitions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agents:definitions",
      tag: ORCHESTRATION_WS_METHODS.listAgentDefinitions,
    }),
    archiveAgentDefinition: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:agent:archive-definition",
      execute: (
        input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.archiveAgentDefinition>,
      ) => request(ORCHESTRATION_WS_METHODS.archiveAgentDefinition, input),
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:channel:create",
      execute: createChannel,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:channel:update",
      execute: updateChannel,
    }),
    createAgent: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:agent:create",
      execute: createAgent,
    }),
    saveAgentDefinition: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:agent:save-definition",
      execute: (input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.saveAgentDefinition>) =>
        request(ORCHESTRATION_WS_METHODS.saveAgentDefinition, input),
    }),
    /** Stores a project secret's value on the environment; nothing ever reads it back. */
    setProjectSecret: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:set-secret",
      execute: (input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.setProjectSecret>) =>
        request(ORCHESTRATION_WS_METHODS.setProjectSecret, input),
    }),
    removeProjectSecret: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:remove-secret",
      execute: (input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.removeProjectSecret>) =>
        request(ORCHESTRATION_WS_METHODS.removeProjectSecret, input),
    }),
    /** A project's hidden scenarios by title and kind; bodies load one at a time. */
    projectHoldouts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:holdouts",
      tag: ORCHESTRATION_WS_METHODS.listProjectHoldouts,
    }),
    getProjectHoldout: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:get-holdout",
      execute: (input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.getProjectHoldout>) =>
        request(ORCHESTRATION_WS_METHODS.getProjectHoldout, input),
    }),
    setProjectHoldout: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:set-holdout",
      execute: (input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.setProjectHoldout>) =>
        request(ORCHESTRATION_WS_METHODS.setProjectHoldout, input),
    }),
    removeProjectHoldout: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:remove-holdout",
      execute: (input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.removeProjectHoldout>) =>
        request(ORCHESTRATION_WS_METHODS.removeProjectHoldout, input),
    }),
    /** A person deciding a lesson an agent proposed: only approved lessons reach briefs. */
    approveLesson: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:approve-lesson",
      execute: approveProjectLesson,
    }),
    dismissLesson: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:dismiss-lesson",
      execute: dismissProjectLesson,
    }),
    removeLesson: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:remove-lesson",
      execute: removeProjectLesson,
    }),
    importAgentDefinitions: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:agent:import-definitions",
      execute: (
        input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.importAgentDefinitions>,
      ) => request(ORCHESTRATION_WS_METHODS.importAgentDefinitions, input),
    }),
  };
}
