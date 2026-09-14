/**
 * ProjectionRunLivenessRepository - narrow reads of how a card's sessions ran and ended, for the
 * scheduler's restarts and the watchdog.
 *
 * @module ProjectionRunLivenessRepository
 */
import { CardId, IsoDateTime, NonNegativeInt, ThreadId } from "@iskra/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

/** One owner session of a card, with the status its provider session ended or stands in. */
export const ProjectionOwnerRun = Schema.Struct({
  threadId: ThreadId,
  restarts: NonNegativeInt,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  sessionStatus: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});
export type ProjectionOwnerRun = typeof ProjectionOwnerRun.Type;

export const ListCardOwnerRunsInput = Schema.Struct({
  cardId: CardId,
  // Only runs started at or after this instant.
  since: IsoDateTime,
});
export type ListCardOwnerRunsInput = typeof ListCardOwnerRunsInput.Type;

export interface ProjectionRunLivenessRepositoryShape {
  /** A card's owner runs started since `since`, newest first. */
  readonly listCardOwnerRuns: (
    input: ListCardOwnerRunsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionOwnerRun>, ProjectionRepositoryError>;
}

export class ProjectionRunLivenessRepository extends Context.Service<
  ProjectionRunLivenessRepository,
  ProjectionRunLivenessRepositoryShape
>()("@iskra/cli/persistence/Services/ProjectionRunLiveness/ProjectionRunLivenessRepository") {}
