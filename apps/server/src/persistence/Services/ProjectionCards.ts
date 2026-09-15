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
  CardAttention,
  CardLanding,
  CardVerdict,
  CardVerdictCriterion,
  CardVerdictDiffJudge,
  CardVerdictScenario,
  CardVerification,
  CardVerifierSelection,
  CardPause,
  CardPremise,
  CardRefChange,
  CardRelation,
  CardSpecState,
  CardStatus,
  CardWaitReason,
  CardOpenElicitation,
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
  openElicitations: Schema.Array(CardOpenElicitation),
  attention: Schema.Array(CardAttention),
  verification: CardVerification,
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
    openElicitations: Schema.fromJsonString(Schema.Array(CardOpenElicitation)),
    attention: Schema.fromJsonString(Schema.Array(CardAttention)),
    verification: Schema.fromJsonString(CardVerification),
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
  COALESCE(open_elicitations_json, '[]') AS "openElicitations",
  COALESCE(attention_json, '[]') AS "attention",
  COALESCE(verification_json, '{"state":"off","headSha":null,"verdictId":null,"verifier":null,"satisfaction":null,"override":null}') AS "verification",
  relations_json AS "relations",
  created_by_json AS "createdBy",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

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
  refChanges: Schema.NullOr(Schema.fromJsonString(Schema.Array(CardRefChange))),
  deliveryThreadId: Schema.NullOr(ThreadId),
});
export type ProjectionCardActivity = typeof ProjectionCardActivity.Type;

/** The `projection_card_activities` columns as `ProjectionCardActivity` reads them. */
export const PROJECTION_CARD_ACTIVITY_COLUMNS = `
  activity_id AS "activityId",
  card_id AS "cardId",
  kind,
  author_json AS "author",
  body,
  run_thread_id AS "runThreadId",
  deliver_to AS "deliverTo",
  delivery_status AS "delivery",
  elicitation_json AS "elicitation",
  answers_json AS "answers",
  status_json AS "status",
  evidence_id AS "evidenceId",
  reason_json AS "reason",
  ref_changes_json AS "refChanges",
  created_at AS "createdAt",
  delivery_thread_id AS "deliveryThreadId"
`;

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

/** An evidence row as selected: SQLite stores `timedOut` as 0 or 1. */
export const ProjectionCardEvidenceDbRow = ProjectionCardEvidenceItem.mapFields(
  Struct.assign({ timedOut: Schema.Number }),
);

/** The `projection_card_evidence` columns as `ProjectionCardEvidenceDbRow` reads them. */
export const PROJECTION_CARD_EVIDENCE_COLUMNS = `
  item_id AS "itemId",
  kind,
  source,
  name,
  criterion_id AS "criterionId",
  exit_code AS "exitCode",
  timed_out AS "timedOut",
  duration_ms AS "durationMs",
  log_tail AS "logTail",
  artifact_path AS "artifactPath",
  unavailable_json AS "unavailable",
  evidence_id AS "evidenceId",
  card_id AS "cardId",
  head_sha AS "headSha",
  purpose,
  created_at AS "createdAt"
`;

/** A verdict as `projection_card_verdicts` stores it, with its JSON columns encoded. */
export const ProjectionCardVerdict = CardVerdict.mapFields(
  Struct.assign({
    verifier: Schema.fromJsonString(CardVerifierSelection),
    criteria: Schema.fromJsonString(Schema.Array(CardVerdictCriterion)),
    diffJudge: Schema.fromJsonString(CardVerdictDiffJudge),
    scenarios: Schema.fromJsonString(Schema.Array(CardVerdictScenario)),
  }),
);

/** A verdict row as selected: SQLite stores `passed` as 0 or 1. */
export const ProjectionCardVerdictDbRow = ProjectionCardVerdict.mapFields(
  Struct.assign({ passed: Schema.Number }),
);

/** The `projection_card_verdicts` columns as `ProjectionCardVerdictDbRow` reads them. */
export const PROJECTION_CARD_VERDICT_COLUMNS = `
  verdict_id AS "verdictId",
  card_id AS "cardId",
  head_sha AS "headSha",
  verifier_json AS "verifier",
  criteria_json AS "criteria",
  diff_judge_json AS "diffJudge",
  scenarios_json AS "scenarios",
  passed,
  recorded_at AS "recordedAt"
`;

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

  /** Record a priced turn; recording the same turn again is a no-op. */
  readonly recordSpend: (
    row: ProjectionCardSpend,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Give these builder activities a new delivery status and session. */
  readonly updateDeliveries: (
    input: typeof CardDeliveryUpdatedPayload.Type,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

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

  /** Remove the items of one recording, so recording it again replaces them. */
  readonly deleteEvidenceItems: (
    input: ListProjectionCardEvidenceInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Record a verdict; recording the same verdict again is a no-op. */
  readonly appendVerdict: (verdict: CardVerdict) => Effect.Effect<void, ProjectionRepositoryError>;

  /** A card's newest verdict, if it has one. */
  readonly latestVerdict: (
    input: GetProjectionCardInput,
  ) => Effect.Effect<Option.Option<CardVerdict>, ProjectionRepositoryError>;

  /** The items of one recording of a card's evidence, in the order they were captured. */
  readonly listEvidenceItems: (
    input: ListProjectionCardEvidenceInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCardEvidenceItem>, ProjectionRepositoryError>;
}

export class ProjectionCardRepository extends Context.Service<
  ProjectionCardRepository,
  ProjectionCardRepositoryShape
>()("@iskra/cli/persistence/Services/ProjectionCards/ProjectionCardRepository") {}
