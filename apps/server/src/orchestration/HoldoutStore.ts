import { HoldoutScenario, type ProjectId } from "@iskra/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";

export class HoldoutStoreError extends Schema.TaggedError<HoldoutStoreError>()("HoldoutStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const HoldoutFile = Schema.fromJsonString(Schema.Array(HoldoutScenario));
const decodeFile = Schema.decodeUnknownEffect(HoldoutFile);
const encodeFile = Schema.encodeEffect(HoldoutFile);

/**
 * A project's hidden scenarios, kept in one file under the server's state directory
 * (`<stateDir>/holdouts/<projectId>.json`, mode 0600). Never in the repository or the event log:
 * Claude builders deny reads of the Iskra home, and OpenCode runs deny reads outside the worktree.
 * Only the verifier reactor and a person's RPCs read it.
 */
export class HoldoutStore extends Context.Service<
  HoldoutStore,
  {
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<HoldoutScenario>, HoldoutStoreError>;
    readonly get: (
      projectId: ProjectId,
      scenarioId: string,
    ) => Effect.Effect<Option.Option<HoldoutScenario>, HoldoutStoreError>;
    /** Adds the scenario, or replaces the one with its id. */
    readonly set: (
      projectId: ProjectId,
      scenario: HoldoutScenario,
    ) => Effect.Effect<void, HoldoutStoreError>;
    readonly remove: (projectId: ProjectId, scenarioId: string) => Effect.Effect<void, HoldoutStoreError>;
  }
>()("@iskra/cli/orchestration/HoldoutStore") {
  static readonly layer = Layer.effect(
    HoldoutStore,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // ponytail: one lock for every project's file; per-project locks if holdout edits ever contend.
      const lock = yield* Semaphore.make(1);
      const directory = path.join(config.stateDir, "holdouts");
      const fileOf = (projectId: ProjectId) =>
        path.join(directory, `${encodeURIComponent(projectId)}.json`);
      const failed = (message: string) => (cause: unknown) =>
        new HoldoutStoreError({ message, cause });

      const read = (projectId: ProjectId) =>
        Effect.gen(function* () {
          const file = fileOf(projectId);
          if (!(yield* fileSystem.exists(file))) return [];
          return yield* decodeFile(yield* fileSystem.readFileString(file));
        }).pipe(Effect.mapError(failed("The project's hidden scenarios couldn't be read.")));

      // Written to a private temp file and renamed over the old one, so a reader never sees half a file.
      const write = (projectId: ProjectId, scenarios: ReadonlyArray<HoldoutScenario>) =>
        Effect.gen(function* () {
          const file = fileOf(projectId);
          yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
          const temporary = `${file}.tmp`;
          yield* fileSystem.writeFileString(temporary, yield* encodeFile(scenarios), { mode: 0o600 });
          yield* fileSystem.chmod(temporary, 0o600);
          yield* fileSystem.rename(temporary, file);
        }).pipe(Effect.mapError(failed("The project's hidden scenarios couldn't be saved.")));

      return HoldoutStore.of({
        list: (projectId) => lock.withPermits(1)(read(projectId)),
        get: (projectId, scenarioId) =>
          lock.withPermits(1)(
            Effect.map(read(projectId), (scenarios) =>
              Option.fromUndefinedOr(scenarios.find((scenario) => scenario.scenarioId === scenarioId)),
            ),
          ),
        set: (projectId, scenario) =>
          lock.withPermits(1)(
            Effect.flatMap(read(projectId), (scenarios) =>
              write(projectId, [
                ...scenarios.filter((existing) => existing.scenarioId !== scenario.scenarioId),
                scenario,
              ]),
            ),
          ),
        remove: (projectId, scenarioId) =>
          lock.withPermits(1)(
            Effect.flatMap(read(projectId), (scenarios) =>
              write(
                projectId,
                scenarios.filter((scenario) => scenario.scenarioId !== scenarioId),
              ),
            ),
          ),
      });
    }),
  );
}

/** What a verifier's stored context shows in place of a hidden scenario's text. */
export const hiddenScenarioPlaceholder = (scenarioId: string) => `[hidden scenario ${scenarioId}]`;

/** Shorter fragments are too likely to be ordinary words to redact. */
const REDACT_MIN_LENGTH = 6;

/**
 * Replaces any scenario's title, body or command quoted in `text` with its placeholder, so what a
 * verifier writes into a verdict (recorded in the event log and fed back to the builder) can't
 * carry a scenario's words. Best effort: a paraphrase gets through.
 */
export const redactHoldouts = (
  text: string,
  scenarios: ReadonlyArray<Pick<HoldoutScenario, "scenarioId" | "title" | "body" | "command">>,
): string =>
  scenarios.reduce(
    (redacted, scenario) =>
      [scenario.body, scenario.command, scenario.title]
        .map((fragment) => fragment?.trim() ?? "")
        .filter((fragment) => fragment.length >= REDACT_MIN_LENGTH)
        .reduce(
          (current, fragment) => current.split(fragment).join(hiddenScenarioPlaceholder(scenario.scenarioId)),
          redacted,
        ),
    text,
  );
