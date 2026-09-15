/**
 * ProjectionAgentRepository - Projection repository interface for agents.
 *
 * Owns persistence operations for agent rows in the orchestration projection
 * read model.
 *
 * @module ProjectionAgentRepository
 */
import {
  AgentBlueprint,
  AgentId,
  AgentRoles,
  IsoDateTime,
  ModelSelection,
  OrchestrationAgentShell,
  ProjectId,
  DEFAULT_AGENT_ROLES,
  RunCapabilities,
  TrimmedNonEmptyString,
} from "@iskra/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionAgent = Schema.Struct({
  agentId: AgentId,
  projectId: ProjectId,
  name: Schema.String,
  avatar: Schema.NullOr(Schema.String),
  roleTags: Schema.Array(Schema.String),
  rolePrompt: Schema.String,
  modelSelection: ModelSelection,
  capabilities: RunCapabilities,
  roles: AgentRoles,
  verifyWith: Schema.NullOr(Schema.String),
  blueprint: AgentBlueprint,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionAgent = typeof ProjectionAgent.Type;

/** A `projection_agents` row as selected, with its JSON columns decoded. */
export const ProjectionAgentDbRow = ProjectionAgent.mapFields(
  Struct.assign({
    roleTags: Schema.fromJsonString(Schema.Array(Schema.String)),
    modelSelection: Schema.fromJsonString(ModelSelection),
    capabilities: Schema.fromJsonString(RunCapabilities),
    roles: Schema.fromJsonString(AgentRoles),
    blueprint: Schema.fromJsonString(AgentBlueprint),
  }),
);

/** An active agent as clients list it, with presence derived from its live run. */
export const ProjectionAgentShellDbRow = OrchestrationAgentShell.mapFields(
  Struct.assign({
    roleTags: Schema.fromJsonString(Schema.Array(TrimmedNonEmptyString)),
    modelSelection: Schema.fromJsonString(ModelSelection),
    capabilities: Schema.fromJsonString(RunCapabilities),
    roles: Schema.fromJsonString(AgentRoles),
    blueprint: Schema.fromJsonString(AgentBlueprint),
  }),
);

/** Roles and blueprint columns are null on agents from before templates; they read as the defaults. */
export const DEFAULT_AGENT_ROLES_JSON = JSON.stringify(DEFAULT_AGENT_ROLES);

export const GetProjectionAgentInput = Schema.Struct({
  agentId: AgentId,
});
export type GetProjectionAgentInput = typeof GetProjectionAgentInput.Type;

export interface ProjectionAgentRepositoryShape {
  /** Insert or replace a projected agent row by `agentId`. */
  readonly upsert: (row: ProjectionAgent) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Read a projected agent row by id. */
  readonly getById: (
    input: GetProjectionAgentInput,
  ) => Effect.Effect<Option.Option<ProjectionAgent>, ProjectionRepositoryError>;
}

export class ProjectionAgentRepository extends Context.Service<
  ProjectionAgentRepository,
  ProjectionAgentRepositoryShape
>()("@iskra/cli/persistence/Services/ProjectionAgents/ProjectionAgentRepository") {}
