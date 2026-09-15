import type { EnvironmentId, ProjectId } from "@iskra/contracts";

export type SampleProjectResult =
  | { readonly _tag: "Success"; readonly projectId: ProjectId }
  | { readonly _tag: "Failure"; readonly message: string };

export const SAMPLE_PROJECT_UNAVAILABLE_TEXT =
  "This server can't create the sample project yet. Update Iskra, or add a project of your own.";

/**
 * Creates the bundled sample project (a tiny app with one failing test, its checks and agents, and
 * a seeded triage card) under `parentDir` on the environment.
 * ponytail: a stub until the server's project.sample.create RPC lands; swap the body for
 * `request(ORCHESTRATION_WS_METHODS.createSampleProject, ...)` then.
 */
export async function createSampleProject(_input: {
  readonly environmentId: EnvironmentId;
  readonly parentDir: string;
}): Promise<SampleProjectResult> {
  return { _tag: "Failure", message: SAMPLE_PROJECT_UNAVAILABLE_TEXT };
}
