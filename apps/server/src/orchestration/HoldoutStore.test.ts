import { ProjectId } from "@iskra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { HoldoutStore } from "./HoldoutStore.ts";

const layer = HoldoutStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "iskra-holdout-store-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const projectId = ProjectId.make("project-holdouts");

it.layer(layer)("HoldoutStore", (it) => {
  it.effect("keeps scenarios in a private file under the state directory, replaced and removed by id", () =>
    Effect.gen(function* () {
      const store = yield* HoldoutStore;
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const scenario = {
        scenarioId: "h1",
        title: "Health is JSON",
        kind: "text",
        body: "GET /health returns ok",
        command: null,
        timeoutMinutes: 5,
      } as const;
      yield* store.set(projectId, scenario);
      yield* store.set(projectId, { ...scenario, scenarioId: "h2", kind: "command", command: "node h2.js" });
      yield* store.set(projectId, { ...scenario, body: "GET /health returns JSON" });

      expect((yield* store.list(projectId)).map((entry) => [entry.scenarioId, entry.body])).toEqual([
        ["h2", "GET /health returns ok"],
        ["h1", "GET /health returns JSON"],
      ]);
      expect(Option.getOrThrow(yield* store.get(projectId, "h1")).body).toBe("GET /health returns JSON");

      const file = path.join(config.stateDir, "holdouts", `${projectId}.json`);
      expect(file.startsWith(config.stateDir)).toBe(true);
      expect((yield* fileSystem.stat(file)).mode & 0o777).toBe(0o600);

      yield* store.remove(projectId, "h2");
      expect((yield* store.list(projectId)).map((entry) => entry.scenarioId)).toEqual(["h1"]);
      expect(yield* store.list(ProjectId.make("project-without-holdouts"))).toEqual([]);
    }),
  );
});
