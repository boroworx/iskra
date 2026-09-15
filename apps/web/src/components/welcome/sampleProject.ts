import { request, type EnvironmentRpcInput } from "@iskra/client-runtime/rpc";
import { createEnvironmentCommand } from "@iskra/client-runtime/state/runtime";
import { ORCHESTRATION_WS_METHODS } from "@iskra/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";

/**
 * Creates the bundled sample project (a tiny app with one failing test, its checks and agents, and
 * a seeded triage card) in a new folder under `parentDir` on the environment. Succeeds with the
 * project, its seeded card and the folder it was written to.
 */
export const createSampleProject = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:commands:project:create-sample",
  execute: (input: EnvironmentRpcInput<typeof ORCHESTRATION_WS_METHODS.createSampleProject>) =>
    request(ORCHESTRATION_WS_METHODS.createSampleProject, input),
});
