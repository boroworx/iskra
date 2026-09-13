import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  it.effect("refuses to download a runtime that is not already complete on disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-refuse-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      // An entry without its sentinel is an interrupted install, not a runtime.
      yield* fs.makeDirectory(path.dirname(finalPaths.entryPath), { recursive: true });
      yield* fs.writeFileString(finalPaths.entryPath, "export {};\n");

      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        validate: () => Effect.die("must not validate a missing runtime"),
      }).pipe(Effect.flip);

      assert.instanceOf(error, PinnedRuntimeInstallError);
      assert.include(error.message, "Iskra is not published to npm yet");
    }),
  );

  it.effect("validates and returns a completed runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-existing-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      yield* fs.makeDirectory(path.dirname(finalPaths.entryPath), { recursive: true });
      yield* fs.writeFileString(finalPaths.entryPath, "export {};\n");
      yield* fs.writeFileString(finalPaths.sentinelPath, "1.2.3\n");

      let validations = 0;
      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        validate: () => Effect.sync(() => void (validations += 1)),
      });

      assert.equal(validations, 1);
      assert.deepEqual(installed, finalPaths);
    }),
  );

  it.effect("preserves a completed runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, "1.2.3");
      yield* fs.makeDirectory(path.dirname(finalPaths.entryPath), { recursive: true });
      yield* fs.writeFileString(finalPaths.entryPath, "broken\n");
      yield* fs.writeFileString(finalPaths.sentinelPath, "1.2.3\n");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version: "1.2.3",
        fs,
        path,
        validate: () =>
          Effect.fail(new PinnedRuntimeInstallError({ step: "validating the runtime" })),
      }).pipe(Effect.flip);

      assert.equal(yield* fs.readFileString(finalPaths.entryPath), "broken\n");
    }),
  );
});
