import {
  ORCHESTRATION_WS_METHODS,
  type OrchestrationChannelMessage,
  type OrchestrationChannelStreamItem,
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

/**
 * A channel's messages after one stream item. A snapshot replaces them, so a
 * resubscription starts clean; a message already held is not added twice; a
 * delivery replaces that agent's earlier standing on its message.
 */
export function applyChannelStreamItem(
  messages: ReadonlyArray<OrchestrationChannelMessage>,
  item: OrchestrationChannelStreamItem,
): ReadonlyArray<OrchestrationChannelMessage> {
  switch (item.kind) {
    case "snapshot":
      return item.messages;
    case "message":
      return messages.some((message) => message.id === item.message.id)
        ? messages
        : [...messages, item.message];
    case "delivery":
      return messages.map((message) =>
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
      );
  }
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
            () => [] as ReadonlyArray<OrchestrationChannelMessage>,
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
