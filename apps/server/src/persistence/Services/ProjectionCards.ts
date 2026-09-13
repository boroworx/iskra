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
  CardStatus,
  ChannelId,
  IsoDateTime,
  ProjectId,
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
}

export class ProjectionCardRepository extends Context.Service<
  ProjectionCardRepository,
  ProjectionCardRepositoryShape
>()("@iskra/cli/persistence/Services/ProjectionCards/ProjectionCardRepository") {}
