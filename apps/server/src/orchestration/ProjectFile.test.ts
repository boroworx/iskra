import type { ProjectScript } from "@iskra/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decodeProjectFile, projectChecks } from "./ProjectFile.ts";

const script = (id: string, role: ProjectScript["role"]): ProjectScript => ({
  id,
  name: id,
  command: `pnpm ${id}`,
  icon: "play",
  runOnWorktreeCreate: false,
  role,
});

it.effect("decodes a lenient project file with defaults for everything omitted", () =>
  Effect.gen(function* () {
    const file = yield* decodeProjectFile(
      `{
        // comments and trailing commas are fine
        "checks": [{ "id": "typecheck", "name": "Typecheck", "command": "pnpm typecheck" }],
        "ports": { "web": 0, "server": 2 },
        "services": [{ "name": "api", "port": "server", "start": "pnpm dev:server" }],
      }`,
      "origin/staging",
    );
    expect(file.checks).toEqual([
      {
        id: "typecheck",
        name: "Typecheck",
        command: "pnpm typecheck",
        timeoutMinutes: 10,
        source: "local",
        ciName: null,
        targetedCommand: null,
        heavy: true,
      },
    ]);
    expect(file.ports).toEqual({ web: 0, server: 2 });
    expect(file.services[0]).toMatchObject({ kind: "app", ready: { kind: "tcp", timeoutSeconds: 60 } });
    expect(file.envFiles).toEqual([]);
    expect(file.resourceProfile).toEqual({
      turboConcurrency: null,
      vitestMaxWorkers: null,
      nodeMaxOldSpaceMb: null,
    });
  }),
);

it.effect("refuses timeouts over an hour, ports outside the block and paths leaving the worktree", () =>
  Effect.gen(function* () {
    const invalid = [
      `{ "checks": [{ "id": "t", "name": "t", "command": "x", "timeoutMinutes": 61 }] }`,
      `{ "ports": { "web": 10 } }`,
      `{ "services": [{ "name": "api", "port": "server", "start": "x" }] }`,
      `{ "envFiles": [{ "template": ".env.iskra", "target": "../outside/.env" }] }`,
      `{ "checks": [{ "id": "t", "name": "a", "command": "x" }, { "id": "t", "name": "b", "command": "y" }] }`,
    ];
    for (const raw of invalid) {
      const error = yield* Effect.flip(decodeProjectFile(raw, "origin/main"));
      expect(error.message).toContain(".iskra/project.json on origin/main isn't valid");
    }
  }),
);

it("falls back to the project's check scripts in listed order", () => {
  const scripts = [script("lint", "check"), script("setup", "setup"), script("test", "check")];
  expect(projectChecks(null, scripts).map((check) => [check.id, check.timeoutMinutes, check.source])).toEqual([
    ["lint", 10, "local"],
    ["test", 10, "local"],
  ]);
});
