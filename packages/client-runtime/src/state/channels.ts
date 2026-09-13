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
  type CreateAgentInput,
  type CreateChannelInput,
  type PostChannelMessageInput,
  type UpdateChannelInput,
  createAgent,
  createChannel,
  postChannelMessage,
  updateChannel,
} from "../operations/commands.ts";
import { request, subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

export type {
  CreateAgentInput,
  CreateChannelInput,
  PostChannelMessageInput,
  UpdateChannelInput,
} from "../operations/commands.ts";

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
      execute: (input: PostChannelMessageInput) => postChannelMessage(input),
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:channel:create",
      execute: (input: CreateChannelInput) => createChannel(input),
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:channel:update",
      execute: (input: UpdateChannelInput) => updateChannel(input),
    }),
    createAgent: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:agent:create",
      execute: (input: CreateAgentInput) => createAgent(input),
    }),
    saveAgentDefinition: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:agent:save-definition",
      execute: (input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.saveAgentDefinition>) =>
        request(ORCHESTRATION_WS_METHODS.saveAgentDefinition, input),
    }),
    importAgentDefinitions: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:agent:import-definitions",
      execute: (
        input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.importAgentDefinitions>,
      ) => request(ORCHESTRATION_WS_METHODS.importAgentDefinitions, input),
    }),
  };
}
