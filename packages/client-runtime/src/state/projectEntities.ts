import type {
  EnvironmentId,
  OrchestrationAgentShell,
  OrchestrationChannelShell,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  ProjectId,
  ScopedProjectRef,
  OrchestrationCardShell,
} from "@iskra/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentProject } from "./models.ts";
import { scopeProject } from "./models.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { arrayElementsEqual, parseProjectKey, projectKey, projectRefsEqual } from "./entities.ts";

const EMPTY_PROJECTS: ReadonlyArray<OrchestrationProjectShell> = Object.freeze([]);
const EMPTY_PROJECT_INDEX: ReadonlyMap<ProjectId, OrchestrationProjectShell> = new Map();

export function createEnvironmentProjectAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  const environmentProjectsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationProjectShell> =>
        get(input.snapshotAtom(environmentId))?.projects ?? EMPTY_PROJECTS,
    ).pipe(Atom.withLabel(`environment-projects:${environmentId}`)),
  );

  const environmentProjectIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<ProjectId, OrchestrationProjectShell> => {
      const projects = get(environmentProjectsAtom(environmentId));
      if (projects.length === 0) {
        return EMPTY_PROJECT_INDEX;
      }
      return new Map(projects.map((project) => [project.id, project] as const));
    }).pipe(Atom.withLabel(`environment-project-index:${environmentId}`)),
  );

  const environmentProjectRefsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ScopedProjectRef> = [];
    return Atom.make((get) => {
      const next = get(environmentProjectsAtom(environmentId)).map((project) => ({
        environmentId,
        projectId: project.id,
      }));
      if (projectRefsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-project-refs:${environmentId}`));
  });

  const projectAtomFamily = Atom.family((key: string) => {
    const ref = parseProjectKey(key);
    let previousSource: OrchestrationProjectShell | null = null;
    let previousValue: EnvironmentProject | null = null;
    return Atom.make((get) => {
      const source = get(environmentProjectIndexAtom(ref.environmentId)).get(ref.projectId) ?? null;
      if (source === previousSource) {
        return previousValue;
      }
      previousSource = source;
      previousValue = source === null ? null : scopeProject(ref.environmentId, source);
      return previousValue;
    }).pipe(Atom.withLabel(`environment-project:${key}`));
  });

  let previousProjectRefs: ReadonlyArray<ScopedProjectRef> = [];
  const projectRefsAtom = Atom.make((get) => {
    const refs: ScopedProjectRef[] = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      refs.push(...get(environmentProjectRefsAtom(environmentId)));
    }
    if (projectRefsEqual(previousProjectRefs, refs)) {
      return previousProjectRefs;
    }
    previousProjectRefs = refs;
    return refs;
  }).pipe(Atom.withLabel("environment-project-refs"));

  let previousProjects: ReadonlyArray<EnvironmentProject> = [];
  const projectsAtom = Atom.make((get) => {
    const next = get(projectRefsAtom).flatMap((ref) => {
      const project = get(projectAtomFamily(projectKey(ref)));
      return project === null ? [] : [project];
    });
    if (arrayElementsEqual(previousProjects, next)) {
      return previousProjects;
    }
    previousProjects = next;
    return previousProjects;
  }).pipe(Atom.withLabel("environment-project-list"));

  return {
    environmentProjectsAtom,
    environmentProjectIndexAtom,
    environmentProjectRefsAtom,
    projectRefsAtom,
    projectsAtom,
    projectAtom: (ref: ScopedProjectRef) => projectAtomFamily(projectKey(ref)),
  };
}

const EMPTY_AGENTS: ReadonlyArray<OrchestrationAgentShell> = Object.freeze([]);
const EMPTY_CHANNELS: ReadonlyArray<OrchestrationChannelShell> = Object.freeze([]);
const EMPTY_CARDS: ReadonlyArray<OrchestrationCardShell> = Object.freeze([]);

/** An environment's active agents, channels and cards; empty for servers that do not send them. */
export function createEnvironmentAgentChannelAtoms(input: {
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  const environmentAgentsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationAgentShell> =>
        get(input.snapshotAtom(environmentId))?.agents ?? EMPTY_AGENTS,
    ).pipe(Atom.withLabel(`environment-agents:${environmentId}`)),
  );

  const environmentChannelsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationChannelShell> =>
        get(input.snapshotAtom(environmentId))?.channels ?? EMPTY_CHANNELS,
    ).pipe(Atom.withLabel(`environment-channels:${environmentId}`)),
  );

  const environmentCardsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationCardShell> =>
        get(input.snapshotAtom(environmentId))?.cards ?? EMPTY_CARDS,
    ).pipe(Atom.withLabel(`environment-cards:${environmentId}`)),
  );

  return { environmentAgentsAtom, environmentChannelsAtom, environmentCardsAtom };
}
