import {
  CARD_PORT_BLOCK_SIZE,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  type ProjectScript,
} from "@iskra/contracts";
import { fromLenientJson } from "@iskra/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProcessRunner } from "../processRunner.ts";

/** Where a project keeps its build knowledge, always read from the base branch on origin. */
export const PROJECT_FILE_PATH = ".iskra/project.json";

const withDefault = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefault(Effect.succeed(value)));

/** A port name as it appears in `${port:NAME}` and ISKRA_PORT_<NAME>. */
const PortName = Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9]*$/));

export const ProjectCheck = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  // Fractions of a minute are allowed; the cap keeps a hung suite from holding the machine.
  timeoutMinutes: withDefault(
    Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(60)),
    10,
  ),
  // "ci" checks are read from the pull request's check rollup, never run on this machine.
  source: withDefault(Schema.Literals(["local", "ci", "both"]), "local"),
  ciName: withDefault(Schema.NullOr(TrimmedNonEmptyString), null),
  // Used for scope "targeted"; `{filter}` is replaced with the requested filter.
  targetedCommand: withDefault(Schema.NullOr(TrimmedNonEmptyString), null),
  heavy: withDefault(Schema.Boolean, true),
});
export type ProjectCheck = typeof ProjectCheck.Type;

export const ProjectServiceConfig = Schema.Struct({
  name: TrimmedNonEmptyString,
  // The name of one of `ports`; the service must listen there.
  port: PortName,
  start: TrimmedNonEmptyString,
  ready: withDefault(
    Schema.Struct({
      kind: withDefault(Schema.Literals(["http", "tcp"]), "tcp"),
      path: withDefault(Schema.String, "/"),
      timeoutSeconds: withDefault(PositiveInt.check(Schema.isLessThanOrEqualTo(600)), 60),
    }),
    {},
  ),
  // "fake" marks a digital twin standing in for an outside API.
  kind: withDefault(Schema.Literals(["app", "fake"]), "app"),
});
export type ProjectServiceConfig = typeof ProjectServiceConfig.Type;

export const ProjectFileConfig = Schema.Struct({
  checks: withDefault(Schema.Array(ProjectCheck), []),
  // Offsets inside the card's port block.
  ports: withDefault(
    Schema.Record(PortName, NonNegativeInt.check(Schema.isLessThan(CARD_PORT_BLOCK_SIZE))),
    {},
  ),
  services: withDefault(Schema.Array(ProjectServiceConfig), []),
  // Worktree-relative paths: `template` is rendered into `target` before any agent session.
  envFiles: withDefault(
    Schema.Array(Schema.Struct({ template: TrimmedNonEmptyString, target: TrimmedNonEmptyString })),
    [],
  ),
  journeys: withDefault(
    Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        name: TrimmedNonEmptyString,
        command: TrimmedNonEmptyString,
        timeoutMinutes: withDefault(
          Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(60)),
          10,
        ),
      }),
    ),
    [],
  ),
  // Hints over the machine-derived throttling; the machine's own setting still wins.
  resourceProfile: withDefault(
    Schema.Struct({
      turboConcurrency: withDefault(Schema.NullOr(PositiveInt), null),
      vitestMaxWorkers: withDefault(Schema.NullOr(PositiveInt), null),
      nodeMaxOldSpaceMb: withDefault(Schema.NullOr(PositiveInt), null),
    }),
    {},
  ),
});
export type ProjectFileConfig = typeof ProjectFileConfig.Type;

export const EMPTY_PROJECT_FILE: ProjectFileConfig = Schema.decodeSync(ProjectFileConfig)({});

export class ProjectFileError extends Schema.TaggedError<ProjectFileError>()("ProjectFileError", {
  ref: Schema.String,
  message: Schema.String,
}) {}

const isInsideWorktree = (relativePath: string) =>
  !relativePath.startsWith("/") &&
  !/^[a-zA-Z]:/.test(relativePath) &&
  !relativePath.split(/[/\\]/).includes("..");

/** What a decoded file gets wrong across fields; empty when it is usable. */
export const projectFileIssues = (file: ProjectFileConfig): ReadonlyArray<string> => {
  const issues: Array<string> = [];
  const checkIds = file.checks.map((check) => check.id);
  for (const id of new Set(checkIds)) {
    if (checkIds.indexOf(id) !== checkIds.lastIndexOf(id)) {
      issues.push(`Check id '${id}' is used more than once.`);
    }
  }
  for (const service of file.services) {
    if (file.ports[service.port] === undefined) {
      issues.push(`Service '${service.name}' uses port '${service.port}', which isn't in ports.`);
    }
  }
  for (const envFile of file.envFiles) {
    for (const path of [envFile.template, envFile.target]) {
      if (!isInsideWorktree(path)) {
        issues.push(`envFiles path '${path}' must stay inside the worktree.`);
      }
    }
  }
  return issues;
};

const decodeJson = Schema.decodeUnknownEffect(fromLenientJson(ProjectFileConfig));

/** Decodes `.iskra/project.json` text; `ref` only names where it came from in errors. */
export const decodeProjectFile = (raw: string, ref: string) =>
  decodeJson(raw).pipe(
    Effect.mapError(
      (cause) =>
        new ProjectFileError({ ref, message: `${PROJECT_FILE_PATH} on ${ref} isn't valid: ${cause.message}` }),
    ),
    Effect.flatMap((file) => {
      const issues = projectFileIssues(file);
      return issues.length === 0
        ? Effect.succeed(file)
        : Effect.fail(
            new ProjectFileError({
              ref,
              message: `${PROJECT_FILE_PATH} on ${ref} isn't valid: ${issues.join(" ")}`,
            }),
          );
    }),
  );

/**
 * Reads the project file at `ref` (a commit-ish such as `origin/staging`) without touching any
 * checkout, so a builder's edits on its own branch change nothing until they merge. Null when the
 * ref has no project file.
 */
export const readProjectFile = Effect.fn("readProjectFile")(function* (input: {
  readonly root: string;
  readonly ref: string;
}) {
  const runner = yield* ProcessRunner;
  const git = (args: ReadonlyArray<string>) =>
    runner
      .run({ command: "git", args: ["-C", input.root, ...args], timeout: "30 seconds" })
      .pipe(
        Effect.mapError(
          (cause) => new ProjectFileError({ ref: input.ref, message: `git could not run: ${cause.message}` }),
        ),
      );
  const exists = yield* git(["cat-file", "-e", `${input.ref}:${PROJECT_FILE_PATH}`]);
  if (exists.code !== 0) {
    return null;
  }
  const shown = yield* git(["show", `${input.ref}:${PROJECT_FILE_PATH}`]);
  if (shown.code !== 0) {
    return yield* new ProjectFileError({
      ref: input.ref,
      message: `Could not read ${PROJECT_FILE_PATH} on ${input.ref}: ${shown.stderr.trim()}`,
    });
  }
  return yield* decodeProjectFile(shown.stdout, input.ref);
});

/**
 * The checks a card must pass, in execution order: the project file's, else the project's scripts
 * with role "check" in listed order, local, 10 minutes each.
 */
export const projectChecks = (
  file: ProjectFileConfig | null,
  scripts: ReadonlyArray<ProjectScript>,
): ReadonlyArray<ProjectCheck> =>
  file !== null && file.checks.length > 0
    ? file.checks
    : scripts
        .filter((script) => script.role === "check")
        .map((script) => ({
          id: script.id,
          name: script.name,
          command: script.command,
          timeoutMinutes: 10,
          source: "local" as const,
          ciName: null,
          targetedCommand: null,
          heavy: true,
        }));
