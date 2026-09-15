import type { ChannelId, EnvironmentId, ProjectId } from "@iskra/contracts";
import * as Schema from "effect/Schema";

import { requestsProjectId } from "./channels/channels.logic";

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
    // Requests names its project in its id, so it resolves before it exists.
    return (
      input.channels.find((channel) => channel.id === params.channelId)?.projectId ??
      requestsProjectId(params.channelId)
    );
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

/** A rail tile's letters: the first letters of the title's first two words, or its first two letters. */
export function projectInitials(title: string): string {
  const words = title.split(/[\s/_.-]+/).filter((word) => word.length > 0);
  const initials =
    words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : title.slice(0, 2);
  return initials.toUpperCase();
}

const commonPrefixLength = (left: string, right: string) => {
  let length = 0;
  while (length < left.length && left[length] === right[length]) length++;
  return length;
};

/**
 * Each rail tile's letters, in rail order. Titles that would share initials keep the first letter
 * and take the first character where they part from their look-alikes (`iskra-m1-demo2` → `I2`),
 * then that character's successors, then a number, so no two tiles read the same.
 */
export function projectRailInitials(titles: ReadonlyArray<string>): ReadonlyArray<string> {
  const bases = titles.map(projectInitials);
  const shared = (base: string) => bases.indexOf(base) !== bases.lastIndexOf(base);
  const used = new Set(bases.filter((base) => !shared(base)));
  const keys = titles.map((title) => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
  return bases.map((base, index) => {
    if (!shared(base)) return base;
    const key = keys[index] ?? "";
    const common = Math.max(
      ...keys.map((other, otherIndex) =>
        otherIndex === index || bases[otherIndex] !== base ? 0 : commonPrefixLength(key, other),
      ),
    );
    const first = base.slice(0, 1);
    // A title that is a prefix of a look-alike has no character of its own, so it keeps its initials.
    const candidates =
      common >= key.length
        ? [base]
        : Array.from(key.slice(common), (char) => `${first}${char.toUpperCase()}`);
    let pick = candidates.find((candidate) => !used.has(candidate));
    for (let number = 2; pick === undefined; number++) {
      if (!used.has(`${first}${number}`)) pick = `${first}${number}`;
    }
    used.add(pick);
    return pick;
  });
}

/** Where opening a project goes: its last channel if that is still active, else its Requests. */
export function railClickTarget(
  channelIds: ReadonlyArray<ChannelId>,
  lastChannelId: string | undefined,
  requestsId: ChannelId,
): ChannelId {
  return channelIds.find((id) => id === lastChannelId) ?? requestsId;
}

/** Projects with the remembered one moved first, so landing reopens it before the most recently active. */
export function withStoredProjectFirst<P extends ProjectRef>(
  projects: ReadonlyArray<P>,
  storedProjectKey: string | null,
): ReadonlyArray<P> {
  const stored = projects.find((project) => projectKey(project) === storedProjectKey);
  return stored === undefined ? projects : [stored, ...projects.filter((p) => p !== stored)];
}
