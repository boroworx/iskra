/**
 * ProjectionCardRepository - Projection repository interface for cards.
 *
 * Owns persistence operations for card rows and their decision log in the
 * orchestration projection read model.
 *
 * @module ProjectionCardRepository
 */
import {
  AgentId,
  CardAuthor,
  CardId,
  CardRelation,
  CardSpecState,
  CardMessageAuthorKind,
  CardStatus,
  ChannelDeliveryStatus,
  ChannelId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  CardDiffStat,
  CardChecks,
  UsageCostSource,
  CardLinearIssue,
} from "@iskra/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionCard = Schema.Struct({
  cardId: CardId,
  projectId: ProjectId,
  channelId: Schema.NullOr(ChannelId),
  parentCardId: Schema.NullOr(CardId),
  title: Schema.String,
  spec: Schema.String,
  specState: CardSpecState,
  tags: Schema.Array(Schema.String),
  status: CardStatus,
  ownerHumanId: Schema.String,
  delegateAgentId: Schema.NullOr(AgentId),
  baseBranch: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  portBase: Schema.NullOr(Schema.Number),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozedAt: Schema.NullOr(IsoDateTime),
  activityAt: IsoDateTime,
  diffStat: Schema.NullOr(CardDiffStat),
  checks: Schema.NullOr(CardChecks),
  spentUsd: Schema.Number,
  budgetCapUsd: Schema.Number,
  unpricedTurns: Schema.Number,
  acceptsUnpriced: Schema.Boolean,
  reviewReturns: Schema.Number,
  attemptGroupId: Schema.NullOr(Schema.String),
  linearIssue: Schema.NullOr(CardLinearIssue),
  sourceMessageId: Schema.NullOr(MessageId),
  proposalReasoning: Schema.NullOr(Schema.String),
  relations: Schema.Array(CardRelation),
  createdBy: CardAuthor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionCard = typeof ProjectionCard.Type;

/** A `projection_cards` row as selected, with its JSON columns decoded. */
export const ProjectionCardDbRow = ProjectionCard.mapFields(
  Struct.assign({
    tags: Schema.fromJsonString(Schema.Array(Schema.String)),
    relations: Schema.fromJsonString(Schema.Array(CardRelation)),
    createdBy: Schema.fromJsonString(CardAuthor),
    diffStat: Schema.fromJsonString(Schema.NullOr(CardDiffStat)),
    checks: Schema.fromJsonString(Schema.NullOr(CardChecks)),
    acceptsUnpriced: Schema.fromJsonString(Schema.Boolean),
    linearIssue: Schema.fromJsonString(Schema.NullOr(CardLinearIssue)),
  }),
);

export const ProjectionCardDecision = Schema.Struct({
  decisionId: Schema.String,
  cardId: CardId,
  author: CardAuthor,
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type ProjectionCardDecision = typeof ProjectionCardDecision.Type;

/** A decision row as selected, with its author decoded. */
export const ProjectionCardDecisionDbRow = ProjectionCardDecision.mapFields(
  Struct.assign({
    author: Schema.fromJsonString(CardAuthor),
  }),
);

/**
 * A message in a card's activity. `deliveryStatus` is null for a message not
 * meant for the owner; otherwise it tracks delivery into the owner's sessions.
 */
export const ProjectionCardMessage = Schema.Struct({
  messageId: MessageId,
  cardId: CardId,
  authorKind: CardMessageAuthorKind,
  authorId: Schema.String,
  body: Schema.String,
  runThreadId: Schema.NullOr(ThreadId),
  deliveryStatus: Schema.NullOr(ChannelDeliveryStatus),
  deliveryThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type ProjectionCardMessage = typeof ProjectionCardMessage.Type;

export const UpdateProjectionCardDeliveriesInput = Schema.Struct({
  messageIds: Schema.Array(MessageId),
  status: ChannelDeliveryStatus,
  threadId: Schema.NullOr(ThreadId),
});
export type UpdateProjectionCardDeliveriesInput = typeof UpdateProjectionCardDeliveriesInput.Type;

/** One priced turn of a card session, so spend sums by card and by agent. */
export const ProjectionCardSpend = Schema.Struct({
  spendId: Schema.String,
  cardId: CardId,
  agentId: AgentId,
  threadId: ThreadId,
  costUsd: Schema.Number,
  costSource: UsageCostSource,
  recordedAt: IsoDateTime,
});
export type ProjectionCardSpend = typeof ProjectionCardSpend.Type;

export const GetProjectionCardInput = Schema.Struct({
  cardId: CardId,
});
export type GetProjectionCardInput = typeof GetProjectionCardInput.Type;

export interface ProjectionCardRepositoryShape {
  /** Insert or replace a projected card row by `cardId`. */
  readonly upsert: (row: ProjectionCard) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Read a projected card row by id. */
  readonly getById: (
    input: GetProjectionCardInput,
  ) => Effect.Effect<Option.Option<ProjectionCard>, ProjectionRepositoryError>;

  /** Append one decision to a card's log; replaying the same decision is a no-op. */
  readonly appendDecision: (
    row: ProjectionCardDecision,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Record a priced turn; recording the same turn again is a no-op. */
  readonly recordSpend: (
    row: ProjectionCardSpend,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** A card's decision log, oldest first. */
  readonly listDecisions: (
    input: GetProjectionCardInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCardDecision>, ProjectionRepositoryError>;

  /** Append a message to a card's activity; replaying the same message is a no-op. */
  readonly appendMessage: (
    row: ProjectionCardMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Give these owner messages a new delivery status and session. */
  readonly updateDeliveries: (
    input: UpdateProjectionCardDeliveriesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** A card's owner messages still pending or sent, oldest first. */
  readonly listOpenOwnerMessages: (
    input: GetProjectionCardInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCardMessage>, ProjectionRepositoryError>;
}

export class ProjectionCardRepository extends Context.Service<
  ProjectionCardRepository,
  ProjectionCardRepositoryShape
>()("@iskra/cli/persistence/Services/ProjectionCards/ProjectionCardRepository") {}
