import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * A pinned runtime is an exact server version installed into
 * <baseDir>/runtime/versions/<version>. The boot service points its unit or
 * launch agent here, and server self-update switches to the target version
 * here, never `npx`, whose cache is ephemeral and whose registry fetch at boot
 * would make startup depend on the network.
 *
 * Iskra is not published to npm, and the `t3` package there is T3 Code. A
 * version that is not already complete on disk therefore fails instead of
 * being downloaded.
 */

const PINNED_RUNTIME_DIR = "runtime";

export interface PinnedRuntimePaths {
  readonly versionDir: string;
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export function pinnedRuntimePaths(
  path: Path.Path,
  baseDir: string,
  version: string,
): PinnedRuntimePaths {
  const versionDir = path.join(baseDir, PINNED_RUNTIME_DIR, "versions", version);
  return {
    versionDir,
    entryPath: path.join(versionDir, "node_modules", "@iskra/cli", "dist", "bin.mjs"),
    sentinelPath: path.join(versionDir, ".install-complete"),
  };
}

export class PinnedRuntimeInstallError extends Schema.TaggedError<PinnedRuntimeInstallError>()(
  "PinnedRuntimeInstallError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Pinned runtime install failed while ${this.step}.`
      : `Pinned runtime install failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class PinnedRuntimePreflightBlockedError extends Schema.TaggedError<PinnedRuntimePreflightBlockedError>()(
  "PinnedRuntimePreflightBlockedError",
  {
    version: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

interface PinnedRuntimeInstallInput {
  readonly baseDir: string;
  readonly version: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly validate: (
    paths: PinnedRuntimePaths,
  ) => Effect.Effect<void, PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError>;
}

/**
 * Returns the validated pinned runtime for `version`. Only a tree whose
 * sentinel records that version counts as complete.
 */
export const ensurePinnedRuntimeInstalled = Effect.fn("cloud.pinned_runtime.ensure_installed")(
  function* (input: PinnedRuntimeInstallInput) {
    const paths = pinnedRuntimePaths(input.path, input.baseDir, input.version);
    const [entryExists, sentinel] = yield* Effect.all([
      input.fs.exists(paths.entryPath),
      input.fs.readFileString(paths.sentinelPath).pipe(Effect.option),
    ]).pipe(
      Effect.mapError(
        (cause) => new PinnedRuntimeInstallError({ step: "checking the pinned runtime", cause }),
      ),
    );
    if (!entryExists || Option.isNone(sentinel) || sentinel.value.trim() !== input.version) {
      return yield* new PinnedRuntimeInstallError({
        step: `installing ${input.version}, because Iskra is not published to npm yet`,
      });
    }
    yield* input.validate(paths);
    return paths;
  },
);
