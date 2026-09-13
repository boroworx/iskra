import {
  ORCHESTRATION_WS_METHODS,
  type OrchestrationChannelMessage,
  type OrchestrationChannelStreamItem,
} from "@t3tools/contracts";
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
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import { createEnvironmentCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export type {
  CreateAgentInput,
  CreateChannelInput,
  PostChannelMessageInput,
  UpdateChannelInput,
} from "../operations/commands.ts";

/**
 * A channel's messages after one stream item. A snapshot replaces them, so a
 * resubscription starts clean; a message already held is not added twice.
 */
export function applyChannelStreamItem(
  messages: ReadonlyArray<OrchestrationChannelMessage>,
  item: OrchestrationChannelStreamItem,
): ReadonlyArray<OrchestrationChannelMessage> {
  if (item.kind === "snapshot") {
    return item.messages;
  }
  return messages.some((message) => message.id === item.message.id)
    ? messages
    : [...messages, item.message];
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
  };
}
