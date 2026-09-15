import { CardId, CommandId, ProjectId } from "@iskra/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ProcessRunner } from "../processRunner.ts";
import { AgentDefinitionSync } from "./AgentDefinitionSync.ts";
import { SAMPLE_PROJECT_CARD, SAMPLE_PROJECT_FILES } from "./sampleProject/files.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

export class SampleProjectError extends Schema.TaggedError<SampleProjectError>()("SampleProjectError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * Creates the first-run sample project in a new folder under `parentDir`: the bundled app in a git
 * repository with one commit, added as a project with its three agents and a triage card. It trusts
 * nothing on the person's behalf: the side-effect guard stays unacknowledged, so no agent starts
 * until they review it.
 */
export const createSampleProject = Effect.fn("createSampleProject")(function* (input: {
  readonly parentDir: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner;
  const engine = yield* OrchestrationEngineService;
  const agents = yield* AgentDefinitionSync;
  const crypto = yield* Crypto.Crypto;
  const failWith = (message: string) => (cause: unknown) => new SampleProjectError({ message, cause });

  if (!path.isAbsolute(input.parentDir)) {
    return yield* new SampleProjectError({ message: "Choose the folder by its full path." });
  }
  const parent = yield* fileSystem
    .realPath(input.parentDir)
    .pipe(Effect.mapError(failWith(`The folder ${input.parentDir} doesn't exist.`)));
  let root = path.join(parent, "iskra-sample");
  for (let copy = 2; yield* fileSystem.exists(root).pipe(Effect.orElseSucceed(() => true)); copy += 1) {
    if (copy > 99) {
      return yield* new SampleProjectError({ message: `${parent} already has too many sample projects.` });
    }
    root = path.join(parent, `iskra-sample-${copy}`);
  }

  const git = (...args: ReadonlyArray<string>) =>
    runner.run({ command: "git", args: ["-C", root, ...args], timeout: "30 seconds" }).pipe(
      Effect.mapError(failWith("git couldn't run.")),
      Effect.flatMap((output) =>
        output.code === 0
          ? Effect.void
          : Effect.fail(new SampleProjectError({ message: `git ${args.at(-1)} failed: ${output.stderr.trim()}` })),
      ),
    );

  yield* Effect.forEach(SAMPLE_PROJECT_FILES, (file) => {
    const target = path.join(root, file.path);
    return fileSystem
      .makeDirectory(path.dirname(target), { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(target, file.contents)));
  }).pipe(Effect.mapError(failWith(`The sample project couldn't be written to ${root}.`)));
  yield* git("init", "--quiet", "--initial-branch=main");

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const projectId = ProjectId.make(yield* uuid);
  yield* engine
    .dispatch({
      type: "project.create",
      commandId: CommandId.make(`server:sample-project:${projectId}`),
      projectId,
      title: "Iskra sample",
      workspaceRoot: root,
      createdAt,
    })
    .pipe(Effect.mapError(failWith("The sample project couldn't be added.")));
  // Reading the agent files writes each one's id into it, so the first commit comes after.
  yield* agents.reconcile(projectId).pipe(Effect.mapError(failWith("The sample project's agents couldn't be read.")));
  yield* git("add", ".");
  yield* git("-c", "user.name=Iskra", "-c", "user.email=sample@iskra.invalid", "commit", "--quiet", "-m", "Sample project");

  const cardId = CardId.make(`card-${yield* uuid}`);
  yield* engine
    .dispatch({
      type: "card.create",
      commandId: CommandId.make(`server:sample-card:${cardId}`),
      cardId,
      projectId,
      title: SAMPLE_PROJECT_CARD.title,
      spec: SAMPLE_PROJECT_CARD.spec,
      tags: [],
      criteria: SAMPLE_PROJECT_CARD.criteria,
      createdAt,
    })
    .pipe(Effect.mapError(failWith("The sample project's first card couldn't be added.")));
  return { projectId, cardId, workspaceRoot: root };
});
