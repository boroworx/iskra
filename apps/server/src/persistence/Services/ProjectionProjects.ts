/**
 * ProjectionProjectRepository - Projection repository interface for projects.
 *
 * Owns persistence operations for project rows in the orchestration projection
 * read model.
 *
 * @module ProjectionProjectRepository
 */
import {
  type AgentId,
  type ProjectWikiPage,
  type ProjectTriggerFire,
  type RunRole,
  IsoDateTime,
  ModelSelection,
  ProjectIconOverride,
  ProjectId,
  ProjectOrchestration,
  ProjectScript,
  ThreadEnvMode,
} from "@iskra/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionProject = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.NullOr(ThreadEnvMode),
  autoPull: Schema.Boolean,
  faviconPath: Schema.optional(Schema.NullOr(Schema.String)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.Array(ProjectScript),
  // Null until a person sets the project's orchestration policy.
  orchestration: Schema.NullOr(ProjectOrchestration),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionProject = typeof ProjectionProject.Type;

export const GetProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type GetProjectionProjectInput = typeof GetProjectionProjectInput.Type;

export const DeleteProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type DeleteProjectionProjectInput = typeof DeleteProjectionProjectInput.Type;

/**
 * ProjectionProjectRepositoryShape - Service API for projected project records.
 */
export interface ProjectionProjectRepositoryShape {
  /**
   * Insert or replace a projected project row.
   *
   * Upserts by `projectId` and persists scripts through JSON encoding.
   */
  readonly upsert: (row: ProjectionProject) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected project row by id.
   */
  readonly getById: (
    input: GetProjectionProjectInput,
  ) => Effect.Effect<Option.Option<ProjectionProject>, ProjectionRepositoryError>;

  /**
   * List all projected project rows.
   *
   * Returned in deterministic creation order.
   */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionProject>,
    ProjectionRepositoryError
  >;

  /**
   * Soft-delete a projected project row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionProjectInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Add one priced turn to its project's month, by agent and run role. */
  readonly addMonthlySpend: (input: {
    readonly projectId: ProjectId;
    readonly month: string;
    readonly agentId: AgentId;
    readonly role: RunRole;
    readonly costUsd: number;
  }) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Write a wiki page's new revision: the page as it now is, and the revision in its history. */
  readonly writeWikiPage: (input: {
    readonly projectId: ProjectId;
    readonly page: ProjectWikiPage;
    readonly summary: string;
    readonly restoredFrom: number | null;
  }) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Lock a wiki page against agents' writes, or unlock it. */
  readonly setWikiPageLocked: (input: {
    readonly projectId: ProjectId;
    readonly slug: string;
    readonly locked: boolean;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Delete a wiki page: its text goes, its revisions stay, so a person can bring it back. */
  readonly deleteWikiPage: (input: {
    readonly projectId: ProjectId;
    readonly slug: string;
    readonly deletedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Record a trigger's fire; the same trigger and source again is a no-op. */
  readonly recordTriggerFire: (input: {
    readonly projectId: ProjectId;
    readonly fire: ProjectTriggerFire;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionProjectRepository - Service tag for project projection persistence.
 */
export class ProjectionProjectRepository extends Context.Service<
  ProjectionProjectRepository,
  ProjectionProjectRepositoryShape
>()("@iskra/cli/persistence/Services/ProjectionProjects/ProjectionProjectRepository") {}
