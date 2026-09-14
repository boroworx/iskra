/**
 * ProjectionCardRepository - Projection repository interface for cards.
 *
 * Owns persistence operations for card rows, their activity stream, evidence
 * and the legacy decision log and messages in the orchestration projection
 * read model.
 *
 * @module ProjectionCardRepository
 */
import {
  AgentId,
  CardAcceptance,
  CardActivity,
  CardActivityAuthor,
  CardAuthor,
  CardCheckpoint,
  CardDeliveryUpdatedPayload,
  CardEstimate,
  CardEvidenceItem,
  CardEvidencePurpose,
  CardEvidenceSummary,
  CardFixRounds,
  CardId,
  CardKind,
  CardLanding,
  CardPause,
  CardPremise,
  CardRelation,
  CardSpecState,
  CardMessageAuthorKind,
  CardStatus,
  CardWaitReason,
  ChannelDeliveryStatus,
  ChannelId,
  Elicitation,
  ElicitationAnswer,
  IsoDateTime,
  MessageId,
  ProjectId,
  Reason,
  ThreadId,
  CardDiffStat,
  CardChecks,
  UsageCostSource,
  CardLinearIssue,
  CardPriority,
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
  suggestedAgentId: Schema.NullOr(AgentId),
  priority: CardPriority,
  kind: CardKind,
  acceptance: CardAcceptance,
  estimate: Schema.NullOr(CardEstimate),
  premise: Schema.NullOr(CardPremise),
  checkpoint: Schema.NullOr(CardCheckpoint),
  fixRounds: CardFixRounds,
  evidence: Schema.NullOr(CardEvidenceSummary),
  landing: Schema.NullOr(CardLanding),
  paused: Schema.NullOr(CardPause),
  waitReason: Schema.NullOr(CardWaitReason),
  queuedAt: Schema.NullOr(IsoDateTime),
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
    acceptance: Schema.fromJsonString(CardAcceptance),
    estimate: Schema.fromJsonString(Schema.NullOr(CardEstimate)),
    premise: Schema.fromJsonString(Schema.NullOr(CardPremise)),
    checkpoint: Schema.fromJsonString(Schema.NullOr(CardCheckpoint)),
    fixRounds: Schema.fromJsonString(CardFixRounds),
    evidence: Schema.fromJsonString(Schema.NullOr(CardEvidenceSummary)),
    landing: Schema.fromJsonString(Schema.NullOr(CardLanding)),
    paused: Schema.fromJsonString(Schema.NullOr(CardPause)),
    waitReason: Schema.fromJsonString(Schema.NullOr(CardWaitReason)),
  }),
);

/**
 * The `projection_cards` columns as `ProjectionCardDbRow` reads them. Contract columns are null on
 * cards from before the contract, which read as confirmed with no criteria and nothing open.
 */
export const PROJECTION_CARD_COLUMNS = `
  card_id AS "cardId",
  project_id AS "projectId",
  channel_id AS "channelId",
  parent_card_id AS "parentCardId",
  title,
  spec,
  spec_state AS "specState",
  tags_json AS "tags",
  status,
  owner_human_id AS "ownerHumanId",
  delegate_agent_id AS "delegateAgentId",
  base_branch AS "baseBranch",
  branch,
  worktree_path AS "worktreePath",
  port_base AS "portBase",
  snoozed_until AS "snoozedUntil",
  snoozed_at AS "snoozedAt",
  activity_at AS "activityAt",
  COALESCE(diff_stat_json, 'null') AS "diffStat",
  COALESCE(checks_json, 'null') AS "checks",
  spent_usd AS "spentUsd",
  budget_cap_usd AS "budgetCapUsd",
  unpriced_turns AS "unpricedTurns",
  accepts_unpriced_json AS "acceptsUnpriced",
  review_returns AS "reviewReturns",
  attempt_group_id AS "attemptGroupId",
  COALESCE(linear_issue_json, 'null') AS "linearIssue",
  source_message_id AS "sourceMessageId",
  proposal_reasoning AS "proposalReasoning",
  suggested_agent_id AS "suggestedAgentId",
  priority,
  kind,
  COALESCE(acceptance_json, '{"criteria":[],"state":"confirmed"}') AS "acceptance",
  COALESCE(estimate_json, 'null') AS "estimate",
  COALESCE(premise_json, 'null') AS "premise",
  COALESCE(checkpoint_json, 'null') AS "checkpoint",
  COALESCE(fix_rounds_json, '{"ci":0,"review":0}') AS "fixRounds",
  COALESCE(evidence_json, 'null') AS "evidence",
  COALESCE(landing_json, 'null') AS "landing",
  COALESCE(paused_json, 'null') AS "paused",
  COALESCE(wait_reason_json, 'null') AS "waitReason",
  queued_at AS "queuedAt",
  relations_json AS "relations",
  created_by_json AS "createdBy",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

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

/** One entry of a card's activity stream, with the session its delivery rides. */
export const ProjectionCardActivity = Schema.Struct({
  ...CardActivity.fields,
  author: Schema.fromJsonString(CardActivityAuthor),
  elicitation: Schema.NullOr(Schema.fromJsonString(Elicitation)),
  answers: Schema.NullOr(Schema.fromJsonString(ElicitationAnswer)),
  status: Schema.NullOr(
    Schema.fromJsonString(Schema.Struct({ from: CardStatus, to: CardStatus })),
  ),
  reason: Schema.NullOr(Schema.fromJsonString(Reason)),
  deliveryThreadId: Schema.NullOr(ThreadId),
});
export type ProjectionCardActivity = typeof ProjectionCardActivity.Type;

/** One captured evidence item, with the recording it belongs to. */
export const ProjectionCardEvidenceItem = Schema.Struct({
  ...CardEvidenceItem.fields,
  evidenceId: Schema.String,
  cardId: CardId,
  headSha: Schema.String,
  purpose: CardEvidencePurpose,
  unavailable: Schema.NullOr(Schema.fromJsonString(Reason)),
  createdAt: IsoDateTime,
});
export type ProjectionCardEvidenceItem = typeof ProjectionCardEvidenceItem.Type;

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

export const ListProjectionCardActivitiesInput = Schema.Struct({
  cardId: CardId,
  limit: Schema.Number,
});
export type ListProjectionCardActivitiesInput = typeof ListProjectionCardActivitiesInput.Type;

export const ListProjectionCardEvidenceInput = Schema.Struct({
  cardId: CardId,
  evidenceId: Schema.String,
});
export type ListProjectionCardEvidenceInput = typeof ListProjectionCardEvidenceInput.Type;

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
    input: typeof CardDeliveryUpdatedPayload.Type,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** A card's owner messages still pending or sent, oldest first. */
  readonly listOpenOwnerMessages: (
    input: GetProjectionCardInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCardMessage>, ProjectionRepositoryError>;

  /** Append one activity; replaying the same activity is a no-op. */
  readonly appendActivity: (
    row: ProjectionCardActivity,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** A card's newest `limit` activities, oldest first. */
  readonly listActivities: (
    input: ListProjectionCardActivitiesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCardActivity>, ProjectionRepositoryError>;

  /** A card's activities for its builder still pending or sent, oldest first. */
  readonly listOpenBuilderActivities: (
    input: GetProjectionCardInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCardActivity>, ProjectionRepositoryError>;

  /** Record captured evidence items; replaying the same items is a no-op. */
  readonly appendEvidenceItems: (
    rows: ReadonlyArray<ProjectionCardEvidenceItem>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** The items of one recording of a card's evidence, in the order they were captured. */
  readonly listEvidenceItems: (
    input: ListProjectionCardEvidenceInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCardEvidenceItem>, ProjectionRepositoryError>;
}

export class ProjectionCardRepository extends Context.Service<
  ProjectionCardRepository,
  ProjectionCardRepositoryShape
>()("@iskra/cli/persistence/Services/ProjectionCards/ProjectionCardRepository") {}
