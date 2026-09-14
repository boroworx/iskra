import type { ChannelId, EnvironmentId, ProjectId } from "@iskra/contracts";
import * as Schema from "effect/Schema";

interface ProjectRef {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

export function projectKey(project: ProjectRef): string {
  return `${project.environmentId}:${project.id}`;
}

/** What the project rail remembers across reloads: the last project a route named, and each project's last channel. */
export const ProjectRailMemory = Schema.Struct({
  lastProjectKey: Schema.NullOr(Schema.String),
  lastChannelByProject: Schema.Record(Schema.String, Schema.String),
});
export type ProjectRailMemory = typeof ProjectRailMemory.Type;

export const PROJECT_RAIL_STORAGE_KEY = "iskra:project-rail:v1";
export const EMPTY_PROJECT_RAIL_MEMORY: ProjectRailMemory = {
  lastProjectKey: null,
  lastChannelByProject: {},
};

/** The project id a route names directly or through its channel, agent, card or thread. */
export function routeProjectId(input: {
  readonly params: {
    readonly projectId?: string | undefined;
    readonly channelId?: string | undefined;
    readonly agentId?: string | undefined;
    readonly cardId?: string | undefined;
  };
  readonly channels: ReadonlyArray<{ readonly id: string; readonly projectId: ProjectId }>;
  readonly agents: ReadonlyArray<{ readonly id: string; readonly projectId: ProjectId }>;
  readonly cards: ReadonlyArray<{ readonly id: string; readonly projectId: ProjectId }>;
  readonly threadProjectId: ProjectId | null;
}): ProjectId | null {
  const { params } = input;
  if (params.projectId !== undefined) return params.projectId as ProjectId;
  if (params.channelId !== undefined) {
    return input.channels.find((channel) => channel.id === params.channelId)?.projectId ?? null;
  }
  if (params.agentId !== undefined) {
    return input.agents.find((agent) => agent.id === params.agentId)?.projectId ?? null;
  }
  if (params.cardId !== undefined) {
    return input.cards.find((card) => card.id === params.cardId)?.projectId ?? null;
  }
  return input.threadProjectId;
}

/**
 * The rail's project: the route's when it names a known one, else the remembered
 * one (routes naming no project, or data still loading), else the first.
 */
export function resolveRailProject<P extends ProjectRef>(input: {
  readonly projects: ReadonlyArray<P>;
  readonly routeEnvironmentId: EnvironmentId | null;
  readonly routeProjectId: ProjectId | null;
  readonly storedProjectKey: string | null;
}): { readonly project: P | null; readonly fromRoute: boolean } {
  const fromRoute = input.projects.find(
    (project) =>
      project.environmentId === input.routeEnvironmentId && project.id === input.routeProjectId,
  );
  if (fromRoute !== undefined) return { project: fromRoute, fromRoute: true };
  const stored = input.projects.find((project) => projectKey(project) === input.storedProjectKey);
  return { project: stored ?? input.projects[0] ?? null, fromRoute: false };
}

/** Records the route's project and open channel; returns `memory` itself when nothing changed. */
export function rememberRailRoute(
  memory: ProjectRailMemory,
  key: string,
  channelId: ChannelId | null,
): ProjectRailMemory {
  const sameChannel = channelId === null || memory.lastChannelByProject[key] === channelId;
  if (memory.lastProjectKey === key && sameChannel) return memory;
  return {
    lastProjectKey: key,
    lastChannelByProject: sameChannel
      ? memory.lastChannelByProject
      : { ...memory.lastChannelByProject, [key]: channelId },
  };
}

/** Where a rail click goes: the project's last channel if it still exists, else its first, else its board. */
export function railClickTarget(
  channelIds: ReadonlyArray<ChannelId>,
  lastChannelId: string | undefined,
): { readonly kind: "channel"; readonly channelId: ChannelId } | { readonly kind: "board" } {
  const channelId = channelIds.find((id) => id === lastChannelId) ?? channelIds[0];
  return channelId === undefined ? { kind: "board" } : { kind: "channel", channelId };
}

/** Projects with the remembered one moved first, so landing reopens it before the most recently active. */
export function withStoredProjectFirst<P extends ProjectRef>(
  projects: ReadonlyArray<P>,
  storedProjectKey: string | null,
): ReadonlyArray<P> {
  const stored = projects.find((project) => projectKey(project) === storedProjectKey);
  return stored === undefined ? projects : [stored, ...projects.filter((p) => p !== stored)];
}
