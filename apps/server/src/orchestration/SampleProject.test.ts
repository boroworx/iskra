import { projectOrchestrationOf } from "@iskra/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ProcessRunner } from "../processRunner.ts";
import * as AgentDefinitionSync from "./AgentDefinitionSync.ts";
import { projectFileIssues, readProjectFile } from "./ProjectFile.ts";
import { cardWorkspaceTestLayer } from "./reactor.testkit.ts";
import { createSampleProject } from "./SampleProject.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const layer = AgentDefinitionSync.layer.pipe(
  Layer.provideMerge(cardWorkspaceTestLayer("iskra-sample-project-test-")),
);

it.layer(layer)("createSampleProject", (it) => {
  it.effect("creates a committed repository whose checks fail, with three agents and a triage card, trusting nothing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const runner = yield* ProcessRunner;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const parentDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "iskra-sample-parent-" });

      const created = yield* createSampleProject({ parentDir });
      const root = created.workspaceRoot;
      expect(root.endsWith("/iskra-sample")).toBe(true);
      const git = (...args: ReadonlyArray<string>) =>
        runner.run({ command: "git", args: ["-C", root, ...args] }).pipe(Effect.map((output) => output.stdout.trim()));
      expect(yield* git("status", "--porcelain")).toBe("");
      expect(yield* git("log", "--format=%s")).toBe("Sample project");

      const file = yield* readProjectFile({ root, ref: "HEAD" });
      expect(file?.checks.map((check) => check.command)).toEqual(["node --test"]);
      expect(projectFileIssues(file!)).toEqual([]);
      // The seeded card has real work to do: the checks fail until it is fixed.
      const tests = yield* runner.run({ command: "node", args: ["--test"], cwd: root, timeout: "60 seconds" });
      expect(tests.code).not.toBe(0);

      const model = yield* snapshotQuery.getCommandReadModel();
      const project = model.projects.find((candidate) => candidate.id === created.projectId);
      expect(projectOrchestrationOf(project!).sideEffectGuard.acknowledgedAt).toBeNull();
      // The verifier it ships checks the work; auto-merge stays off.
      expect(projectOrchestrationOf(project!)).toMatchObject({ verifier: { mode: "on" }, autoMerge: { enabled: false } });
      const agents = (model.agents ?? []).filter((agent) => agent.projectId === created.projectId);
      const builder = agents.find((agent) => agent.name === "builder");
      expect(builder?.verifyWith).toBe("verifier");
      expect(
        agents.map((agent) => [agent.name, agent.roles.toSorted()]).toSorted(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ["builder", ["builder", "critic", "helper", "lead"]],
        ["lead", ["lead"]],
        ["verifier", ["verifier"]],
      ]);
      expect(model.cards?.find((card) => card.id === created.cardId)).toMatchObject({
        projectId: created.projectId,
        status: "triage",
        acceptance: { state: "draft", criteria: [{ id: "c1" }, { id: "c2" }] },
        // Approve & start suggests the builder; only a person assigns it.
        suggestedAgentId: builder?.id,
        delegateAgentId: null,
      });
      // Agent ids were written into the files before the commit, so the files stay the definitions.
      expect(yield* fileSystem.readFileString(`${root}/.iskra/agents/verifier.md`)).toMatch(/^---\nid: /);

      const again = yield* createSampleProject({ parentDir });
      expect(again.workspaceRoot.endsWith("/iskra-sample-2")).toBe(true);
      expect(yield* createSampleProject({ parentDir: "relative/dir" }).pipe(Effect.flip)).toMatchObject({
        _tag: "SampleProjectError",
        message: "Choose the folder by its full path.",
      });
    }),
  );
});
