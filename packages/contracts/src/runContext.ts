import * as Schema from "effect/Schema";

import {
  AgentId,
  ChannelId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { AgentName, ChannelKind, ChannelMessageAuthorKind } from "./orchestration.ts";

/** One channel message as an agent sees it, with its author resolved to a display name. */
export const RunContextMessage = Schema.Struct({
  messageId: MessageId,
  authorKind: ChannelMessageAuthorKind,
  authorName: TrimmedNonEmptyString,
  body: Schema.String,
  createdAt: IsoDateTime,
});
export type RunContextMessage = typeof RunContextMessage.Type;

/**
 * Everything an agent is handed when it wakes, before rendering to prompt text.
 * Stored with the run so the context inspector shows exactly what the run saw.
 */
export const RunContextPayload = Schema.Struct({
  agent: Schema.Struct({
    id: AgentId,
    name: AgentName,
    rolePrompt: Schema.String,
  }),
  channel: Schema.Struct({
    id: ChannelId,
    kind: ChannelKind,
    name: TrimmedNonEmptyString,
    topic: Schema.String,
  }),
  pinnedSpec: Schema.String,
  wakeDepth: NonNegativeInt,
  // The newest `wakeDepth` messages before the trigger, oldest first.
  history: Schema.Array(RunContextMessage),
  trigger: RunContextMessage,
});
export type RunContextPayload = typeof RunContextPayload.Type;

/** The exact text a run sends its provider, rendered from a `RunContextPayload`. */
export const RenderedRunContext = Schema.Struct({
  systemPrompt: Schema.String,
  firstMessage: Schema.String,
});
export type RenderedRunContext = typeof RenderedRunContext.Type;
